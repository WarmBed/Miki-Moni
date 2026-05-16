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
}

interface ToolUseInfo { id: string; name: string; description?: string; input: unknown; input_summary: string }
interface ToolResultInfo { tool_use_id?: string; content: string; truncated: boolean; is_error?: boolean }
interface TranscriptTurn { ts: string; role: "user" | "assistant"; text: string; tool_use?: ToolUseInfo; tool_result?: ToolResultInfo; raw_type?: string }
interface TranscriptResp { session_uuid: string; transcript_path: string; file_size: number; last_modified: string; turn_count: number; turns: TranscriptTurn[] }

interface LogEntry { ts: number; level: "info" | "warn" | "error"; msg: string; ctx?: Record<string, unknown> }

interface SessionPreview {
  session_uuid: string;
  ai_title: string | null;
  last_assistant_text: string | null;
  last_user_text: string | null;
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
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return md.replace(/\s+/g, " ").trim();
  }
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
  const roleLabel = isUser ? "user" : "assistant";
  const roleColor = isUser ? "var(--neutral)" : "var(--pass)";
  return (
    <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ color: roleColor, fontWeight: 600, fontSize: 12 }}>{roleLabel}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{fmtDateTime(t.ts)}</span>
        {t.tool_use && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>· 🔧 {t.tool_use.name}</span>
        )}
        {t.tool_result && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>· 📤 tool result</span>
        )}
      </div>
      {t.text && <MD text={t.text} />}
      {t.tool_use && <ToolUseBox t={t} />}
      {t.tool_result && <ToolResultBox t={t} />}
    </div>
  );
}

// ── Session card ───────────────────────────────────────────────────────────

type ActionResult = { ok: boolean; label: string; url?: string; reply?: string; durationMs?: number; ts: number } | null;

function Card({ s, defaultExpanded, onFocus, onSend }: {
  s: Session;
  defaultExpanded: boolean;
  onFocus: (uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (uuid: string, prompt: string, submit: boolean) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number }>;
}) {
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [draft, setDraft] = useState("");
  // Default = prefill (free, uses your already-running VSCode panel session).
  // 真送出 (-p headless) is OPT-IN — it spawns a NEW claude.exe that re-loads
  // the whole session context through cache → burns real $ for large sessions
  // BEFORE generating any token.
  const [submitMode, setSubmitMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusResult, setFocusResult] = useState<ActionResult>(null);
  const [sendResult, setSendResult] = useState<ActionResult>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptResp | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptLimit, setTranscriptLimit] = useState(20);
  const sessionUuid = s.session_uuid ?? "";

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
    if (!prompt) return;
    clog("click send", { cwd: s.cwd, uuid: sessionUuid, mode: submitMode ? "submit" : "prefill", len: prompt.length });
    setSendResult(null);
    setBusy(true);
    try {
      const r = await onSend(sessionUuid, prompt, submitMode);
      const label = !r.ok
        ? `失敗 HTTP ${r.status}`
        : submitMode
          ? `Claude 已回覆 (${r.duration_ms ?? "?"} ms)`
          : `已預填 · 請在 VSCode 按 Enter`;
      setSendResult({ ok: r.ok, label, url: r.url, reply: r.reply, durationMs: r.duration_ms, ts: Date.now() });
      setDraft("");
      // If we have transcript loaded and we just submitted, auto-refresh to show the new turn
      if (r.ok && submitMode && transcript) void loadTranscript();
    } finally {
      setBusy(false);
    }
    setTimeout(() => setSendResult(null), 60_000);
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
  return (
    <div class="card">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <span class={STATUS_DOT[s.status]} />
        <button
          class="btn-ghost"
          style={{ fontWeight: 600, fontSize: 15, padding: "2px 6px" }}
          onClick={handleFocus}
          title="叫起 VSCode 視窗（focus）"
        >{s.project_name}</button>
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{STATUS_LABEL[s.status]}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11, marginLeft: 8 }}>{fmtRelative(s.last_event_at)}</span>
        <button
          class="btn-ghost"
          style={{ marginLeft: "auto", fontSize: 11 }}
          onClick={handleFocus}
          title="同步 VSCode panel — 觸發 vscode:// URI handler 強制 extension 重新從 JSONL 讀 session（已開的 tab 可能只 refocus，請配合 Cmd/Ctrl+Shift+P → Developer: Reload Window 確保 hot-reload）"
        >🔄 同步</button>
        <button class="btn-ghost" onClick={() => setCollapsed(true)} title="收合">▴</button>
      </div>

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
        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            style={{ flex: 1, minHeight: 38, fontSize: 13 }}
            rows={2}
            placeholder={submitMode ? "輸入 prompt 真的送給這個 session（會花 API 費用）…" : "輸入 prompt 預填到 input box（不送出、零成本）…"}
            value={draft}
            onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
            disabled={busy}
          />
          <button
            class={submitMode ? "btn-warn" : "btn-primary"}
            disabled={!draft.trim() || busy}
            onClick={handleSend}
            title={submitMode ? "headless 模式：真的 submit + Claude 回應（花費 API$）" : "prefill 模式：只塞進 input box"}
          >
            {busy ? "⌛" : submitMode ? "真送出" : "預填"}
          </button>
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
          {submitMode ? (
            <>
              💸 <strong style={{ color: "var(--accent)" }}>真送出</strong>：spawn `claude -p` 新 process、重 load 整個 session cache、call API → 大 session 可能花 $2-5+。<br />
              <span style={{ color: "var(--warn)" }}>⚠️ Windows 限制：prompt 含中文/emoji 會被切碼，請用英文。</span>
            </>
          ) : (
            <>
              📥 <strong style={{ color: "var(--pass)" }}>預填</strong>：vscode:// URI 把 prompt 塞進你現有 VSCode panel 的 input box，<strong>你按 Enter</strong> → 走你 panel 已 loaded 的 session（cache 全熱、不重 load、近乎零成本）。
            </>
          )}
        </div>
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

        {/* Send result */}
        {sendResult && (
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, color: sendResult.ok ? "var(--pass)" : "var(--accent)" }}>
              送 prompt：{sendResult.label}
            </div>
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
          </div>
        )}
      </div>

      {/* Transcript */}
      <div style={{ borderTop: "1px solid var(--border)" }}>
        <button class="btn-ghost" style={{ width: "100%", justifyContent: "flex-start", padding: "8px 14px", borderRadius: 0 }} onClick={toggleTranscript}>
          {showTranscript ? "▾" : "▸"} 上下文 transcript
          {transcript && <span style={{ marginLeft: 8, color: "var(--fg-subtle)", fontSize: 11 }}>· {transcript.turn_count} 條 · {(transcript.file_size / 1024).toFixed(1)} KB</span>}
        </button>
        {showTranscript && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderTop: "1px solid var(--border)" }}>
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
              </select>
              <button class="btn-outline" style={{ height: 28, padding: "0 10px" }} onClick={() => loadTranscript(transcriptLimit)} disabled={transcriptLoading}>
                {transcriptLoading ? "讀取中…" : "重新讀取"}
              </button>
            </div>
            {transcriptError && (
              <div style={{ padding: "8px 14px", color: "var(--accent)", fontSize: 12 }}>{transcriptError}</div>
            )}
            {transcript && (
              <div style={{ maxHeight: 480, overflowY: "auto" }}>
                {transcript.turns.length === 0 && (
                  <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>(transcript 沒有可顯示的訊息)</div>
                )}
                {transcript.turns.map((t, i) => <TurnView key={i} t={t} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Summary banner ─────────────────────────────────────────────────────────

function SummaryBanner({ sessions }: { sessions: Session[] }) {
  const counts = sessions.reduce(
    (acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; },
    {} as Record<Session["status"], number>,
  );
  const total = sessions.length;
  return (
    <section style={{ marginBottom: 16, padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
      <div class="section-label" style={{ marginBottom: 8 }}>目前正在運行</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{total}</div>
          <div style={{ fontSize: 11, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "0.08em" }}>total</div>
        </div>
        <Stat n={counts.active ?? 0} label="進行中" dot="dot-active" />
        <Stat n={counts.waiting ?? 0} label="等回應" dot="dot-waiting" />
        <Stat n={counts.idle ?? 0} label="閒置" dot="dot-idle" />
        <Stat n={counts.stale ?? 0} label="已斷線" dot="dot-stale" />
      </div>
    </section>
  );
}

function Stat({ n, label, dot }: { n: number; label: string; dot: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: n === 0 ? "var(--fg-subtle)" : "var(--fg)" }}>{n}</div>
      <div style={{ fontSize: 11, color: "var(--fg-subtle)", display: "flex", alignItems: "center", gap: 4 }}>
        <span class={`dot ${dot}`} style={{ width: 6, height: 6 }} /> {label}
      </div>
    </div>
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

// ── Grid overview cell ────────────────────────────────────────────────────

function Cell({ s, preview, onQuickSend, onOpenTab, onSync }: {
  s: Session;
  preview?: SessionPreview;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenTab: (uuid: string) => void;
  onSync: (uuid: string) => void;
}) {
  const title = preview?.ai_title ?? s.project_name;
  const lastReplyRaw = preview?.last_assistant_text;
  const lastReply = useMemo(() => (lastReplyRaw ? mdToPlainText(lastReplyRaw) : ""), [lastReplyRaw]);
  const c = colorForCwd(s.cwd);

  function handleClick(ev: MouseEvent) {
    onQuickSend(s, ev.clientX, ev.clientY);
  }

  return (
    <div class="cell" onClick={handleClick} style={{ borderTop: `3px solid ${c.border}` }}>
      <div class="cell-head">
        <span class={STATUS_DOT[s.status]} />
        <span class="cell-title" title={title}>{title}</span>
        <button
          class="cell-open-tab"
          onClick={(e) => { e.stopPropagation(); onSync(s.session_uuid ?? ""); }}
          title="同步 VSCode panel（觸發 vscode:// URI handler 重讀 session）"
        >🔄</button>
        <button
          class="cell-open-tab"
          onClick={(e) => { e.stopPropagation(); onOpenTab(s.session_uuid ?? ""); }}
          title="開到 tab"
        >開 tab ↗</button>
      </div>
      <div class="cell-cwd" style={{ color: c.label }} title={s.cwd}>
        <strong style={{ fontWeight: 600 }}>{s.project_name}</strong>
        <span style={{ opacity: 0.7 }}> · {s.cwd}</span>
      </div>
      <div class="cell-preview">
        {lastReply
          ? lastReply.slice(0, 240) + (lastReply.length > 240 ? "…" : "")
          : <span class="cell-empty">(尚未有 AI 回應)</span>}
      </div>
      <div class="cell-foot">
        <span class="cell-status">{STATUS_LABEL[s.status]}</span>
        <span>·</span>
        <span>{fmtRelative(s.last_event_at)}</span>
      </div>
    </div>
  );
}

// ── Grid overview (sessions grouped by cwd) ──────────────────────────

function GridOverview({ sessions, previews, onQuickSend, onOpenTab, onSync }: {
  sessions: Session[];
  previews: Record<string, SessionPreview>;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenTab: (uuid: string) => void;
  onSync: (uuid: string) => void;
}) {
  // Flat list, newest first. No grouping.
  const ordered = [...sessions].sort((a, b) => b.last_event_at - a.last_event_at);
  return (
    <div class="cwd-group-grid">
      {ordered.map((s) => (
        <Cell
          key={s.session_uuid ?? s.cwd}
          s={s}
          preview={s.session_uuid ? previews[s.session_uuid] : undefined}
          onQuickSend={onQuickSend}
          onOpenTab={onOpenTab}
          onSync={onSync}
        />
      ))}
    </div>
  );
}

// ── Popover (quick-send at mouse position) ───────────────────────────

function Popover({ s, x, y, onClose, onSend, onOpenTab, onSync }: {
  s: Session;
  x: number;
  y: number;
  onClose: () => void;
  onSend: (uuid: string, prompt: string, submit: boolean) => Promise<{ ok: boolean; status: number; reply?: string; duration_ms?: number }>;
  onOpenTab: (uuid: string) => void;
  onSync: (uuid: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [submitMode, setSubmitMode] = useState(false);  // default = prefill (free)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; label: string; reply?: string } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

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
    if (!prompt.trim() || !s.session_uuid) return;
    setBusy(true); setResult(null);
    try {
      const r = await onSend(s.session_uuid, prompt.trim(), submitMode);
      const label = !r.ok
        ? `失敗 HTTP ${r.status}`
        : submitMode
          ? `Claude 已回覆 (${r.duration_ms ?? "?"} ms)`
          : `已預填，請在 VSCode 按 Enter`;
      setResult({ ok: r.ok, label, reply: r.reply });
      if (r.ok) setPrompt("");
    } finally { setBusy(false); }
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
          <button
            class="btn-ghost"
            style={{ marginLeft: "auto", padding: "2px 6px" }}
            onClick={() => onSync(s.session_uuid ?? "")}
            title="同步 VSCode panel"
          >🔄</button>
          <button class="btn-ghost" style={{ padding: "2px 6px" }} onClick={() => { onOpenTab(s.session_uuid ?? ""); onClose(); }}>
            開到 tab ↗
          </button>
          <button class="btn-ghost" style={{ padding: "2px 6px" }} onClick={onClose}>×</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "ui-monospace, monospace", marginBottom: 8, wordBreak: "break-all" }}>
          {s.cwd}<br />
          {s.session_uuid}
        </div>
        <textarea
          autoFocus
          placeholder={submitMode ? "輸入 prompt 真的送出（會花 API$）…" : "輸入 prompt 預填到 VSCode input box…"}
          value={prompt}
          onInput={(e) => setPrompt((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend(); }}
          disabled={busy}
          style={{ width: "100%", minHeight: 80, fontSize: 13, fontFamily: "inherit", marginBottom: 8 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            class="btn-ghost"
            style={{ fontSize: 10, padding: "2px 6px" }}
            onClick={() => setShowAdvanced((v) => !v)}
            title="切換到 -p headless 模式（會花錢）"
          >{showAdvanced ? "▾ adv" : "▸ adv"}</button>
          <button
            class={submitMode ? "btn-warn" : "btn-primary"}
            disabled={!prompt.trim() || busy}
            onClick={handleSend}
            style={{ marginLeft: "auto" }}
          >
            {busy ? "⌛" : submitMode ? "真送出 💸" : "預填"}
          </button>
        </div>
        {showAdvanced && (
          <label style={{ fontSize: 10, color: "var(--fg-subtle)", cursor: "pointer", marginTop: 4, display: "block" }}>
            <input type="checkbox" checked={submitMode} onChange={(e) => setSubmitMode((e.currentTarget as HTMLInputElement).checked)} style={{ marginRight: 4, verticalAlign: "middle" }} />
            真送出（spawn `claude -p`，重 load context 會花 $$）
          </label>
        )}
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--fg-subtle)" }}>
          {submitMode
            ? "💸 真送出：新 process、重 load cache、call API"
            : "📥 預填：餵進你 VSCode panel input box，按 Enter 由 panel 既有 session 處理（cache 熱、~free）"}
          <br />⌘/Ctrl+Enter 送出 · Esc 關閉
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

// ── App ────────────────────────────────────────────────────────────────────

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);

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
        addLog("info", `GET /sessions 200 — 收到 ${list.length} 個 session`);
        void loadPreviews();
      })
      .catch((e) => addLog("error", `GET /sessions throw`, { error: String(e) }));

    const wsUrl = `ws://${location.host}/ws`;
    addLog("info", "WS 連線中", { url: wsUrl });
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => { setWsConn("open"); addLog("info", "WS open"); };
    ws.onclose = (ev) => { setWsConn("closed"); addLog("warn", "WS close", { code: ev.code }); };
    ws.onerror = () => { addLog("error", "WS error"); };
    ws.onmessage = (ev) => {
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
      }
    };

    return () => ws.close();
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
  async function onSend(uuid: string, prompt: string, submit: boolean) {
    addLog("info", `POST /send (mode=${submit ? "submit" : "prefill"})`, { uuid: uuid.slice(0, 8), len: prompt.length });
    try {
      const r = await fetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid, prompt, submit }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/send ${r.status}`, { mode: body?.mode, reply_preview: body?.reply?.slice(0, 60), duration_ms: body?.duration_ms });
      // refresh previews so the cell shows the new reply
      if (r.ok && submit) scheduleRefresh();
      return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms };
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
      <header style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>cc-hub</h1>
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>本機儀表板</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-subtle)" }}>
          <span class={`dot ${wsConn === "open" ? "dot-active" : wsConn === "connecting" ? "dot-waiting" : "dot-stale"}`} style={{ width: 6, height: 6 }} />
          {wsConn === "open" ? "WS connected" : wsConn === "connecting" ? "connecting…" : "WS disconnected"}
        </div>
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
          <SummaryBanner sessions={sessions} />
          {sessions.length === 0 ? (
            <div class="card" style={{ padding: "24px 14px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
              <div>目前沒有 session。</div>
              <div style={{ fontSize: 11, marginTop: 6 }}>在任何 VSCode 視窗開 Claude Code panel 就會冒出來。</div>
              <div style={{ fontSize: 11 }}>沒反應的話：<code>pnpm install:hooks</code></div>
            </div>
          ) : (
            <GridOverview
              sessions={sessions}
              previews={previews}
              onQuickSend={openQuickSend}
              onOpenTab={openTab}
              onSync={(uuid) => { void onFocus(uuid); }}
            />
          )}
        </>
      ) : (
        (() => {
          const s = sessionByUuid.get(currentTab);
          if (!s) return <div style={{ padding: 24, color: "var(--fg-subtle)" }}>(session 不存在了，可能 daemon 重啟過)</div>;
          return <Card s={s} defaultExpanded={true} onFocus={onFocus} onSend={onSend} />;
        })()
      )}

      <ActivityLog entries={log} onClear={() => setLog([])} />

      {/* Popover */}
      {popoverFor && (
        <Popover
          s={popoverFor.s}
          x={popoverFor.x}
          y={popoverFor.y}
          onClose={() => setPopoverFor(null)}
          onSend={onSend}
          onOpenTab={openTab}
          onSync={(uuid) => { void onFocus(uuid); }}
        />
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
