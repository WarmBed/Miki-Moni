import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { marked } from "marked";

// ── Types ──────────────────────────────────────────────────────────────────

interface Session {
  cwd: string;
  session_uuid: string | null;
  project_name: string;
  status: "active" | "waiting" | "idle" | "stale";
  last_event_at: number;
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
  wrapped?: boolean;  // true if a `cch claude` wrapper is actively connected
  activity?: string | null;  // "Ideating" / "Using Bash" / "Replying" / null — live wrapper state
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | null;
  pending_ask?: PendingAsk | null;
}

interface AskOption { label: string; description: string }
interface AskQuestion { question: string; header: string; multiSelect?: boolean; options: AskOption[] }
interface PendingAsk { question_id: string; questions: AskQuestion[] }

interface ToolUseInfo { id: string; name: string; description?: string; input: unknown; input_summary: string }
interface ToolResultInfo { tool_use_id?: string; content: string; truncated: boolean; is_error?: boolean }
interface TranscriptTurn { ts: string; role: "user" | "assistant"; text: string; tool_use?: ToolUseInfo; tool_result?: ToolResultInfo; raw_type?: string }
interface TranscriptResp { session_uuid: string; transcript_path: string; file_size: number; last_modified: string; turn_count: number; turns: TranscriptTurn[] }

interface LogEntry { ts: number; level: "info" | "warn" | "error"; msg: string; ctx?: Record<string, unknown> }

interface SessionPreview {
  session_uuid: string;
  ai_title: string | null;
  last_assistant_text: string | null;
  last_assistant_ts: string | null;
  last_user_text: string | null;
  last_user_ts: string | null;
  last_tool_use: { name: string; description?: string } | null;
  last_tool_use_ts: string | null;
  last_modified_ms: number;
  transcript_path: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const STATUS_DOT: Record<Session["status"], string> = {
  active: "dot dot-active",
  waiting: "dot dot-waiting",
  idle: "dot dot-idle",
  stale: "dot dot-stale",
};

const STATUS_BORDER_COLOR: Record<Session["status"], string> = {
  active: "var(--pass)",
  waiting: "var(--warn)",
  idle: "var(--neutral)",
  stale: "var(--accent)",
};

const STATUS_LABEL: Record<Session["status"], string> = {
  active: "進行中",
  waiting: "等你回應",
  idle: "閒置",
  stale: "已斷線",
};

const ACT_LOG_MAX = 50;

// ── Console logging helper ─────────────────────────────────────────────────

const TAG = "%c[cc-hub]";
const TAG_STYLE = "color:#4b556a;font-weight:600";
function clog(label: string, ctx?: Record<string, unknown>) { console.log(TAG, TAG_STYLE, label, ctx ?? ""); }
function cwarn(label: string, ctx?: Record<string, unknown>) { console.warn(TAG, TAG_STYLE, label, ctx ?? ""); }
function cerr(label: string, ctx?: Record<string, unknown>) { console.error(TAG, TAG_STYLE, label, ctx ?? ""); }

// ── Format helpers ─────────────────────────────────────────────────────────

function fmtTime(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return "";
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  return `${HH}:${MM}:${SS}`;
}
function fmtDateTime(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-TW", { hour12: false });
}
function fmtRelative(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分鐘前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小時前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}
function fmtTurnTs(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return fmtRelative(ms);
}

// ── Inline SVG icons (lucide style — line, currentColor) ──────────────────

function IconCopy({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function IconExternalLink({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
function IconSend({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

// ── Markdown rendering ─────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: true });

function MD({ text }: { text: string }) {
  const html = useMemo(() => {
    try { return marked.parse(text, { async: false }) as string; }
    catch { return `<pre>${escapeHtml(text)}</pre>`; }
  }, [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Convert markdown to clean plain text for preview cells: drop syntax, tables, links → just words.
function mdToPlainText(md: string): string {
  try {
    const html = marked.parse(md, { async: false }) as string;
    const text = html
      // Drop code blocks and HR entirely — they add noise in a 240-char preview.
      .replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, " ")
      .replace(/<hr\s*\/?\s*>/gi, " ")
      // Table cells and list items: insert " · " separator so columns don't smush together.
      .replace(/<\/(td|th|li)>/gi, " · ")
      // Block tags: replace closing tag with a space.
      .replace(/<\/(p|div|tr|thead|tbody|h[1-6]|blockquote)>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      // Strip remaining tags.
      .replace(/<[^>]+>/g, "")
      // HTML entities.
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Clean up: trim and collapse, drop trailing/repeated separators.
      .replace(/(\s*·\s*){2,}/g, " · ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^·\s*/, "")
      .replace(/\s*·\s*$/, "");
    return text;
  } catch {
    return md.replace(/\s+/g, " ").trim();
  }
}

// ── Attached image utilities (Ctrl+V paste) ────────────────────────────────

interface AttachedImage {
  media_type: string;  // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  data: string;        // base64 (no data: prefix)
  preview: string;     // full data URL for <img src=...>
  bytes: number;       // for showing size
}

// Read all image items off a ClipboardEvent. Returns an array of base64-encoded
// images suitable for Anthropic's image content blocks. Non-image items skipped.
async function extractImagesFromClipboard(e: ClipboardEvent): Promise<AttachedImage[]> {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: AttachedImage[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!item.type.startsWith("image/")) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => resolve(r.result as string);
      r.readAsDataURL(blob);
    });
    const [meta, data] = dataUrl.split(",");
    const media_type = meta?.match(/^data:([^;]+);/)?.[1] ?? "image/png";
    out.push({ media_type, data: data ?? "", preview: dataUrl, bytes: blob.size });
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Modal picker for Claude's AskUserQuestion. Renders tabs across questions,
// radio (single-select) or checkbox (multi) per option, submit POSTs back.
function AskQuestionModal({ sessionUuid, ask, onSubmitted, onDismiss }: {
  sessionUuid: string;
  ask: PendingAsk;
  onSubmitted: () => void;
  onDismiss: () => void;
}) {
  const [currentQ, setCurrentQ] = useState(0);
  const [picks, setPicks] = useState<Record<number, Set<number>>>({});  // question idx → set of option idx
  const [customs, setCustoms] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = ask.questions[currentQ];
  if (!q) return null;

  function togglePick(qi: number, oi: number, multi: boolean): void {
    setPicks((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        if (cur.has(oi)) cur.delete(oi); else cur.add(oi);
      } else {
        cur.clear(); cur.add(oi);
      }
      return { ...prev, [qi]: cur };
    });
  }

  async function submit(): Promise<void> {
    // For each question: build list of answer strings (option labels OR custom text).
    const answers: string[][] = ask.questions.map((qq, qi) => {
      const chosen = Array.from(picks[qi] ?? []);
      const labels = chosen.map((oi) => qq.options[oi]?.label ?? "").filter(Boolean);
      const custom = (customs[qi] ?? "").trim();
      return custom ? [...labels, custom] : labels;
    });
    if (answers.every((a) => a.length === 0)) {
      setErr("請至少回答一題");
      return;
    }
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch("/wrap/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: sessionUuid, question_id: ask.question_id, answers }),
      });
      if (!r.ok) { setErr(`HTTP ${r.status}`); return; }
      onSubmitted();
    } catch (e) {
      setErr(String(e));
    } finally { setSubmitting(false); }
  }

  return (
    <>
      <div class="popover-backdrop" onClick={onDismiss} />
      <div class="ask-modal">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>❓ Claude 在問你問題</strong>
          <span style={{ color: "var(--fg-subtle)", fontSize: 11, marginLeft: "auto" }}>{ask.questions.length > 1 ? `${currentQ + 1} / ${ask.questions.length}` : ""}</span>
          <button class="btn-ghost" style={{ padding: "2px 8px" }} onClick={onDismiss}>×</button>
        </div>
        {ask.questions.length > 1 && (
          <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
            {ask.questions.map((qq, i) => {
              const answered = (picks[i]?.size ?? 0) > 0 || (customs[i]?.trim()?.length ?? 0) > 0;
              return (
                <button
                  key={i}
                  class={"ask-tab" + (i === currentQ ? " ask-tab-active" : "") + (answered ? " ask-tab-done" : "")}
                  onClick={() => setCurrentQ(i)}
                >{answered ? "✓ " : ""}{qq.header}</button>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>{q.question}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {q.options.map((opt, oi) => {
            const checked = picks[currentQ]?.has(oi) ?? false;
            const multi = !!q.multiSelect;
            return (
              <label key={oi} class={"ask-option" + (checked ? " ask-option-checked" : "")}>
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={`q-${currentQ}`}
                  checked={checked}
                  onChange={() => togglePick(currentQ, oi, multi)}
                />
                <div>
                  <div style={{ fontWeight: 500 }}>{opt.label}</div>
                  {opt.description && <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>{opt.description}</div>}
                </div>
              </label>
            );
          })}
        </div>
        <input
          type="text"
          placeholder="或自己打答案（會跟勾選一起送）…"
          value={customs[currentQ] ?? ""}
          onInput={(e) => setCustoms((p) => ({ ...p, [currentQ]: (e.currentTarget as HTMLInputElement).value }))}
          style={{ width: "100%", marginTop: 10 }}
        />
        {err && <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent)" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {ask.questions.length > 1 && currentQ > 0 && (
            <button class="btn-outline" onClick={() => setCurrentQ((i) => i - 1)}>← 上一題</button>
          )}
          {ask.questions.length > 1 && currentQ < ask.questions.length - 1 && (
            <button class="btn-outline" onClick={() => setCurrentQ((i) => i + 1)}>下一題 →</button>
          )}
          <button
            class="btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={submit}
            disabled={submitting}
          >{submitting ? "送出中…" : "Submit"}</button>
        </div>
      </div>
    </>
  );
}

function AttachedImageStrip({ images, onRemove, dimmed }: {
  images: AttachedImage[];
  onRemove: (idx: number) => void;
  dimmed?: boolean;  // true when current send path can't carry images (e.g. VSCode prefill)
}) {
  if (images.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6, opacity: dimmed ? 0.5 : 1 }}>
      {images.map((img, i) => (
        <div key={i} style={{ position: "relative", border: "1px solid var(--border)", borderRadius: 4, padding: 2 }}>
          <img src={img.preview} alt="" style={{ display: "block", maxHeight: 72, maxWidth: 120, borderRadius: 2 }} />
          <div style={{ fontSize: 9, color: "var(--fg-subtle)", textAlign: "center", marginTop: 2 }}>
            {img.media_type.replace("image/", "")} · {fmtBytes(img.bytes)}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(i); }}
            style={{ position: "absolute", top: -6, right: -6, background: "rgba(20,20,20,0.85)", color: "white", border: "1px solid white", borderRadius: "50%", width: 18, height: 18, padding: 0, cursor: "pointer", fontSize: 10, lineHeight: "16px" }}
            title="移除這張"
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ── Tool box (IN/OUT) ──────────────────────────────────────────────────────

function ToolUseBox({ t }: { t: TranscriptTurn }) {
  const u = t.tool_use!;
  const [expanded, setExpanded] = useState(false);
  const inputStr = typeof u.input === "string" ? u.input : JSON.stringify(u.input, null, 2);
  return (
    <div class="toolbox" style={{ marginTop: 4 }}>
      <div
        class="toolbox-head"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "收合" : "展開 IN"}
      >
        <span style={{ color: "var(--fg-subtle)", fontSize: 10, width: 10, display: "inline-block" }}>{expanded ? "▾" : "▸"}</span>
        <span class="dot dot-active" style={{ width: 6, height: 6 }} />
        <span>{u.name}</span>
        {u.description && <span style={{ color: "var(--fg-subtle)" }}>{u.description}</span>}
      </div>
      {expanded && (
        <div class="toolbox-row">
          <div class="toolbox-label">IN</div>
          <pre class="toolbox-content" style={{ margin: 0 }}>{inputStr}</pre>
        </div>
      )}
    </div>
  );
}

function ToolResultBox({ t }: { t: TranscriptTurn }) {
  const r = t.tool_result!;
  const [expanded, setExpanded] = useState(false);
  const content = r.content || "(empty)";
  const preview = content.replace(/\s+/g, " ").slice(0, 120);
  return (
    <div class="toolbox" style={{ marginTop: 4 }}>
      <div
        class="toolbox-head"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "收合" : "展開 OUT"}
      >
        <span style={{ color: "var(--fg-subtle)", fontSize: 10, width: 10, display: "inline-block" }}>{expanded ? "▾" : "▸"}</span>
        <span class={"toolbox-label" + (r.is_error ? " is-error" : "")} style={{ margin: 0 }}>OUT</span>
        {!expanded && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {preview}{content.length > 120 ? "…" : ""}
          </span>
        )}
      </div>
      {expanded && (
        <div class="toolbox-row">
          <div class="toolbox-label">&nbsp;</div>
          <pre class={"toolbox-content" + (r.is_error ? " is-error" : "")} style={{ margin: 0 }}>
            {content}
            {r.truncated && <div style={{ color: "var(--fg-subtle)", fontSize: 10, marginTop: 4 }}>…[truncated]</div>}
          </pre>
        </div>
      )}
    </div>
  );
}

function TurnView({ t }: { t: TranscriptTurn }) {
  const isUser = t.role === "user";
  const isTool = !!(t.tool_use || t.tool_result);
  const roleLabel = isUser ? "user" : "assistant";
  // Tool turns: dim role color (de-emphasized) since the tool box is the main signal.
  const roleColor = isTool ? "var(--fg-subtle)" : isUser ? "var(--neutral)" : "var(--pass)";
  const bgClass = isTool ? "turn-bg-tool" : isUser ? "turn-bg-user" : "turn-bg-assistant";
  // Tool turns: tighter padding + smaller header margin since the embedded tool box has its own padding.
  const pad = isTool ? "4px 12px" : "10px 14px";
  const headerMb = isTool ? 3 : 6;
  const headerFontSize = isTool ? 11 : 12;
  return (
    <div class={bgClass} style={{ padding: pad, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: headerMb }}>
        <span style={{ color: roleColor, fontWeight: 600, fontSize: headerFontSize }}>{roleLabel}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>{fmtDateTime(t.ts)}</span>
        {t.tool_use && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>· 🔧 {t.tool_use.name}</span>
        )}
        {t.tool_result && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>· 📤 tool result</span>
        )}
      </div>
      {t.text && <MD text={t.text} />}
      {t.tool_use && <ToolUseBox t={t} />}
      {t.tool_result && <ToolResultBox t={t} />}
    </div>
  );
}

// Split transcript into two columns:
//   left  — conversation (user/assistant text, no tool activity)
//   right — tool activity (assistant tool_use + user tool_result)
// A turn that has BOTH text and tool_use shows the text on the left and the tool box on the right.
// Auto follow-tail: each column auto-scrolls to bottom on new content unless the user has
// manually scrolled up. Scrolling back to bottom re-engages follow.
function TwoColumnTranscript({ turns }: { turns: TranscriptTurn[] }) {
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  // refs (not state) so toggling doesn't re-render; only the scroll effect reads them.
  const stickyLeft = useRef(true);
  const stickyRight = useRef(true);

  const { leftTurns, rightTurns } = useMemo(() => {
    const l: TranscriptTurn[] = [];
    const r: TranscriptTurn[] = [];
    for (const t of turns) {
      const hasTool = !!(t.tool_use || t.tool_result);
      if (t.text) l.push({ ...t, tool_use: undefined, tool_result: undefined });
      if (hasTool) r.push({ ...t, text: "" });
    }
    return { leftTurns: l, rightTurns: r };
  }, [turns]);

  // After each render (i.e., when turns change), pin to bottom if user is still following.
  useEffect(() => {
    if (stickyLeft.current && leftRef.current) {
      leftRef.current.scrollTop = leftRef.current.scrollHeight;
    }
    if (stickyRight.current && rightRef.current) {
      rightRef.current.scrollTop = rightRef.current.scrollHeight;
    }
  });

  // Tolerance for "at bottom": some browsers report fractional scroll positions.
  const TAIL_TOL = 24;
  function makeOnScroll(stickyRef: { current: boolean }) {
    return (ev: Event) => {
      const el = ev.currentTarget as HTMLDivElement;
      stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_TOL;
    };
  }

  if (turns.length === 0) {
    return <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>(transcript 沒有可顯示的訊息)</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", height: "100%", minHeight: 0, overflow: "hidden" }}>
      <div ref={leftRef} onScroll={makeOnScroll(stickyLeft)} style={{ overflowY: "auto", borderRight: "1px solid var(--border)" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 1, padding: "6px 14px", fontSize: 10, fontWeight: 600, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--sl2)", borderBottom: "1px solid var(--border)" }}>
          對話 · {leftTurns.length}
        </div>
        {leftTurns.length === 0 ? (
          <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>(無對話訊息)</div>
        ) : (
          leftTurns.map((t, i) => <TurnView key={`L${i}`} t={t} />)
        )}
      </div>
      <div ref={rightRef} onScroll={makeOnScroll(stickyRight)} style={{ overflowY: "auto" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 1, padding: "6px 14px", fontSize: 10, fontWeight: 600, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--sl2)", borderBottom: "1px solid var(--border)" }}>
          工具 · {rightTurns.length}
        </div>
        {rightTurns.length === 0 ? (
          <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>(無工具呼叫)</div>
        ) : (
          rightTurns.map((t, i) => <TurnView key={`R${i}`} t={t} />)
        )}
      </div>
    </div>
  );
}

// ── Session card ───────────────────────────────────────────────────────────

type ActionResult = { ok: boolean; label: string; url?: string; reply?: string; durationMs?: number; diag?: string; error?: string; ts: number } | null;

function Card({ s, defaultExpanded, clientType, onSetClientType, onFocus, onSend, sendKey, modalMode, onAfterSend }: {
  s: Session;
  defaultExpanded: boolean;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onFocus: (uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number; diag?: string; error?: string }>;
  sendKey: SendKey;
  modalMode?: boolean;
  onAfterSend?: () => void;
}) {
  const isCli = clientType === "cli";
  const isWrapped = !!s.wrapped;
  // Only wrapped CLI sessions allow send. VSCode-panel mode is disabled because
  // claude-code's primaryEditor.open(uuid) creates a FRESH empty panel when the
  // session UUID isn't already in its sessionPanels map, and there's no
  // exposed API to load by UUID — so sends would silently target the wrong
  // (new, empty) conversation. CLI WITHOUT wrap also blocked: -p costs $$ +
  // injects a resume marker. Wrap-push is the only reliable delivery path.
  const sendBlocked = !isWrapped;
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<AttachedImage[]>([]);
  const imagesSupported = isWrapped;  // only wrap-push can carry image blocks
  // Default = prefill (free, uses your already-running VSCode panel session).
  // For wrapped sessions, server-side intercepts ANY mode and routes via WS push,
  // so submitMode doesn't matter — but keep it false so UI labels don't scream "💸".
  const [submitMode, setSubmitMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusResult, setFocusResult] = useState<ActionResult>(null);
  const [sendResult, setSendResult] = useState<ActionResult>(null);
  const [showTranscript, setShowTranscript] = useState(defaultExpanded);
  const [transcript, setTranscript] = useState<TranscriptResp | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptLimit, setTranscriptLimit] = useState(20);
  const sessionUuid = s.session_uuid ?? "";

  // Auto-load transcript on first mount when defaultExpanded (i.e., in tab view)
  useEffect(() => {
    if (defaultExpanded && sessionUuid && !transcript && !transcriptLoading) {
      void loadTranscript();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUuid]);

  // Live tail (path 1): WS-driven. When this session emits session_changed
  // (hook fired), debounce 600ms then refetch.
  const autoRefreshTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!defaultExpanded || !sessionUuid || !showTranscript || !transcript) return;
    if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current);
    autoRefreshTimerRef.current = window.setTimeout(() => {
      void loadTranscript(transcriptLimit);
    }, 600);
    return () => { if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.last_event_at]);

  // Live tail (path 2): polling fallback. Hooks may not be installed for every
  // VSCode panel (panels opened BEFORE `pnpm install:hooks` won't fire), so
  // we also poll a cheap meta endpoint every 2s. If the JSONL's mtime or size
  // bumps, refetch the full transcript.
  //
  // Self-disabling on 404: if the daemon doesn't have /transcript-meta (older
  // daemon not yet restarted) the very first poll 404s — stop the interval to
  // avoid spamming the console, then retry once after 5s in case the user
  // restarts the daemon mid-session.
  useEffect(() => {
    if (!defaultExpanded || !sessionUuid || !showTranscript) return;
    let cancelled = false;
    let intervalId: number | undefined;
    let retryTimerId: number | undefined;
    let lastMtime = transcript?.last_modified ?? "";
    let lastSize = transcript?.file_size ?? 0;

    function start() {
      intervalId = window.setInterval(async () => {
        if (cancelled) return;
        try {
          const r = await fetch(`/sessions/${encodeURIComponent(sessionUuid)}/transcript-meta`);
          if (r.status === 404) {
            if (intervalId) { window.clearInterval(intervalId); intervalId = undefined; }
            cwarn("transcript-meta 404 — polling paused (restart daemon to re-enable); retry in 5s");
            retryTimerId = window.setTimeout(() => { if (!cancelled) start(); }, 5000);
            return;
          }
          if (!r.ok) return;
          const meta: { last_modified: string; file_size: number } = await r.json();
          if (meta.last_modified !== lastMtime || meta.file_size !== lastSize) {
            lastMtime = meta.last_modified;
            lastSize = meta.file_size;
            void loadTranscript(transcriptLimit);
          }
        } catch { /* silent — next tick will retry */ }
      }, 2000);
    }
    start();

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
      if (retryTimerId) window.clearTimeout(retryTimerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUuid, showTranscript, transcript?.last_modified, transcript?.file_size, transcriptLimit]);

  async function loadTranscript(limit = transcriptLimit) {
    if (!sessionUuid) return;
    setTranscriptLoading(true);
    setTranscriptError(null);
    try {
      const r = await fetch(`/sessions/${encodeURIComponent(sessionUuid)}/transcript?limit=${limit}`);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        setTranscriptError(`HTTP ${r.status}: ${body.slice(0, 200)}`);
        return;
      }
      const data: TranscriptResp = await r.json();
      setTranscript(data);
      clog("transcript loaded", { session_uuid: sessionUuid, turns: data.turn_count });
    } catch (e) {
      setTranscriptError(String(e));
    } finally {
      setTranscriptLoading(false);
    }
  }

  function toggleTranscript() {
    const next = !showTranscript;
    setShowTranscript(next);
    if (next && !transcript && !transcriptLoading) void loadTranscript();
  }

  async function handleFocus() {
    clog("click focus", { cwd: s.cwd, uuid: sessionUuid });
    setFocusResult(null);
    const r = await onFocus(sessionUuid);
    setFocusResult({ ok: r.ok, label: r.ok ? `OK · HTTP ${r.status}` : `失敗 HTTP ${r.status}`, url: r.url, ts: Date.now() });
    setTimeout(() => setFocusResult(null), 15_000);
  }
  async function handleSend() {
    const prompt = draft.trim();
    const hasImages = draftImages.length > 0;
    if (!prompt && !hasImages) return;
    clog("click send", { cwd: s.cwd, uuid: sessionUuid, mode: submitMode ? "submit" : "prefill+enter", len: prompt.length, images: hasImages ? draftImages.length : 0 });
    setSendResult(null);
    setBusy(true);
    try {
      const sendImages = imagesSupported ? draftImages : undefined;
      const r = await onSend(sessionUuid, prompt, submitMode, sendImages);
      const label = !r.ok
        ? `失敗 HTTP ${r.status}`
        : submitMode
          ? `Claude 已回覆 (${r.duration_ms ?? "?"} ms)`
          : `已送出到 VSCode panel（Enter 已自動按）`;
      setSendResult({ ok: r.ok, label, url: r.url, reply: r.reply, durationMs: r.duration_ms, diag: r.diag, error: r.error, ts: Date.now() });
      if (r.ok) { setDraft(""); setDraftImages([]); }
      if (r.ok && submitMode && transcript) void loadTranscript();
      if (r.ok && onAfterSend) onAfterSend();
    } finally {
      setBusy(false);
    }
    setTimeout(() => setSendResult(null), 60_000);
  }

  async function handlePasteCard(e: ClipboardEvent) {
    const got = await extractImagesFromClipboard(e);
    if (got.length > 0) {
      e.preventDefault();
      setDraftImages((prev) => [...prev, ...got]);
    }
  }

  // ── Collapsed view (one line) ───────────────────────────────────────────
  if (collapsed) {
    return (
      <div class="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
        <span class={STATUS_DOT[s.status]} />
        <span style={{ fontWeight: 500, minWidth: 120 }}>{s.project_name}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11, fontFamily: "ui-monospace, monospace" }}>{s.cwd}</span>
        <span style={{ color: "var(--fg-muted)", fontSize: 12, marginLeft: "auto" }}>{STATUS_LABEL[s.status]}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{fmtRelative(s.last_event_at)}</span>
        <button class="btn-ghost" onClick={() => setCollapsed(false)} title="展開">▾</button>
      </div>
    );
  }

  // ── Expanded view ──────────────────────────────────────────────────────
  // When defaultExpanded (tab view): card fills viewport, transcript flex:1 in middle,
  // bottom section (meta + composer) sticks to bottom.
  // When modalMode: same flex layout but height=100% of the parent modal container.
  // When inline (legacy): natural height.
  const fixedHeight = defaultExpanded;
  const cardStyle = modalMode
    ? { display: "flex", flexDirection: "column" as const, height: "100%", minHeight: 0, border: "none", borderRadius: 0 }
    : fixedHeight
      ? { display: "flex", flexDirection: "column" as const, height: "calc(100vh - 220px)", minHeight: 480 }
      : undefined;
  return (
    <div class="card" style={cardStyle}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span class={STATUS_DOT[s.status]} />
        <button
          class="btn-ghost"
          style={{ fontWeight: 600, fontSize: 15, padding: "2px 6px" }}
          onClick={handleFocus}
          title={isCli ? "🚫 CLI session 不支援 focus（URI handler 只開 VSCode）" : "叫起 VSCode 視窗（focus）"}
          disabled={isCli}
        >{s.project_name}</button>
        {s.wrapped ? (
          <span class="client-badge client-badge-wrap client-badge-md" title="wrapper 接管中（CLI session）">🔌 wrapped</span>
        ) : (
          <ClientTypeBadge
            type={clientType}
            onToggle={() => onSetClientType(sessionUuid, isCli ? "vscode" : "cli")}
            size="md"
          />
        )}
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{STATUS_LABEL[s.status]}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11, marginLeft: 8 }}>{fmtRelative(s.last_event_at)}</span>
        <button class="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setCollapsed(true)} title="收合">▴</button>
      </div>

      {/* Transcript section — flex:1, scrollable */}
      <div style={fixedHeight
        ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, borderBottom: "1px solid var(--border)" }
        : { borderBottom: "1px solid var(--border)" }
      }>
        <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
          <button class="btn-ghost" style={{ flex: 1, justifyContent: "flex-start", padding: "8px 14px", borderRadius: 0 }} onClick={toggleTranscript}>
            {showTranscript ? "▾" : "▸"} 上下文 transcript
            {transcript && <span style={{ marginLeft: 8, color: "var(--fg-subtle)", fontSize: 11 }}>· {transcript.turn_count} 條 · {(transcript.file_size / 1024).toFixed(1)} KB</span>}
          </button>
        </div>
        {showTranscript && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              {transcript && (
                <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
                  最後修改 {fmtDateTime(transcript.last_modified)}
                </span>
              )}
              <select
                value={transcriptLimit}
                onChange={(e) => { const n = parseInt((e.currentTarget as HTMLSelectElement).value, 10); setTranscriptLimit(n); void loadTranscript(n); }}
                style={{ marginLeft: "auto" }}
              >
                <option value={10}>10 條</option>
                <option value={20}>20 條</option>
                <option value={50}>50 條</option>
                <option value={100}>100 條</option>
                <option value={200}>200 條</option>
                <option value={500}>500 條</option>
                <option value={10000}>全部</option>
              </select>
              <button
                class="btn-outline"
                style={{ height: 28, padding: "0 10px" }}
                onClick={() => { setTranscriptLimit(10000); void loadTranscript(10000); }}
                disabled={transcriptLoading}
                title="把整個 session JSONL 全部讀進來（最多 10000 turn）"
              >📜 載入全部</button>
              <button class="btn-outline" style={{ height: 28, padding: "0 10px" }} onClick={() => loadTranscript(transcriptLimit)} disabled={transcriptLoading}>
                {transcriptLoading ? "讀取中…" : "重新讀取"}
              </button>
            </div>
            {transcriptError && (
              <div style={{ padding: "8px 14px", color: "var(--accent)", fontSize: 12 }}>{transcriptError}</div>
            )}
            {transcript && (
              <div style={fixedHeight ? { flex: 1, minHeight: 0, display: "flex" } : { maxHeight: 480, overflow: "hidden", display: "flex" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TwoColumnTranscript turns={transcript.turns} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom: Meta + Send composer */}
      <div style={{ flexShrink: 0 }}>
        {/* Meta */}
        <div style={{ padding: "8px 14px", color: "var(--fg-subtle)", fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
          <div>{s.cwd}</div>
          <div>session_uuid: {sessionUuid || <span style={{ color: "var(--warn)" }}>null</span>}</div>
        </div>

        {/* Focus result */}
        {focusResult && (
          <div style={{ padding: "0 14px 8px", fontSize: 12, color: focusResult.ok ? "var(--pass)" : "var(--accent)" }}>
            叫起視窗：{focusResult.label}
          </div>
        )}

        {/* Send composer */}
        <div style={{ padding: "8px 14px 12px", display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border)" }}>
          <AttachedImageStrip images={draftImages} onRemove={(i) => setDraftImages((prev) => prev.filter((_, j) => j !== i))} dimmed={!imagesSupported && draftImages.length > 0} />
          {!imagesSupported && draftImages.length > 0 && (
            <div style={{ fontSize: 10, color: "var(--warn)" }}>
              ⚠️ 圖片在這個 session 模式下會被忽略（只有 wrapped 才能傳圖）
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              autoFocus={modalMode}
              style={{ flex: 1, minHeight: 38, fontSize: 13 }}
              rows={2}
              placeholder={
                sendBlocked
                  ? (isCli
                      ? `CLI session 沒接管 — 先在 terminal 跑：cch claude -r ${sessionUuid.slice(0, 8)}…`
                      : `VSCode panel mode 已停用 — 請改用 wrap：cch claude -r ${sessionUuid.slice(0, 8)}…`)
                  : "輸入 prompt（Ctrl+V 可貼圖）→ push 進 wrapper 的 query()…"
              }
              value={draft}
              onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
              onPaste={(e) => { void handlePasteCard(e as unknown as ClipboardEvent); }}
              onKeyDown={(e) => {
                if (shouldSendOnKey(e as unknown as KeyboardEvent, sendKey)) {
                  e.preventDefault();
                  if (!busy && !sendBlocked && (draft.trim() || draftImages.length > 0)) handleSend();
                }
              }}
              disabled={busy || sendBlocked}
            />
            <button
              class={isWrapped ? "btn-primary" : "btn-ghost"}
              disabled={(!draft.trim() && draftImages.length === 0) || busy || sendBlocked}
              onClick={handleSend}
              title={
                sendBlocked ? "先 `cch claude -r <uuid>` 接管 (wrap-cli)"
                : "走 wrap WS push 進 terminal 的 query()（免費，可帶圖）"
              }
            >
              {busy ? "⌛" : isWrapped ? "送出 🔌" : "送出 (需 wrap)"}
            </button>
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            {sendBlocked ? (
              isCli ? (
                <>
                  📟 <strong style={{ color: "#a8740d" }}>CLI session 沒接管</strong>：terminal 那個 <code>claude</code> 是封閉 process、外面塞不進去。請先停掉、改用 <code>cch claude -r {sessionUuid.slice(0, 8)}…</code> 接管，這邊就能即時送 prompt 進去（免費、無 resume marker）。
                </>
              ) : (
                <>
                  🖥️ <strong style={{ color: "#a8740d" }}>VSCode panel mode 已停用</strong>：claude-code 不給「按 UUID 載入 session」的 API，從外面送會跑去開新 panel 而不是接續對話。請改 wrap：<code>cch claude -r {sessionUuid.slice(0, 8)}…</code> 接管後就能從這送（免費、無 resume marker）。
                </>
              )
            ) : (
              <>
                🔌 <strong style={{ color: "#5a2db8" }}>wrapped</strong>：訊息直接 push 進你 terminal 的長壽 query() — 不 spawn 新 process、cache 全熱、沒 API 費用、不會出現「Continue from where you left off」。
              </>
            )}
          </div>
          {!isCli && (
            <>
              <button
                class="btn-ghost"
                style={{ fontSize: 10, alignSelf: "flex-start", padding: "2px 6px" }}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "▾" : "▸"} advanced：切換送出模式
              </button>
              {showAdvanced && (
                <label style={{ fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer", userSelect: "none", paddingLeft: 16 }}>
                  <input
                    type="checkbox"
                    checked={submitMode}
                    onChange={(e) => setSubmitMode((e.currentTarget as HTMLInputElement).checked)}
                    style={{ marginRight: 6, verticalAlign: "middle" }}
                  />
                  真送出模式（headless `claude -r -p`，會花 API 費用、不走你 panel session）
                </label>
              )}
            </>
          )}

          {/* Send result */}
          {sendResult && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, color: sendResult.ok ? "var(--pass)" : "var(--accent)" }}>
                送 prompt：{sendResult.label}
              </div>
              {sendResult.error && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--accent)", padding: 8, background: "var(--bg-subtle)", borderRadius: 4 }}>
                  ⚠️ {sendResult.error}
                </div>
              )}
              {sendResult.reply && (
                <div style={{ marginTop: 6, padding: 10, background: "var(--sl2)", border: "1px solid var(--border)", borderRadius: 6 }}>
                  <div class="section-label" style={{ marginBottom: 4 }}>Claude 回覆</div>
                  <MD text={sendResult.reply} />
                </div>
              )}
              {sendResult.url && (
                <div style={{ marginTop: 6, fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--fg-subtle)", wordBreak: "break-all" }}>
                  URI：<a href={sendResult.url} style={{ color: "var(--neutral)" }}>{sendResult.url}</a>
                </div>
              )}
              {sendResult.diag && (
                <div style={{ marginTop: 6, fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--fg-subtle)", wordBreak: "break-all" }}>
                  diag：{sendResult.diag}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Summary banner ─────────────────────────────────────────────────────────

// Status filter for the overview grid. "live" merges active + waiting because
// they're both "session is alive right now" to the user.
type StatusFilter = "all" | "live" | "idle" | "stale";

function SummaryBanner({ sessions, filter, onFilter }: {
  sessions: Session[];
  filter: StatusFilter;
  onFilter: (next: StatusFilter) => void;
}) {
  const counts = sessions.reduce(
    (acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; },
    {} as Record<Session["status"], number>,
  );
  const liveCount = (counts.active ?? 0) + (counts.waiting ?? 0);
  const total = sessions.length;
  return (
    <section style={{ marginBottom: 16, padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
      <div class="section-label" style={{ marginBottom: 8 }}>
        目前正在運行
        {filter !== "all" && (
          <span style={{ marginLeft: 8, color: "var(--neutral)", textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
            · 已過濾 ({filter}) · 點 TOTAL 重設
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <StatChip n={total}      label="TOTAL"  active={filter === "all"}    onClick={() => onFilter("all")}     big />
        <StatChip n={liveCount}  label="進行中 / 等回應"  active={filter === "live"}   onClick={() => onFilter("live")}    dot="dot-active" />
        <StatChip n={counts.idle ?? 0}  label="閒置"     active={filter === "idle"}   onClick={() => onFilter("idle")}    dot="dot-idle" />
        <StatChip n={counts.stale ?? 0} label="已斷線"    active={filter === "stale"}  onClick={() => onFilter("stale")}   dot="dot-stale" />
      </div>
    </section>
  );
}

function StatChip({ n, label, active, onClick, dot, big }: {
  n: number;
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: string;
  big?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={"stat-chip" + (active ? " stat-chip-active" : "")}
      style={{ cursor: "pointer", border: "none", padding: "6px 12px", borderRadius: 8, background: active ? "var(--sl3)" : "transparent", fontFamily: "inherit", textAlign: "left" }}
    >
      <div style={{ fontSize: big ? 28 : 22, fontWeight: big ? 600 : 500, fontVariantNumeric: "tabular-nums", color: n === 0 ? "var(--fg-subtle)" : "var(--fg)" }}>{n}</div>
      <div style={{ fontSize: 11, color: "var(--fg-subtle)", display: "flex", alignItems: "center", gap: 4, textTransform: big ? "uppercase" : "none", letterSpacing: big ? "0.08em" : 0 }}>
        {dot && <span class={`dot ${dot}`} style={{ width: 6, height: 6 }} />}
        {label}
      </div>
    </button>
  );
}

// ── Warm pastel palette for cwd groups ────────────────────────────────────

const CWD_PALETTE: Array<{ bg: string; border: string; label: string }> = [
  { bg: "#fef3e2", border: "#f3d4a8", label: "#7c4a08" },   // cream
  { bg: "#fde6d3", border: "#f4c8a2", label: "#7d3f06" },   // peach
  { bg: "#fdedd3", border: "#f1d39c", label: "#76551a" },   // butter
  { bg: "#fce7e6", border: "#f0bdba", label: "#7e2924" },   // blush
  { bg: "#f9e3df", border: "#e9b6ae", label: "#75342a" },   // sand
  { bg: "#fbe6cc", border: "#eecca0", label: "#74471a" },   // apricot
  { bg: "#fff4dc", border: "#f0d9a4", label: "#6f4f12" },   // honey
  { bg: "#f7ede4", border: "#dec9b4", label: "#5a4838" },   // taupe
];

function colorForCwd(cwd: string) {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h * 31) + cwd.charCodeAt(i)) >>> 0;
  return CWD_PALETTE[h % CWD_PALETTE.length]!;
}

// ── Copy resume command ─────────────────────────────────────────────────────

// Copies `pnpm --dir D:\code\cc-hub cch claude -r <uuid>` so user can quickly
// re-arm a wrap session after killing it.
function CopyResumeButton({ sessionUuid, compact }: { sessionUuid: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  function handle(e: MouseEvent) {
    e.stopPropagation();
    if (!sessionUuid) return;
    const cmd = `pnpm --dir D:\\code\\cc-hub cch claude -r ${sessionUuid}`;
    void navigator.clipboard.writeText(cmd).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
      () => { /* clipboard perm denied — silent */ },
    );
  }
  const iconSize = compact ? 11 : 13;
  return (
    <button
      class="btn-ghost icon-btn"
      style={{ padding: compact ? "3px 6px" : "4px 8px" }}
      onClick={handle}
      title={`複製重啟指令：pnpm --dir D:\\code\\cc-hub cch claude -r ${sessionUuid}`}
      disabled={!sessionUuid}
    >{copied ? <IconCheck size={iconSize} /> : <IconCopy size={iconSize} />}</button>
  );
}

// ── Client type toggle badge ───────────────────────────────────────────────

function ClientTypeBadge({ type, onToggle, size = "sm" }: {
  type: ClientType;
  onToggle: () => void;
  size?: "sm" | "md";
}) {
  const isCli = type === "cli";
  const label = isCli ? "📟 CLI" : "🖥️ VSCode";
  const title = isCli
    ? "標記為 CLI session — 預填送出已停用（URI handler 不支援 terminal）。點一下改回 VSCode。"
    : "標記為 VSCode session — 點一下改成 CLI。";
  return (
    <button
      class={"client-badge" + (isCli ? " client-badge-cli" : " client-badge-vscode") + (size === "md" ? " client-badge-md" : "")}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={title}
    >{label}</button>
  );
}

// ── Permission mode badge (only for wrapped CLI sessions) ─────────────────
// Shown next to the wrapped badge. Mode is set at `cch claude` startup via
// --permission-mode / --bypass-permissions and locked for the session lifetime
// (SDK has no mid-session toggle). Default mode → no badge.

function PermissionModeBadge({ mode, size = "sm" }: { mode: NonNullable<Session["permission_mode"]>; size?: "sm" | "md" }) {
  if (!mode || mode === "default") return null as any;
  const config: Record<string, { label: string; cls: string; title: string }> = {
    acceptEdits: {
      label: "✏️ auto edit",
      cls: "pmode-badge-auto",
      title: "Auto-accept edits mode：所有 edit/write 直接套用、不再確認。`cch claude --permission-mode acceptEdits` 啟動鎖定。",
    },
    bypassPermissions: {
      label: "⚠️ bypass",
      cls: "pmode-badge-bypass",
      title: "Bypass permissions：所有工具都不問就執行。極度危險，僅在 sandbox 使用。`cch claude --bypass-permissions` 啟動鎖定。",
    },
    plan: {
      label: "📋 plan",
      cls: "pmode-badge-plan",
      title: "Plan mode：只規劃、不執行 mutation 類工具。`cch claude --permission-mode plan` 啟動鎖定。",
    },
  };
  const cfg = config[mode];
  if (!cfg) return null as any;
  return (
    <span
      class={"client-badge " + cfg.cls + (size === "md" ? " client-badge-md" : "")}
      title={cfg.title}
    >{cfg.label}</span>
  );
}

// Small chip variant used in cell-foot — shows mode (including "default")
// so users always have a visible signal that wrapped + know which mode.
// Click to open a small menu and switch mode via POST /wrap/permission-mode.
// Icons + labels mirror Claude Code's VSCode native mode picker so the UI feels familiar.
type PMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto";

// Inline SVG icons (1em × 1em, currentColor) — line-style to match VSCode picker.
function PModeIcon({ mode }: { mode: PMode }) {
  const common = { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" as const, "stroke-linejoin": "round" as const };
  switch (mode) {
    case "default":  // Ask before edits — open hand / stop palm
      return (
        <svg {...common}>
          <path d="M11 12.5V5a1.7 1.7 0 0 0-3.4 0v8.5" />
          <path d="M11 14V3.5a1.7 1.7 0 0 1 3.4 0V14" />
          <path d="M14.4 13V6a1.7 1.7 0 0 1 3.4 0v8" />
          <path d="M17.8 11.5a1.7 1.7 0 1 1 3.4 0V15a8 8 0 0 1-8 8h-2a4 4 0 0 1-4-4v-2.5a2 2 0 0 1 1.4-1.9" />
        </svg>
      );
    case "acceptEdits":  // Edit automatically — </>
      return (
        <svg {...common}>
          <polyline points="9 6 3 12 9 18" />
          <polyline points="15 6 21 12 15 18" />
        </svg>
      );
    case "plan":  // Plan mode — document with lines
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="9" y1="12" x2="15" y2="12" />
          <line x1="9" y1="16" x2="13" y2="16" />
        </svg>
      );
    case "auto":  // Auto mode — lightning bolt
      return (
        <svg {...common}>
          <polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2" />
        </svg>
      );
    case "bypassPermissions":  // Bypass permissions — broken chain link
      return (
        <svg {...common}>
          <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
          <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
        </svg>
      );
  }
}

// Inline styles for the send-button border/color per mode. We use inline style
// (not a class) so :hover rules on .cell-send-btn don't fight back — inline
// `borderColor` wins and the mode signal stays consistent on hover.
const PMODE_BTN_STYLE: Record<PMode, { borderColor: string; color: string; background: string }> = {
  default:           { borderColor: "rgba(120,130,150,0.45)", color: "#60646c", background: "rgba(120,130,150,0.10)" },
  acceptEdits:       { borderColor: "rgba(40,140,100,0.45)",  color: "#1f7a4d", background: "rgba(40,140,100,0.12)" },
  plan:              { borderColor: "rgba(40,110,200,0.45)",  color: "#2c5fa8", background: "rgba(40,110,200,0.12)" },
  auto:              { borderColor: "rgba(170,110,220,0.45)", color: "#7b3fb8", background: "rgba(170,110,220,0.12)" },
  bypassPermissions: { borderColor: "rgba(200,50,40,0.50)",   color: "#b3261e", background: "rgba(200,50,40,0.12)" },
};

const PMODE_CONFIG: Record<PMode, { short: string; menuLabel: string; menuDesc: string; cls: string; title: string }> = {
  default: {
    short: "ask",
    menuLabel: "Ask before edits",
    menuDesc: "每次 edit 都問你",
    cls: "pmode-chip-default",
    title: "Ask before edits：每個 mutation 工具會問你。",
  },
  acceptEdits: {
    short: "edit auto",
    menuLabel: "Edit automatically",
    menuDesc: "Edit / write 直接套用",
    cls: "pmode-chip-auto",
    title: "Edit automatically：所有 edit/write 直接套用、不再確認。",
  },
  plan: {
    short: "plan",
    menuLabel: "Plan mode",
    menuDesc: "只規劃、不動檔案",
    cls: "pmode-chip-plan",
    title: "Plan mode：只規劃、不執行 mutation 類工具。",
  },
  auto: {
    short: "auto",
    menuLabel: "Auto mode",
    menuDesc: "Claude 自己挑 mode",
    cls: "pmode-chip-autopick",
    title: "Auto mode：Claude 自動依任務選最適合的 mode。",
  },
  bypassPermissions: {
    short: "bypass",
    menuLabel: "Bypass permissions",
    menuDesc: "全部工具直接跑（危險）",
    cls: "pmode-chip-bypass",
    title: "Bypass permissions：所有工具都不問就執行。極度危險，只在 sandbox 使用。",
  },
};
function PermissionModeChip({ sessionUuid, mode }: { sessionUuid: string | null; mode: PMode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const cfg = PMODE_CONFIG[mode] ?? PMODE_CONFIG.default;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  async function pick(next: PMode) {
    if (!sessionUuid || pending || next === mode) { setOpen(false); return; }
    setPending(next); setErr(null);
    try {
      const r = await fetch("/wrap/permission-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: sessionUuid, mode: next }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body?.error ?? `HTTP ${r.status}`);
      } else {
        // Daemon will push session_changed once wrap acks → UI updates automatically.
        setOpen(false);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setPending(null);
    }
  }

  // stopPropagation on every interactive handler so clicks never bubble up to
  // the cell's onOpenModal — otherwise the big modal opens and visually masks
  // the dropdown (modal z=60 > menu z=30) and it looks like nothing happened.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div ref={ref} class="pmode-chip-wrap" onClick={stop} onMouseDown={stop}>
      <button
        class="pmode-chip pmode-chip-neutral"
        title={cfg.title + " · 點一下切換 mode"}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onMouseDown={stop}
        disabled={!sessionUuid}
      >
        <PModeIcon mode={pending ?? mode} />
        <span>{pending ? `${PMODE_CONFIG[pending].short}…` : cfg.short}</span>
      </button>
      {open && (
        <div class="pmode-menu" onClick={stop} onMouseDown={stop}>
          <div class="pmode-menu-head">Modes</div>
          {(["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as PMode[]).map((m) => (
            <button
              key={m}
              class={"pmode-menu-item " + (m === mode ? "is-current" : "") + " " + PMODE_CONFIG[m].cls}
              onClick={(e) => { e.stopPropagation(); pick(m); }}
              onMouseDown={stop}
              disabled={!!pending}
              title={PMODE_CONFIG[m].title}
            >
              <span class="pmode-menu-icon"><PModeIcon mode={m} /></span>
              <div class="pmode-menu-text">
                <div class="pmode-menu-label">{PMODE_CONFIG[m].menuLabel}</div>
                <div class="pmode-menu-desc">{PMODE_CONFIG[m].menuDesc}</div>
              </div>
              {m === mode && <span class="pmode-check">✓</span>}
            </button>
          ))}
          {err && <div class="pmode-err">{err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Grid overview cell ────────────────────────────────────────────────────

function Cell({ s, preview, activity, clientType, onSetClientType, onQuickSend, onOpenTab, onOpenModal }: {
  s: Session;
  preview?: SessionPreview;
  activity?: string;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenTab: (uuid: string) => void;
  onOpenModal: (s: Session) => void;
}) {
  const title = preview?.ai_title ?? s.project_name;
  const lastUserRaw = preview?.last_user_text;
  const lastAssistantRaw = preview?.last_assistant_text;
  const lastTool = preview?.last_tool_use ?? null;
  const lastUser = useMemo(() => (lastUserRaw ? mdToPlainText(lastUserRaw) : ""), [lastUserRaw]);
  const lastAssistant = useMemo(() => (lastAssistantRaw ? mdToPlainText(lastAssistantRaw) : ""), [lastAssistantRaw]);
  const c = colorForCwd(s.cwd);

  // Flash whole card light-yellow when AI is genuinely idle waiting for user.
  // Two-stage timer to avoid false flashes from transient stops (sub-agent
  // finishing, multi-step assistant pausing for a beat, etc.):
  //   1. Enter waiting   → arm 10s timer
  //   2. Still waiting after 10s → START flashing for 10s
  //   3. Status leaves waiting at any point → cancel + stop
  const [flashing, setFlashing] = useState(false);
  const prevStatusRef = useRef(s.status);
  const armTimerRef = useRef<number | undefined>(undefined);
  const flashTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = s.status;

    function clearAll() {
      if (armTimerRef.current) { window.clearTimeout(armTimerRef.current); armTimerRef.current = undefined; }
      if (flashTimerRef.current) { window.clearTimeout(flashTimerRef.current); flashTimerRef.current = undefined; }
    }

    // Any transition AWAY from waiting kills both the pending arm and the active flash.
    if (prev === "waiting" && s.status !== "waiting") {
      clearAll();
      setFlashing(false);
      return;
    }

    // Enter waiting → arm a 10s timer; only after it survives, start the flash.
    if (prev !== "waiting" && s.status === "waiting") {
      clearAll();
      armTimerRef.current = window.setTimeout(() => {
        armTimerRef.current = undefined;
        setFlashing(true);
        flashTimerRef.current = window.setTimeout(() => {
          flashTimerRef.current = undefined;
          setFlashing(false);
        }, 10000);
      }, 10000);
    }
  }, [s.status]);

  // Cleanup any pending timers on unmount.
  useEffect(() => () => {
    if (armTimerRef.current) window.clearTimeout(armTimerRef.current);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
  }, []);

  // Brief blue flash whenever the preview's per-turn timestamps change —
  // i.e. a new user/assistant/tool turn was just picked up by /sessions/previews.
  // Skip the initial mount so we don't flash every card on page load.
  const [updateFlash, setUpdateFlash] = useState(false);
  const prevTsKeyRef = useRef<string | null>(null);
  const updateFlashTimerRef = useRef<number | undefined>(undefined);
  const tsKey = `${preview?.last_user_ts ?? ""}|${preview?.last_assistant_ts ?? ""}|${preview?.last_tool_use_ts ?? ""}`;
  useEffect(() => {
    const prev = prevTsKeyRef.current;
    prevTsKeyRef.current = tsKey;
    // First render (prev === null) → just record, don't flash
    if (prev === null) return;
    if (prev === tsKey) return;
    if (updateFlashTimerRef.current) window.clearTimeout(updateFlashTimerRef.current);
    setUpdateFlash(true);
    updateFlashTimerRef.current = window.setTimeout(() => {
      setUpdateFlash(false);
      updateFlashTimerRef.current = undefined;
    }, 1200);
  }, [tsKey]);
  useEffect(() => () => {
    if (updateFlashTimerRef.current) window.clearTimeout(updateFlashTimerRef.current);
  }, []);

  const USER_MAX = 140;
  const ASSISTANT_MAX = 260;

  return (
    <div
      class={"cell cell-clickable" + (flashing ? " cell-flash" : "") + (updateFlash ? " cell-flash-update" : "")}
      style={{ borderTop: `3px solid ${STATUS_BORDER_COLOR[s.status]}` }}
      onClick={() => onOpenModal(s)}
    >
      <div class="cell-head">
        <span class="cell-title" title={title}>{title}</span>
        {activity && (
          <span class="cell-activity" title={`wrapper 正在: ${activity}`}>
            <span class="cell-activity-dot" /> {activity}…
          </span>
        )}
        <CopyResumeButton sessionUuid={s.session_uuid ?? ""} compact />
        <button
          class="cell-open-tab icon-btn"
          onClick={(e) => { e.stopPropagation(); onOpenTab(s.session_uuid ?? ""); }}
          title="開到 tab"
        ><IconExternalLink size={12} /></button>
      </div>
      <div class="cell-cwd" style={{ color: c.label, display: "flex", alignItems: "center", gap: 6 }} title={s.cwd}>
        <strong style={{ fontWeight: 600 }}>{s.project_name}</strong>
        {s.wrapped ? (
          // Wrapped session: it's inherently CLI + we own it. One badge says it all.
          <span class="client-badge client-badge-wrap" title="這個 session 被 `cch claude` wrapper 接管（CLI session）— 送出走 push、不再 spawn / 不花 $$">🔌 wrapped</span>
        ) : (
          <ClientTypeBadge
            type={clientType}
            onToggle={() => onSetClientType(s.session_uuid ?? "", clientType === "cli" ? "vscode" : "cli")}
          />
        )}
      </div>
      <div class="cell-preview cell-convo">
        {!lastUser && !lastAssistant && !lastTool ? (
          <span class="cell-empty">(尚未開始對話)</span>
        ) : (
          <>
            {lastTool && (
              <div class="cell-turn cell-turn-tool" title={lastTool.description || lastTool.name}>
                <div class="cell-turn-role">
                  <span>🔧 tool</span>
                  {preview?.last_tool_use_ts && <span class="cell-turn-ts" title={preview.last_tool_use_ts}>{fmtTurnTs(preview.last_tool_use_ts)}</span>}
                </div>
                <div class="cell-turn-body">
                  <strong style={{ fontWeight: 600 }}>{lastTool.name}</strong>
                  {lastTool.description && (
                    <span style={{ color: "var(--fg-subtle)" }}> · {lastTool.description}</span>
                  )}
                </div>
              </div>
            )}
            {lastAssistant && (
              <div class="cell-turn cell-turn-assistant">
                <div class="cell-turn-role">
                  <span>assistant</span>
                  {preview?.last_assistant_ts && <span class="cell-turn-ts" title={preview.last_assistant_ts}>{fmtTurnTs(preview.last_assistant_ts)}</span>}
                </div>
                <div class="cell-turn-body">{lastAssistant.slice(0, ASSISTANT_MAX)}{lastAssistant.length > ASSISTANT_MAX ? "…" : ""}</div>
              </div>
            )}
            {lastUser && (
              <div class="cell-turn cell-turn-user">
                <div class="cell-turn-role">
                  <span>user</span>
                  {preview?.last_user_ts && <span class="cell-turn-ts" title={preview.last_user_ts}>{fmtTurnTs(preview.last_user_ts)}</span>}
                </div>
                <div class="cell-turn-body">{lastUser.slice(0, USER_MAX)}{lastUser.length > USER_MAX ? "…" : ""}</div>
              </div>
            )}
          </>
        )}
      </div>
      <div class="cell-foot">
        <span class="cell-status">{STATUS_LABEL[s.status]}</span>
        <span>·</span>
        <span>{fmtRelative(s.last_event_at)}</span>
        {s.wrapped && <PermissionModeChip sessionUuid={s.session_uuid} mode={s.permission_mode ?? "default"} />}
        <button
          class="cell-send-btn icon-btn"
          style={s.wrapped ? PMODE_BTN_STYLE[s.permission_mode ?? "default"] : undefined}
          onClick={(ev) => { ev.stopPropagation(); onQuickSend(s, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY); }}
          title="快速送出（彈出小卡片，不展開 transcript）"
        ><IconSend size={12} /></button>
      </div>
    </div>
  );
}

// ── Grid overview (sessions grouped by cwd) ──────────────────────────

function GridOverview({ sessions, previews, activities, getClientType, onSetClientType, onQuickSend, onOpenTab, onOpenModal }: {
  sessions: Session[];
  previews: Record<string, SessionPreview>;
  activities: Record<string, string>;
  getClientType: (uuid: string | null | undefined) => ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenTab: (uuid: string) => void;
  onOpenModal: (s: Session) => void;
}) {
  // Stable layout: each session is assigned a slot index the first time we see
  // its key, and that index never changes for the lifetime of this tab. New
  // sessions append at the end, existing sessions never reshuffle on WS update.
  // A session that disappears keeps its slot reserved (cheap; ~bytes per entry)
  // so if it comes back the layout stays the same.
  const slotRef = useRef<Map<string, number>>(new Map());
  let nextSlot = slotRef.current.size;
  for (const s of sessions) {
    const key = s.session_uuid ?? s.cwd;
    if (!slotRef.current.has(key)) slotRef.current.set(key, nextSlot++);
  }
  const ordered = [...sessions].sort((a, b) => {
    const ai = slotRef.current.get(a.session_uuid ?? a.cwd) ?? 0;
    const bi = slotRef.current.get(b.session_uuid ?? b.cwd) ?? 0;
    return ai - bi;
  });
  return (
    <div class="cwd-group-grid">
      {ordered.map((s) => (
        <Cell
          key={s.session_uuid ?? s.cwd}
          s={s}
          preview={s.session_uuid ? previews[s.session_uuid] : undefined}
          activity={s.session_uuid ? activities[s.session_uuid] : undefined}
          clientType={getClientType(s.session_uuid)}
          onSetClientType={onSetClientType}
          onQuickSend={onQuickSend}
          onOpenTab={onOpenTab}
          onOpenModal={onOpenModal}
        />
      ))}
    </div>
  );
}

// ── Popover (quick-send at mouse position) ───────────────────────────

function Popover({ s, x, y, clientType, onSetClientType, onClose, onSend, onOpenTab, sendKey }: {
  s: Session;
  x: number;
  y: number;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onClose: () => void;
  onSend: (uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) => Promise<{ ok: boolean; status: number; reply?: string; duration_ms?: number; error?: string }>;
  onOpenTab: (uuid: string) => void;
  sendKey: SendKey;
}) {
  const isCli = clientType === "cli";
  const isWrapped = !!s.wrapped;
  // Only wrapped CLI sessions allow send. VSCode-panel mode is disabled
  // (claude-code creates fresh empty panel when uuid not in its sessionPanels).
  // Wrap-push is the only reliable delivery path.
  const sendBlocked = !isWrapped;
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  // VSCode: prefill (free). Wrapped: server routes ANY mode through wrap WS push, so mode doesn't matter.
  const [submitMode, setSubmitMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; label: string; reply?: string } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Images only travel through wrap-push. Warn user when in any other mode.
  const imagesSupported = isWrapped;

  // Position: open below-right of cursor, but clamp to viewport
  const popW = 360, popH = 280;
  const px = Math.min(x + 12, window.innerWidth - popW - 16);
  const py = Math.min(y + 12, window.innerHeight - popH - 16);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSend() {
    const hasText = !!prompt.trim();
    const hasImages = images.length > 0;
    if ((!hasText && !hasImages) || !s.session_uuid) return;
    setBusy(true); setResult(null);
    try {
      // Drop images on paths that can't carry them.
      const sendImages = imagesSupported ? images : undefined;
      const r = await onSend(s.session_uuid, prompt.trim(), submitMode, sendImages);
      if (r.ok) {
        // Success → close popover and return to dashboard. No need to flash a
        // result here; the dashboard card will reflect the new state.
        setPrompt(""); setImages([]);
        onClose();
        return;
      }
      const label = `失敗 HTTP ${r.status}`;
      setResult({ ok: r.ok, label, reply: r.reply });
    } finally { setBusy(false); }
  }

  async function handlePaste(e: ClipboardEvent) {
    const got = await extractImagesFromClipboard(e);
    if (got.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...got]);
    }
    // else: let default text paste happen
  }

  return (
    <>
      <div class="popover-backdrop" onClick={onClose} />
      <div
        ref={popRef}
        class="popover"
        style={{ left: px, top: py }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span class={STATUS_DOT[s.status]} />
          <strong style={{ fontSize: 13 }}>{s.project_name}</strong>
          {s.wrapped ? (
            <span class="client-badge client-badge-wrap" title="wrapper 接管中（CLI session）">🔌 wrapped</span>
          ) : (
            <ClientTypeBadge
              type={clientType}
              onToggle={() => onSetClientType(s.session_uuid ?? "", isCli ? "vscode" : "cli")}
            />
          )}
          <button
            class="btn-ghost icon-btn"
            style={{ marginLeft: "auto", padding: "4px 8px" }}
            onClick={() => { onOpenTab(s.session_uuid ?? ""); onClose(); }}
            title="開到 tab"
          ><IconExternalLink size={13} /></button>
          <button class="btn-ghost" style={{ padding: "2px 8px" }} onClick={onClose} title="關閉">×</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "ui-monospace, monospace", marginBottom: 8, wordBreak: "break-all" }}>
          {s.cwd}<br />
          {s.session_uuid}
        </div>
        <AttachedImageStrip images={images} onRemove={(i) => setImages((prev) => prev.filter((_, j) => j !== i))} dimmed={!imagesSupported && images.length > 0} />
        {!imagesSupported && images.length > 0 && (
          <div style={{ fontSize: 10, color: "var(--warn)", marginBottom: 4 }}>
            ⚠️ 圖片在這個 session 模式下會被忽略（只有 wrapped 才能傳圖）
          </div>
        )}
        <textarea
          autoFocus
          placeholder={
            sendBlocked
              ? (isCli
                  ? `CLI session 沒接管 — 先在 terminal 跑：cch claude -r ${s.session_uuid?.slice(0, 8)}…`
                  : `VSCode panel mode 已停用 — 請改 wrap：cch claude -r ${s.session_uuid?.slice(0, 8)}…`)
              : "輸入 prompt（Ctrl+V 可貼圖）→ push 進 wrapper 的 query()…"
          }
          value={prompt}
          onInput={(e) => setPrompt((e.currentTarget as HTMLTextAreaElement).value)}
          onPaste={(e) => { void handlePaste(e as unknown as ClipboardEvent); }}
          onKeyDown={(e) => {
            if (shouldSendOnKey(e as unknown as KeyboardEvent, sendKey)) {
              e.preventDefault();
              if (!busy && !sendBlocked && prompt.trim()) handleSend();
            }
          }}
          disabled={busy || sendBlocked}
          style={{ width: "100%", minHeight: 80, fontSize: 13, fontFamily: "inherit", marginBottom: 8 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            class={isWrapped ? "btn-primary" : "btn-ghost"}
            disabled={!prompt.trim() || busy || sendBlocked}
            onClick={handleSend}
            style={{ marginLeft: "auto" }}
            title={sendBlocked ? "請先 `cch claude -r <uuid>` 接管 (wrap-cli)" : "走 wrap WS push 進 terminal 的 query()"}
          >
            {busy ? "⌛" : isWrapped ? "送出 🔌" : "送出 (需 wrap)"}
          </button>
        </div>
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--fg-subtle)" }}>
          {sendBlocked
            ? (isCli
                ? <>📟 <strong>CLI session 沒接管</strong>：terminal 那個 <code>claude</code> 是封閉 process、外面塞不進去。請先停掉、改用 <code>cch claude -r {s.session_uuid?.slice(0, 8)}…</code> 接管，這邊就能即時送 prompt 進去（免費、無 resume marker）。</>
                : <>🖥️ <strong>VSCode panel mode 已停用</strong>：claude-code 不給「按 UUID 載入 session」的 API。請改 wrap：<code>cch claude -r {s.session_uuid?.slice(0, 8)}…</code> 接管後就能送（免費、無 resume marker）。</>)
            : <>🔌 <strong>wrapped</strong>：訊息直接 push 進你 terminal 的長壽 query() — 不 spawn 新 process、cache 全熱、沒 API 費用、不會出現「Continue from where you left off」。</>}
          <br />{sendKey === "enter" ? "Enter 送出 · Shift+Enter 換行" : "⌘/Ctrl+Enter 送出 · Enter 換行"} · Esc 關閉
        </div>
        {result && (
          <div style={{ marginTop: 8, padding: 8, background: "var(--sl2)", border: "1px solid var(--border)", borderRadius: 6 }}>
            <div style={{ fontSize: 12, color: result.ok ? "var(--pass)" : "var(--accent)", marginBottom: result.reply ? 6 : 0 }}>
              {result.label}
            </div>
            {result.reply && <div style={{ maxHeight: 160, overflowY: "auto" }}><MD text={result.reply} /></div>}
          </div>
        )}
      </div>
    </>
  );
}

// ── Activity log ───────────────────────────────────────────────────────────

function ActivityLog({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  return (
    <section class="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
        <span class="section-label">活動紀錄</span>
        <span style={{ marginLeft: 8, color: "var(--fg-subtle)", fontSize: 11 }}>同步輸出到 F12 Console</span>
        <button class="btn-ghost" style={{ marginLeft: "auto" }} onClick={onClear}>清空</button>
      </div>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {entries.length === 0 && (
          <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>尚無活動，按任何按鈕或等 hook 事件就會冒出來。</div>
        )}
        {entries.map((e, i) => (
          <div key={i} class={`log-entry log-entry-${e.level}`}>
            <span class="log-time">{fmtTime(e.ts)}</span>{" "}
            {e.msg}
            {e.ctx && <span class="log-ctx"> {JSON.stringify(e.ctx)}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Cell modal (tall overlay) ─────────────────────────────────────────────
// Triggered by clicking a dashboard cell. Renders the full Card (transcript +
// composer) in a centered modal. Closes on backdrop click, Esc key, or after
// a successful send (via Card's onAfterSend hook).

function CellModal({ s, onClose, clientType, onSetClientType, onFocus, onSend, sendKey }: {
  s: Session;
  onClose: () => void;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onFocus: (uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number; diag?: string; error?: string }>;
  sendKey: SendKey;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="cell-modal-backdrop" onClick={onClose}>
      <div class="cell-modal" onClick={(e) => e.stopPropagation()}>
        <button class="cell-modal-close" onClick={onClose} title="關閉 (Esc)">×</button>
        <Card
          s={s}
          defaultExpanded={true}
          clientType={clientType}
          onSetClientType={onSetClientType}
          onFocus={onFocus}
          onSend={onSend}
          sendKey={sendKey}
          modalMode={true}
          onAfterSend={onClose}
        />
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────

// Manual per-session "is this a CLI or VSCode session?" flag. Stored in
// localStorage so the choice persists across page reloads. Daemon doesn't
// know the difference yet — this is a user-controlled toggle for now.
type ClientType = "vscode" | "cli";
const CLIENT_TYPE_LS_KEY = "cc-hub:client-types";
function loadClientTypesFromLS(): Record<string, ClientType> {
  try {
    const raw = localStorage.getItem(CLIENT_TYPE_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ClientType>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}
function saveClientTypesToLS(map: Record<string, ClientType>) {
  try { localStorage.setItem(CLIENT_TYPE_LS_KEY, JSON.stringify(map)); } catch { /* quota / disabled */ }
}

// Global send-key preference: Enter vs Ctrl/Cmd+Enter to submit prompt.
// Applies to both Card composer (tab view) and Popover (dashboard quick-send).
// Default = "ctrl-enter" to preserve previous behavior; Enter is opt-in.
type SendKey = "enter" | "ctrl-enter";
const SEND_KEY_LS_KEY = "cc-hub:send-key";
function loadSendKeyFromLS(): SendKey {
  try {
    const raw = localStorage.getItem(SEND_KEY_LS_KEY);
    return raw === "enter" ? "enter" : "ctrl-enter";
  } catch { return "ctrl-enter"; }
}
function saveSendKeyToLS(v: SendKey) {
  try { localStorage.setItem(SEND_KEY_LS_KEY, v); } catch { /* quota / disabled */ }
}

// Shared keydown handler — decides whether Enter (or Ctrl/Cmd+Enter) should
// trigger send, based on the user's global preference. Skips IME composition.
// In "enter" mode: Shift+Enter → newline, Ctrl/Cmd+Enter still sends (escape hatch).
// In "ctrl-enter" mode: bare Enter → newline, Ctrl/Cmd+Enter sends.
function shouldSendOnKey(e: KeyboardEvent, mode: SendKey): boolean {
  if (e.key !== "Enter") return false;
  if ((e as any).isComposing || e.keyCode === 229) return false;
  const isMod = e.metaKey || e.ctrlKey;
  if (mode === "enter") {
    if (e.shiftKey) return false;
    return true;
  }
  return isMod;
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  // Live activity label per wrapped session ("Ideating" / "Using Bash" / null).
  const [activities, setActivities] = useState<Record<string, string>>({});
  // Pending AskUserQuestion per session — Claude is waiting for a pick.
  const [asks, setAsks] = useState<Record<string, PendingAsk>>({});
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [clientTypes, setClientTypesState] = useState<Record<string, ClientType>>(() => loadClientTypesFromLS());
  const [sendKey, setSendKeyState] = useState<SendKey>(() => loadSendKeyFromLS());
  const [showSettings, setShowSettings] = useState(false);
  const [modalFor, setModalFor] = useState<Session | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  function setSendKey(v: SendKey) {
    setSendKeyState(v);
    saveSendKeyToLS(v);
  }
  function openCellModal(s: Session) {
    setModalFor(s);
  }
  function closeCellModal() {
    setModalFor(null);
  }

  function setClientType(uuid: string, type: ClientType) {
    if (!uuid) return;
    setClientTypesState((prev) => {
      const next = { ...prev, [uuid]: type };
      saveClientTypesToLS(next);
      return next;
    });
  }
  function getClientType(uuid: string | null | undefined): ClientType {
    if (!uuid) return "vscode";
    // Wrapped sessions are always CLI by definition (the wrapper is the CLI host).
    // The manual toggle becomes irrelevant — we hard-override to "cli" so the
    // prefill-send / focus disabling kicks in automatically.
    const s = sessions.find((x) => x.session_uuid === uuid);
    if (s?.wrapped) return "cli";
    return clientTypes[uuid] ?? "vscode";
  }

  // Tabs: "overview" or session_uuid. Order = open order; "overview" always first.
  const [openTabs, setOpenTabs] = useState<string[]>(["overview"]);
  const [currentTab, setCurrentTab] = useState<string>("overview");

  // Popover state
  const [popoverFor, setPopoverFor] = useState<{ s: Session; x: number; y: number } | null>(null);

  function addLog(level: LogEntry["level"], msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx };
    setLog((prev) => [entry, ...prev].slice(0, ACT_LOG_MAX));
    (level === "error" ? cerr : level === "warn" ? cwarn : clog)(msg, ctx);
  }

  async function loadPreviews() {
    try {
      const r = await fetch("/sessions/previews");
      if (!r.ok) { addLog("warn", `GET /sessions/previews ${r.status}`); return; }
      const arr: SessionPreview[] = await r.json();
      const map: Record<string, SessionPreview> = {};
      for (const p of arr) map[p.session_uuid] = p;
      setPreviews(map);
      addLog("info", `previews loaded`, { count: arr.length });
    } catch (e) {
      addLog("error", "previews fetch throw", { error: String(e) });
    }
  }

  useEffect(() => {
    addLog("info", "啟動 — 抓 /sessions + previews");
    fetch("/sessions").then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j })))
      .then((r) => {
        if (!r.ok) { addLog("error", `GET /sessions 失敗`, { status: r.status }); return; }
        const list = r.body as Session[];
        setSessions(list);
        // Seed activity map from /sessions payload so badges survive browser F5.
        const seed: Record<string, string> = {};
        const seedAsks: Record<string, PendingAsk> = {};
        for (const s of list) {
          if (s.session_uuid && s.activity) seed[s.session_uuid] = s.activity;
          if (s.session_uuid && s.pending_ask) seedAsks[s.session_uuid] = s.pending_ask;
        }
        if (Object.keys(seed).length > 0) setActivities(seed);
        if (Object.keys(seedAsks).length > 0) setAsks(seedAsks);
        addLog("info", `GET /sessions 200 — 收到 ${list.length} 個 session`);
        void loadPreviews();
      })
      .catch((e) => addLog("error", `GET /sessions throw`, { error: String(e) }));

    const wsUrl = `ws://${location.host}/ws`;
    addLog("info", "WS 連線中", { url: wsUrl });
    let currentSocket: WebSocket | null = null;
    let reconnectAttempts = 0;
    let cancelled = false;
    function connectWs(): void {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl);
      currentSocket = ws;
      ws.onopen = () => {
        setWsConn("open");
        if (reconnectAttempts > 0) {
          // Pick up anything we missed while disconnected — daemon may have
          // restarted, sessions may have changed status, new activities started.
          addLog("info", `WS reconnected after ${reconnectAttempts} attempt(s) — refetching state`);
          fetch("/sessions").then((r) => r.json()).then((list: Session[]) => {
            setSessions(list);
            const fresh: Record<string, string> = {};
            const freshAsks: Record<string, PendingAsk> = {};
            for (const s of list) {
              if (s.session_uuid && s.activity) fresh[s.session_uuid] = s.activity;
              if (s.session_uuid && s.pending_ask) freshAsks[s.session_uuid] = s.pending_ask;
            }
            setActivities(fresh);
            setAsks(freshAsks);
          }).catch(() => {});
          void loadPreviews();
        } else {
          addLog("info", "WS open");
        }
        reconnectAttempts = 0;
      };
      ws.onclose = (ev) => {
        setWsConn("closed");
        addLog("warn", "WS close", { code: ev.code });
        if (cancelled) return;
        reconnectAttempts++;
        // Backoff: 500ms → 1s → 2s → 4s → cap at 5s
        const delay = Math.min(500 * Math.pow(2, Math.min(reconnectAttempts - 1, 4)), 5000);
        setWsConn("connecting");
        setTimeout(connectWs, delay);
      };
      ws.onerror = () => { addLog("error", "WS error"); };
      ws.onmessage = handleWsMessage;
    }
    function handleWsMessage(ev: MessageEvent) {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.type === "session_changed") {
        const s = msg.session as Session;
        addLog("info", "WS session_changed", { project: s.project_name, status: s.status, uuid: s.session_uuid?.slice(0, 8) });
        setSessions((prev) => {
          const others = prev.filter((x) => x.session_uuid !== s.session_uuid);
          return [s, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
        // Debounced previews refresh: on every WS event, schedule a single refresh
        scheduleRefresh();
      } else if (msg.type === "session_removed") {
        const uuid = msg.session_uuid as string;
        addLog("info", "WS session_removed", { uuid: uuid.slice(0, 8) });
        setSessions((prev) => prev.filter((x) => x.session_uuid !== uuid));
        setActivities((prev) => { const next = { ...prev }; delete next[uuid]; return next; });
        // Also close the tab if it was open
        setOpenTabs((prev) => prev.filter((t) => t !== uuid));
        setCurrentTab((cur) => (cur === uuid ? "overview" : cur));
      } else if (msg.type === "activity") {
        const uuid = msg.session_uuid as string;
        const label = typeof msg.label === "string" ? msg.label : null;
        setActivities((prev) => {
          if (!label) { const next = { ...prev }; delete next[uuid]; return next; }
          if (prev[uuid] === label) return prev;
          return { ...prev, [uuid]: label };
        });
      } else if (msg.type === "ask_question") {
        const uuid = msg.session_uuid as string;
        const ask: PendingAsk = { question_id: msg.question_id, questions: msg.questions };
        setAsks((prev) => ({ ...prev, [uuid]: ask }));
      } else if (msg.type === "ask_question_done") {
        const uuid = msg.session_uuid as string;
        setAsks((prev) => { const next = { ...prev }; delete next[uuid]; return next; });
      }
    }
    connectWs();

    return () => {
      cancelled = true;
      if (currentSocket) currentSocket.close();
    };
  }, []);

  // Debounce previews refresh — many session_changed events in a row should batch
  const refreshTimerRef = useRef<number | undefined>(undefined);
  function scheduleRefresh() {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => { void loadPreviews(); }, 1500);
  }

  async function onFocus(uuid: string) {
    addLog("info", "POST /focus", { uuid: uuid.slice(0, 8) });
    try {
      const r = await fetch("/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/focus ${r.status}`, { url: body?.url });
      return { ok: r.ok, status: r.status, url: body?.url };
    } catch (e) { addLog("error", "/focus throw", { error: String(e) }); return { ok: false, status: 0 }; }
  }
  async function onSend(uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) {
    const imgPayload = images?.map(({ media_type, data }) => ({ media_type, data }));
    addLog("info", `POST /send (mode=${submit ? "submit" : "prefill"})`, { uuid: uuid.slice(0, 8), len: prompt.length, images: imgPayload?.length ?? 0 });
    try {
      const r = await fetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid, prompt, submit, images: imgPayload }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/send ${r.status}`, { mode: body?.mode, reply_preview: body?.reply?.slice(0, 60), duration_ms: body?.duration_ms, diag: body?.diag });
      // refresh previews so the cell shows the new reply
      if (r.ok && submit) scheduleRefresh();
      return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms, diag: body?.diag, error: body?.error };
    } catch (e) { addLog("error", "/send throw", { error: String(e) }); return { ok: false, status: 0 }; }
  }

  function openTab(uuid: string) {
    if (!uuid) return;
    setOpenTabs((prev) => prev.includes(uuid) ? prev : [...prev, uuid]);
    setCurrentTab(uuid);
  }
  function closeTab(uuid: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t !== uuid);
      // If closing current tab, switch to overview
      if (currentTab === uuid) setCurrentTab("overview");
      return next;
    });
  }

  function openQuickSend(s: Session, x: number, y: number) {
    setPopoverFor({ s, x, y });
  }

  const sessionByUuid = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) if (s.session_uuid) m.set(s.session_uuid, s);
    return m;
  }, [sessions]);

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", padding: "16px 24px 64px" }}>
      {/* Top nav */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)", position: "relative" }}>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>cc-hub</h1>
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>本機儀表板</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--fg-subtle)" }}>
          <span class={`dot ${wsConn === "open" ? "dot-active" : wsConn === "connecting" ? "dot-waiting" : "dot-stale"}`} style={{ width: 6, height: 6 }} />
          {wsConn === "open" ? "WS connected" : wsConn === "connecting" ? "connecting…" : "WS disconnected"}
          <button
            class="btn-ghost"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => setShowSettings((v) => !v)}
            title="設定"
          >⚙️ 設定</button>
        </div>
        {showSettings && (
          <div
            style={{
              position: "absolute", top: "100%", right: 0, marginTop: 6, zIndex: 50,
              background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "12px 14px", minWidth: 280, boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>送出鍵（全域）</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="cc-hub-send-key"
                  checked={sendKey === "enter"}
                  onChange={() => setSendKey("enter")}
                />
                <span><strong>Enter</strong> 送出 ·  Shift+Enter 換行</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="cc-hub-send-key"
                  checked={sendKey === "ctrl-enter"}
                  onChange={() => setSendKey("ctrl-enter")}
                />
                <span><strong>Ctrl/⌘ + Enter</strong> 送出 · Enter 換行</span>
              </label>
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 8, lineHeight: 1.5 }}>
              套用到 dashboard 快速送出視窗 + 每個 tab 的 composer。Enter 模式下仍可用 Ctrl/⌘+Enter 強制送出。
            </div>
            <div style={{ marginTop: 10, textAlign: "right" }}>
              <button class="btn-ghost" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setShowSettings(false)}>關閉</button>
            </div>
          </div>
        )}
      </header>

      {/* TabBar */}
      <div class="tabbar" style={{ marginTop: 0, marginBottom: 20 }}>
        {openTabs.map((tabId) => {
          if (tabId === "overview") {
            return (
              <div
                key="overview"
                class={"tab" + (currentTab === "overview" ? " active" : "")}
                onClick={() => setCurrentTab("overview")}
              >
                <span>🗺️ 全覽</span>
                <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{sessions.length}</span>
              </div>
            );
          }
          const s = sessionByUuid.get(tabId);
          const p = previews[tabId];
          const label = p?.ai_title || s?.project_name || tabId.slice(0, 8);
          return (
            <div
              key={tabId}
              class={"tab" + (currentTab === tabId ? " active" : "")}
              onClick={() => setCurrentTab(tabId)}
              title={tabId}
            >
              {s && <span class={STATUS_DOT[s.status]} style={{ width: 6, height: 6 }} />}
              <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              <span
                class="tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tabId); }}
                title="關閉 tab"
              >×</span>
            </div>
          );
        })}
      </div>

      {/* Tab content */}
      {currentTab === "overview" ? (
        <>
          <SummaryBanner sessions={sessions} filter={statusFilter} onFilter={setStatusFilter} />
          {sessions.length === 0 ? (
            <div class="card" style={{ padding: "24px 14px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
              <div>目前沒有 session。</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>在任何 VSCode 視窗開 Claude Code panel 就會冒出來。</div>
              <div style={{ fontSize: 11 }}>沒反應的話：<code>pnpm install:hooks</code></div>
            </div>
          ) : (
            <GridOverview
              sessions={sessions.filter((s) => {
                if (statusFilter === "all") return true;
                if (statusFilter === "live") return s.status === "active" || s.status === "waiting";
                return s.status === statusFilter;
              })}
              previews={previews}
              activities={activities}
              getClientType={getClientType}
              onSetClientType={setClientType}
              onQuickSend={openQuickSend}
              onOpenTab={openTab}
              onOpenModal={openCellModal}
            />
          )}
        </>
      ) : (
        (() => {
          const s = sessionByUuid.get(currentTab);
          if (!s) return <div style={{ padding: 24, color: "var(--fg-subtle)" }}>(session 不存在了，可能 daemon 重啟過)</div>;
          return <Card s={s} defaultExpanded={true} clientType={getClientType(s.session_uuid)} onSetClientType={setClientType} onFocus={onFocus} onSend={onSend} sendKey={sendKey} />;
        })()
      )}

      <ActivityLog entries={log} onClear={() => setLog([])} />

      {/* Popover */}
      {popoverFor && (
        <Popover
          s={popoverFor.s}
          x={popoverFor.x}
          y={popoverFor.y}
          clientType={getClientType(popoverFor.s.session_uuid)}
          onSetClientType={setClientType}
          onClose={() => setPopoverFor(null)}
          onSend={onSend}
          onOpenTab={openTab}
          sendKey={sendKey}
        />
      )}

      {/* Cell modal — tall overlay with full Card (transcript + composer) */}
      {modalFor && (
        <CellModal
          s={sessionByUuid.get(modalFor.session_uuid ?? "") ?? modalFor}
          onClose={closeCellModal}
          clientType={getClientType(modalFor.session_uuid)}
          onSetClientType={setClientType}
          onFocus={onFocus}
          onSend={onSend}
          sendKey={sendKey}
        />
      )}

      {/* AskUserQuestion modal — Claude is waiting for the user to pick options */}
      {(() => {
        const askUuid = Object.keys(asks)[0];  // show one at a time; most recent
        if (!askUuid) return null;
        const ask = asks[askUuid]!;
        const s = sessionByUuid.get(askUuid);
        return (
          <AskQuestionModal
            sessionUuid={askUuid}
            ask={ask}
            onSubmitted={() => {
              setAsks((prev) => { const next = { ...prev }; delete next[askUuid]; return next; });
              addLog("info", `ask answered`, { uuid: askUuid.slice(0, 8), project: s?.project_name });
            }}
            onDismiss={() => {
              // User closed without answering — keep state, they can also answer in terminal
              setAsks((prev) => { const next = { ...prev }; delete next[askUuid]; return next; });
            }}
          />
        );
      })()}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
