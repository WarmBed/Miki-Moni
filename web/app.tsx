import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { marked } from "marked";
import { t, useLocale, setLocale as setLocaleGlobal, LOCALES, LOCALE_LABELS, type Locale } from "@shared/i18n";
import { apiFetch, apiWebSocket } from "./api";

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
  wrapped?: boolean;  // true if a `miki claude` wrapper is actively connected
  activity?: string | null;  // "Ideating" / "Using Bash" / "Replying" / null — live wrapper state
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | null;
  pending_ask?: PendingAsk | null;
}

interface AskOption { label: string; description: string }
interface AskQuestion { question: string; header: string; multiSelect?: boolean; options: AskOption[] }
interface PendingAsk { question_id: string; questions: AskQuestion[] }

interface ToolUseInfo { id: string; name: string; description?: string; input: unknown; input_summary: string }
interface ToolResultInfo { tool_use_id?: string; content: string; truncated: boolean; is_error?: boolean }
interface TranscriptTurn { ts: string; role: "user" | "assistant" | "system"; text: string; tool_use?: ToolUseInfo; tool_result?: ToolResultInfo; raw_type?: string }
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

function statusLabel(s: Session["status"]): string {
  return t(`status.${s}`);
}

const ACT_LOG_MAX = 50;

// ── Console logging helper ─────────────────────────────────────────────────

const TAG = "%c[miki-moni]";
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
  if (ms < 60_000) return t("time.secondsAgo", { n: Math.floor(ms / 1000) });
  if (ms < 3_600_000) return t("time.minutesAgo", { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t("time.hoursAgo", { n: Math.floor(ms / 3_600_000) });
  return t("time.daysAgo", { n: Math.floor(ms / 86_400_000) });
}
function fmtTurnTs(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return fmtRelative(ms);
}

// ── Inline SVG icons (lucide style — line, currentColor) ──────────────────

// Miki-Moni mascot: a curled-up sleeping cat. Used as the app's top-left
// logo. Pure stroke-art so it inherits currentColor and matches the rest of
// the icon set. Two pointed ears, a closed-eye curve, and a small "Z" for
// "asleep / standing watch quietly while you work".
function IconSleepingCat({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="miki-moni"
    >
      {/* Curled body + two ear peaks in one continuous outline */}
      <path d="M4.5 13.2 L6 10 L7.6 13 L9.6 11 L11.4 13 C14.5 13 18.5 13.6 20 15.8 C20.8 17 20.4 18.3 18.6 18.7 C16 19.2 7 19.2 5.4 18.4 C3.8 17.5 3.6 14.5 4.5 13.2 Z" />
      {/* Closed sleeping eye */}
      <path d="M6.8 15.2 q0.9 0.7 1.8 0" stroke-width="1.3" />
      {/* Two stacked Z's drifting up — "asleep" */}
      <path d="M15 7 h2.4 l-2.4 2.6 h2.4" stroke-width="1.3" />
      <path d="M18.4 4.5 h1.6 l-1.6 1.8 h1.6" stroke-width="1.1" />
    </svg>
  );
}

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
function IconStop({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
function IconList({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}
function IconActivity({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function IconPause({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
function IconPlugOff({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}
function IconWifi({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}
function IconWifiOff({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}
function IconSettings({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconTerminalPlus({ size = 13 }: { size?: number }) {
  // Terminal box with `>` prompt + small `+` badge in the top-right corner —
  // signals "open a new terminal session" without needing a label.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 5a2 2 0 0 1 2-2h11" />
      <path d="M21 11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <polyline points="7 10 10 13 7 16" />
      <line x1="13" y1="16" x2="17" y2="16" />
      <line x1="19" y1="3" x2="19" y2="7" />
      <line x1="17" y1="5" x2="21" y2="5" />
    </svg>
  );
}
function IconLayers({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
function IconRefresh({ size = 13, spinning = false }: { size?: number; spinning?: boolean }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style={spinning ? { animation: "mm-spin 0.9s linear infinite" } : undefined}
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
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
      setErr(t("ask.atLeastOne"));
      return;
    }
    setSubmitting(true); setErr(null);
    try {
      const r = await apiFetch("/wrap/answer", {
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
      <div class="ask-modal-backdrop" onClick={(e) => { e.stopPropagation(); onDismiss(); }} />
      <div class="ask-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>{t("ask.claudeAsking")}</strong>
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
          placeholder={t("ask.placeholder")}
          value={customs[currentQ] ?? ""}
          onInput={(e) => setCustoms((p) => ({ ...p, [currentQ]: (e.currentTarget as HTMLInputElement).value }))}
          style={{ width: "100%", marginTop: 10 }}
        />
        {err && <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent)" }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {ask.questions.length > 1 && currentQ > 0 && (
            <button class="btn-outline" onClick={() => setCurrentQ((i) => i - 1)}>{t("ask.prev")}</button>
          )}
          {ask.questions.length > 1 && currentQ < ask.questions.length - 1 && (
            <button class="btn-outline" onClick={() => setCurrentQ((i) => i + 1)}>{t("ask.next")}</button>
          )}
          <button
            class="btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={submit}
            disabled={submitting}
          >{submitting ? t("ask.submitting") : t("ask.submit")}</button>
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
            title={t("ask.removeThis")}
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ── Tool box (IN/OUT) ──────────────────────────────────────────────────────

function ToolUseBox({ turn }: { turn: TranscriptTurn }) {
  const u = turn.tool_use!;
  const [expanded, setExpanded] = useState(false);
  const inputStr = typeof u.input === "string" ? u.input : JSON.stringify(u.input, null, 2);
  return (
    <div class="toolbox" style={{ marginTop: 4 }}>
      <div
        class="toolbox-head"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? t("expand.collapse") : t("expand.expandIn")}
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

function ToolResultBox({ turn }: { turn: TranscriptTurn }) {
  const r = turn.tool_result!;
  const [expanded, setExpanded] = useState(false);
  const content = r.content || "(empty)";
  const preview = content.replace(/\s+/g, " ").slice(0, 120);
  return (
    <div class="toolbox" style={{ marginTop: 4 }}>
      <div
        class="toolbox-head"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? t("expand.collapse") : t("expand.expandOut")}
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

function TurnView({ turn }: { turn: TranscriptTurn }) {
  const isUser = turn.role === "user";
  const isSystem = turn.role === "system";
  const isTool = !!(turn.tool_use || turn.tool_result);
  const roleLabel = isSystem ? "system" : isUser ? "user" : "claude";
  // Tool turns: dim role color (de-emphasized) since the tool box is the main signal.
  const roleColor = isTool
    ? "var(--fg-subtle)"
    : isSystem
      ? "var(--fg-subtle)"
      : isUser
        ? "var(--neutral)"
        : "var(--pass)";
  const bgClass = isTool ? "turn-bg-tool" : isSystem ? "turn-bg-tool" : isUser ? "turn-bg-user" : "turn-bg-assistant";
  // Tool turns: tighter padding + smaller header margin since the embedded tool box has its own padding.
  const pad = isTool ? "4px 12px" : "10px 14px";
  const headerMb = isTool ? 3 : 6;
  const headerFontSize = isTool ? 11 : 12;
  return (
    <div class={bgClass} style={{ padding: pad, borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: headerMb }}>
        <span style={{ color: roleColor, fontWeight: 600, fontSize: headerFontSize }}>{roleLabel}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>{fmtDateTime(turn.ts)}</span>
        {turn.tool_use && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>· 🔧 {turn.tool_use.name}</span>
        )}
        {turn.tool_result && (
          <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>· 📤 tool result</span>
        )}
      </div>
      {turn.text && <MD text={turn.text} />}
      {turn.tool_use && <ToolUseBox turn={turn} />}
      {turn.tool_result && <ToolResultBox turn={turn} />}
    </div>
  );
}

// Split transcript into two columns:
//   left  — conversation (user/assistant text, no tool activity)
//   right — tool activity (assistant tool_use + user tool_result)
// A turn that has BOTH text and tool_use shows the text on the left and the tool box on the right.
// Auto follow-tail: each column auto-scrolls to bottom on new content unless the user has
// manually scrolled up. Scrolling back to bottom re-engages follow.
function SingleColumnTranscript({ turns }: { turns: TranscriptTurn[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // ref (not state) so toggling doesn't re-render; only the scroll effect reads it.
  const sticky = useRef(true);

  // After each render (i.e., when turns change), pin to bottom if user is still following.
  useEffect(() => {
    if (sticky.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  // Tolerance for "at bottom": some browsers report fractional scroll positions.
  const TAIL_TOL = 24;
  function onScroll(ev: Event) {
    const el = ev.currentTarget as HTMLDivElement;
    sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_TOL;
  }

  if (turns.length === 0) {
    return <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>{t("transcript.empty")}</div>;
  }
  return (
    <div ref={scrollRef} onScroll={onScroll} style={{ overflowY: "auto", height: "100%", minHeight: 0 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 1, padding: "6px 14px", fontSize: 10, fontWeight: 600, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--sl2)", borderBottom: "1px solid var(--border)" }}>
        {t("transcript.conversation")} · {turns.length}
      </div>
      {turns.map((turn, i) => <TurnView key={i} turn={turn} />)}
    </div>
  );
}

// ── Session card ───────────────────────────────────────────────────────────

type ActionResult = { ok: boolean; label: string; url?: string; reply?: string; durationMs?: number; diag?: string; error?: string; ts: number } | null;

function Card({ s, defaultExpanded, clientType, onSetClientType, onFocus, onSend, sendKey, modalMode, onAfterSend, activity, transcript, transcriptLoading, transcriptError, transcriptLimit, onSetTranscriptLimit, onReloadTranscript, showTools, onSetShowTools, streamingText, userOverlayText, userOverlayTs }: {
  s: Session;
  defaultExpanded: boolean;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onFocus: (uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number; diag?: string; error?: string }>;
  sendKey: SendKey;
  modalMode?: boolean;
  onAfterSend?: () => void;
  activity?: string;
  // Transcript: owned by App so dashboard cells and the modal big-card share
  // a single update pipeline (WS + 2s poll + scheduleRefresh). Card is a
  // pure renderer here — no fetch, no auto-refresh useEffects.
  transcript: TranscriptResp | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  transcriptLimit: number;
  onSetTranscriptLimit: (n: number) => void;
  onReloadTranscript: () => void;
  showTools: boolean;
  onSetShowTools: (v: boolean) => void;
  // Live overlays threaded through from App, matching the small card's
  // assistant streaming + just-sent user message UX. Both drop themselves
  // automatically once the canonical JSONL refresh catches up:
  //   streamingText  is cleared on `assistant_delta_end` by the WS handler.
  //   userOverlayTs  is dropped by loadPreviews when last_user_ts >= ts.
  streamingText?: string;
  userOverlayText?: string;
  userOverlayTs?: number;
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
  const sessionUuid = s.session_uuid ?? "";

  async function handleFocus() {
    clog("click focus", { cwd: s.cwd, uuid: sessionUuid });
    setFocusResult(null);
    const r = await onFocus(sessionUuid);
    setFocusResult({ ok: r.ok, label: r.ok ? t("send.httpOk", { status: r.status }) : t("send.httpFail", { status: r.status }), url: r.url, ts: Date.now() });
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
        ? t("send.httpFail", { status: r.status })
        : submitMode
          ? t("send.claudeReplied", { ms: r.duration_ms ?? "?" })
          : t("send.sentToVSCode");
      setSendResult({ ok: r.ok, label, url: r.url, reply: r.reply, durationMs: r.duration_ms, diag: r.diag, error: r.error, ts: Date.now() });
      if (r.ok) { setDraft(""); setDraftImages([]); }
      // After submit, the App-level scheduleRefresh (called inside onSend)
      // already takes care of refreshing previews + transcript via the
      // unified pipeline. No local refetch needed.
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
        <span style={{ color: "var(--fg-muted)", fontSize: 12, marginLeft: "auto" }}>{statusLabel(s.status)}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11 }}>{fmtRelative(s.last_event_at)}</span>
        <button class="btn-ghost" onClick={() => setCollapsed(false)} title={t("expand.expand")}>▾</button>
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
          title={isCli ? t("focus.cliNotSupported") : t("focus.bringVSCode")}
          disabled={isCli}
        >{s.project_name}</button>
        {s.wrapped ? (
          <span class="client-badge client-badge-wrap client-badge-md" title={t("focus.wrappedTitle")}>{t("focus.wrappedBadge")}</span>
        ) : (
          <ClientTypeBadge
            type={clientType}
            onToggle={() => onSetClientType(sessionUuid, isCli ? "vscode" : "cli")}
            size="md"
          />
        )}
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{statusLabel(s.status)}</span>
        {activity && (
          <span class="cell-activity" title={t("focus.wrapperRunning", { activity })}>
            <span class="cell-activity-dot" /> {activity}…
          </span>
        )}
        <span style={{ color: "var(--fg-subtle)", fontSize: 11, marginLeft: 8 }}>{fmtRelative(s.last_event_at)}</span>
        {s.wrapped && <PermissionModeChip sessionUuid={s.session_uuid} mode={s.permission_mode ?? "default"} />}
        <button class="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setCollapsed(true)} title={t("expand.collapse")}>▴</button>
      </div>

      {/* Transcript section — flex:1, scrollable */}
      <div style={fixedHeight
        ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, borderBottom: "1px solid var(--border)" }
        : { borderBottom: "1px solid var(--border)" }
      }>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", flexShrink: 0 }}>
              <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={showTools}
                  onChange={(e) => onSetShowTools((e.currentTarget as HTMLInputElement).checked)}
                  style={{ margin: 0 }}
                />
                {t("transcript.showTool")}
              </label>
              <select
                value={transcriptLimit}
                onChange={(e) => onSetTranscriptLimit(parseInt((e.currentTarget as HTMLSelectElement).value, 10))}
              >
                <option value={10}>{t("transcript.items10")}</option>
                <option value={20}>{t("transcript.items20")}</option>
                <option value={50}>{t("transcript.items50")}</option>
                <option value={100}>{t("transcript.items100")}</option>
                <option value={200}>{t("transcript.items200")}</option>
                <option value={500}>{t("transcript.items500")}</option>
                <option value={10000}>{t("transcript.itemsAll")}</option>
              </select>
              <button
                class="btn-outline"
                style={{ height: 28, padding: "0 8px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                onClick={() => onSetTranscriptLimit(10000)}
                disabled={transcriptLoading}
                title={t("transcript.loadAllTitle")}
                aria-label={t("transcript.loadAll")}
              ><IconLayers size={14} /></button>
              <button
                class="btn-outline"
                style={{ height: 28, padding: "0 8px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                onClick={onReloadTranscript}
                disabled={transcriptLoading}
                title={transcriptLoading ? t("transcript.loading") : t("transcript.reload")}
                aria-label={transcriptLoading ? t("transcript.loading") : t("transcript.reload")}
              ><IconRefresh size={14} spinning={transcriptLoading} /></button>
            </div>
            {transcriptError && (
              <div style={{ padding: "8px 14px", color: "var(--accent)", fontSize: 12 }}>{transcriptError}</div>
            )}
            {transcript && (() => {
              // Compose render-time turns: canonical JSONL plus the same live
              // overlays the small card shows. The overlays drop themselves
              // when the next refresh's canonical data surfaces them:
              //   userOverlay  → canonical user turn appears in JSONL
              //   streaming    → assistant_delta_end clears the buffer
              // When tools are hidden the server over-fetches (see
              // effectiveLimit). Slice to the LAST `transcriptLimit`
              // conversation turns so the user-selected "20 條" maps to 20
              // visible rows, not "20 mixed minus tool turns".
              const baseTurns = showTools
                ? transcript.turns
                : transcript.turns
                    .filter((tn) => !tn.tool_use && !tn.tool_result)
                    .slice(-transcriptLimit);
              const extras: TranscriptTurn[] = [];
              // Append optimistic user overlay only when JSONL has not yet
              // caught up: i.e. the latest user turn we know of is older
              // than the overlay timestamp.
              if (userOverlayText && userOverlayTs) {
                let latestUserTs = 0;
                for (const tn of transcript.turns) {
                  if (tn.role !== "user" || tn.tool_result) continue;
                  const ts = Date.parse(tn.ts) || 0;
                  if (ts > latestUserTs) latestUserTs = ts;
                }
                if (latestUserTs < userOverlayTs) {
                  extras.push({
                    ts: new Date(userOverlayTs).toISOString(),
                    role: "user",
                    text: userOverlayText,
                    raw_type: "synthetic-user-overlay",
                  });
                }
              }
              // Append in-flight assistant streaming buffer. WS handler clears
              // this on `assistant_delta_end`, so by the time the canonical
              // turn lands in JSONL there's no double-render.
              if (streamingText && streamingText.length > 0) {
                extras.push({
                  ts: new Date().toISOString(),
                  role: "assistant",
                  text: streamingText,
                  raw_type: "synthetic-streaming",
                });
              }
              const renderTurns = extras.length > 0 ? baseTurns.concat(extras) : baseTurns;
              return (
                <div style={fixedHeight ? { flex: 1, minHeight: 0, display: "flex" } : { maxHeight: 480, overflow: "hidden", display: "flex" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <SingleColumnTranscript turns={renderTurns} />
                  </div>
                </div>
              );
            })()}
      </div>

      {/* Bottom: Meta + Send composer */}
      <div style={{ flexShrink: 0 }}>
        {/* Meta hidden — cwd / uuid available via tab title + copy button */}

        {/* Focus result */}
        {focusResult && (
          <div style={{ padding: "0 14px 8px", fontSize: 12, color: focusResult.ok ? "var(--pass)" : "var(--accent)" }}>
            {t("send.focusing", { label: focusResult.label })}
          </div>
        )}

        {/* Send composer */}
        <div style={{ padding: "8px 14px 12px", display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border)" }}>
          <AttachedImageStrip images={draftImages} onRemove={(i) => setDraftImages((prev) => prev.filter((_, j) => j !== i))} dimmed={!imagesSupported && draftImages.length > 0} />
          {!imagesSupported && draftImages.length > 0 && (
            <div style={{ fontSize: 10, color: "var(--warn)" }}>
              {t("composer.imageIgnored")}
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
                      ? t("composer.cliNotWrapped", { short: sessionUuid.slice(0, 8) })
                      : t("composer.vscodeDisabledWrap", { short: sessionUuid.slice(0, 8) }))
                  : t("composer.inputPrompt")
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
            {isWrapped && (
              <button
                class="btn-ghost icon-btn"
                style={{ height: 34, width: 34, padding: 0, fontSize: 16, lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                onClick={() => {
                  void apiFetch("/wrap/interrupt", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ session_uuid: sessionUuid }),
                  });
                }}
                title={t("composer.interruptLong")}
              ><IconStop size={14} /></button>
            )}
            <button
              class={isWrapped ? "btn-primary icon-btn" : "btn-ghost icon-btn"}
              style={{ height: 34, width: 34, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              disabled={(!draft.trim() && draftImages.length === 0) || busy || sendBlocked}
              onClick={handleSend}
              title={
                sendBlocked ? t("composer.needWrapHint")
                : isWrapped ? t("composer.wrapWSHint")
                : t("composer.needWrapBadge")
              }
            >
              {busy ? "⌛" : <IconSend size={14} />}
            </button>
          </div>
          {/* Help text hidden — only show for blocked CLI without wrap (still informative) */}
          {sendBlocked && isCli && (
            <div style={{ fontSize: 10, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
              📟 <strong style={{ color: "#a8740d" }}>{t("composer.cliNotWrappedStrong")}</strong>{t("composer.pleaseUse")} <code>miki claude -r {sessionUuid.slice(0, 8)}…</code>{t("composer.toTakeOver")}
            </div>
          )}
          {/* Advanced toggle hidden — wrap-push is the only working path anyway */}
          {false && !isCli && (
            <>
              <button
                class="btn-ghost"
                style={{ fontSize: 10, alignSelf: "flex-start", padding: "2px 6px" }}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "▾" : "▸"} {t("composer.advancedToggle")}
              </button>
              {showAdvanced && (
                <label style={{ fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer", userSelect: "none", paddingLeft: 16 }}>
                  <input
                    type="checkbox"
                    checked={submitMode}
                    onChange={(e) => setSubmitMode((e.currentTarget as HTMLInputElement).checked)}
                    style={{ marginRight: 6, verticalAlign: "middle" }}
                  />
                  {t("composer.headlessReal")}
                </label>
              )}
            </>
          )}

          {/* Send result — only show when there's an actual error worth surfacing.
              Success / streaming-placeholder reply / URI / diag are noise — the
              real answer streams into the transcript above anyway. */}
          {sendResult && !sendResult.ok && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, color: "var(--accent)" }}>
                {t("send.sendFailed", { label: sendResult.label })}
              </div>
              {sendResult.error && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--accent)", padding: 8, background: "var(--bg-subtle)", borderRadius: 4 }}>
                  ⚠️ {sendResult.error}
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

function HeaderStats({ sessions, filter, onFilter }: {
  sessions: Session[];
  filter: StatusFilter;
  onFilter: (next: StatusFilter) => void;
}) {
  const counts = sessions.reduce(
    (acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; },
    {} as Record<Session["status"], number>,
  );
  const liveCount = (counts.active ?? 0) + (counts.waiting ?? 0);
  // Click an already-active chip → back to "all". Removes the need for a
  // dedicated total/all chip and keeps the bar to 3 buttons on mobile.
  const toggle = (next: StatusFilter) => onFilter(filter === next ? "all" : next);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: 4 }}>
      <HeaderStatChip n={liveCount}         label={t("header.live")}  icon={<IconActivity />} dot="dot-active" active={filter === "live"}  onClick={() => toggle("live")} />
      <HeaderStatChip n={counts.idle ?? 0}  label={t("header.idle")}  icon={<IconPause />}    dot="dot-idle"   active={filter === "idle"}  onClick={() => toggle("idle")} />
      <HeaderStatChip n={counts.stale ?? 0} label={t("header.stale")} icon={<IconPlugOff />}  dot="dot-stale"  active={filter === "stale"} onClick={() => toggle("stale")} />
    </div>
  );
}

function HeaderStatChip({ n, label, icon, dot, active, onClick }: {
  n: number;
  label: string;
  icon?: ComponentChildren;
  dot?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={"header-stat" + (active ? " is-active" : "")}
      title={t("header.onlyShow", { label })}
      aria-label={t("header.onlyShow", { label })}
    >
      <strong>{n}</strong>
      {dot && <span class={`dot ${dot}`} />}
      {icon ?? <span>{label}</span>}
    </button>
  );
}

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
  return (
    <section style={{ marginBottom: 16, padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
      <div class="section-label" style={{ marginBottom: 8 }}>
        {t("header.running")}
        {filter !== "all" && (
          <span style={{ marginLeft: 8, color: "var(--neutral)", textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
            {t("header.filtered", { filter })}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <StatChip n={liveCount}         label={t("header.liveLong")} active={filter === "live"}  onClick={() => onFilter(filter === "live"  ? "all" : "live")}  dot="dot-active" />
        <StatChip n={counts.idle ?? 0}  label={t("header.idle")}     active={filter === "idle"}  onClick={() => onFilter(filter === "idle"  ? "all" : "idle")}  dot="dot-idle" />
        <StatChip n={counts.stale ?? 0} label={t("header.stale")}    active={filter === "stale"} onClick={() => onFilter(filter === "stale" ? "all" : "stale")} dot="dot-stale" />
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

// Copies `pnpm --dir D:\code\cc-hub miki claude -r <uuid>` so user can quickly
// re-arm a wrap session after killing it.
function CopyResumeButton({ sessionUuid, compact }: { sessionUuid: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  function handle(e: MouseEvent) {
    e.stopPropagation();
    if (!sessionUuid) return;
    const cmd = `pnpm --dir D:\\code\\cc-hub miki claude -r ${sessionUuid}`;
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
      title={t("session.copyRestart", { uuid: sessionUuid })}
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
    ? t("session.cliMarkTooltip")
    : t("session.vscodeMarkTooltip");
  return (
    <button
      class={"client-badge" + (isCli ? " client-badge-cli" : " client-badge-vscode") + (size === "md" ? " client-badge-md" : "")}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={title}
    >{label}</button>
  );
}

// ── Permission mode badge (only for wrapped CLI sessions) ─────────────────
// Shown next to the wrapped badge. Mode is set at `miki claude` startup via
// --permission-mode / --bypass-permissions and locked for the session lifetime
// (SDK has no mid-session toggle). Default mode → no badge.

function PermissionModeBadge({ mode, size = "sm" }: { mode: NonNullable<Session["permission_mode"]>; size?: "sm" | "md" }) {
  if (!mode || mode === "default") return null as any;
  const config: Record<string, { label: string; cls: string; title: string }> = {
    acceptEdits: {
      label: "✏️ auto edit",
      cls: "pmode-badge-auto",
      title: t("mode.lockedAcceptTitle"),
    },
    bypassPermissions: {
      label: "⚠️ bypass",
      cls: "pmode-badge-bypass",
      title: t("mode.lockedBypassTitle"),
    },
    plan: {
      label: "📋 plan",
      cls: "pmode-badge-plan",
      title: t("mode.lockedPlanTitle"),
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

// `short`, `cls`, `menuLabel` are language-stable. `menuDesc` and `title` are
// looked up via t() at render time so locale switches take effect immediately.
const PMODE_STATIC: Record<PMode, { short: string; cls: string; menuLabel: string; descKey: string; titleKey: string }> = {
  default:           { short: "ask",       cls: "pmode-chip-default",  menuLabel: "Ask before edits",   descKey: "mode.defaultDesc", titleKey: "mode.defaultTitle" },
  acceptEdits:       { short: "edit auto", cls: "pmode-chip-auto",     menuLabel: "Edit automatically", descKey: "mode.acceptDesc",  titleKey: "mode.acceptTitle"  },
  plan:              { short: "plan",      cls: "pmode-chip-plan",     menuLabel: "Plan mode",          descKey: "mode.planDesc",    titleKey: "mode.planTitle"    },
  auto:              { short: "auto",      cls: "pmode-chip-autopick", menuLabel: "Auto mode",          descKey: "mode.autoDesc",    titleKey: "mode.autoTitle"    },
  bypassPermissions: { short: "bypass",    cls: "pmode-chip-bypass",   menuLabel: "Bypass permissions", descKey: "mode.bypassDesc",  titleKey: "mode.bypassTitle"  },
};
function pmodeCfg(mode: PMode) {
  const s = PMODE_STATIC[mode] ?? PMODE_STATIC.default;
  return { short: s.short, cls: s.cls, menuLabel: s.menuLabel, menuDesc: t(s.descKey), title: t(s.titleKey) };
}
function PermissionModeChip({ sessionUuid, mode }: { sessionUuid: string | null; mode: PMode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PMode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const cfg = pmodeCfg(mode);

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
      const r = await apiFetch("/wrap/permission-mode", {
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
        title={cfg.title + t("mode.switchHint")}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onMouseDown={stop}
        disabled={!sessionUuid}
      >
        <PModeIcon mode={pending ?? mode} />
        <span>{pending ? `${PMODE_STATIC[pending].short}…` : cfg.short}</span>
      </button>
      {open && (
        <div class="pmode-menu" onClick={stop} onMouseDown={stop}>
          <div class="pmode-menu-head">Modes</div>
          {(["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as PMode[]).map((m) => (
            <button
              key={m}
              class={"pmode-menu-item " + (m === mode ? "is-current" : "") + " " + PMODE_STATIC[m].cls}
              onClick={(e) => { e.stopPropagation(); pick(m); }}
              onMouseDown={stop}
              disabled={!!pending}
              title={t(PMODE_STATIC[m].titleKey)}
            >
              <span class="pmode-menu-icon"><PModeIcon mode={m} /></span>
              <div class="pmode-menu-text">
                <div class="pmode-menu-label">{PMODE_STATIC[m].menuLabel}</div>
                <div class="pmode-menu-desc">{t(PMODE_STATIC[m].descKey)}</div>
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

// Opens a Windows Terminal tab running `miki claude -r <uuid>` so an unwrapped
// VSCode-panel session becomes wrapped without the user touching a terminal.
// Disables itself for ~5s after click to dampen accidental double-spawns; the
// real source of truth is `s.wrapped` flipping (button hides) once wrap.ts
// connects back.
function WrapStartButton({ sessionUuid }: { sessionUuid: string }) {
  // Click is now a REQUEST — App-level <WrapConfirmDialog> shows a confirm
  // modal with the split-brain warning + Confirm/Cancel buttons. Only on
  // Confirm does it actually call /wrap/start. This prevents the "wt window
  // popped up before I could read the warning" UX bug.
  function start(e: MouseEvent) {
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("miki-moni:wrap-request", {
      detail: { sessionUuid },
    }));
  }
  return (
    <button
      class="cell-wrap-btn cell-wrap-btn-icon"
      onClick={start}
      onMouseDown={(e) => e.stopPropagation()}
      title={t("session.openCliTooltip")}
      aria-label={t("session.openCli")}
    >🔌</button>
  );
}

// Pre-spawn confirmation dialog for 🔌 wrap-start. Listens for the
// "miki-moni:wrap-request" CustomEvent from <WrapStartButton>; the BUTTON
// no longer calls /wrap/start directly so the wt window never opens before
// the user has read the split-brain warning and ticked confirmation.
//
// Friction by design: Confirm button stays disabled until the checkbox is
// ticked. No auto-dismiss. Cancel button bails entirely without spawning
// anything.
function WrapConfirmDialog({ sessionByUuid }: { sessionByUuid: Map<string, Session> }) {
  const [request, setRequest] = useState<{ sessionUuid: string; project: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onRequest(e: Event) {
      const ce = e as CustomEvent<{ sessionUuid: string }>;
      const uuid = ce.detail?.sessionUuid;
      if (!uuid) return;
      const s = sessionByUuid.get(uuid);
      const project = s?.project_name ?? uuid.slice(0, 8);
      setRequest({ sessionUuid: uuid, project });
      setConfirmed(false);
      setErr(null);
    }
    window.addEventListener("miki-moni:wrap-request", onRequest);
    return () => window.removeEventListener("miki-moni:wrap-request", onRequest);
  }, [sessionByUuid]);

  function close() {
    setRequest(null);
    setConfirmed(false);
    setErr(null);
  }

  async function confirm() {
    if (!request || !confirmed || pending) return;
    setPending(true); setErr(null);
    try {
      const r = await apiFetch("/wrap/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: request.sessionUuid }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body?.error ?? `HTTP ${r.status}`);
      } else {
        close();
      }
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setPending(false);
    }
  }

  // Esc to cancel (only when not mid-POST so we don't drop a successful spawn).
  useEffect(() => {
    if (!request) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, pending]);

  if (!request) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      style={{
        position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
        zIndex: 70,
        maxWidth: 540, minWidth: 360,
        padding: "12px 14px",
        background: "var(--bg)",
        border: "1px solid var(--warn)",
        borderLeft: "3px solid var(--warn)",
        borderRadius: 6,
        boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
        fontSize: 12, lineHeight: 1.5, color: "var(--fg)",
        animation: "miki-toast-in 0.18s ease-out",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{ fontSize: 16, lineHeight: 1, marginTop: 1 }}>⚠️</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("wrapNotice.title")}</div>
          <div style={{ color: "var(--fg-muted)", marginBottom: 10 }}>{t("wrapNotice.body", { project: request.project })}</div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: pending ? "not-allowed" : "pointer", marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onInput={(e) => setConfirmed((e.target as HTMLInputElement).checked)}
              style={{ margin: 0 }}
            />
            <span>{t("wrapNotice.confirmCheck")}</span>
          </label>
          {err && <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 8 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              class="btn-primary"
              style={{ height: 28, padding: "0 12px", fontSize: 12 }}
              disabled={!confirmed || pending}
              onClick={() => void confirm()}
            >{pending ? t("session.openCliPending") : t("wrapNotice.confirm")}</button>
            <button
              class="btn-ghost"
              style={{ height: 28, padding: "0 10px", fontSize: 12 }}
              disabled={pending}
              onClick={close}
            >{t("wrapNotice.later")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Bottom-of-page loading banner shown after the user clicks "Open" in the
// NewCliButton popover. Bridges the 3–5s gap between "wt window spawned"
// and "wrap process connected back → session card appears in grid". Without
// this, the user clicks, the popover closes, and nothing visible happens
// until the new card materialises — easy to think nothing worked.
//
// Auto-dismisses when a session matching the spawned cwd appears (we watch
// the `sessions` prop). 30s safety timer also dismisses + shows an error
// hint in case the wt window crashed silently and no wrap ever connects.
function SpawnPendingBanner({ sessions }: { sessions: Session[] }) {
  interface Pending { cwd: string; startedAt: number; timedOut: boolean }
  const [pendings, setPendings] = useState<Pending[]>([]);

  // Listen for spawn-pending events fired by <NewCliButton> on /wrap/start success.
  useEffect(() => {
    function onSpawn(e: Event) {
      const ce = e as CustomEvent<{ cwd: string }>;
      const cwd = ce.detail?.cwd;
      if (!cwd) return;
      setPendings((prev) => {
        // De-dupe: replace existing entry for same cwd (re-clicks reset timer).
        const without = prev.filter((p) => p.cwd.toLowerCase() !== cwd.toLowerCase());
        return [...without, { cwd, startedAt: Date.now(), timedOut: false }];
      });
    }
    window.addEventListener("miki-moni:spawn-pending", onSpawn);
    return () => window.removeEventListener("miki-moni:spawn-pending", onSpawn);
  }, []);

  // Tick the timeout once a second so the banner can switch to "timed out"
  // copy after 30s. Cheap — only runs while there's a pending entry.
  useEffect(() => {
    if (pendings.length === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setPendings((prev) => prev.map((p) =>
        p.timedOut ? p : (now - p.startedAt > 30_000 ? { ...p, timedOut: true } : p)
      ));
    }, 1000);
    return () => window.clearInterval(id);
  }, [pendings.length]);

  // Auto-dismiss when a real session for that cwd has shown up post-event.
  // We treat "appeared" as: any session row whose cwd matches AND
  // last_event_at >= the spawn's startedAt (the session row could have
  // pre-existed from VSCode-panel hooks). The `sessions` prop refreshes
  // every 2s via the App's polling tick, so this resolves naturally.
  useEffect(() => {
    if (pendings.length === 0) return;
    setPendings((prev) => prev.filter((p) => {
      const match = sessions.find(
        (s) => s.cwd.toLowerCase() === p.cwd.toLowerCase() && s.last_event_at >= p.startedAt,
      );
      return !match;
    }));
  }, [sessions, pendings.length]);

  function dismiss(cwd: string) {
    setPendings((prev) => prev.filter((p) => p.cwd !== cwd));
  }

  if (pendings.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)",
        zIndex: 65,
        display: "flex", flexDirection: "column", gap: 8,
        maxWidth: "min(520px, calc(100vw - 24px))",
        width: "100%",
      }}
    >
      {pendings.map((p) => (
        <div
          key={p.cwd}
          role="status"
          style={{
            padding: "10px 14px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderLeft: `3px solid var(${p.timedOut ? "--accent" : "--pass"})`,
            borderRadius: 6,
            boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
            fontSize: 12, lineHeight: 1.5, color: "var(--fg)",
            display: "flex", alignItems: "flex-start", gap: 10,
          }}
        >
          {p.timedOut
            ? <span style={{ fontSize: 14, marginTop: 1 }}>⚠️</span>
            : <span class="spawn-pending-spinner" aria-hidden="true">⟳</span>
          }
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("spawnPending.title")}</div>
            <div style={{ color: "var(--fg-muted)", overflowWrap: "anywhere" }}>
              {p.timedOut ? t("spawnPending.timeout") : t("spawnPending.body", { cwd: p.cwd })}
            </div>
          </div>
          <button
            class="btn-ghost"
            style={{ fontSize: 11, padding: "2px 8px", flexShrink: 0 }}
            onClick={() => dismiss(p.cwd)}
          >{t("spawnPending.dismiss")}</button>
        </div>
      ))}
    </div>
  );
}

// Header "+ 新增 CLI" button. Opens a popover with a folder-path input so the
// user can spawn `miki claude --fresh` in any directory without typing in a
// terminal. Recently-seen cwds (derived from current sessions) get autocompleted
// via a native <datalist> — no extra deps, works offline, F5-stable.
function NewCliButton({ recentCwds }: { recentCwds: string[] }) {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // popover anchor in viewport coords (recomputed on open + window resize) so
  // a narrow viewport doesn't leave the popover clipped off-screen.
  const [popTop, setPopTop] = useState(0);
  // distance from the right edge of the viewport to the right edge of the
  // button — popover aligns to that so it visually "drops out from under the
  // button leftward", instead of slamming against the viewport's right gutter.
  const [popRight, setPopRight] = useState(8);

  // Close on outside click — same pattern as Settings / PermissionModeChip.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Autofocus the input + clear stale feedback when reopening.
  useEffect(() => {
    if (!open) return;
    setErr(null); setOk(false);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Re-measure popover anchor whenever it opens or the viewport resizes —
  // popover is fixed-positioned so it doesn't get clipped by ancestor overflow.
  useEffect(() => {
    if (!open) return;
    function measure() {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPopTop(r.bottom + 6);
      // Align popover's right edge with the button's right edge so on mobile
      // it opens *leftward* from the button position rather than from the
      // viewport's right gutter (which made it look like it "popped right"
      // because the button isn't actually at the viewport edge — there's
      // header padding).
      setPopRight(Math.max(8, window.innerWidth - r.right));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  async function submit() {
    const trimmed = cwd.trim();
    if (!trimmed || pending) return;
    setPending(true); setErr(null); setOk(false);
    try {
      const r = await apiFetch("/wrap/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: trimmed }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body?.error ?? `HTTP ${r.status}`);
      } else {
        setOk(true);
        // Tell the App-level SpawnPendingBanner that a wt window is opening
        // for `cwd` — it'll show a loading banner until the wrap process
        // connects back to daemon and a fresh session card materialises in
        // the grid. Without this the user has zero visual feedback for the
        // 3–5s between click and card-appearing.
        window.dispatchEvent(new CustomEvent("miki-moni:spawn-pending", {
          detail: { cwd: trimmed },
        }));
        // Auto-close after a beat so user sees the success indicator briefly.
        window.setTimeout(() => { setOpen(false); setCwd(""); }, 800);
      }
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setPending(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
    else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={btnRef}
        class="btn-ghost"
        style={{ padding: "4px 6px", display: "inline-flex", alignItems: "center" }}
        onClick={() => setOpen((v) => !v)}
        title={t("header.newCliTitle")}
        aria-label={t("header.newCli")}
      ><IconTerminalPlus size={15} /></button>
      {open && (
        <div
          style={{
            // Fixed to the viewport (not the button's relative parent) so a
            // narrow window can't clip the popover off the left edge. Right
            // edge aligns with the button's right edge (popRight, measured
            // on open + resize) so the popover visually drops from under the
            // button and extends LEFTWARD — instead of being slammed against
            // the viewport's right gutter, which on mobile makes it look like
            // a misplaced "rightward" popover.
            position: "fixed",
            top: popTop,
            right: popRight,
            zIndex: 50,
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
            padding: "12px 14px",
            width: "min(360px, calc(100vw - 16px))",
            maxWidth: "calc(100vw - 16px)",
            boxSizing: "border-box",
            boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("newCli.heading")}</div>
          <label style={{ fontSize: 11, color: "var(--fg-muted)", display: "block", marginBottom: 4 }}>
            {t("newCli.cwdLabel")}
          </label>
          <input
            ref={inputRef}
            type="text"
            list="newcli-cwd-suggestions"
            value={cwd}
            onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
            onKeyDown={onKey}
            placeholder={t("newCli.cwdPlaceholder")}
            spellcheck={false}
            autoComplete="off"
            style={{ width: "100%", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }}
          />
          {recentCwds.length > 0 && (
            <datalist id="newcli-cwd-suggestions">
              {recentCwds.map((c) => <option key={c} value={c} />)}
            </datalist>
          )}
          <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 6, lineHeight: 1.45 }}>
            {t("newCli.hint")}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
            <button
              class="btn-primary"
              style={{ height: 28, padding: "0 10px", fontSize: 11 }}
              disabled={pending || !cwd.trim()}
              onClick={() => void submit()}
            >{pending ? t("newCli.submitting") : t("newCli.submit")}</button>
            {err && <span style={{ fontSize: 10, color: "var(--accent)" }}>{t("newCli.error", { err })}</span>}
            {ok && <span style={{ fontSize: 10, color: "var(--pass)" }}>✓ {t("newCli.success")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Grid overview cell ────────────────────────────────────────────────────

function Cell({ s, preview, activity, streamingText, userOverlayText, pendingAsk, askDismissed, onReopenAsk, clientType, onSetClientType, onQuickSend, onOpenModal }: {
  s: Session;
  preview?: SessionPreview;
  activity?: string;
  streamingText?: string;
  userOverlayText?: string;
  pendingAsk?: PendingAsk;
  askDismissed?: boolean;
  onReopenAsk?: (uuid: string) => void;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenModal: (s: Session) => void;
}) {
  const title = preview?.ai_title ?? s.project_name;
  // Optimistic overlay wins over JSONL-derived text while we wait for the
  // /sessions/previews poll to catch up to the latest user turn.
  const lastUserRaw = userOverlayText && userOverlayText.length > 0
    ? userOverlayText
    : preview?.last_user_text;
  // Live stream wins over JSONL-derived preview while a turn is in flight.
  const lastAssistantRaw = streamingText && streamingText.length > 0 ? streamingText : preview?.last_assistant_text;
  const lastTool = preview?.last_tool_use ?? null;
  const lastUser = useMemo(() => (lastUserRaw ? mdToPlainText(lastUserRaw) : ""), [lastUserRaw]);
  const lastAssistant = useMemo(() => (lastAssistantRaw ? mdToPlainText(lastAssistantRaw) : ""), [lastAssistantRaw]);
  const isStreaming = !!streamingText && streamingText.length > 0;
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

  // Sustained pink background once a session has been waiting for >60s — lets
  // user scan the grid and spot who's been sitting idle waiting for input.
  //
  // Daemon's `status` / `last_event_at` only advance when a hook fires.
  // UserPromptSubmit PowerShell hook can be silently missed (session started
  // before hooks were installed, PS error swallowed, daemon timeout). Preview
  // pipeline reads the transcript JSONL directly, so its last_user_ts is
  // authoritative for "did user actually respond". If preview shows a user
  // turn newer than last_event_at → user already replied, daemon is behind —
  // don't paint stale.
  const [staleWaiting, setStaleWaiting] = useState(false);
  useEffect(() => {
    if (s.status !== "waiting") { setStaleWaiting(false); return; }
    const lastUserMs = preview?.last_user_ts ? Date.parse(preview.last_user_ts) : 0;
    if (lastUserMs > s.last_event_at) { setStaleWaiting(false); return; }
    const elapsed = Date.now() - s.last_event_at;
    if (elapsed >= 60_000) { setStaleWaiting(true); return; }
    setStaleWaiting(false);
    const timer = window.setTimeout(() => setStaleWaiting(true), 60_000 - elapsed);
    return () => window.clearTimeout(timer);
  }, [s.status, s.last_event_at, preview?.last_user_ts]);

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
      class={"cell cell-clickable" + (flashing ? " cell-flash" : "") + (updateFlash ? " cell-flash-update" : "") + (pendingAsk && askDismissed ? " cell-ask-pending" : "")}
      style={{ borderTop: `3px solid ${STATUS_BORDER_COLOR[s.status]}` }}
      onClick={() => onOpenModal(s)}
    >
      <div class="cell-head">
        <span class="cell-title" title={title}>{title}</span>
        {pendingAsk && askDismissed && (
          <button
            class="cell-ask-bell"
            onClick={(e) => { e.stopPropagation(); if (s.session_uuid && onReopenAsk) onReopenAsk(s.session_uuid); }}
            title={t("session.waitingTooltip")}
          >{t("session.waitingBadge")}</button>
        )}
        {activity && (
          <span class="cell-activity" title={t("focus.wrapperRunning", { activity })}>
            <span class="cell-activity-dot" /> {activity}…
          </span>
        )}
        {/* CLI ("start wrap") button sits to the LEFT of the copy button so
         * the top row reads: title … [🔌 CLI] [📋 copy]. Hidden for wrapped
         * sessions (already wrapped — nothing to start). */}
        {!s.wrapped && s.session_uuid && <WrapStartButton sessionUuid={s.session_uuid} />}
        <CopyResumeButton sessionUuid={s.session_uuid ?? ""} compact />
      </div>
      <div class="cell-cwd" style={{ color: c.label, display: "flex", alignItems: "center", gap: 6 }} title={s.cwd}>
        <strong style={{ fontWeight: 600 }}>{s.project_name}</strong>
        {s.wrapped ? (
          // Wrapped session: it's inherently CLI + we own it. One badge says it all.
          <span class="client-badge client-badge-wrap" title={t("session.wrappedDetailed")}>{t("focus.wrappedBadge")}</span>
        ) : (
          <ClientTypeBadge
            type={clientType}
            onToggle={() => onSetClientType(s.session_uuid ?? "", clientType === "cli" ? "vscode" : "cli")}
          />
        )}
        {/* Last TOOL inline next to the VSCode/CLI badge — was a separate
         * preview row before, which pushed assistant/user content down and
         * wasted vertical space. Truncates via cell-cwd's ellipsis. */}
        {lastTool && (
          <span class="cell-tool-inline" title={lastTool.description || lastTool.name}>
            <span class="cell-tool-icon">🔧</span>
            <strong>{lastTool.name}</strong>
            {lastTool.description && (
              <span class="cell-tool-desc"> · {lastTool.description}</span>
            )}
            {preview?.last_tool_use_ts && (
              <span class="cell-tool-ts" title={preview.last_tool_use_ts}> · {fmtTurnTs(preview.last_tool_use_ts)}</span>
            )}
          </span>
        )}
      </div>
      <div class="cell-preview cell-convo">
        {!lastUser && !lastAssistant ? (
          <span class="cell-empty">{t("session.empty")}</span>
        ) : (
          <>
            {lastAssistant && (
              <div class="cell-turn cell-turn-assistant">
                <div class="cell-turn-role">
                  <span>claude</span>
                  {isStreaming
                    ? <span class="cell-turn-ts" style={{ color: "var(--pass)" }}>streaming…</span>
                    : preview?.last_assistant_ts && <span class="cell-turn-ts" title={preview.last_assistant_ts}>{fmtTurnTs(preview.last_assistant_ts)}</span>}
                </div>
                <div class="cell-turn-body">
                  {lastAssistant.slice(0, ASSISTANT_MAX)}{lastAssistant.length > ASSISTANT_MAX ? "…" : ""}
                  {isStreaming && <span class="streaming-cursor">▌</span>}
                </div>
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
      <div class={"cell-foot cell-foot-" + s.status}>
        <span class="cell-status">{statusLabel(s.status)}</span>
        <span>·</span>
        <span>{fmtRelative(s.last_event_at)}</span>
        {s.wrapped && <PermissionModeChip sessionUuid={s.session_uuid} mode={s.permission_mode ?? "default"} />}
        <button
          class="cell-send-btn icon-btn"
          style={s.wrapped ? PMODE_BTN_STYLE[s.permission_mode ?? "default"] : undefined}
          onClick={(ev) => { ev.stopPropagation(); onQuickSend(s, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY); }}
          title={t("session.quickSend")}
        ><IconSend size={12} /></button>
      </div>
    </div>
  );
}

// ── Grid overview (sessions grouped by cwd) ──────────────────────────

function GridOverview({ sessions, sortMode, previews, activities, streaming, userOverlay, pendingAsks, dismissedAsks, onReopenAsk, getClientType, onSetClientType, onQuickSend, onOpenModal }: {
  sessions: Session[];
  sortMode: SortMode;
  previews: Record<string, SessionPreview>;
  activities: Record<string, string>;
  streaming: Record<string, string>;
  userOverlay: Record<string, { text: string; ts: number }>;
  pendingAsks: Record<string, PendingAsk>;
  dismissedAsks: Set<string>;
  onReopenAsk: (uuid: string) => void;
  getClientType: (uuid: string | null | undefined) => ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenModal: (s: Session) => void;
}) {
  // Deterministic ordering. The previous implementation used a useRef Map to
  // assign first-seen slot indexes, which was stable within a session but reset
  // on F5 (since useRef is per-mount). The user explicitly wanted F5-stable
  // ordering — so we now use a pure function of (sessions, sortMode), making
  // the layout reproducible across reloads.
  //   priority → status (waiting first) then cwd alpha (default)
  //   cwd      → pure cwd alpha (most stable; never moves on activity)
  //   recent   → last_event_at DESC (mirrors backend; intentionally drifts)
  const ordered = useMemo(
    () => sessions.slice().sort(compareFor(sortMode)),
    [sessions, sortMode],
  );
  return (
    <div class="cwd-group-grid">
      {ordered.map((s) => (
        <Cell
          key={s.session_uuid ?? s.cwd}
          s={s}
          preview={s.session_uuid ? previews[s.session_uuid] : undefined}
          activity={s.session_uuid ? activities[s.session_uuid] : undefined}
          streamingText={s.session_uuid ? streaming[s.session_uuid] : undefined}
          userOverlayText={s.session_uuid ? userOverlay[s.session_uuid]?.text : undefined}
          pendingAsk={s.session_uuid ? pendingAsks[s.session_uuid] : undefined}
          askDismissed={s.session_uuid ? dismissedAsks.has(s.session_uuid) : false}
          onReopenAsk={onReopenAsk}
          clientType={getClientType(s.session_uuid)}
          onSetClientType={onSetClientType}
          onQuickSend={onQuickSend}
          onOpenModal={onOpenModal}
        />
      ))}
    </div>
  );
}

// ── Popover (quick-send at mouse position) ───────────────────────────

function Popover({ s, x, y, clientType, onSetClientType, onClose, onSend, sendKey }: {
  s: Session;
  x: number;
  y: number;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onClose: () => void;
  onSend: (uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) => Promise<{ ok: boolean; status: number; reply?: string; duration_ms?: number; error?: string }>;
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

  // Position: open below-right of cursor and clamp to viewport on desktop.
  // On narrow screens (mobile), the 360px popover would overflow horizontally
  // and clipping to the edges still looks broken — center it instead.
  const popW = 360, popH = 280;
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 560;
  const px = isNarrow
    ? Math.max(8, (window.innerWidth - popW) / 2)
    : Math.min(x + 12, window.innerWidth - popW - 16);
  const py = isNarrow
    ? Math.max(16, (window.innerHeight - popH) / 2)
    : Math.min(y + 12, window.innerHeight - popH - 16);

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
      const label = t("send.httpFail", { status: r.status });
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
            <span class="client-badge client-badge-wrap" title={t("focus.wrappedTitle")}>{t("focus.wrappedBadge")}</span>
          ) : (
            <ClientTypeBadge
              type={clientType}
              onToggle={() => onSetClientType(s.session_uuid ?? "", isCli ? "vscode" : "cli")}
            />
          )}
          <button class="btn-ghost" style={{ marginLeft: "auto", padding: "2px 8px" }} onClick={onClose} title={t("session.closeKey")}>×</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "ui-monospace, monospace", marginBottom: 8, wordBreak: "break-all" }}>
          {s.cwd}<br />
          {s.session_uuid}
        </div>
        <AttachedImageStrip images={images} onRemove={(i) => setImages((prev) => prev.filter((_, j) => j !== i))} dimmed={!imagesSupported && images.length > 0} />
        {!imagesSupported && images.length > 0 && (
          <div style={{ fontSize: 10, color: "var(--warn)", marginBottom: 4 }}>
            {t("composer.imageIgnored")}
          </div>
        )}
        <textarea
          autoFocus
          placeholder={
            sendBlocked
              ? (isCli
                  ? t("composer.cliNotWrapped", { short: s.session_uuid?.slice(0, 8) ?? "" })
                  : t("composer.vscodeDisabledWrap2", { short: s.session_uuid?.slice(0, 8) ?? "" }))
              : t("composer.inputPrompt")
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
          {isWrapped && (
            <button
              class="btn-ghost"
              style={{ marginLeft: "auto", height: 32, padding: "0 10px", fontSize: 14, lineHeight: 1 }}
              onClick={() => {
                if (!s.session_uuid) return;
                void apiFetch("/wrap/interrupt", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ session_uuid: s.session_uuid }),
                });
              }}
              title={t("composer.interruptShort")}
            ><IconStop size={14} /></button>
          )}
          <button
            class={isWrapped ? "btn-primary" : "btn-ghost"}
            disabled={!prompt.trim() || busy || sendBlocked}
            onClick={handleSend}
            style={isWrapped ? undefined : { marginLeft: "auto" }}
            title={sendBlocked ? t("composer.needWrapHint2") : t("composer.wrapWSShort")}
          >
            {busy ? t("composer.sendBusy") : isWrapped ? t("composer.sendWrapped") : t("composer.sendNeedWrap")}
          </button>
        </div>
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--fg-subtle)" }}>
          {sendKey === "enter" ? t("composer.keyEnter") : t("composer.keyCtrlEnter")}{t("composer.escClose")}
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
        <span class="section-label">{t("log.activity")}</span>
        <span style={{ marginLeft: 8, color: "var(--fg-subtle)", fontSize: 11 }}>{t("log.syncedConsole")}</span>
        <button class="btn-ghost" style={{ marginLeft: "auto" }} onClick={onClear}>{t("log.clear")}</button>
      </div>
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {entries.length === 0 && (
          <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>{t("log.empty")}</div>
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

function CellModal({ s, onClose, clientType, onSetClientType, onFocus, onSend, sendKey, pendingAsk, askDismissed, onReopenAsk, activity, transcript, transcriptLoading, transcriptError, transcriptLimit, onSetTranscriptLimit, onReloadTranscript, showTools, onSetShowTools, streamingText, userOverlayText, userOverlayTs }: {
  s: Session;
  onClose: () => void;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onFocus: (uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number; diag?: string; error?: string }>;
  sendKey: SendKey;
  pendingAsk?: PendingAsk;
  askDismissed?: boolean;
  onReopenAsk?: (uuid: string) => void;
  activity?: string;
  transcript: TranscriptResp | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  transcriptLimit: number;
  onSetTranscriptLimit: (n: number) => void;
  onReloadTranscript: () => void;
  showTools: boolean;
  onSetShowTools: (v: boolean) => void;
  streamingText?: string;
  userOverlayText?: string;
  userOverlayTs?: number;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while modal is open — otherwise wheel events over the
  // backdrop (or wheel events that hit the modal's scroll boundary) chain up
  // and scroll the dashboard underneath.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div class="cell-modal-backdrop" onClick={onClose}>
      <div class="cell-modal" onClick={(e) => e.stopPropagation()}>
        <button class="cell-modal-close" onClick={onClose} title={t("session.modalClose")}>×</button>
        {pendingAsk && askDismissed && (
          <div class="cell-modal-ask-banner">
            <span>{t("session.claudeWaitingHere")}</span>
            <button
              class="btn-primary"
              style={{ height: 26, padding: "0 10px", fontSize: 12 }}
              onClick={() => { if (s.session_uuid && onReopenAsk) onReopenAsk(s.session_uuid); }}
            >{t("session.showQuestion")}</button>
          </div>
        )}
        <Card
          s={s}
          defaultExpanded={true}
          activity={activity}
          clientType={clientType}
          onSetClientType={onSetClientType}
          onFocus={onFocus}
          onSend={onSend}
          sendKey={sendKey}
          modalMode={true}
          transcript={transcript}
          transcriptLoading={transcriptLoading}
          transcriptError={transcriptError}
          transcriptLimit={transcriptLimit}
          onSetTranscriptLimit={onSetTranscriptLimit}
          onReloadTranscript={onReloadTranscript}
          showTools={showTools}
          onSetShowTools={onSetShowTools}
          streamingText={streamingText}
          userOverlayText={userOverlayText}
          userOverlayTs={userOverlayTs}
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
const CLIENT_TYPE_LS_KEY = "miki-moni:client-types";
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
const SEND_KEY_LS_KEY = "miki-moni:send-key";
function loadSendKeyFromLS(): SendKey {
  try {
    const raw = localStorage.getItem(SEND_KEY_LS_KEY);
    return raw === "enter" ? "enter" : "ctrl-enter";
  } catch { return "ctrl-enter"; }
}
function saveSendKeyToLS(v: SendKey) {
  try { localStorage.setItem(SEND_KEY_LS_KEY, v); } catch { /* quota / disabled */ }
}

// Theme: light / dark / system. Stored in localStorage. Applied by toggling
// `data-theme` attribute on <html>, which CSS reads to swap the Radix Slate
// palette. "system" mirrors prefers-color-scheme and reacts to OS changes.
type Theme = "light" | "dark" | "system";
const THEME_LS_KEY = "miki-moni:theme";
function loadThemeFromLS(): Theme {
  try {
    const raw = localStorage.getItem(THEME_LS_KEY);
    return raw === "dark" || raw === "light" || raw === "system" ? raw : "light";
  } catch { return "light"; }
}
function saveThemeToLS(v: Theme) {
  try { localStorage.setItem(THEME_LS_KEY, v); } catch { /* quota / disabled */ }
}
function resolveTheme(t: Theme): "light" | "dark" {
  if (t === "system") {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return t;
}
function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(t));
}

// Card sort mode for the Overview grid. Stored in localStorage.
//  - "priority": status-priority first (waiting → active → idle → stale), then cwd alpha.
//    Default. Surfaces sessions that need user attention without random F5 shuffling.
//  - "uuid": sort by session_uuid. Opaque but maximally stable — each session
//    permanently occupies the same slot for its entire lifetime, regardless of
//    activity, cwd renames, or restarts. (Previous "cwd" mode was confusing
//    because the label "字典序" didn't say which string was being lex-sorted.)
//  - "recent": most-recently-active first (mirrors backend ORDER BY last_event_at DESC).
//    Useful if you actively want the "active session bubbles up" behavior; expect
//    position drift on F5 by design.
export type SortMode = "priority" | "uuid" | "recent";
const SORT_MODE_LS_KEY = "miki-moni:sort-mode";
function loadSortModeFromLS(): SortMode {
  try {
    const raw = localStorage.getItem(SORT_MODE_LS_KEY);
    // Migrate the old "cwd" value (renamed to "uuid" 2026-05-17) so existing
    // localStorage entries don't fall back to the new default.
    if (raw === "cwd") return "uuid";
    return raw === "uuid" || raw === "recent" || raw === "priority" ? raw : "uuid";
  } catch { return "uuid"; }
}
function saveSortModeToLS(v: SortMode): void {
  try { localStorage.setItem(SORT_MODE_LS_KEY, v); } catch { /* quota / disabled */ }
}

// Default = "live" (online only): users opening miki-moni almost always want
// to see what's running right now, not every stale session in their history.
// Persisted to LS so the user's choice — including clicking "all" back on —
// survives reloads.
const STATUS_FILTER_LS_KEY = "miki-moni:status-filter";
function loadStatusFilterFromLS(): StatusFilter {
  try {
    const raw = localStorage.getItem(STATUS_FILTER_LS_KEY);
    if (raw === "all" || raw === "live" || raw === "idle" || raw === "stale") return raw;
  } catch { /* SSR / disabled */ }
  return "live";
}
function saveStatusFilterToLS(v: StatusFilter): void {
  try { localStorage.setItem(STATUS_FILTER_LS_KEY, v); } catch { /* quota / disabled */ }
}

// Lower number = higher in list. "waiting" = Claude is blocked on user input —
// Miki the Monitor exists to surface those. Stale at the bottom because the
// session may be defunct.
function statusPriority(status: Session["status"]): number {
  switch (status) {
    case "waiting": return 0;
    case "active":  return 1;
    case "idle":    return 2;
    case "stale":   return 3;
    default:        return 4;
  }
}

// Pure compare functions. Each is deterministic given (a, b) — F5 produces the
// same ordering for the same session set (modulo last_event_at drift in "recent").
function comparePriority(a: Session, b: Session): number {
  const pa = statusPriority(a.status);
  const pb = statusPriority(b.status);
  if (pa !== pb) return pa - pb;
  return a.cwd.localeCompare(b.cwd);
}
function compareUuid(a: Session, b: Session): number {
  // Sort by session_uuid — opaque but completely stable: a session keeps the
  // exact same slot across F5 / restarts for its entire lifetime. Sessions with
  // a null uuid (rare: row created before SDK init landed) sink to the bottom.
  const au = a.session_uuid;
  const bu = b.session_uuid;
  if (au && bu) return au.localeCompare(bu);
  if (au) return -1;
  if (bu) return 1;
  return a.cwd.localeCompare(b.cwd);
}
function compareRecent(a: Session, b: Session): number {
  // DESC by last_event_at; tiebreak by cwd so two sessions with identical
  // timestamps still produce a stable order.
  if (a.last_event_at !== b.last_event_at) return b.last_event_at - a.last_event_at;
  return a.cwd.localeCompare(b.cwd);
}
function compareFor(mode: SortMode): (a: Session, b: Session) => number {
  switch (mode) {
    case "uuid":   return compareUuid;
    case "recent": return compareRecent;
    case "priority":
    default:       return comparePriority;
  }
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
  // Subscribe to locale changes so the whole tree re-renders when the user
  // switches language. Most components call `t()` directly; we keep the value
  // here for the language switcher highlight in the settings panel.
  const [currentLocale] = useLocale();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  // Live activity label per wrapped session ("Ideating" / "Using Bash" / null).
  const [activities, setActivities] = useState<Record<string, string>>({});
  // Live streaming assistant text per session — populated by assistant_delta WS
  // messages while a turn is in progress. Cleared on assistant_delta_end. When
  // present, overrides preview.last_assistant_text so the cell preview / modal
  // shows token-by-token output instead of waiting for full turn.
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  // Optimistic user-message overlay per session — populated by user_message WS
  // (wrap.ts emits this the instant Enter is pressed, before SDK flushes to
  // JSONL). The small card's "user" line reads this first; we drop it once the
  // canonical /sessions/previews response's last_user_ts catches up.
  const [userOverlay, setUserOverlay] = useState<Record<string, { text: string; ts: number }>>({});
  // Pending AskUserQuestion per session — Claude is waiting for a pick.
  const [asks, setAsks] = useState<Record<string, PendingAsk>>({});
  // Asks the user clicked-away from (modal closed but question still unanswered).
  // Card flashes red + shows 🔔 button to re-open. Submitted / wrap-side answered clears.
  const [dismissedAsks, setDismissedAsks] = useState<Set<string>>(new Set());
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [clientTypes, setClientTypesState] = useState<Record<string, ClientType>>(() => loadClientTypesFromLS());
  const [sendKey, setSendKeyState] = useState<SendKey>(() => loadSendKeyFromLS());
  const [theme, setThemeState] = useState<Theme>(() => loadThemeFromLS());
  const [showSettings, setShowSettings] = useState(false);
  const [modalFor, setModalFor] = useState<Session | null>(null);
  // Modal transcript — lifted up from Card so the App-level WS handler +
  // polling tick own a single update pipeline for all session data shown in
  // any view (small cells AND the modal big-card). Card is a pure renderer.
  const [transcript, setTranscript] = useState<TranscriptResp | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptLimit, setTranscriptLimit] = useState(20);
  // Whether the transcript modal includes TOOL turns. Owned by App so:
  //   (a) it persists across modal open/close
  //   (b) loadTranscript can over-fetch when tools are hidden — otherwise
  //       the user-selected "20 條" leaks tool turns into the budget and
  //       the modal shows < 20 actual conversation rows.
  const [showTools, setShowTools] = useState(false);
  // Cache the latest (mtime, size) we've seen so the 2s polling fallback
  // can short-circuit when nothing changed.
  const transcriptMetaRef = useRef<{ last_modified: string; file_size: number } | null>(null);
  // If /transcript-meta 404s (older daemon without the endpoint), suspend
  // the meta-check optimization for 5s and just refetch directly.
  const transcriptMeta404UntilRef = useRef<number>(0);
  // Mirror of modalFor's session_uuid for use inside the WS handler + 2s
  // polling tick (both set up in a useEffect with [] deps — they would
  // otherwise capture the initial null value).
  const modalSessionUuidRef = useRef<string | null>(null);
  // And transcriptLimit, same reason.
  const transcriptLimitRef = useRef<number>(20);
  const showToolsRef = useRef<boolean>(false);

  // Effective server-side limit: when tools are hidden, over-fetch so the
  // displayed (filtered) count actually reaches the user's chosen limit.
  // 4× covers typical assistant→tool→user→tool ratios in Claude Code
  // transcripts. Cap at 10000 (matches the "load all" option).
  function effectiveLimit(limit: number, withTools: boolean): number {
    if (withTools) return limit;
    return Math.min(10000, limit * 4);
  }
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>(() => loadStatusFilterFromLS());
  function setStatusFilter(v: StatusFilter) {
    setStatusFilterState(v);
    saveStatusFilterToLS(v);
  }
  const [sortMode, setSortModeState] = useState<SortMode>(() => loadSortModeFromLS());

  function setSendKey(v: SendKey) {
    setSendKeyState(v);
    saveSendKeyToLS(v);
  }
  function setTheme(v: Theme) {
    setThemeState(v);
    saveThemeToLS(v);
  }
  function setSortMode(v: SortMode) {
    setSortModeState(v);
    saveSortModeToLS(v);
  }

  // Apply theme on mount + when it changes. In "system" mode, also listen for
  // OS-level prefers-color-scheme changes so miki-moni flips alongside the OS.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);
  function openCellModal(s: Session) {
    setModalFor(s);
  }
  function closeCellModal() {
    setModalFor(null);
    // Clear transcript so a stale session's body doesn't flash on next open.
    setTranscript(null);
    setTranscriptError(null);
    transcriptMetaRef.current = null;
  }

  // Keep refs in sync with state so the WS handler and 2s polling tick
  // (both [] -deps useEffects) can read the latest values.
  useEffect(() => {
    modalSessionUuidRef.current = modalFor?.session_uuid ?? null;
  }, [modalFor]);
  useEffect(() => {
    transcriptLimitRef.current = transcriptLimit;
  }, [transcriptLimit]);
  useEffect(() => {
    showToolsRef.current = showTools;
  }, [showTools]);

  // Initial-load when modal opens, limit changes, or showTools toggles.
  // (showTools changes the effective server-side fetch budget — see
  // effectiveLimit — so we must refetch.) WS-driven refreshes happen
  // later via scheduleRefresh; the 2s polling tick acts as backup.
  useEffect(() => {
    const uuid = modalFor?.session_uuid;
    if (!uuid) return;
    void loadTranscript(uuid, effectiveLimit(transcriptLimit, showTools));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalFor?.session_uuid, transcriptLimit, showTools]);

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

  // Popover state
  const [popoverFor, setPopoverFor] = useState<{ s: Session; x: number; y: number } | null>(null);

  function addLog(level: LogEntry["level"], msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx };
    setLog((prev) => [entry, ...prev].slice(0, ACT_LOG_MAX));
    // Only mirror warn / error to F12 console. The 2s previews-poll loop +
    // every WS session_changed used to spam clog on info level, drowning out
    // real issues. The in-memory log buffer (ActivityLog) still keeps all
    // info entries for debugging without burning F12 attention.
    if (level === "error") cerr(msg, ctx);
    else if (level === "warn") cwarn(msg, ctx);
  }

  async function loadPreviews() {
    try {
      const r = await apiFetch("/sessions/previews");
      if (!r.ok) { addLog("warn", `GET /sessions/previews ${r.status}`); return; }
      const arr: SessionPreview[] = await r.json();
      const map: Record<string, SessionPreview> = {};
      for (const p of arr) map[p.session_uuid] = p;
      setPreviews(map);
      // Drop optimistic user overlays once the canonical JSONL preview has
      // caught up (last_user_ts ≥ overlay.ts). Keeps the overlay visible across
      // poll ticks where JSONL hasn't flushed yet, then yields cleanly.
      setUserOverlay((prev) => {
        let mutated = false;
        const next: typeof prev = {};
        for (const [uuid, ov] of Object.entries(prev)) {
          const p = map[uuid];
          const pTs = p?.last_user_ts ? Date.parse(p.last_user_ts) : 0;
          if (pTs && pTs >= ov.ts) { mutated = true; continue; }
          next[uuid] = ov;
        }
        return mutated ? next : prev;
      });
      addLog("info", `previews loaded`, { count: arr.length });
    } catch (e) {
      addLog("error", "previews fetch throw", { error: String(e) });
    }
  }

  // Unified transcript fetcher. Called from:
  //   1. Modal open (initial load)
  //   2. transcriptLimit change (user select)
  //   3. scheduleRefresh fire (WS-driven, same pipeline as previews)
  //   4. 2s polling tick — but only when maybeRefreshTranscript decides it's needed
  async function loadTranscript(uuid: string, limit: number) {
    if (!uuid) return;
    setTranscriptLoading(true);
    setTranscriptError(null);
    try {
      const r = await apiFetch(`/sessions/${encodeURIComponent(uuid)}/transcript?limit=${limit}`);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        setTranscriptError(`HTTP ${r.status}: ${body.slice(0, 200)}`);
        return;
      }
      const data: TranscriptResp = await r.json();
      setTranscript(data);
      transcriptMetaRef.current = { last_modified: data.last_modified, file_size: data.file_size };
      addLog("info", "transcript loaded", { session_uuid: uuid, turns: data.turn_count });
    } catch (e) {
      setTranscriptError(String(e));
    } finally {
      setTranscriptLoading(false);
    }
  }

  // Polling-tick variant: cheap mtime/size check; only refetch on change.
  // Belt-and-suspenders against missed WS events / wrap-sessions whose hooks
  // didn't fire. Identical contract to the per-Card poller that used to live
  // inside the component — now centralised at App level.
  async function maybeRefreshTranscript(uuid: string, limit: number) {
    if (!uuid) return;
    if (Date.now() < transcriptMeta404UntilRef.current) {
      // /transcript-meta unavailable; suspended for 5s, retry passively.
      return;
    }
    try {
      const r = await apiFetch(`/sessions/${encodeURIComponent(uuid)}/transcript-meta`);
      if (r.status === 404) {
        transcriptMeta404UntilRef.current = Date.now() + 5000;
        cwarn("transcript-meta 404 — meta poll paused for 5s (restart daemon to re-enable)");
        return;
      }
      if (!r.ok) return;
      const meta: { last_modified: string; file_size: number } = await r.json();
      const prev = transcriptMetaRef.current;
      if (!prev || meta.last_modified !== prev.last_modified || meta.file_size !== prev.file_size) {
        void loadTranscript(uuid, limit);
      }
    } catch { /* network blip — next tick retries */ }
  }

  useEffect(() => {
    addLog("info", t("startup.starting"));
    apiFetch("/sessions").then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j })))
      .then((r) => {
        if (!r.ok) { addLog("error", t("startup.getSessionsFailed"), { status: r.status }); return; }
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
        addLog("info", t("startup.gotSessions", { n: list.length }));
        void loadPreviews();
      })
      .catch((e) => addLog("error", `GET /sessions throw`, { error: String(e) }));

    // apiWebSocket picks the right transport (local same-origin WS or tunneled
    // over the encrypted CF Worker relay) based on the bootstrap setup.
    addLog("info", t("startup.wsConnecting"), { url: "/ws (via transport)" });
    let currentSocket: ReturnType<typeof apiWebSocket> | null = null;
    let reconnectAttempts = 0;
    let cancelled = false;
    function connectWs(): void {
      if (cancelled) return;
      const ws = apiWebSocket("/ws");
      currentSocket = ws;
      ws.onopen = () => {
        setWsConn("open");
        if (reconnectAttempts > 0) {
          // Pick up anything we missed while disconnected — daemon may have
          // restarted, sessions may have changed status, new activities started.
          addLog("info", `WS reconnected after ${reconnectAttempts} attempt(s) — refetching state`);
          apiFetch("/sessions").then((r) => r.json()).then((list: Session[]) => {
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
      } else if (msg.type === "activity") {
        const uuid = msg.session_uuid as string;
        const label = typeof msg.label === "string" ? msg.label : null;
        setActivities((prev) => {
          if (!label) { const next = { ...prev }; delete next[uuid]; return next; }
          if (prev[uuid] === label) return prev;
          return { ...prev, [uuid]: label };
        });
      } else if (msg.type === "assistant_delta_start") {
        // New assistant text block starting — reset the streaming buffer
        // (covers the case where a turn has multiple text blocks).
        const uuid = msg.session_uuid as string;
        addLog("info", "WS assistant_delta_start", { uuid: uuid.slice(0, 8) });
        setStreaming((prev) => ({ ...prev, [uuid]: "" }));
      } else if (msg.type === "assistant_delta") {
        const uuid = msg.session_uuid as string;
        const chunk = typeof msg.text === "string" ? msg.text : "";
        if (!chunk) return;
        setStreaming((prev) => ({ ...prev, [uuid]: (prev[uuid] ?? "") + chunk }));
      } else if (msg.type === "assistant_delta_end") {
        // Turn complete — drop the streaming buffer. The next preview poll
        // (within ~2s) replaces it with the canonical text from JSONL, so
        // there's no visual gap. Also schedule a unified refresh so the
        // modal transcript snaps to the canonical JSONL state without
        // waiting for the followup hook-driven session_changed.
        const uuid = msg.session_uuid as string;
        addLog("info", "WS assistant_delta_end", { uuid: uuid.slice(0, 8) });
        setStreaming((prev) => { const next = { ...prev }; delete next[uuid]; return next; });
        scheduleRefresh();
      } else if (msg.type === "user_message") {
        // Wrap-side optimistic user-text overlay. Stash it so the small card's
        // user line repaints immediately; the next /sessions/previews response
        // with last_user_ts ≥ ts will clear it (see loadPreviews).
        const uuid = msg.session_uuid as string;
        const text = typeof msg.text === "string" ? msg.text : "";
        const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
        if (uuid && text) {
          setUserOverlay((prev) => ({ ...prev, [uuid]: { text, ts } }));
        }
      } else if (msg.type === "ask_question") {
        const uuid = msg.session_uuid as string;
        const ask: PendingAsk = { question_id: msg.question_id, questions: msg.questions };
        setAsks((prev) => ({ ...prev, [uuid]: ask }));
      } else if (msg.type === "ask_question_done") {
        const uuid = msg.session_uuid as string;
        setAsks((prev) => { const next = { ...prev }; delete next[uuid]; return next; });
        setDismissedAsks((prev) => { const next = new Set(prev); next.delete(uuid); return next; });
      }
    }
    connectWs();

    // Polling fallback for cell previews — same idea as the modal's 2s
    // transcript-meta poll, but cheaper: one GET /sessions/previews per tick
    // refreshes every cell's last-tool / last-assistant / last-user lines
    // regardless of whether hooks fired. Catches the case where a rapid burst
    // of tool events starves the debounced refresh path, AND the case where
    // a wrap session writes to JSONL between hook events.
    const pollIntervalId = window.setInterval(() => {
      if (cancelled) return;
      // Re-fetch the full session list too — without this, new VSCode panels
      // (whose hooks fired after WS reconnect, or with broken hooks) never
      // appear in the dashboard until F5. /sessions is cheap (in-memory map),
      // so refreshing alongside previews is fine.
      void apiFetch("/sessions").then((r) => r.ok ? r.json() : null).then((list: Session[] | null) => {
        if (!list || cancelled) return;
        setSessions((prev) => {
          // Drop sessions that disappeared from the server but keep manual ordering
          // for ones still present. Last-write-wins from server payload otherwise.
          const byUuid = new Map(list.map((s) => [s.session_uuid ?? s.cwd, s] as const));
          const seen = new Set<string>();
          const merged: Session[] = [];
          for (const old of prev) {
            const key = old.session_uuid ?? old.cwd;
            const fresh = byUuid.get(key);
            if (fresh) { merged.push(fresh); seen.add(key); }
          }
          for (const s of list) {
            const key = s.session_uuid ?? s.cwd;
            if (!seen.has(key)) merged.push(s);
          }
          return merged.sort((a, b) => b.last_event_at - a.last_event_at);
        });
        // Also pick up activity / pending_ask seeded on /sessions responses.
        const seedAct: Record<string, string> = {};
        for (const s of list) {
          if (s.session_uuid && (s as any).activity) seedAct[s.session_uuid] = (s as any).activity;
        }
        setActivities((prev) => ({ ...prev, ...seedAct }));
      }).catch(() => { /* network blip — next tick retries */ });
      void loadPreviews();
      // Belt-and-suspenders for the modal transcript: cheap mtime/size
      // probe; only refetches /transcript when the JSONL actually changed.
      // Same 2s cadence as previews, so small-card and big-card see the
      // same picture.
      const muuid = modalSessionUuidRef.current;
      if (muuid) void maybeRefreshTranscript(muuid, effectiveLimit(transcriptLimitRef.current, showToolsRef.current));
    }, 2000);

    return () => {
      cancelled = true;
      if (currentSocket) currentSocket.close();
      window.clearInterval(pollIntervalId);
    };
  }, []);

  // Debounce previews refresh — many session_changed events in a row should
  // still batch into one IO sweep, but 1500ms was too long: user-perceived lag
  // between "wrap finished replying" (status flips on WS) and "new turn shows
  // up in the cell preview" (depends on this refresh). 300ms keeps the batch
  // benefit on rapid-fire events while feeling snappy.
  // Trailing debounce + max-wait throttle. Pure debounce was getting starved
  // during rapid tool-use bursts (pre_tool_use / post_tool_use back-to-back
  // at <300ms each kept resetting the timer indefinitely → cell preview
  // frozen). max-wait fires the refresh after MAX_REFRESH_INTERVAL_MS from
  // the first event in a burst, even if events keep arriving.
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const refreshMaxTimerRef = useRef<number | undefined>(undefined);
  const MAX_REFRESH_INTERVAL_MS = 1500;
  function scheduleRefresh() {
    function fire() {
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = undefined; }
      if (refreshMaxTimerRef.current) { clearTimeout(refreshMaxTimerRef.current); refreshMaxTimerRef.current = undefined; }
      void loadPreviews();
      // Same pipeline updates the modal transcript when one is open. Reads
      // from refs because the WS handler that calls scheduleRefresh() was
      // set up under [] deps and would otherwise see stale modalFor=null.
      const muuid = modalSessionUuidRef.current;
      if (muuid) void loadTranscript(muuid, effectiveLimit(transcriptLimitRef.current, showToolsRef.current));
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(fire, 300);
    if (!refreshMaxTimerRef.current) {
      refreshMaxTimerRef.current = window.setTimeout(fire, MAX_REFRESH_INTERVAL_MS);
    }
  }

  async function onFocus(uuid: string) {
    addLog("info", "POST /focus", { uuid: uuid.slice(0, 8) });
    try {
      const r = await apiFetch("/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/focus ${r.status}`, { url: body?.url });
      return { ok: r.ok, status: r.status, url: body?.url };
    } catch (e) { addLog("error", "/focus throw", { error: String(e) }); return { ok: false, status: 0 }; }
  }
  async function onSend(uuid: string, prompt: string, submit: boolean, images?: AttachedImage[]) {
    const imgPayload = images?.map(({ media_type, data }) => ({ media_type, data }));
    addLog("info", `POST /send (mode=${submit ? "submit" : "prefill"})`, { uuid: uuid.slice(0, 8), len: prompt.length, images: imgPayload?.length ?? 0 });
    try {
      const r = await apiFetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid, prompt, submit, images: imgPayload }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/send ${r.status}`, { mode: body?.mode, reply_preview: body?.reply?.slice(0, 60), duration_ms: body?.duration_ms, diag: body?.diag });
      // refresh previews so the cell shows the new reply
      if (r.ok && submit) scheduleRefresh();
      return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms, diag: body?.diag, error: body?.error };
    } catch (e) { addLog("error", "/send throw", { error: String(e) }); return { ok: false, status: 0 }; }
  }


  function openQuickSend(s: Session, x: number, y: number) {
    setPopoverFor({ s, x, y });
  }

  const sessionByUuid = useMemo(() => {
    const m = new Map<string, Session>();
    for (const s of sessions) if (s.session_uuid) m.set(s.session_uuid, s);
    return m;
  }, [sessions]);

  // De-duped, recency-sorted list of session cwds. Used to populate the
  // NewCliButton's <datalist> so users get autocomplete on common folders
  // without us building a separate "recent cwds" persistence layer.
  const recentCwds = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of sessions) {
      const c = s.cwd;
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      if (out.length >= 30) break;
    }
    return out;
  }, [sessions]);

  return (
    <div class="app-shell">
      {/* Top nav */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)", position: "relative" }}>
        <h1
          style={{ margin: 0, display: "inline-flex", alignItems: "center", color: "var(--fg)" }}
          title="miki-moni"
          aria-label="miki-moni"
        >
          <IconSleepingCat size={24} />
        </h1>
        <HeaderStats sessions={sessions} filter={statusFilter} onFilter={setStatusFilter} />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-subtle)" }}>
          <NewCliButton recentCwds={recentCwds} />
          <button
            class="btn-ghost"
            style={{ fontSize: 11, padding: "2px 6px", display: "inline-flex", alignItems: "center" }}
            onClick={() => setShowSettings((v) => !v)}
            title={t("settings.title")}
            aria-label={t("settings.title")}
          ><IconSettings size={14} /></button>
        </div>
        {showSettings && (
          <div
            class="settings-popover"
            style={{
              position: "absolute", top: "100%", right: 0, marginTop: 6, zIndex: 50,
              background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "12px 14px", minWidth: 280, boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
              // Constrain to viewport so a tall popover (multi-section settings)
              // doesn't overflow off-screen on mobile / short viewports / when
              // there's no card content to push the page taller. 100px leaves
              // room for the header above + a few px breathing room.
              maxHeight: "calc(100vh - 100px)",
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("settings.sendKeySection")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="miki-moni-send-key"
                  checked={sendKey === "enter"}
                  onChange={() => setSendKey("enter")}
                />
                <span><strong>{t("settings.enterLabel")}</strong>{t("settings.enterDesc")}</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="miki-moni-send-key"
                  checked={sendKey === "ctrl-enter"}
                  onChange={() => setSendKey("ctrl-enter")}
                />
                <span><strong>{t("settings.ctrlEnterLabel")}</strong>{t("settings.ctrlEnterDesc")}</span>
              </label>
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 8, lineHeight: 1.5 }}>
              {t("settings.sendKeyHelp")}
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 14, marginBottom: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>{t("settings.appearance")}</div>
            <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
              {(["light", "dark", "system"] as Theme[]).map((th) => (
                <button
                  key={th}
                  class="btn-outline"
                  style={{
                    flex: 1, height: 28, padding: "0 8px", fontSize: 11,
                    borderColor: theme === th ? "var(--fg)" : "var(--border)",
                    background: theme === th ? "var(--sl3)" : "var(--bg)",
                    fontWeight: theme === th ? 600 : 400,
                  }}
                  onClick={() => setTheme(th)}
                  title={th === "system" ? t("settings.themeSystemTitle") : th === "dark" ? t("settings.themeDarkTitle") : t("settings.themeLightTitle")}
                >{th === "light" ? t("settings.themeLight") : th === "dark" ? t("settings.themeDark") : t("settings.themeSystem")}</button>
              ))}
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 14, marginBottom: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>{t("settings.sortMode")}</div>
            <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
              {([
                { v: "priority", labelKey: "settings.sortPriorityLabel", titleKey: "settings.sortPriorityTitle" },
                { v: "uuid",     labelKey: "settings.sortUuidLabel",     titleKey: "settings.sortUuidTitle" },
                { v: "recent",   labelKey: "settings.sortRecentLabel",   titleKey: "settings.sortRecentTitle" },
              ] as { v: SortMode; labelKey: string; titleKey: string }[]).map((opt) => (
                <button
                  key={opt.v}
                  class="btn-outline"
                  style={{
                    flex: 1, height: 28, padding: "0 6px", fontSize: 11,
                    borderColor: sortMode === opt.v ? "var(--fg)" : "var(--border)",
                    background: sortMode === opt.v ? "var(--sl3)" : "var(--bg)",
                    fontWeight: sortMode === opt.v ? 600 : 400,
                  }}
                  onClick={() => setSortMode(opt.v)}
                  title={t(opt.titleKey)}
                >{t(opt.labelKey)}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 6, lineHeight: 1.5 }}>
              {t("settings.sortHelp")}
            </div>

            {/* Language selector — added 2026-05-17. Switches the entire UI
                between 繁體中文 / 简体中文 / English; persisted to localStorage. */}
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 14, marginBottom: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>{t("settings.language")}</div>
            <div style={{ display: "flex", gap: 4, fontSize: 11 }}>
              {LOCALES.map((lc) => {
                const active = currentLocale === lc;
                return (
                  <button
                    key={lc}
                    class="btn-outline"
                    style={{
                      flex: 1, height: 28, padding: "0 6px", fontSize: 11,
                      borderColor: active ? "var(--fg)" : "var(--border)",
                      background: active ? "var(--sl3)" : "var(--bg)",
                      fontWeight: active ? 600 : 400,
                    }}
                    onClick={() => setLocaleGlobal(lc)}
                    title={LOCALE_LABELS[lc]}
                  >{LOCALE_LABELS[lc]}</button>
                );
              })}
            </div>

            <div style={{ marginTop: 10, textAlign: "right" }}>
              <button class="btn-ghost" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setShowSettings(false)}>{t("settings.close")}</button>
            </div>
          </div>
        )}
      </header>

      {/* Dashboard — single view. Tabs removed; click a cell to open the
          modal big-card. Modal owns its own expanded transcript view. */}
      <div style={{ marginTop: 12, marginBottom: 20 }} />
      {sessions.length === 0 ? (
        <div class="card" style={{ padding: "24px 14px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
          <div>{t("overview.noSessions")}</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>{t("overview.openPanelHint")}</div>
          <div style={{ fontSize: 11 }}>{t("overview.runHooks")}<code>pnpm install:hooks</code></div>
        </div>
      ) : (
        <GridOverview
          sessions={sessions.filter((s) => {
            if (statusFilter === "all") return true;
            if (statusFilter === "live") return s.status === "active" || s.status === "waiting";
            return s.status === statusFilter;
          })}
          sortMode={sortMode}
          previews={previews}
          activities={activities}
          streaming={streaming}
          userOverlay={userOverlay}
          pendingAsks={asks}
          dismissedAsks={dismissedAsks}
          onReopenAsk={(uuid) => setDismissedAsks((prev) => { const next = new Set(prev); next.delete(uuid); return next; })}
          getClientType={getClientType}
          onSetClientType={setClientType}
          onQuickSend={openQuickSend}
          onOpenModal={openCellModal}
        />
      )}

      {/* Activity log hidden — events still flow to F12 console via clog/cwarn/cerr */}
      {false && <ActivityLog entries={log} onClear={() => setLog([])} />}

      {/* Pre-spawn confirm dialog. Catches the 🔌 click BEFORE we POST
          /wrap/start, so the wt window doesn't pop up until the user has
          ticked "I closed the VSCode panel" + hit Confirm. */}
      <WrapConfirmDialog sessionByUuid={sessionByUuid} />

      {/* Loading banner shown after "新增 CLI > Open" — bridges the gap
          between spawning wt.exe and a real session card appearing in the
          grid. Watches `sessions` to auto-dismiss when the wrap connects. */}
      <SpawnPendingBanner sessions={sessions} />

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
          pendingAsk={modalFor.session_uuid ? asks[modalFor.session_uuid] : undefined}
          askDismissed={modalFor.session_uuid ? dismissedAsks.has(modalFor.session_uuid) : false}
          onReopenAsk={(uuid) => setDismissedAsks((prev) => { const next = new Set(prev); next.delete(uuid); return next; })}
          activity={modalFor.session_uuid ? activities[modalFor.session_uuid] : undefined}
          transcript={transcript}
          transcriptLoading={transcriptLoading}
          transcriptError={transcriptError}
          transcriptLimit={transcriptLimit}
          onSetTranscriptLimit={setTranscriptLimit}
          onReloadTranscript={() => { if (modalFor.session_uuid) void loadTranscript(modalFor.session_uuid, effectiveLimit(transcriptLimit, showTools)); }}
          showTools={showTools}
          onSetShowTools={setShowTools}
          streamingText={modalFor.session_uuid ? streaming[modalFor.session_uuid] : undefined}
          userOverlayText={modalFor.session_uuid ? userOverlay[modalFor.session_uuid]?.text : undefined}
          userOverlayTs={modalFor.session_uuid ? userOverlay[modalFor.session_uuid]?.ts : undefined}
        />
      )}

      {/* AskUserQuestion modal — Claude is waiting for the user to pick options */}
      {(() => {
        // Show first ask that's NOT been dismissed by the user.
        const askUuid = Object.keys(asks).find((u) => !dismissedAsks.has(u));
        if (!askUuid) return null;
        const ask = asks[askUuid]!;
        const s = sessionByUuid.get(askUuid);
        return (
          <AskQuestionModal
            sessionUuid={askUuid}
            ask={ask}
            onSubmitted={() => {
              setAsks((prev) => { const next = { ...prev }; delete next[askUuid]; return next; });
              setDismissedAsks((prev) => { const next = new Set(prev); next.delete(askUuid); return next; });
              addLog("info", `ask answered`, { uuid: askUuid.slice(0, 8), project: s?.project_name });
            }}
            onDismiss={() => {
              // Modal closed but question still pending — flag it so card pulses red + shows 🔔.
              setDismissedAsks((prev) => { const next = new Set(prev); next.add(askUuid); return next; });
            }}
          />
        );
      })()}
    </div>
  );
}

// Render is invoked from the bootstrap (web/main.tsx or web-phone/main.tsx),
// which installs the right Transport *before* mounting. Local-build's
// bootstrap is in this same directory; tunnel-build's bootstrap is in
// web-phone/ and mounts <App /> here after pairing + TunnelTransport setup.
export { App };
export function mountApp(): void {
  render(<App />, document.getElementById("app")!);
}

// Auto-mount when loaded directly (back-compat: the local index.html still
// uses `<script type="module" src="/app.tsx">`). If a bootstrap module has
// already installed a transport, we mount immediately; otherwise we install
// the local one and mount. This keeps `pnpm dev` working without touching
// web/index.html.
import { getTransport, setTransport } from "./api";
import { LocalHttpTransport } from "./transport-local";
try { getTransport(); } catch { setTransport(new LocalHttpTransport()); }
mountApp();
