import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { marked } from "marked";
import { t, useLocale, setLocale as setLocaleGlobal, LOCALES, LOCALE_LABELS, type Locale } from "@shared/i18n";
import { stripCodexBrowserContext } from "@shared/codex-display";
import { apiFetch, apiWebSocket } from "./api";
import { assembleRenderTurns } from "./lib/transcript-assembly";
import { loadHiddenSet, addHidden, removeHidden, HIDDEN_KEY } from "./lib/hidden-sessions.js";

// Build-time constant injected by vite.config.ts `define`. Holds the
// `version` field of package.json so the settings popover can show users
// which build they're running without us shipping a runtime /version
// endpoint.
declare const __APP_VERSION__: string;

// ── Types ──────────────────────────────────────────────────────────────────

type AgentId = "claude" | "codex";

interface Session {
  cwd: string;
  session_uuid: string | null;
  agent?: AgentId;
  project_name: string;
  status: "active" | "waiting" | "idle" | "stale";
  last_event_at: number;
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
  wrapped?: boolean;  // true if a `miki claude` wrapper is actively connected
  activity?: string | null;  // "Ideating" / "Using Bash" / "Replying" / null — live wrapper state
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | null;
  // Active SDK model the wrap session is running on. Empty string = SDK
  // default (no --model override). null = not wrapped / unknown.
  current_model?: string | null;
  // Active reasoning-effort level (low / medium / high / xhigh / max).
  // Empty string = SDK default. null = not wrapped / unknown.
  current_effort?: string | null;
  pending_ask?: PendingAsk | null;
}

interface AskOption { label: string; description: string }
interface AskQuestion { question: string; header: string; multiSelect?: boolean; options: AskOption[] }
interface PendingAsk { question_id: string; questions: AskQuestion[] }

// Mirrors VersionInfo from src/version-check.ts. Settings popover shows
// the badge whenever `hasUpdate` is true; we never act on the `error`
// field beyond hiding the badge (failure = silent).
interface UpdateInfo {
  current:   string;
  latest:    string | null;
  hasUpdate: boolean;
  fetchedAt: number;
  error:     "npm_unreachable" | "timeout" | null;
}

interface ToolUseInfo { id: string; name: string; description?: string; input: unknown; input_summary: string }
interface ToolResultInfo { tool_use_id?: string; content: string; truncated: boolean; is_error?: boolean }
interface TranscriptTurn { ts: string; role: "user" | "assistant" | "system"; text: string; tool_use?: ToolUseInfo; tool_result?: ToolResultInfo; images?: Array<{ media_type: string; data: string }>; raw_type?: string }
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

function agentOf(s: Pick<Session, "agent">): AgentId {
  return s.agent === "codex" ? "codex" : "claude";
}

const CODEX_PREVIEW_ACTIVE_MS = 15 * 60 * 1000;

function displaySession(s: Session, preview?: SessionPreview): Session {
  if (agentOf(s) !== "codex" || s.status !== "stale") return s;
  const previewIsNewer = (preview?.last_modified_ms ?? 0) > s.last_event_at;
  const previewIsRecent = Date.now() - (preview?.last_modified_ms ?? 0) <= CODEX_PREVIEW_ACTIVE_MS;
  if (previewIsNewer && previewIsRecent) return { ...s, status: "active", last_event_at: preview!.last_modified_ms };
  const sessionPreviewIsRecent = Date.now() - s.last_event_at <= CODEX_PREVIEW_ACTIVE_MS;
  return s.last_message_preview && sessionPreviewIsRecent ? { ...s, status: "active" } : s;
}

function agentLabel(agent: AgentId): string {
  return agent === "codex" ? "codex" : "claude";
}

function userFacingWrapError(error: unknown, status: number): string {
  const key = typeof error === "string" ? error : "";
  if (key === "codex_wrap_unsupported") return t("wrapNotice.codexUnsupported");
  if (key === "session already wrapped") return t("wrapNotice.alreadyWrapped");
  if (key === "session not found") return t("wrapNotice.sessionNotFound");
  return key || `HTTP ${status}`;
}

const OPENAI_LOGO_PATH = "M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z";
const CLAUDE_LOGO_PATH = "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.158-.134-.097-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.146-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.728.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

function AgentLogo({ agent }: { agent: AgentId }) {
  return (
    <span class={`agent-logo agent-logo-${agent}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d={agent === "codex" ? OPENAI_LOGO_PATH : CLAUDE_LOGO_PATH} />
      </svg>
    </span>
  );
}

function AgentBadge({ agent }: { agent: AgentId }) {
  return (
    <span
      class={`agent-badge agent-badge-${agent}`}
      title={agent === "codex" ? "Codex session" : "Claude session"}
    >
      <AgentLogo agent={agent} />
    </span>
  );
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
  // Clamp negative deltas to 0. Server clock skew, just-fired events whose
  // ts is "now + a few ms", or post-set state reads can otherwise produce
  // "-1 秒前" which looks broken.
  const ms = Math.max(0, Date.now() - ts);
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
function IconX({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function IconUndo({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </svg>
  );
}

// ── Update badge ──────────────────────────────────────────────────────

function UpdateBadge({ latest }: { latest: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied]     = useState(false);
  const cmd = "npm i -g miki-moni@latest";

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (insecure context, permission denied) —
      // silent fallback; the command is still visible inline.
    }
  }

  return (
    <>
      <button
        class="btn-ghost"
        style={{
          fontSize: 10,
          padding: "0 4px",
          marginLeft: 4,
          color: "var(--accent, #4f6dff)",
          fontVariantNumeric: "tabular-nums",
        }}
        onClick={() => setExpanded((v) => !v)}
        title={t("settings.updateAvailable")}
      >→ v{latest}</button>
      {expanded && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            borderRadius: 4,
            background: "var(--sl3)",
            fontSize: 10,
            color: "var(--fg)",
            lineHeight: 1.4,
          }}
        >
          <div style={{ marginBottom: 4 }}>{t("settings.updateAvailable")}: <strong>{latest}</strong></div>
          <div style={{ marginBottom: 4 }}>{t("settings.updateInstall")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <code style={{
              flex: 1,
              padding: "2px 4px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              fontFamily: "monospace",
              fontSize: 10,
            }}>{cmd}</code>
            <button
              class="btn-ghost"
              style={{ fontSize: 10, padding: "1px 6px" }}
              onClick={() => { void copy(); }}
            >{copied ? "✓" : t("settings.updateCopy")}</button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Close card button ──────────────────────────────────────────────────
//
// State-aware top-right button for each grid cell:
//   - wrapped   → IconStop  → POST /wrap/stop  (cell flips non-wrapped)
//   - non-wrap  → IconX     → hide locally     (cell disappears)
//   - hidden    → IconUndo  → un-hide locally  (cell returns)
//
// Failure of /wrap/stop is surfaced inline (red border + tooltip for 3s)
// matching ModelChip's pattern so we don't need a global toast system.
// localStorage failures are silent (in-memory state still works) — see
// web/lib/hidden-sessions.ts.

function CloseCardButton({
  sessionUuid, wrapped, isHiddenView, onHide, onUnhide,
}: {
  sessionUuid: string;
  wrapped: boolean;
  isHiddenView: boolean;
  onHide: (uuid: string) => void;
  onUnhide: (uuid: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handle(e: MouseEvent) {
    e.stopPropagation();
    if (!sessionUuid || pending) return;

    if (isHiddenView) {
      onUnhide(sessionUuid);
      return;
    }
    if (!wrapped) {
      onHide(sessionUuid);
      return;
    }

    // wrapped: kill via daemon
    setPending(true); setErr(null);
    try {
      const r = await apiFetch("/wrap/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: sessionUuid }),
      });
      if (!r.ok && r.status !== 404) {
        // 404 = already stopped (race with WS close). Treat as success.
        throw new Error(`HTTP ${r.status}`);
      }
      // No optimistic UI: daemon's WS session_changed event will flip wrapped=false.
    } catch (e: unknown) {
      setErr(String(e));
      window.setTimeout(() => setErr(null), 3000);
    } finally {
      setPending(false);
    }
  }

  const title = isHiddenView
    ? t("session.unhide")
    : wrapped
      ? t("session.closeWrapped")
      : t("session.closeHidden");

  const icon = isHiddenView
    ? <IconUndo size={11} />
    : wrapped
      ? <IconStop size={11} />
      : <IconX size={11} />;

  return (
    <button
      class="btn-ghost icon-btn"
      style={{
        padding: "3px 6px",
        opacity: pending ? 0.5 : 1,
        borderColor: err ? "var(--err, #d33)" : undefined,
      }}
      onClick={(e) => { void handle(e); }}
      title={err ?? title}
      disabled={!sessionUuid || pending}
    >{icon}</button>
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
function IconSliders({ size = 13 }: { size?: number }) {
  // Three horizontal sliders — signals "view options / settings for the
  // current panel" without pulling the heavier gear icon (which already
  // means global Settings elsewhere in the app).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" fill="var(--bg)" />
      <circle cx="15" cy="12" r="2" fill="var(--bg)" />
      <circle cx="7" cy="18" r="2" fill="var(--bg)" />
    </svg>
  );
}
function IconImagePlus({ size = 13 }: { size?: number }) {
  // Picture frame with a small `+` overlay — signals "attach image".
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <circle cx="8" cy="8" r="1.5" />
      <polyline points="3 14 8 10 13 14 17 11" />
      <line x1="19" y1="15" x2="19" y2="21" />
      <line x1="16" y1="18" x2="22" y2="18" />
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

function IconMonit({ size = 20, class: cls = "" }: { size?: number; class?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" class={cls}
         xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="4" width="16" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
      <path d="M5 11 L7.5 8 L10 10 L13 6.5 L15 8.5" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="7" y1="16" x2="13" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  );
}

interface MetricPoint { ts: number; value: number; }

function MetricChart({
  data,
  fleetAvg,
  label,
  unit,
  higherIsBetter,
}: {
  data: MetricPoint[];
  fleetAvg: number | null;
  label: string;
  unit: string;
  higherIsBetter: boolean;
}) {
  const W = 340, H = 90;

  if (data.length === 0) {
    return (
      <div class="flex flex-col gap-1">
        <div class="text-xs font-medium" style={{ color: "var(--fg-muted)" }}>{label}</div>
        <div class="flex items-center justify-center h-[90px] text-xs" style={{ color: "var(--fg-subtle)" }}>暫無資料</div>
      </div>
    );
  }

  const xs = data.map(d => d.ts);
  const ys = data.map(d => d.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxY = Math.max(...ys) * 1.25 || 1;

  const scaleX = (ts: number) => ((ts - minX) / (maxX - minX || 1)) * W;
  const scaleY = (v: number) => H - (v / maxY) * H;

  const pts = data.map(d => ({ x: scaleX(d.ts), y: scaleY(d.value), v: d.value }));
  const avgY = fleetAvg !== null ? scaleY(fleetAvg) : null;

  function buildAreaPath(points: typeof pts, above: boolean): string {
    if (avgY === null || points.length < 2) return "";
    const segs: Array<typeof pts> = [];
    let cur: typeof pts = [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i]!;
      const isAbove = pt.y < avgY;
      if ((above && isAbove) || (!above && !isAbove)) {
        cur.push(pt);
      } else {
        if (cur.length >= 1) segs.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 1) segs.push(cur);

    return segs.map(seg => {
      if (seg.length === 1) return "";
      const top = seg.map(p => `${p.x},${p.y}`).join(" ");
      const bot = `${seg[seg.length - 1]!.x},${avgY} ${seg[0]!.x},${avgY}`;
      return `M ${seg[0]!.x},${avgY} L ${top} L ${bot} Z`;
    }).join(" ");
  }

  const greenPath = buildAreaPath(pts, higherIsBetter);
  const redPath   = buildAreaPath(pts, !higherIsBetter);
  const linePts = pts.map(p => `${p.x},${p.y}`).join(" ");

  const lastVal = data[data.length - 1]?.value ?? 0;
  const fmt = (v: number) => unit === "ms" ? `${Math.round(v)}ms` : `${v.toFixed(1)}/s`;

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium" style={{ color: "var(--fg-muted)" }}>{label}</span>
        <span class="text-xs tabular-nums" style={{ color: "var(--fg)" }}>{fmt(lastVal)}</span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="overflow-visible">
        {avgY !== null && (
          <line x1={0} y1={avgY} x2={W} y2={avgY}
                stroke="var(--accent, #4f6dff)" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
        )}
        {greenPath && <path d={greenPath} fill="#22c55e" opacity="0.2"/>}
        {redPath   && <path d={redPath}   fill="#ef4444" opacity="0.2"/>}
        <polyline points={linePts} fill="none" stroke="var(--fg-subtle)" stroke-width="1.5"
                  stroke-linejoin="round" stroke-linecap="round"/>
        {pts.length > 0 && (
          <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y}
                  r="2.5" fill="var(--fg-subtle)"/>
        )}
      </svg>
      {avgY !== null && fleetAvg !== null && (
        <div class="flex items-center gap-3" style={{ fontSize: 10, color: "var(--fg-subtle)" }}>
          <span class="flex items-center gap-1">
            <span class="inline-block w-2 h-2 rounded-sm bg-green-500 opacity-60"/>
            {higherIsBetter ? "超越" : "超越"}
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block w-2 h-2 rounded-sm bg-red-500 opacity-60"/>
            落後
          </span>
          <span class="flex items-center gap-1">
            <span style={{ display: "inline-block", width: 16, borderTop: "1px dashed var(--accent, #4f6dff)", opacity: 0.7 }}/>
            fleet 平均 ({fmt(fleetAvg)})
          </span>
        </div>
      )}
    </div>
  );
}

type MetricWindow = "1h" | "6h" | "24h" | "48h";
type MetricAgentFilter = "all" | AgentId;

interface MetricsApiRow {
  ts: number; session_uuid: string;
  agent: AgentId | null;
  project_name?: string | null;
  cwd?: string | null;
  ttft_ms: number | null; tps: number | null;
  char_count: number; duration_ms: number;
}

interface MetricsApiResponse {
  metrics: MetricsApiRow[];
  fleet_avg_ttft: number | null;
  fleet_avg_tps: number | null;
  agent: AgentId | null;
  window_ms: number;
}

function MonitPanel({ onClose }: { onClose: () => void }) {
  const [window_, setWindow] = useState<MetricWindow>("24h");
  const [agentFilter, setAgentFilter] = useState<MetricAgentFilter>("all");
  const [data, setData] = useState<MetricsApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const doFetch = (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      const agentParam = agentFilter === "all" ? "" : `&agent=${agentFilter}`;
      fetch(`/metrics?window=${window_}${agentParam}`)
        .then(r => r.json())
        .then((d: MetricsApiResponse) => { if (!cancelled) { setData(d); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    };
    doFetch(true);
    const timer = setInterval(() => doFetch(false), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [window_, agentFilter]);

  const ttftPoints: MetricPoint[] = (data?.metrics ?? [])
    .filter(m => m.ttft_ms !== null)
    .map(m => ({ ts: m.ts, value: m.ttft_ms! }));

  const tpsPoints: MetricPoint[] = (data?.metrics ?? [])
    .filter(m => m.tps !== null)
    .map(m => ({ ts: m.ts, value: m.tps! }));

  const WINDOWS: MetricWindow[] = ["1h", "6h", "24h", "48h"];
  const AGENTS: Array<{ key: MetricAgentFilter; label: string }> = [
    { key: "all", label: "全部" },
    { key: "claude", label: "Claude" },
    { key: "codex", label: "Codex" },
  ];

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-end pointer-events-none">
      <div class="pointer-events-auto mt-14 mr-2 w-[400px] max-w-[calc(100vw-16px)] rounded-lg flex flex-col overflow-hidden"
           style={{ background: "var(--bg-elev)", border: "1px solid var(--border-hi)", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div class="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <span class="text-sm font-medium" style={{ color: "var(--fg)" }}>效能監控</span>
          <div class="flex items-center gap-3">
            <div class="flex gap-1">
              {WINDOWS.map(w => (
                <button key={w}
                  class="px-2 py-0.5 rounded text-xs transition-colors"
                  style={window_ === w
                    ? { background: "var(--sl4)", color: "var(--fg)", fontWeight: 500 }
                    : { color: "var(--fg-muted)" }}
                  onClick={() => setWindow(w)}>
                  {w}
                </button>
              ))}
            </div>
            <button onClick={onClose} style={{ color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer", display: "flex" }}>
              <IconX size={16}/>
            </button>
          </div>
        </div>
        <div class="px-4 pt-3 flex items-center justify-between gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <div class="flex gap-1 pb-3">
            {AGENTS.map(a => (
              <button key={a.key}
                class="px-2 py-0.5 rounded text-xs transition-colors"
                style={agentFilter === a.key
                  ? { background: "var(--sl4)", color: "var(--fg)", fontWeight: 600 }
                  : { color: "var(--fg-muted)" }}
                onClick={() => setAgentFilter(a.key)}>
                {a.key === "all" ? "All" : a.label}
              </button>
            ))}
          </div>
          <div class="pb-3 text-[10px] tabular-nums" style={{ color: "var(--fg-subtle)" }}>
            {(data?.metrics.length ?? 0)} turns
          </div>
        </div>
        <div class="p-4 flex flex-col gap-6">
          {loading ? (
            <div class="flex items-center justify-center h-24 text-xs" style={{ color: "var(--fg-subtle)" }}>載入中…</div>
          ) : (
            <>
              <MetricChart
                data={ttftPoints}
                fleetAvg={data?.fleet_avg_ttft ?? null}
                label="TTFT 趨勢"
                unit="ms"
                higherIsBetter={false}
              />
              <MetricChart
                data={tpsPoints}
                fleetAvg={data?.fleet_avg_tps ?? null}
                label="TPS 趨勢"
                unit="/s"
                higherIsBetter={true}
              />
            </>
          )}
        </div>
      </div>
    </div>
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
async function blobToAttachedImage(blob: Blob): Promise<AttachedImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
  const [meta, data] = dataUrl.split(",");
  const media_type = meta?.match(/^data:([^;]+);/)?.[1] ?? "image/png";
  return { media_type, data: data ?? "", preview: dataUrl, bytes: blob.size };
}

async function extractImagesFromClipboard(e: ClipboardEvent): Promise<AttachedImage[]> {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: AttachedImage[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!item.type.startsWith("image/")) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    out.push(await blobToAttachedImage(blob));
  }
  return out;
}

// Convert files chosen by an <input type="file" accept="image/*"> picker into
// AttachedImage records. Mobile-friendly counterpart to clipboard-paste —
// gives the phone UI an explicit upload button (the only realistic way to
// attach an image when you don't have a system clipboard with image content).
async function filesToAttachedImages(files: FileList | File[] | null): Promise<AttachedImage[]> {
  if (!files) return [];
  const arr = Array.from(files);
  const out: AttachedImage[] = [];
  for (const f of arr) {
    if (!f.type.startsWith("image/")) continue;
    out.push(await blobToAttachedImage(f));
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
      <div class="dialog-backdrop ask-modal-backdrop" onClick={(e) => { e.stopPropagation(); onDismiss(); }} />
      <div class="dialog-panel ask-modal" onClick={(e) => e.stopPropagation()}>
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
          {ask.questions.length > 1 && currentQ < ask.questions.length - 1 ? (
            <button
              class="btn-primary"
              style={{ marginLeft: "auto" }}
              onClick={() => setCurrentQ((i) => i + 1)}
            >{t("ask.next")}</button>
          ) : (
            <button
              class="btn-primary"
              style={{ marginLeft: "auto" }}
              onClick={submit}
              disabled={submitting}
            >{submitting ? t("ask.submitting") : t("ask.submit")}</button>
          )}
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

function TurnView({ turn, agent = "claude" }: { turn: TranscriptTurn; agent?: AgentId }) {
  const isUser = turn.role === "user" && !turn.tool_result;
  const isSystem = turn.role === "system";
  const isTool = !!(turn.tool_use || turn.tool_result);
  // Streaming turns are synthesised by assembleRenderTurns from the live
  // WS assistant_delta_* buffer (see web/lib/transcript-assembly.ts). The
  // raw_type tag is the only signal we get here — use it to mirror the
  // small-cell "streaming…" + ▌ cue inside the big-card bubble.
  const isStreaming = turn.raw_type === "synthetic-streaming";
  // Thinking turn: same module synthesises this when the wrap session has
  // a live activity ("Ideating" / "Using Bash" / …) but no streaming text
  // has arrived yet. turn.text holds the activity label so users can tell
  // at a glance whether claude is ideating vs. running a tool.
  const isThinking = turn.raw_type === "synthetic-thinking";
  const roleLabel = isSystem ? "system" : isUser ? "user" : agentLabel(agent);
  // Tool turns: dim role color (de-emphasized) since the tool box is the main signal.
  const roleColor = isTool
    ? "var(--fg-subtle)"
    : isSystem
      ? "var(--fg-subtle)"
      : isUser
        ? "var(--neutral)"
        : "var(--pass)";
  const bgClass = isTool || isSystem ? "turn-bg-tool" : isUser ? "turn-bg-user" : "turn-bg-assistant";
  const headerMb = isTool ? 3 : 6;
  const headerFontSize = isTool ? 11 : 12;
  // Chat-bubble layout: user anchored right, everyone else (assistant /
  // system / tool) anchored left. The outer .turn-row picks the side via
  // justify-content; the inner .turn-bubble is the constrained-width card.
  // System messages share the assistant side per user spec; tool turns too.
  return (
    <div class={`turn-row ${isUser ? "turn-row-user" : "turn-row-other"}`}>
      <div class={`turn-bubble ${bgClass}${isTool ? " turn-bubble-tool" : ""}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: headerMb, flexWrap: "wrap" }}>
          <span style={{ color: roleColor, fontWeight: 600, fontSize: headerFontSize }}>{roleLabel}</span>
          {/* Header label suppressed during isThinking: the blue ▌ in the
           * body already signals "claude is busy", and an explicit
           * "Ideating…" word here was visually noisy (per user feedback,
           * mirroring the small-cell fix in d99f615). No timestamp either
           * since turn.ts is Date.now() — meaningless to show. */}
          {isThinking
            ? null
            : isStreaming
              ? <span style={{ color: "var(--pass)", fontSize: 10 }}>streaming…</span>
              : <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>{fmtDateTime(turn.ts)}</span>}
          {turn.tool_use && (
            <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>· 🔧 {turn.tool_use.name}</span>
          )}
          {turn.tool_result && (
            <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>· 📤 tool result</span>
          )}
        </div>
        {/* Thinking bubble: render NOTHING in the body text slot — turn.text
         * holds the activity label ("Ideating" / "Using Bash" / …) which
         * we deliberately don't show (cursor alone is the signal). Suppress
         * <MD> so we don't accidentally render the activity word as
         * markdown content. */}
        {!isThinking && turn.text && <MD text={turn.text} />}
        {/* Trailing blink cursor. Two flavours:
         *   - synthetic-streaming → black ▌  (= claude is actively typing)
         *   - synthetic-thinking  → blue  ▌  (= claude is pre-typing busy)
         * Lives outside <MD> so markdown block-level endings don't push it
         * onto a new line — matches the small-cell behaviour. */}
        {isStreaming && <span class="streaming-cursor" aria-hidden="true">▌</span>}
        {isThinking && <span class="streaming-cursor streaming-cursor--thinking" aria-hidden="true">▌</span>}
        {turn.images && turn.images.length > 0 && (
          <div style={{ marginTop: turn.text ? 8 : 0 }}>
            {/* Text label first — guaranteed visible even if img tag fails
                (broken data URL, CSP, oversized payload, etc.). Lets the
                user know "yes, this message had an image" instead of the
                bubble silently looking text-only. */}
            <div style={{ fontSize: 11, color: "var(--fg-subtle)", marginBottom: 4 }}>
              📎 [image × {turn.images.length}]
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {turn.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt={`image ${i + 1}`}
                  style={{ display: "block", maxHeight: 200, maxWidth: "100%", borderRadius: 4, border: "1px solid var(--border)" }}
                  onError={(e) => {
                    // If the inline render fails, leave the [image] label as
                    // the visible signal and hide the broken-img placeholder.
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ))}
            </div>
          </div>
        )}
        {turn.tool_use && <ToolUseBox turn={turn} />}
        {turn.tool_result && <ToolResultBox turn={turn} />}
      </div>
    </div>
  );
}

// Split transcript into two columns:
//   left  — conversation (user/assistant text, no tool activity)
//   right — tool activity (assistant tool_use + user tool_result)
// A turn that has BOTH text and tool_use shows the text on the left and the tool box on the right.
// Auto follow-tail: each column auto-scrolls to bottom on new content unless the user has
// manually scrolled up. Scrolling back to bottom re-engages follow.
function SingleColumnTranscript({ turns, agent = "claude" }: { turns: TranscriptTurn[]; agent?: AgentId }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // ref (not state) so toggling doesn't re-render; only the scroll effect reads it.
  const sticky = useRef(true);

  // Auto-tail: pin to bottom on content change only (not every parent
  // re-render). Without the contentKey dep, this fires after EVERY render
  // — incidental updates from activity/streaming/peer events would snap
  // the user back to bottom before they could finish a single touchmove.
  const contentKey = turns.length === 0
    ? "0"
    : `${turns.length}|${turns[turns.length - 1]!.ts}|${turns[turns.length - 1]!.text.length}`;
  useEffect(() => {
    if (sticky.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [contentKey]);

  // Tolerance for "at bottom". 64px so a single touchmove on iOS reliably
  // crosses the threshold and disengages auto-tail; the original 24px was
  // too tight — short transcripts couldn't outpace it.
  const TAIL_TOL = 64;
  function onScroll(ev: Event) {
    const el = ev.currentTarget as HTMLDivElement;
    sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_TOL;
  }

  if (turns.length === 0) {
    return <div style={{ padding: "12px 14px", color: "var(--fg-subtle)", fontSize: 12 }}>{t("transcript.empty")}</div>;
  }
  return (
    // overscrollBehavior:contain — when this scroller hits its top/bottom on
    // iOS, the touchmove momentum stops here instead of chaining up to the
    // dashboard underneath the modal.
    <div ref={scrollRef} onScroll={onScroll} style={{ overflowY: "auto", height: "100%", minHeight: 0, overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}>
      <div style={{ position: "sticky", top: 0, zIndex: 1, padding: "6px 14px", fontSize: 10, fontWeight: 600, color: "var(--fg-subtle)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--sl2)", borderBottom: "1px solid var(--border)" }}>
        {t("transcript.conversation")} · {turns.length}
      </div>
      {turns.map((turn, i) => <TurnView key={i} turn={turn} agent={agent} />)}
    </div>
  );
}

// ── Session card ───────────────────────────────────────────────────────────

type ActionResult = { ok: boolean; label: string; url?: string; reply?: string; durationMs?: number; diag?: string; error?: string; ts: number } | null;

function Card({ s, defaultExpanded, clientType, onSetClientType, onFocus, onSend, sendKey, modalMode, onAfterSend, activity, transcript, transcriptLoading, transcriptError, transcriptLimit, onSetTranscriptLimit, onReloadTranscript, showTools, onSetShowTools, streamingText, streamingStartTs, userOverlayText, userOverlayTs }: {
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
  streamingStartTs?: number;
  userOverlayText?: string;
  userOverlayTs?: number;
}) {
  const agent = agentOf(s);
  const isCli = clientType === "cli";
  const isWrapped = !!s.wrapped;
  const canSend = isWrapped || agent === "codex";
  // Only wrapped CLI sessions allow send. VSCode-panel mode is disabled because
  // claude-code's primaryEditor.open(uuid) creates a FRESH empty panel when the
  // session UUID isn't already in its sessionPanels map, and there's no
  // exposed API to load by UUID — so sends would silently target the wrong
  // (new, empty) conversation. CLI WITHOUT wrap also blocked: -p costs $$ +
  // injects a resume marker. Wrap-push is the only reliable delivery path.
  const sendBlocked = !canSend;
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<AttachedImage[]>([]);
  // Textarea ref + auto-resize.
  //
  // OLD BUG: auto-resize ran inline in onInput (set height="auto" then
  // scrollHeight). On iOS that produced visible vibration on each keystroke
  // — the "auto" step momentarily collapsed the box to one line (because
  // overflow:hidden) before re-expanding, jiggling the entire modal layout
  // since the composer flex-shrinks the transcript above.
  //
  // FIX: run auto-resize in a useEffect[draft] so React commits the new
  // value first, then we measure + apply height in one paint cycle. Also
  // skips the resize when `draft` is empty (just clears inline height,
  // returning to CSS min-height — the post-send shrink case).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (draft === "") {
      el.style.height = "";
      return;
    }
    // Two-step measure: height=auto so scrollHeight reflects intrinsic
    // size, then clamp to maxHeight from the inline style. rAF defers
    // the work to next paint so we don't fight React's commit phase.
    requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, modalMode ? 160 : 260)}px`;
    });
  }, [draft, modalMode]);
  // In modalMode the inline "show TOOL / 20 條 / load-all / reload" bar is
  // hidden to declutter the phone view; the same controls live in a popover
  // toggled by an icon button in the header. State + ref managed here so
  // outside-click closes it.
  const [transcriptMenuOpen, setTranscriptMenuOpen] = useState(false);
  const transcriptMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!transcriptMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!transcriptMenuRef.current?.contains(e.target as Node)) setTranscriptMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [transcriptMenuOpen]);
  const imagesSupported = isWrapped || agent === "codex";
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
        : agent === "codex"
          ? t("send.codexReplied", { ms: r.duration_ms ?? "?" })
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
      {/* Header — in modalMode (phone) we keep this minimal: just dot + name
          + wrap/client badge. Status label, relative time, activity, and the
          permission-mode chip move down to a thin status line directly above
          the composer (rendered later in this component). Rationale: on a
          narrow viewport those chips wrap onto 2-3 rows and visually drown
          the project name; users glance at the composer when typing, so the
          status belongs *there* (matches Happy CLI's "cooking…" pattern).
          Padding is tighter in modal mode — vertical real-estate is precious
          on phones, and 12px top/bottom was eating ~8% of the visible card
          for whitespace alone. */}
      <div style={{ display: "flex", alignItems: "center", gap: modalMode ? 8 : 10, padding: modalMode ? "6px 12px" : "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span class={STATUS_DOT[s.status]} />
        <button
          class="btn-ghost"
          style={{ fontWeight: 600, fontSize: modalMode ? 14 : 15, padding: modalMode ? "0 4px" : "2px 6px" }}
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
        {/* Desktop (non-modal): keep the original chips in the header.
            Phone (modalMode): omit them — they move to the composer status line. */}
        {!modalMode && (
          <>
            <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{statusLabel(s.status)}</span>
            {activity && (
              <span class="cell-activity" title={t("focus.wrapperRunning", { activity })}>
                {activity}…
              </span>
            )}
            <span style={{ color: "var(--fg-subtle)", fontSize: 11, marginLeft: 8 }}>{fmtRelative(s.last_event_at)}</span>
            {s.wrapped && <ModelChip sessionUuid={s.session_uuid} current={s.current_model} currentEffort={s.current_effort} />}
            {s.wrapped && <PermissionModeChip sessionUuid={s.session_uuid} mode={s.permission_mode ?? "default"} />}
          </>
        )}
        {/* Collapse button only makes sense for the inline (grid) expanded card.
            In modalMode the big card is opened in an overlay that has its own
            close affordance — a second "collapse" button is redundant and on
            mobile crowds the header. */}
        {!modalMode && (
          <button class="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setCollapsed(true)} title={t("expand.collapse")}>▴</button>
        )}
        {/* Phone: single sliders button — collapses the entire transcript
            controls bar (show-TOOL / 20條 / load-all / reload) into a popover
            so the header doesn't grow another row of chips. Anchored to the
            wrapped/client badge area (pushed right with marginLeft:auto). */}
        {modalMode && (
          // marginRight reserves space for the absolutely-positioned
          // .cell-modal-close (×) button at top:8 right:8 — without it the
          // sliders icon sits underneath the close button.
          <div ref={transcriptMenuRef} style={{ marginLeft: "auto", marginRight: 36, position: "relative" }}>
            <button
              class="btn-ghost icon-btn"
              style={{ padding: "4px 6px" }}
              onClick={() => setTranscriptMenuOpen((v) => !v)}
              title={t("transcript.viewOptions")}
              aria-label={t("transcript.viewOptions")}
              aria-expanded={transcriptMenuOpen}
            ><IconSliders size={15} /></button>
            {transcriptMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  zIndex: 50,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
                  minWidth: 200,
                  display: "flex", flexDirection: "column", gap: 8,
                }}
              >
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-muted)", cursor: "pointer", userSelect: "none" }}>
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
                  style={{ width: "100%" }}
                >
                  <option value={10}>{t("transcript.items10")}</option>
                  <option value={20}>{t("transcript.items20")}</option>
                  <option value={50}>{t("transcript.items50")}</option>
                  <option value={100}>{t("transcript.items100")}</option>
                  <option value={200}>{t("transcript.items200")}</option>
                  <option value={500}>{t("transcript.items500")}</option>
                  <option value={10000}>{t("transcript.itemsAll")}</option>
                </select>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    class="btn-outline"
                    style={{ flex: 1, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12 }}
                    onClick={() => { onSetTranscriptLimit(10000); setTranscriptMenuOpen(false); }}
                    disabled={transcriptLoading}
                    title={t("transcript.loadAllTitle")}
                  ><IconLayers size={13} /> {t("transcript.loadAll")}</button>
                  <button
                    class="btn-outline"
                    style={{ height: 30, padding: "0 10px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    onClick={() => { onReloadTranscript(); setTranscriptMenuOpen(false); }}
                    disabled={transcriptLoading}
                    title={transcriptLoading ? t("transcript.loading") : t("transcript.reload")}
                    aria-label={transcriptLoading ? t("transcript.loading") : t("transcript.reload")}
                  ><IconRefresh size={13} spinning={transcriptLoading} /></button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transcript section — flex:1, scrollable */}
      <div style={fixedHeight
        ? { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, borderBottom: "1px solid var(--border)" }
        : { borderBottom: "1px solid var(--border)" }
      }>
        {/* Inline transcript controls bar — hidden in modalMode where the
            same controls live in the header's sliders popover. */}
        {!modalMode && (
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
        )}
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
              const fallbackTurns: TranscriptTurn[] = baseTurns.length === 0 && agent === "codex" && s.last_message_preview
                ? [{
                    ts: new Date(s.last_event_at || Date.now()).toISOString(),
                    role: "assistant",
                    text: s.last_message_preview,
                    raw_type: "codex:dashboard-reply",
                  }]
                : baseTurns;
              // Merge canonical baseTurns with optimistic overlays and
              // chronologically sort. Pure logic lives in
              // web/lib/transcript-assembly.ts — the historical bug was
              // appending overlays at the END without sorting, which made
              // a stale user overlay land below a newer canonical
              // assistant turn that had already hit JSONL.
              const overlay = userOverlayText && userOverlayTs
                ? { text: userOverlayText, ts: userOverlayTs }
                : undefined;
              const stream = streamingText && streamingText.length > 0
                ? { text: streamingText, startTs: streamingStartTs ?? 0 }
                : undefined;
              const renderTurns = assembleRenderTurns(fallbackTurns, overlay, stream, activity);
              return (
                <div style={fixedHeight ? { flex: 1, minHeight: 0, display: "flex" } : { maxHeight: 480, overflow: "hidden", display: "flex" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <SingleColumnTranscript turns={renderTurns} agent={agent} />
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
          {/* Phone status line — moved out of header. Single row that wraps
              gracefully; permission-mode chip stays clickable. Inspired by
              Happy CLI where "cooking…" sits inline above the input. */}
          {modalMode && (
            // Status line layout — left cluster is STABLE (status dot + label +
            // chips), right cluster holds the volatile bits (relative time,
            // cooking… activity). Time text width changes as seconds tick
            // ("9 秒前" → "10 秒前" → "1 分鐘前") which previously rippled
            // through the flex row and made the default/bypass chips
            // visibly drift. Pushing the volatile group to the right with
            // marginLeft:auto pins the chips in place.
            <div style={{
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
              fontSize: 11, color: "var(--fg-subtle)", marginBottom: 2,
            }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span class={STATUS_DOT[s.status]} style={{ width: 7, height: 7 }} />
                <span style={{ color: "var(--fg-muted)" }}>{statusLabel(s.status)}</span>
              </span>
              {s.wrapped && (
                <>
                  <ModelChip sessionUuid={s.session_uuid} current={s.current_model} currentEffort={s.current_effort} />
                  <PermissionModeChip sessionUuid={s.session_uuid} mode={s.permission_mode ?? "default"} />
                </>
              )}
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {activity && (
                  <span class="cell-activity" title={t("focus.wrapperRunning", { activity })}>
                    {activity}…
                  </span>
                )}
                <span>{fmtRelative(s.last_event_at)}</span>
              </span>
            </div>
          )}
          <AttachedImageStrip images={draftImages} onRemove={(i) => setDraftImages((prev) => prev.filter((_, j) => j !== i))} dimmed={!imagesSupported && draftImages.length > 0} />
          {!imagesSupported && draftImages.length > 0 && (
            <div style={{ fontSize: 10, color: "var(--warn)" }}>
              {t("composer.imageIgnored")}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              ref={textareaRef}
              autoFocus={modalMode}
              // minWidth:0: canonical flex-child shrink fix (without it,
              // placeholder text intrinsically widens the textarea on
              // phones and pushes send/upload icons off-screen).
              //
              // Phone: halve the visible height — "輸入訊息…" only needs
              // one line, the original rows={2} ate too much screen.
              // Desktop keeps the 2-row affordance for longer prompts.
              //
              // overflow:hidden + resize:none + auto-resize-in-onInput
              // lets the textarea grow line-by-line as the user types
              // multi-line prompts (capped at maxHeight). The native
              // corner grabber would fight that, so we hide it.
              style={{ flex: 1, minWidth: 0, minHeight: modalMode ? 20 : 38, maxHeight: modalMode ? 160 : 260, fontSize: 13, overflow: "hidden", resize: "none" }}
              rows={modalMode ? 1 : 2}
              placeholder={
                sendBlocked
                  ? (isCli
                      ? t(modalMode ? "composer.cliNotWrappedShort" : "composer.cliNotWrapped", { short: sessionUuid.slice(0, 8) })
                      : t(modalMode ? "composer.vscodeDisabledShort" : "composer.vscodeDisabledWrap", { short: sessionUuid.slice(0, 8) }))
                  : agent === "codex"
                    ? t(modalMode ? "composer.inputPromptCodexShort" : "composer.inputPromptCodex")
                  : t(modalMode ? "composer.inputPromptShort" : "composer.inputPrompt")
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
            {/* Image upload — explicit button so mobile users (who don't have
                clipboard image paste) can still attach screenshots. Hidden
                native <input type=file> triggered by the icon button. */}
            <label
              class="btn-ghost icon-btn"
              style={{
                height: 34, width: 34, padding: 0, display: "inline-flex",
                alignItems: "center", justifyContent: "center",
                cursor: imagesSupported && !busy ? "pointer" : "not-allowed",
                opacity: imagesSupported && !busy ? 1 : 0.5,
              }}
              title={t("composer.uploadImage")}
              aria-label={t("composer.uploadImage")}
            >
              <IconImagePlus size={14} />
              <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                disabled={!imagesSupported || busy}
                onChange={async (e) => {
                  const el = e.currentTarget as HTMLInputElement;
                  const got = await filesToAttachedImages(el.files);
                  if (got.length > 0) setDraftImages((prev) => [...prev, ...got]);
                  // Reset so picking the same file again still fires onChange.
                  el.value = "";
                }}
              />
            </label>
            {(isWrapped || (agent === "codex" && busy)) && (
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
              class={canSend ? "btn-primary icon-btn" : "btn-ghost icon-btn"}
              style={{ height: 34, width: 34, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              disabled={(!draft.trim() && draftImages.length === 0) || busy || sendBlocked}
              onClick={handleSend}
              title={
                sendBlocked ? t("composer.needWrapHint")
                : agent === "codex" ? t("composer.codexExecHint")
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

          {/* Send result. Claude wrapper success streams into the transcript,
              but Codex exec can return before a transcript exists, so surface
              that reply directly. */}
          {sendResult && (!sendResult.ok || (agent === "codex" && sendResult.reply)) && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, color: sendResult.ok ? "var(--pass)" : "var(--accent)" }}>
                {sendResult.ok ? sendResult.label : t("send.sendFailed", { label: sendResult.label })}
              </div>
              {sendResult.error && (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--accent)", padding: 8, background: "var(--bg-subtle)", borderRadius: 4 }}>
                  ⚠️ {sendResult.error}
                </div>
              )}
              {sendResult.reply && (
                <div style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", fontSize: 13, lineHeight: 1.5, padding: 8, background: "var(--bg-subtle)", borderRadius: 4 }}>
                  <MD text={sendResult.reply} />
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
type AgentFilter = "all" | AgentId;

function HeaderStats({ sessions, filter, onFilter, agentFilter, onAgentFilter, hiddenCount, showHidden, onToggleHidden }: {
  sessions: Session[];
  filter: StatusFilter;
  onFilter: (next: StatusFilter) => void;
  agentFilter: AgentFilter;
  onAgentFilter: (next: AgentFilter) => void;
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
}) {
  const counts = sessions.reduce(
    (acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; },
    {} as Record<Session["status"], number>,
  );
  const liveCount = (counts.active ?? 0) + (counts.waiting ?? 0);
  const agentCounts = sessions.reduce(
    (acc, s) => { const a = agentOf(s); acc[a] = (acc[a] ?? 0) + 1; return acc; },
    {} as Record<AgentId, number>,
  );
  // Click an already-active chip → back to "all". Removes the need for a
  // dedicated total/all chip and keeps the bar to 3 buttons on mobile.
  const toggle = (next: StatusFilter) => onFilter(filter === next ? "all" : next);
  const toggleAgent = (next: AgentFilter) => onAgentFilter(agentFilter === next ? "all" : next);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: 4 }}>
      <HeaderStatChip n={liveCount}         label={t("header.live")}  icon={<IconActivity />} dot="dot-active" active={filter === "live"}  onClick={() => toggle("live")} />
      <HeaderStatChip n={counts.stale ?? 0} label={t("header.stale")} icon={<IconPlugOff />}  dot="dot-stale"  active={filter === "stale"} onClick={() => toggle("stale")} />
      <span class="header-stat-sep" />
      <HeaderStatChip n={agentCounts.claude ?? 0} label="Claude" icon={<AgentLogo agent="claude" />} active={agentFilter === "claude"} onClick={() => toggleAgent("claude")} />
      <HeaderStatChip n={agentCounts.codex ?? 0} label="Codex" icon={<AgentLogo agent="codex" />} active={agentFilter === "codex"} onClick={() => toggleAgent("codex")} />
      {hiddenCount > 0 && (
        <button
          class="btn-ghost"
          style={{
            marginLeft: 6, fontSize: 11, padding: "2px 6px",
            borderColor: showHidden ? "var(--fg)" : "var(--border)",
            background: showHidden ? "var(--sl3)" : "transparent",
            borderWidth: 1, borderStyle: "solid", borderRadius: 4,
          }}
          title={t("filter.hiddenTooltip", { n: hiddenCount })}
          onClick={onToggleHidden}
        ><span class="header-hidden-lbl">{t("filter.hiddenLabel")} </span>{hiddenCount}</button>
      )}
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
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Viewport-clamped popover coords — same trick as ModelChip. CSS-only
  // anchoring (left:0 / right:0 relative to the chip) cut the menu off when
  // the chip sat near the right edge of the modal status line (especially
  // on phones), hiding the icon column + first chars of each label. We now
  // measure the chip rect on open + resize/scroll and clamp the popover
  // into the viewport with an 8px gutter, growing upward from the chip.
  const [popPos, setPopPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const cfg = pmodeCfg(mode);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) { setPopPos(null); return; }
    function measure() {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 300px is enough for label + desc (e.g. "Bypass permissions / Always
      // run (dangerous)"); cap so 8px gutters fit on narrow phones.
      const width = Math.min(300, vw - 16);
      // Anchor menu's left edge to chip's left, but slide left if it would
      // overflow the right gutter.
      const desiredLeft = r.left;
      const maxLeft = vw - width - 8;
      const left = Math.max(8, Math.min(desiredLeft, maxLeft));
      // Distance from viewport bottom to where popover bottom edge sits
      // (= chip top - 6px gap). Using `bottom` so menu grows upward.
      const bottom = vh - r.top + 6;
      setPopPos({ left, bottom, width });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
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
        ref={btnRef}
        // Apply the per-mode color class (pmode-chip-bypass / -plan / etc)
        // so the chip itself tints by mode — red for bypass, blue for plan,
        // green for accept-edits, etc. Previously stuck on the neutral
        // grey, which hid the safety signal (bypass especially deserves
        // to be visually loud).
        class={`pmode-chip ${PMODE_STATIC[pending ?? mode].cls}`}
        title={cfg.title + t("mode.switchHint")}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onMouseDown={stop}
        disabled={!sessionUuid}
      >
        <PModeIcon mode={pending ?? mode} />
        <span>{pending ? `${PMODE_STATIC[pending].short}…` : cfg.short}</span>
      </button>
      {open && popPos && (
        // position: fixed with measured coords — bypass .pmode-menu's CSS
        // anchoring so the popover always sits inside the viewport even
        // when the chip is near the right edge.
        <div
          class="pmode-menu"
          onClick={stop}
          onMouseDown={stop}
          style={{
            position: "fixed",
            left: popPos.left,
            bottom: popPos.bottom,
            top: "auto",
            right: "auto",
            width: popPos.width,
            maxWidth: "none",
            minWidth: 0,
          }}
        >
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

// Active-model chip — sister of PermissionModeChip, sits one slot to its
// left in the modal status line. Click → popover with the four canonical
// Anthropic models + the implicit "(default)" fallback (which delegates to
// whatever the SDK / CLAUDE_DEFAULT_MODEL resolves to at runtime).
// Picking a model POSTs to /wrap/model; daemon forwards to wrap.ts which
// calls q.setModel(). The current_model field on Session is updated by the
// server's model_changed handler and re-broadcast via session_changed so
// every connected dashboard repaints.
//
// Model list is intentionally short — most users only switch between these
// few. Tier-3-style fine-grained pinning ("claude-opus-4-7-20251122") is
// available by typing in the textbox at the bottom; freeform takes
// precedence over the preset buttons.
const MODEL_PRESETS: { key: string; label: string; aliasFor: string }[] = [
  { key: "default", label: "default", aliasFor: "" },           // empty = SDK default
  { key: "sonnet",  label: "Sonnet",  aliasFor: "sonnet"  },
  { key: "opus",    label: "Opus",    aliasFor: "opus"    },
  { key: "haiku",   label: "Haiku",   aliasFor: "haiku"   },
];

function modelLabel(current: string | null | undefined): string {
  if (!current) return "default";
  const preset = MODEL_PRESETS.find((p) => p.aliasFor === current);
  if (preset) return preset.label;
  // Custom model id — show a compact suffix instead of full
  // "claude-opus-4-7-20251122" to avoid bloating the status line.
  // Strip "claude-" prefix and trailing date if present.
  return current.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// SDK reasoning-effort levels (sdk.d.ts:472-480). The empty-string key is the
// "no override; use SDK default" sentinel — same convention as model="".
const EFFORT_LEVELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "",        label: "default" },
  { key: "low",     label: "low"     },
  { key: "medium",  label: "medium"  },
  { key: "high",    label: "high"    },
  { key: "xhigh",   label: "xhigh"   },
  { key: "max",     label: "max"     },
];

// VSCode-style discrete slider over EFFORT_LEVELS. Click any dot to jump,
// or grab the indicator and drag — release fires onPick with the snapped
// level's key. While dragging we update a local `dragIdx` so the indicator
// follows the pointer live; the actual /wrap/effort POST only fires on
// pointerup to avoid flooding the daemon with intermediate values.
//
// Pointer events (not separate mouse + touch) cover desktop + phone with
// one code path; setPointerCapture keeps the drag glued to this element
// even if the pointer slides outside the popover.
function EffortSlider({
  currentEffort, pending, onPick, title, stopPropagation,
}: {
  currentEffort: string;
  pending: boolean;
  onPick: (key: string) => void;
  title: string;
  stopPropagation: (e: { stopPropagation: () => void }) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const curIdx = Math.max(0, EFFORT_LEVELS.findIndex((l) => l.key === currentEffort));
  const displayIdx = dragIdx !== null ? dragIdx : curIdx;
  const displayLabel = EFFORT_LEVELS[displayIdx]?.label ?? "default";

  function clientXToIdx(clientX: number): number {
    const el = trackRef.current;
    if (!el) return displayIdx;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(ratio * (EFFORT_LEVELS.length - 1));
  }

  function onPointerDown(e: PointerEvent) {
    if (pending) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragIdx(clientXToIdx(e.clientX));
  }
  function onPointerMove(e: PointerEvent) {
    if (dragIdx === null) return;
    setDragIdx(clientXToIdx(e.clientX));
  }
  function onPointerUp(e: PointerEvent) {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
    if (dragIdx === null) return;
    const finalIdx = clientXToIdx(e.clientX);
    setDragIdx(null);
    const picked = EFFORT_LEVELS[finalIdx];
    if (picked && picked.key !== currentEffort) onPick(picked.key);
  }

  return (
    <div onClick={stopPropagation} onMouseDown={stopPropagation}>
      <div style={{
        padding: "8px 10px 4px",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        fontSize: 10,
        fontWeight: 600,
        color: "var(--fg-subtle)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}>
        <span>{title}</span>
        <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, color: "var(--fg)" }}>
          ({displayLabel})
        </span>
      </div>
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: "relative",
          margin: "2px 14px 4px",
          height: 20,
          cursor: pending ? "wait" : "pointer",
          opacity: pending ? 0.5 : 1,
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {/* Track line behind the dots */}
        <div style={{
          position: "absolute",
          top: "50%",
          left: 0,
          right: 0,
          height: 2,
          background: "var(--border)",
          borderRadius: 1,
          transform: "translateY(-50%)",
        }} />
        {/* Filled portion left of the indicator */}
        <div style={{
          position: "absolute",
          top: "50%",
          left: 0,
          width: `${(displayIdx / (EFFORT_LEVELS.length - 1)) * 100}%`,
          height: 2,
          background: "var(--accent, #4f6dff)",
          borderRadius: 1,
          transform: "translateY(-50%)",
          transition: dragIdx === null ? "width 0.12s ease-out" : "none",
        }} />
        {/* Dots */}
        {EFFORT_LEVELS.map((lvl, i) => {
          const isActive = i === displayIdx;
          return (
            <span
              key={lvl.key || "default"}
              title={lvl.label}
              style={{
                position: "absolute",
                top: "50%",
                left: `${(i / (EFFORT_LEVELS.length - 1)) * 100}%`,
                transform: "translate(-50%, -50%)",
                width: isActive ? 10 : 6,
                height: isActive ? 10 : 6,
                borderRadius: "50%",
                background: i <= displayIdx ? "var(--accent, #4f6dff)" : "var(--bg-elevated, #fff)",
                border: i <= displayIdx ? "none" : "1.5px solid var(--border)",
                boxShadow: isActive ? "0 0 0 2px var(--bg-elevated, #fff), 0 1px 3px rgba(0,0,0,0.18)" : "none",
                transition: dragIdx === null ? "all 0.12s ease-out" : "none",
                pointerEvents: "none",
              }}
            />
          );
        })}
      </div>
      {/* Tick labels — half the size of body text, neutral colour. */}
      <div style={{
        position: "relative",
        margin: "0 8px 8px",
        height: 12,
        fontSize: 9,
        color: "var(--fg-subtle)",
        userSelect: "none",
      }}>
        {EFFORT_LEVELS.map((lvl, i) => (
          <span
            key={lvl.key || "default"}
            style={{
              position: "absolute",
              left: `${(i / (EFFORT_LEVELS.length - 1)) * 100}%`,
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
            }}
          >{lvl.label}</span>
        ))}
      </div>
    </div>
  );
}

function ModelChip({ sessionUuid, current, currentEffort }: {
  sessionUuid: string | null;
  current: string | null | undefined;
  currentEffort?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Fixed-position popover coords. CSS-only anchoring (right:0 / left:0
  // relative to the chip) was unreliable on phones because the chip sits
  // mid-row in the status line — neither anchor stays inside the viewport.
  // We measure the chip rect on open + resize and clamp the popover into
  // the viewport (left 8px gutter, width = min(content, vw-16)).
  //
  // Vertical: prefer growing UPWARD (bottom anchor). For cells in the top row
  // there isn't enough room above — flip to grow DOWNWARD (top anchor) and
  // bound by maxHeight so the menu never overflows the viewport.
  const [popPos, setPopPos] = useState<
    | { left: number; bottom: number; top: "auto"; width: number; maxHeight: number }
    | { left: number; top: number; bottom: "auto"; width: number; maxHeight: number }
    | null
  >(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) { setPopPos(null); return; }
    function measure() {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Prefer 300px wide; cap so the popover always fits with 8px gutters
      // on both sides regardless of chip horizontal position.
      const width = Math.min(300, vw - 16);
      const desiredLeft = r.left;
      const maxLeft = vw - width - 8;
      const left = Math.max(8, Math.min(desiredLeft, maxLeft));

      // Pick the side with more room. The popover's natural height is around
      // 280-340px (title + 3 model rows + custom input + effort slider). If
      // we anchor upward but the chip is in the top row, the popover would
      // extend above the viewport (the original bug). Anchoring downward
      // covers that case; maxHeight clamps to whichever side wins so neither
      // direction ever overflows.
      const GAP = 6;
      const GUTTER = 8;
      const spaceAbove = Math.max(0, r.top - GAP - GUTTER);
      const spaceBelow = Math.max(0, vh - r.bottom - GAP - GUTTER);
      if (spaceAbove >= spaceBelow) {
        // Anchor by bottom edge so menu grows upward from the chip.
        setPopPos({
          left,
          bottom: vh - r.top + GAP,
          top: "auto",
          width,
          maxHeight: spaceAbove,
        });
      } else {
        // Anchor by top edge so menu grows downward from the chip.
        setPopPos({
          left,
          top: r.bottom + GAP,
          bottom: "auto",
          width,
          maxHeight: spaceBelow,
        });
      }
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  async function pick(modelId: string) {
    if (!sessionUuid || pending !== null) return;
    setPending(modelId); setErr(null);
    try {
      const r = await apiFetch("/wrap/model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: sessionUuid, model: modelId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body?.error ?? `HTTP ${r.status}`);
      } else {
        setOpen(false);
        setCustom("");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setPending(null);
    }
  }

  // Effort sits in the same popover so the user picks a (model, effort) pair
  // in one place. SDK silently downgrades unsupported levels (e.g. xhigh on
  // non-Opus-4.7 falls back to high) — we don't pre-filter; the chip just
  // shows what the server reports back via `current_effort`.
  async function pickEffort(level: string) {
    if (!sessionUuid || pendingEffort !== null) return;
    setPendingEffort(level); setErr(null);
    try {
      const r = await apiFetch("/wrap/effort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: sessionUuid, effort: level }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body?.error ?? `HTTP ${r.status}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setPendingEffort(null);
    }
  }

  const label = pending !== null
    ? `${modelLabel(pending || null)}…`
    : modelLabel(current);

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div ref={ref} class="pmode-chip-wrap" onClick={stop} onMouseDown={stop}>
      <button
        ref={btnRef}
        // Same shape/skin as a permission-mode chip (e.g. bypass) — neutral
        // colour because model isn't a safety signal, but identical metrics
        // (height/padding/font) so the row of chips reads as one unit.
        class="pmode-chip pmode-chip-neutral"
        title={t("model.switchHint")}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onMouseDown={stop}
        disabled={!sessionUuid}
      >
        <span>{label}</span>
      </button>
      {open && popPos && (
        // position: fixed with measured coords — see effect above. We
        // bypass .pmode-menu's CSS anchoring entirely (no left:0 / right:0)
        // so the popover is guaranteed to stay inside the viewport on any
        // chip position. Width is min(300, vw-16); maxHeight clamps to the
        // chosen side's available space; overflow-y: auto so the menu
        // scrolls internally if its content (default + 3 models + custom
        // input + effort slider) exceeds the available room.
        <div
          class="pmode-menu"
          onClick={stop}
          onMouseDown={stop}
          style={{
            position: "fixed",
            left: popPos.left,
            top: popPos.top,
            bottom: popPos.bottom,
            right: "auto",
            width: popPos.width,
            maxWidth: "none",
            minWidth: 0,
            maxHeight: popPos.maxHeight,
            overflowY: "auto",
          }}
        >
          <div class="pmode-menu-head">{t("model.menuTitle")}</div>
          {MODEL_PRESETS.map((p) => {
            const isCurrent = (current ?? "") === p.aliasFor;
            return (
              <button
                key={p.key}
                class={"pmode-menu-item " + (isCurrent ? "is-current" : "")}
                onClick={(e) => { e.stopPropagation(); pick(p.aliasFor); }}
                onMouseDown={stop}
                disabled={pending !== null}
                title={p.label}
              >
                <div class="pmode-menu-text">
                  <div class="pmode-menu-label">{p.label}</div>
                  <div class="pmode-menu-desc">
                    {p.aliasFor === "" ? t("model.defaultDesc") : t("model.aliasDesc", { id: p.aliasFor })}
                  </div>
                </div>
                {isCurrent && <span class="pmode-check">✓</span>}
              </button>
            );
          })}
          <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)", display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder={t("model.customPlaceholder")}
              value={custom}
              onInput={(e) => setCustom((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter" && custom.trim()) { e.preventDefault(); void pick(custom.trim()); } }}
              style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "ui-monospace, monospace" }}
            />
            <button
              class="btn-primary"
              style={{ height: 28, padding: "0 10px", fontSize: 11 }}
              disabled={!custom.trim() || pending !== null}
              onClick={(e) => { e.stopPropagation(); if (custom.trim()) void pick(custom.trim()); }}
            >{t("model.applyCustom")}</button>
          </div>
          {/* Effort selector — VSCode-style discrete slider over the 6 SDK
              levels. Click a dot or drag the indicator. SDK silently
              downgrades unsupported levels (xhigh → high on non-Opus-4.7,
              max gated to select models); we don't pre-filter — the
              daemon echoes back whatever the SDK accepted via
              effort_changed. */}
          <EffortSlider
            currentEffort={currentEffort ?? ""}
            pending={pendingEffort !== null}
            onPick={(key) => { void pickEffort(key); }}
            title={t("model.effortTitle")}
            stopPropagation={stop}
          />
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
        setErr(userFacingWrapError(body?.error, r.status));
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
    <div class="dialog-backdrop wrap-confirm-backdrop" onClick={() => { if (!pending) close(); }}>
      <div
        role="alertdialog"
        aria-modal="true"
        class="dialog-panel wrap-confirm-dialog"
        onClick={(e) => e.stopPropagation()}
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
  interface Pending { cwd: string; agent: AgentId; startedAt: number; timedOut: boolean }
  const [pendings, setPendings] = useState<Pending[]>([]);

  // Listen for spawn-pending events fired by <NewCliButton> on /wrap/start success.
  useEffect(() => {
    function onSpawn(e: Event) {
      const ce = e as CustomEvent<{ cwd: string; agent?: AgentId }>;
      const cwd = ce.detail?.cwd;
      const agent = ce.detail?.agent === "codex" ? "codex" : "claude";
      if (!cwd) return;
      setPendings((prev) => {
        // De-dupe: replace existing entry for same cwd (re-clicks reset timer).
        const without = prev.filter((p) => p.cwd.toLowerCase() !== cwd.toLowerCase());
        return [...without, { cwd, agent, startedAt: Date.now(), timedOut: false }];
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
              {p.timedOut ? t("spawnPending.timeout") : t(p.agent === "codex" ? "spawnPending.bodyCodex" : "spawnPending.bodyClaude", { cwd: p.cwd })}
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
  const [agent, setAgent] = useState<AgentId>("claude");
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
        body: JSON.stringify({ cwd: trimmed, agent }),
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
          detail: { cwd: trimmed, agent },
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
          <div style={{ fontSize: 11, color: "var(--fg-muted)", display: "block", marginBottom: 4 }}>
            {t("newCli.agentLabel")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
            {(["claude", "codex"] as AgentId[]).map((a) => (
              <button
                key={a}
                type="button"
                class={"header-stat" + (agent === a ? " is-active" : "")}
                style={{ justifyContent: "center", height: 30 }}
                onClick={() => setAgent(a)}
                aria-pressed={agent === a}
              >
                <AgentLogo agent={a} />
                <span>{agentLabel(a)}</span>
              </button>
            ))}
          </div>
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
          {/* Mobile-friendly dropdown: <datalist> requires tapping a tiny
              caret on iOS Safari and is hidden on most Android browsers.
              A native <select> opens the OS picker on tap — much easier on
              touch. Picking an entry mirrors it back into the input above. */}
          {recentCwds.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                if (v) {
                  setCwd(v);
                  // Reset the select back to placeholder so the user can
                  // pick the same entry again after edits.
                  (e.currentTarget as HTMLSelectElement).value = "";
                  queueMicrotask(() => inputRef.current?.focus());
                }
              }}
              aria-label={t("newCli.recentCwds")}
              style={{ width: "100%", marginTop: 6, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }}
            >
              <option value="">{t("newCli.recentCwds")}…</option>
              {recentCwds.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 6, lineHeight: 1.45 }}>
            {agent === "codex" ? t("newCli.hintCodex") : t("newCli.hintClaude")}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
            <button
              class="btn-primary"
              style={{ height: 28, padding: "0 10px", fontSize: 11 }}
              disabled={pending || !cwd.trim()}
              onClick={() => void submit()}
            >{pending ? t("newCli.submitting") : t("newCli.submit")}</button>
            {err && <span style={{ fontSize: 10, color: "var(--accent)" }}>{t("newCli.error", { err })}</span>}
            {ok && <span style={{ fontSize: 10, color: "var(--pass)" }}>✓ {agent === "codex" ? t("newCli.successCodex") : t("newCli.successClaude")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Grid overview cell ────────────────────────────────────────────────────

function Cell({ s, preview, activity, streamingText, userOverlayText, userOverlayTs, pendingAsk, askDismissed, onReopenAsk, bannerHidden, onHideBanner, clientType, onSetClientType, onQuickSend, onOpenModal, showHidden, onHide, onUnhide }: {
  s: Session;
  preview?: SessionPreview;
  activity?: string;
  streamingText?: string;
  userOverlayText?: string;
  userOverlayTs?: number;
  pendingAsk?: PendingAsk;
  askDismissed?: boolean;
  onReopenAsk?: (uuid: string) => void;
  bannerHidden?: boolean;
  onHideBanner?: (uuid: string) => void;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenModal: (s: Session) => void;
  showHidden: boolean;
  onHide: (uuid: string) => void;
  onUnhide: (uuid: string) => void;
}) {
  const agent = agentOf(s);
  const title = preview?.ai_title ?? s.project_name;
  // Optimistic overlay wins over JSONL-derived text while we wait for the
  // /sessions/previews poll to catch up to the latest user turn.
  const lastUserRaw = userOverlayText && userOverlayText.length > 0
    ? userOverlayText
    : preview?.last_user_text;
  // Live stream wins over JSONL-derived preview while a turn is in flight.
  // Pending Codex sessions may not have a transcript file yet, so fall back
  // to the daemon's latest exec reply preview.
  const codexPreviewFallback = agent === "codex" && !preview?.last_assistant_text ? s.last_message_preview : undefined;
  const lastAssistantRaw = streamingText && streamingText.length > 0 ? streamingText : preview?.last_assistant_text ?? codexPreviewFallback;
  const lastTool = preview?.last_tool_use ?? null;
  const lastUser = useMemo(() => (lastUserRaw ? mdToPlainText(lastUserRaw) : ""), [lastUserRaw]);
  const lastAssistant = useMemo(() => (lastAssistantRaw ? mdToPlainText(lastAssistantRaw) : ""), [lastAssistantRaw]);
  const isStreaming = !!streamingText && streamingText.length > 0;
  // Thinking state — claude received the user msg, wrap is busy (activity
  // != null), but no streaming text has arrived yet. We only show the cue
  // when the latest user turn is newer than the latest assistant turn so
  // the indicator vanishes the moment claude's reply lands. userOverlayTs
  // wins over preview.last_user_ts because the preview poll lags.
  const isThinking = (() => {
    if (!activity || isStreaming) return false;
    const userTs = userOverlayTs && userOverlayTs > 0
      ? userOverlayTs
      : (preview?.last_user_ts ? Date.parse(preview.last_user_ts) : 0);
    const assistantTs = preview?.last_assistant_ts ? Date.parse(preview.last_assistant_ts) : 0;
    return userTs > assistantTs;
  })();
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
      class={"cell cell-clickable" + (flashing ? " cell-flash" : "") + (updateFlash ? " cell-flash-update" : "") + (pendingAsk && askDismissed && !bannerHidden ? " cell-ask-pending" : "")}
      style={{ borderTop: `3px solid ${STATUS_BORDER_COLOR[s.status]}` }}
      onClick={(e) => {
        // Safety net: chip popovers (PermissionMode / Model) render with
        // position:fixed. The real fix lives in CSS — `.cell:active` used
        // to apply `transform: scale(...)` which turned the cell into a
        // containing block for the fixed-positioned menu, causing the
        // menu to reanchor mid-press and the mouseup to land on the cell
        // (opening the big-card modal instead of selecting a mode). Even
        // with that fixed, keep this guard so any future fixed-popover
        // child of a cell can't accidentally trigger the modal.
        const tgt = e.target as HTMLElement | null;
        if (tgt?.closest?.(".pmode-chip-wrap, .pmode-menu")) return;
        onOpenModal(s);
      }}
    >
      <div class="cell-head">
        <span class="cell-title" title={title}>{title}</span>
        {pendingAsk && askDismissed && !bannerHidden && (
          <>
            <button
              class="cell-ask-bell"
              onClick={(e) => { e.stopPropagation(); if (s.session_uuid && onReopenAsk) onReopenAsk(s.session_uuid); }}
              title={t("session.waitingTooltip")}
            >{t("session.waitingBadge")}</button>
            {/* Tiny × to silence just this session's bell + red flash. Same
             * semantics as the modal banner dismiss: a NEW ask_question
             * with a different question_id wipes hiddenAskBanners so the
             * bell nags again. Stops propagation so it doesn't bubble to
             * the cell's onClick (which would open the big card). */}
            <button
              class="cell-ask-bell-dismiss"
              onClick={(e) => { e.stopPropagation(); if (s.session_uuid && onHideBanner) onHideBanner(s.session_uuid); }}
              title={t("session.dismissBanner")}
              aria-label={t("session.dismissBanner")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="6" y1="6" x2="18" y2="18"/>
                <line x1="18" y1="6" x2="6" y2="18"/>
              </svg>
            </button>
          </>
        )}
        {activity && (
          <span class="cell-activity" title={t("focus.wrapperRunning", { activity })}>
            <span class="cell-activity-dot" /> {activity}…
          </span>
        )}
        {/* CLI ("start wrap") button sits to the LEFT of the copy button so
         * the top row reads: title … [🔌 CLI] [📋 copy]. Hidden for wrapped
         * sessions (already wrapped — nothing to start). */}
        {!s.wrapped && agentOf(s) === "claude" && s.session_uuid && <WrapStartButton sessionUuid={s.session_uuid} />}
        <CloseCardButton
          sessionUuid={s.session_uuid ?? ""}
          wrapped={s.wrapped ?? false}
          isHiddenView={showHidden}
          onHide={onHide}
          onUnhide={onUnhide}
        />
      </div>
      <div class="cell-cwd" style={{ color: c.label, display: "flex", alignItems: "center", gap: 6 }} title={s.cwd}>
        <strong style={{ fontWeight: 600 }}>{s.project_name}</strong>
        <AgentBadge agent={agent} />
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
        {!lastUser && !lastAssistant && !isThinking ? (
          <span class="cell-empty">{t("session.empty")}</span>
        ) : (
          <>
            {/* Claude strip — rendered whenever there's a prev reply to show
             * OR when we're synthesising a thinking state. Plan X: instead
             * of opening a SEPARATE thinking strip below the user msg, we
             * reuse this strip so the blinking cursor sits at the end of
             * the previous claude reply (matches the user's mental model
             * of "cursor lives at end of text"). The two booleans
             * isStreaming and isThinking are mutually exclusive
             * (isThinking's definition requires !isStreaming), so the
             * header and body each show exactly one variant at a time. */}
            {(lastAssistant || isThinking) && (
              <div class="cell-turn cell-turn-assistant">
                <div class="cell-turn-role">
                  <span>{agentLabel(agent)}</span>
                  {/* During isThinking we deliberately fall through to the
                   * prev reply's timestamp instead of showing "{activity}…"
                   * here — the cell already has a global activity badge at
                   * the top-right (next to the wrapped/CLI chip), so a
                   * second "Ideating…" under CLAUDE was just visual
                   * duplication. The blue ▌ in the body is the only
                   * thinking-specific cue this strip needs. */}
                  {isStreaming
                    ? <span class="cell-turn-ts" style={{ color: "var(--pass)" }}>streaming…</span>
                    : preview?.last_assistant_ts && <span class="cell-turn-ts" title={preview.last_assistant_ts}>{fmtTurnTs(preview.last_assistant_ts)}</span>}
                </div>
                {/* Body shape: optional prev-assistant text, then a trailing
                 * cursor when claude is "live":
                 *   - isStreaming → black ▌  (claude is actively typing —
                 *                              lastAssistant is the live
                 *                              streaming text)
                 *   - isThinking  → blue  ▌  (claude is busy with no text
                 *                              yet — cursor sits at end of
                 *                              the prev reply we keep on
                 *                              screen as scaffolding)
                 * lastAssistant may be empty when isThinking fires on the
                 * very first turn (no prior reply); the body then shows
                 * just the cursor at the start of an empty line — graceful
                 * fallback. .cell-turn-body has overflow:hidden +
                 * -webkit-line-clamp:4 so when the prev reply fills the
                 * box, the trailing inline cursor can be clipped; we
                 * accept this for now since ASSISTANT_MAX=260 chars +
                 * 4-line clamp keeps it rare. */}
                <div class="cell-turn-body">
                  {lastAssistant.slice(0, ASSISTANT_MAX)}{lastAssistant.length > ASSISTANT_MAX ? "…" : ""}
                  {isStreaming && <span class="streaming-cursor">▌</span>}
                  {isThinking && <span class="streaming-cursor streaming-cursor--thinking">▌</span>}
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
        {s.wrapped && <ModelChip sessionUuid={s.session_uuid} current={s.current_model} currentEffort={s.current_effort} />}
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

function GridOverview({ sessions, sortMode, pinWaiting, previews, activities, streaming, userOverlay, pendingAsks, dismissedAsks, onReopenAsk, hiddenBanners, onHideBanner, getClientType, onSetClientType, onQuickSend, onOpenModal, showHidden, onHide, onUnhide }: {
  sessions: Session[];
  sortMode: SortMode;
  pinWaiting: boolean;
  previews: Record<string, SessionPreview>;
  activities: Record<string, string>;
  streaming: Record<string, string>;
  userOverlay: Record<string, { text: string; ts: number }>;
  pendingAsks: Record<string, PendingAsk>;
  dismissedAsks: Set<string>;
  onReopenAsk: (uuid: string) => void;
  hiddenBanners: Set<string>;
  onHideBanner: (uuid: string) => void;
  getClientType: (uuid: string | null | undefined) => ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenModal: (s: Session) => void;
  showHidden: boolean;
  onHide: (uuid: string) => void;
  onUnhide: (uuid: string) => void;
}) {
  // Deterministic ordering. The previous implementation used a useRef Map to
  // assign first-seen slot indexes, which was stable within a session but reset
  // on F5 (since useRef is per-mount). The user explicitly wanted F5-stable
  // ordering — so we now use a pure function of (sessions, sortMode, pinWaiting),
  // making the layout reproducible across reloads.
  //   priority → status (waiting first) then cwd alpha (default)
  //   cwd      → pure cwd alpha (most stable; never moves on activity)
  //   recent   → last_event_at DESC (mirrors backend; intentionally drifts)
  //
  // pinWaiting overlays on top: when on, any session with status === "waiting"
  // is partitioned to the top regardless of the base sort. Both partitions
  // keep their base-sort order internally so the relative position of cards
  // within each group is still F5-stable.
  const ordered = useMemo(() => {
    const sorted = sessions.slice().sort(compareFor(sortMode));
    if (!pinWaiting) return sorted;
    const waiting: Session[] = [];
    const rest: Session[] = [];
    for (const s of sorted) {
      (s.status === "waiting" ? waiting : rest).push(s);
    }
    return waiting.concat(rest);
  }, [sessions, sortMode, pinWaiting]);
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
          userOverlayTs={s.session_uuid ? userOverlay[s.session_uuid]?.ts : undefined}
          pendingAsk={s.session_uuid ? pendingAsks[s.session_uuid] : undefined}
          askDismissed={s.session_uuid ? dismissedAsks.has(s.session_uuid) : false}
          onReopenAsk={onReopenAsk}
          bannerHidden={s.session_uuid ? hiddenBanners.has(s.session_uuid) : false}
          onHideBanner={onHideBanner}
          clientType={getClientType(s.session_uuid)}
          onSetClientType={onSetClientType}
          onQuickSend={onQuickSend}
          onOpenModal={onOpenModal}
          showHidden={showHidden}
          onHide={onHide}
          onUnhide={onUnhide}
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
  const agent = agentOf(s);
  const isWrapped = !!s.wrapped;
  const canSend = isWrapped || agent === "codex";
  // Only wrapped CLI sessions allow send. VSCode-panel mode is disabled
  // (claude-code creates fresh empty panel when uuid not in its sessionPanels).
  // Wrap-push is the only reliable delivery path.
  const sendBlocked = !canSend;
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  // VSCode: prefill (free). Wrapped: server routes ANY mode through wrap WS push, so mode doesn't matter.
  const [submitMode, setSubmitMode] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; label: string; reply?: string } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Images only travel through wrap-push. Warn user when in any other mode.
  const imagesSupported = isWrapped || agent === "codex";

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
              : agent === "codex"
                ? t("composer.inputPromptCodex")
              : t("composer.inputPrompt")
          }
          value={prompt}
          onInput={(e) => setPrompt((e.currentTarget as HTMLTextAreaElement).value)}
          onPaste={(e) => { void handlePaste(e as unknown as ClipboardEvent); }}
          onKeyDown={(e) => {
            if (shouldSendOnKey(e as unknown as KeyboardEvent, sendKey)) {
              e.preventDefault();
              if (!busy && !sendBlocked && (prompt.trim() || images.length > 0)) handleSend();
            }
          }}
          disabled={busy || sendBlocked}
          style={{ width: "100%", minHeight: 80, fontSize: 13, fontFamily: "inherit", marginBottom: 8 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Mobile-friendly image upload — see matching button in <Card>. */}
          <label
            class="btn-ghost"
            style={{
              height: 32, padding: "0 10px", display: "inline-flex",
              alignItems: "center", justifyContent: "center",
              cursor: imagesSupported && !busy ? "pointer" : "not-allowed",
              opacity: imagesSupported && !busy ? 1 : 0.5,
            }}
            title={t("composer.uploadImage")}
            aria-label={t("composer.uploadImage")}
          >
            <IconImagePlus size={14} />
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              disabled={!imagesSupported || busy}
              onChange={async (e) => {
                const el = e.currentTarget as HTMLInputElement;
                const got = await filesToAttachedImages(el.files);
                if (got.length > 0) setImages((prev) => [...prev, ...got]);
                el.value = "";
              }}
            />
          </label>
          {(isWrapped || (agent === "codex" && busy)) && (
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
            class={canSend ? "btn-primary" : "btn-ghost"}
            disabled={(!prompt.trim() && images.length === 0) || busy || sendBlocked}
            onClick={handleSend}
            style={canSend ? undefined : { marginLeft: "auto" }}
            title={sendBlocked ? t("composer.needWrapHint2") : agent === "codex" ? t("composer.codexExecHint") : t("composer.wrapWSShort")}
          >
            {busy ? t("composer.sendBusy") : canSend ? t("composer.sendWrapped") : t("composer.sendNeedWrap")}
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

function CellModal({ s, onClose, clientType, onSetClientType, onFocus, onSend, sendKey, pendingAsk, askDismissed, onReopenAsk, bannerHidden, onHideBanner, activity, transcript, transcriptLoading, transcriptError, transcriptLimit, onSetTranscriptLimit, onReloadTranscript, showTools, onSetShowTools, streamingText, streamingStartTs, userOverlayText, userOverlayTs }: {
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
  bannerHidden?: boolean;
  onHideBanner?: (uuid: string) => void;
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
  streamingStartTs?: number;
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

  // Lock body scroll while modal is open. On desktop `overflow: hidden` is
  // enough, but iOS Safari ignores it during momentum/touch scroll — the
  // page underneath still scrolls when a touch inside the modal hits the
  // scroll boundary. The reliable iOS fix is to flip body to `position:
  // fixed` and offset it by the current scrollY; on unmount we restore the
  // styles AND scrollTo the saved offset so the dashboard ends up exactly
  // where the user left it.
  useEffect(() => {
    const body = document.body;
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    const scrollY = window.scrollY || window.pageYOffset || 0;
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      // Restore exact scroll position. Without this the dashboard jumps to
      // the top when the modal closes.
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Swipe-right-to-close gesture (back gesture, matches iOS convention).
  //
  // The previous attempt used React synthetic onTouchStart/End on the modal
  // panel. Those handlers never fired reliably because the transcript
  // scroll container (which fills most of the modal) captures touch
  // sequences for its own vertical scroll handling on iOS, swallowing the
  // bubble path. Document-level native listeners get every touch
  // unconditionally — including the ones that started inside the scroller.
  //
  // We also drag the modal panel along with the finger for visual
  // feedback (transform: translateX) so the user can SEE that the gesture
  // is being recognised. If the gesture aborts (lifted finger short of
  // threshold, or vertical motion dominates), we snap back to 0.
  const modalPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = modalPanelRef.current;
    if (!panel) return;
    let startX = 0, startY = 0;
    let active = false;
    let armed = false;       // true once we're sure this is a horizontal gesture
    let onInteractive = false;
    function reset() {
      active = false; armed = false; onInteractive = false;
      panel!.style.transition = "transform 0.18s ease-out";
      panel!.style.transform = "";
    }
    function isInteractive(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (el.closest("textarea, input, select")) return true;
      // Anything inside an open popover menu (model / permission mode picker).
      if (el.closest(".pmode-menu")) return true;
      return false;
    }
    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) { active = false; return; }
      const t = e.touches[0]!;
      // Only consider touches that started inside the modal panel.
      if (!panel!.contains(t.target as Node)) { active = false; return; }
      startX = t.clientX; startY = t.clientY;
      active = true; armed = false;
      onInteractive = isInteractive(t.target);
      panel!.style.transition = "none";  // follow finger 1:1 during drag
    }
    function onMove(e: TouchEvent) {
      if (!active || onInteractive) return;
      const t = e.touches[0]; if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!armed) {
        // Disambiguate gesture once motion is ~8px. If clearly vertical
        // (likely a transcript scroll), abandon — vertical scroll proceeds
        // normally because we don't preventDefault.
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) { active = false; return; }
        armed = true;
      }
      if (dx > 0) {
        // Drag follows finger rightward. Cap leftward drag at 0 (don't
        // let the modal slide off the left edge — left-swipe isn't a
        // close gesture in this app).
        panel!.style.transform = `translateX(${dx}px)`;
        // Once we own the gesture, prevent the page from also reacting
        // (e.g. iOS native swipe-to-go-back when starting near the left
        // edge — same direction, would race us).
        if (e.cancelable) e.preventDefault();
      } else {
        panel!.style.transform = "";
      }
    }
    function onEnd(e: TouchEvent) {
      if (!active) { reset(); return; }
      const t = e.changedTouches[0];
      if (!t) { reset(); return; }
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Threshold: travelled ≥80px right AND horizontal-dominant.
      if (armed && dx > 80 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        // Animate the rest of the way off-screen then close.
        panel!.style.transition = "transform 0.16s ease-out";
        panel!.style.transform = `translateX(100%)`;
        // Wait for the slide before calling onClose so the user perceives
        // continuity. If anything ever races, the modal still unmounts.
        window.setTimeout(() => { onClose(); }, 160);
      } else {
        reset();
      }
    }
    // passive:false on touchmove so we can preventDefault when horizontal-
    // dominant; touchstart/end stay passive (cheaper, no preventDefault).
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [onClose]);

  return (
    <div class="dialog-backdrop cell-modal-backdrop" onClick={onClose}>
      <div
        ref={modalPanelRef}
        class="dialog-panel cell-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button class="cell-modal-close" onClick={onClose} title={t("session.modalClose")}>×</button>
        {pendingAsk && askDismissed && !bannerHidden && (
          <div class="cell-modal-ask-banner">
            <span>{t("session.claudeWaitingHere")}</span>
            {/* Re-open the AskQuestionModal. SVG eye icon, not a labelled
                button — the previous "重新顯示問題" text button collided
                with the modal's × close button (top:8 right:8). */}
            <button
              class="cell-modal-ask-banner-btn"
              onClick={() => { if (s.session_uuid && onReopenAsk) onReopenAsk(s.session_uuid); }}
              title={t("session.showQuestion")}
              aria-label={t("session.showQuestion")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            {/* Hide just this banner — the small-card 🔔 still nags so
                the user doesn't lose track of the unanswered question. */}
            <button
              class="cell-modal-ask-banner-btn cell-modal-ask-banner-dismiss"
              onClick={() => { if (s.session_uuid && onHideBanner) onHideBanner(s.session_uuid); }}
              title={t("session.dismissBanner")}
              aria-label={t("session.dismissBanner")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="6" y1="6" x2="18" y2="18"/>
                <line x1="18" y1="6" x2="6" y2="18"/>
              </svg>
            </button>
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
          streamingStartTs={streamingStartTs}
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

// AskUserQuestion dismiss state — persisted by question_id (NOT session
// uuid) so that:
//   (a) F5 → the user's "I already X'd this" decision survives. Without
//       this, the daemon resends `ask_question` on WS reconnect and the
//       modal pops back up immediately, ignoring the user's dismiss.
//   (b) A new question (different question_id) naturally falls outside
//       the persisted set → modal/banner show again — no manual cleanup
//       needed when claude moves on.
// Bounded to MAX_TRACKED so the LS entry can't grow unboundedly across
// long sessions; oldest entries roll off FIFO-ish (we just slice).
const ASK_DISMISSED_LS_KEY = "miki-moni:ask-dismissed-qids";
const ASK_HIDDEN_BANNER_LS_KEY = "miki-moni:ask-hidden-banner-qids";
const MAX_TRACKED_ASK_QIDS = 200;
function loadQidSetFromLS(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((s) => typeof s === "string")) : new Set();
  } catch { return new Set(); }
}
function saveQidSetToLS(key: string, s: Set<string>) {
  try {
    const arr = Array.from(s);
    const bounded = arr.length > MAX_TRACKED_ASK_QIDS ? arr.slice(-MAX_TRACKED_ASK_QIDS) : arr;
    localStorage.setItem(key, JSON.stringify(bounded));
  } catch { /* quota / disabled */ }
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

// "Pin waiting" toggle. Orthogonal to sortMode: when on, sessions whose
// status === "waiting" (Claude is blocked on user input) float to the top
// regardless of which base sort is selected. Default on — Miki the Monitor's
// whole job is to surface these, so users shouldn't have to opt in.
const PIN_WAITING_LS_KEY = "miki-moni:pin-waiting";
function loadPinWaitingFromLS(): boolean {
  try {
    const raw = localStorage.getItem(PIN_WAITING_LS_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch { /* SSR / disabled */ }
  return true;
}
function savePinWaitingToLS(v: boolean): void {
  try { localStorage.setItem(PIN_WAITING_LS_KEY, v ? "1" : "0"); } catch { /* quota / disabled */ }
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
const AGENT_FILTER_LS_KEY = "miki-moni:agent-filter";
function loadAgentFilterFromLS(): AgentFilter {
  try {
    const raw = localStorage.getItem(AGENT_FILTER_LS_KEY);
    if (raw === "all" || raw === "claude" || raw === "codex") return raw;
  } catch { /* SSR / disabled */ }
  return "all";
}
function saveAgentFilterToLS(v: AgentFilter): void {
  try { localStorage.setItem(AGENT_FILTER_LS_KEY, v); } catch { /* quota / disabled */ }
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
  // messages while a turn is in progress. Cleared not on assistant_delta_end
  // (that left a blank gap until canonical JSONL landed ~300ms later — the
  // user-visible "flash"), but in loadPreviews once last_assistant_ts proves
  // canonical has caught up. Render-time logic uses streamingStartTs to skip
  // the overlay when canonical already has the assistant turn, avoiding both
  // the flash AND a brief duplicate render.
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  // Wall-clock timestamp recorded on assistant_delta_start; used as the
  // "is canonical caught up?" reference. Parallel to `streaming` so we can
  // keep that state shape compatible with existing consumers.
  const [streamingStartTs, setStreamingStartTs] = useState<Record<string, number>>({});
  // Optimistic user-message overlay per session — populated by user_message WS
  // (wrap.ts emits this the instant Enter is pressed, before SDK flushes to
  // JSONL). The small card's "user" line reads this first; we drop it once the
  // canonical /sessions/previews response's last_user_ts catches up.
  const [userOverlay, setUserOverlay] = useState<Record<string, { text: string; ts: number }>>({});
  // Pending AskUserQuestion per session — Claude is waiting for a pick.
  const [asks, setAsks] = useState<Record<string, PendingAsk>>({});
  // Asks the user clicked-away from (modal closed but question still unanswered).
  // Card flashes red + shows 🔔 button to re-open. Submitted / wrap-side answered clears.
  // Keyed by session uuid; the persisted counterpart below is keyed by question_id
  // so F5 / WS reconnect restores the user's "I dismissed this" decision without
  // resurrecting it when a NEW question (different qid) arrives.
  const [dismissedAsks, setDismissedAsks] = useState<Set<string>>(new Set());
  const [dismissedAskQids, setDismissedAskQids] = useState<Set<string>>(() => loadQidSetFromLS(ASK_DISMISSED_LS_KEY));
  // Sessions whose "Claude is waiting" banner (big-card banner + small-card 🔔
  // + red flash) the user explicitly X'd. Separate from dismissedAsks so we
  // could decouple them later if needed. Auto-clears on new question (in
  // ask_question handler) or on answer (ask_question_done).
  const [hiddenAskBanners, setHiddenAskBanners] = useState<Set<string>>(new Set());
  const [hiddenAskBannerQids, setHiddenAskBannerQids] = useState<Set<string>>(() => loadQidSetFromLS(ASK_HIDDEN_BANNER_LS_KEY));
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [clientTypes, setClientTypesState] = useState<Record<string, ClientType>>(() => loadClientTypesFromLS());
  const [sendKey, setSendKeyState] = useState<SendKey>(() => loadSendKeyFromLS());
  const [theme, setThemeState] = useState<Theme>(() => loadThemeFromLS());
  const [showSettings, setShowSettings] = useState(false);
  const [monitOpen, setMonitOpen] = useState(false);
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
    return Math.min(10000, limit * 50);
  }
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>(() => loadStatusFilterFromLS());
  function setStatusFilter(v: StatusFilter) {
    setStatusFilterState(v);
    saveStatusFilterToLS(v);
  }
  const [agentFilter, setAgentFilterState] = useState<AgentFilter>(() => loadAgentFilterFromLS());
  function setAgentFilter(v: AgentFilter) {
    setAgentFilterState(v);
    saveAgentFilterToLS(v);
  }
  // Hidden-cards state. Per-browser via localStorage. Cross-tab sync is
  // wired via the `storage` event in a useEffect below.
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(() => loadHiddenSet());
  const [showHidden, setShowHidden] = useState(false);

  function hideSession(uuid: string) {
    setHiddenSet(prev => addHidden(prev, uuid));
  }
  function unhideSession(uuid: string) {
    setHiddenSet(prev => removeHidden(prev, uuid));
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== HIDDEN_KEY) return;
      setHiddenSet(loadHiddenSet());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // Auto-flip out of "show hidden" view when the user un-hides the last card,
  // so they aren't stranded looking at an empty grid.
  useEffect(() => {
    if (hiddenSet.size === 0 && showHidden) setShowHidden(false);
  }, [hiddenSet.size, showHidden]);
  const [sortMode, setSortModeState] = useState<SortMode>(() => loadSortModeFromLS());
  const [pinWaiting, setPinWaitingState] = useState<boolean>(() => loadPinWaitingFromLS());
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    void apiFetch("/admin/version-check")
      .then((r) => r.ok ? r.json() : null)
      .then((info) => { if (info) setUpdateInfo(info as UpdateInfo); })
      .catch(() => { /* silent — badge just won't render */ });
  }, []);

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
  function setPinWaiting(v: boolean) {
    setPinWaitingState(v);
    savePinWaitingToLS(v);
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

  // Shared helpers for ask-dismiss / banner-hide / re-open. They mutate the
  // session-uuid-keyed in-memory sets AND the question-id-keyed persisted
  // sets so the user's decision survives F5 / WS reconnect. The qid lookup
  // uses functional setState on `asks` to avoid stale closures.
  function dismissAskForSession(uuid: string) {
    setDismissedAsks((prev) => { if (prev.has(uuid)) return prev; const next = new Set(prev); next.add(uuid); return next; });
    setAsks((prev) => {
      const qid = prev[uuid]?.question_id;
      if (qid) {
        setDismissedAskQids((q) => { if (q.has(qid)) return q; const next = new Set(q); next.add(qid); saveQidSetToLS(ASK_DISMISSED_LS_KEY, next); return next; });
      }
      return prev;
    });
  }
  function hideBannerForSession(uuid: string) {
    setHiddenAskBanners((prev) => { if (prev.has(uuid)) return prev; const next = new Set(prev); next.add(uuid); return next; });
    setAsks((prev) => {
      const qid = prev[uuid]?.question_id;
      if (qid) {
        setHiddenAskBannerQids((q) => { if (q.has(qid)) return q; const next = new Set(q); next.add(qid); saveQidSetToLS(ASK_HIDDEN_BANNER_LS_KEY, next); return next; });
      }
      return prev;
    });
  }
  function reopenAskForSession(uuid: string) {
    setDismissedAsks((prev) => { if (!prev.has(uuid)) return prev; const next = new Set(prev); next.delete(uuid); return next; });
    setHiddenAskBanners((prev) => { if (!prev.has(uuid)) return prev; const next = new Set(prev); next.delete(uuid); return next; });
    setAsks((prev) => {
      const qid = prev[uuid]?.question_id;
      if (qid) {
        // Clear persisted "dismissed" + "hidden" for this qid — user is
        // engaging with it again, so a future F5 should let the modal
        // auto-open if it's still unanswered.
        setDismissedAskQids((q) => { if (!q.has(qid)) return q; const next = new Set(q); next.delete(qid); saveQidSetToLS(ASK_DISMISSED_LS_KEY, next); return next; });
        setHiddenAskBannerQids((q) => { if (!q.has(qid)) return q; const next = new Set(q); next.delete(qid); saveQidSetToLS(ASK_HIDDEN_BANNER_LS_KEY, next); return next; });
      }
      return prev;
    });
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
      // Drop streaming buffers once canonical JSONL has caught up (its
      // last_assistant_ts ≥ the streamingStartTs we recorded on
      // assistant_delta_start). Mirrors the userOverlay cleanup above and
      // closes the "flash" loop — render kept the overlay visible during
      // the gap, this clears it now that canonical owns the turn.
      setStreamingStartTs((prevStartTs) => {
        const muted = new Set<string>();
        const nextStartTs: Record<string, number> = {};
        for (const [uuid, startTs] of Object.entries(prevStartTs)) {
          const p = map[uuid];
          const aTs = p?.last_assistant_ts ? Date.parse(p.last_assistant_ts) : 0;
          if (aTs >= startTs) { muted.add(uuid); continue; }
          nextStartTs[uuid] = startTs;
        }
        if (muted.size > 0) {
          setStreaming((prev) => {
            const next = { ...prev };
            for (const uuid of muted) delete next[uuid];
            return next;
          });
        }
        return muted.size > 0 ? nextStartTs : prevStartTs;
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
        // (covers the case where a turn has multiple text blocks). Record
        // a wall-clock startTs so render + loadPreviews can decide later
        // when canonical JSONL has caught up.
        const uuid = msg.session_uuid as string;
        addLog("info", "WS assistant_delta_start", { uuid: uuid.slice(0, 8) });
        setStreaming((prev) => ({ ...prev, [uuid]: "" }));
        setStreamingStartTs((prev) => ({ ...prev, [uuid]: Date.now() }));
      } else if (msg.type === "assistant_delta") {
        const uuid = msg.session_uuid as string;
        const chunk = typeof msg.text === "string" ? msg.text : "";
        if (!chunk) return;
        setStreaming((prev) => ({ ...prev, [uuid]: (prev[uuid] ?? "") + chunk }));
      } else if (msg.type === "assistant_delta_end") {
        // Turn complete. Crucially we do NOT drop the streaming buffer here
        // anymore — that used to leave the dashboard blank for the 300ms+
        // gap between delta_end and canonical JSONL landing (the "flash"
        // the user reported). The buffer survives until loadPreviews sees
        // last_assistant_ts >= streamingStartTs[uuid] and clears it; the
        // render-time check in <Card> uses the same comparison to skip
        // the overlay once canonical has the turn, so there's no duplicate.
        const uuid = msg.session_uuid as string;
        addLog("info", "WS assistant_delta_end", { uuid: uuid.slice(0, 8) });
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
        const newQid = msg.question_id as string;
        const ask: PendingAsk = { question_id: newQid, questions: msg.questions };
        // Snapshot the persisted qid sets via setState callbacks (avoid
        // racing with concurrent updates).
        let alreadyDismissed = false;
        let alreadyHidden = false;
        setDismissedAskQids((qs) => { alreadyDismissed = qs.has(newQid); return qs; });
        setHiddenAskBannerQids((qs) => { alreadyHidden = qs.has(newQid); return qs; });
        setAsks((prev) => {
          // qid changed → clear any stale per-session flags carried over
          // from the previous question so the new one is actually visible.
          const existing = prev[uuid];
          const qidChanged = !existing || existing.question_id !== newQid;
          if (qidChanged) {
            setDismissedAsks((d) => {
              const has = d.has(uuid);
              if (alreadyDismissed) {
                // F5 / WS reconnect: persisted set says user X'd this qid
                // before → keep dismissedAsks set for this session.
                if (has) return d;
                const n = new Set(d); n.add(uuid); return n;
              }
              if (!has) return d;
              const n = new Set(d); n.delete(uuid); return n;
            });
            setHiddenAskBanners((h) => {
              const has = h.has(uuid);
              if (alreadyHidden) {
                if (has) return h;
                const n = new Set(h); n.add(uuid); return n;
              }
              if (!has) return h;
              const n = new Set(h); n.delete(uuid); return n;
            });
          }
          return { ...prev, [uuid]: ask };
        });
      } else if (msg.type === "ask_question_done") {
        const uuid = msg.session_uuid as string;
        // The question for `uuid` has been answered/cancelled wrap-side.
        // Forget every trace of it (in-memory + persisted) so a future
        // re-emission of the same qid (defensive) doesn't auto-dismiss it.
        let doneQid: string | null = null;
        setAsks((prev) => {
          doneQid = prev[uuid]?.question_id ?? null;
          const next = { ...prev }; delete next[uuid]; return next;
        });
        setDismissedAsks((prev) => { if (!prev.has(uuid)) return prev; const next = new Set(prev); next.delete(uuid); return next; });
        setHiddenAskBanners((prev) => { if (!prev.has(uuid)) return prev; const next = new Set(prev); next.delete(uuid); return next; });
        if (doneQid) {
          const qid = doneQid;
          setDismissedAskQids((prev) => { if (!prev.has(qid)) return prev; const next = new Set(prev); next.delete(qid); saveQidSetToLS(ASK_DISMISSED_LS_KEY, next); return next; });
          setHiddenAskBannerQids((prev) => { if (!prev.has(qid)) return prev; const next = new Set(prev); next.delete(qid); saveQidSetToLS(ASK_HIDDEN_BANNER_LS_KEY, next); return next; });
        }
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
    const overlayText = stripCodexBrowserContext(prompt).trim() || (imgPayload && imgPayload.length > 0 ? `[image x ${imgPayload.length}]` : "");
    if (overlayText) {
      setUserOverlay((prev) => ({ ...prev, [uuid]: { text: overlayText, ts: Date.now() } }));
    }
    addLog("info", `POST /send (mode=${submit ? "submit" : "prefill"})`, { uuid: uuid.slice(0, 8), len: prompt.length, images: imgPayload?.length ?? 0 });
    try {
      const r = await apiFetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid, prompt, submit, images: imgPayload }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/send ${r.status}`, { mode: body?.mode, reply_preview: body?.reply?.slice(0, 60), duration_ms: body?.duration_ms, diag: body?.diag });
      // refresh previews so the cell shows the new reply
      if (r.ok) scheduleRefresh();
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
  const displaySessions = useMemo(
    () => sessions.map((s) => displaySession(s, s.session_uuid ? previews[s.session_uuid] : undefined)),
    [sessions, previews],
  );

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
        <div class="header-stats-bar">
          <HeaderStats
            sessions={displaySessions}
            filter={statusFilter}
            onFilter={setStatusFilter}
            agentFilter={agentFilter}
            onAgentFilter={setAgentFilter}
            hiddenCount={hiddenSet.size}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden(v => !v)}
          />
        </div>
        <div style={{ marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-subtle)" }}>
          <span class="header-newcli"><NewCliButton recentCwds={recentCwds} /></span>
          <button
            class="p-1.5 rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 transition-colors"
            title="效能監控"
            onClick={() => setMonitOpen(v => !v)}>
            <IconMonit size={18}/>
          </button>
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
              // position: fixed (not absolute) so the popover anchors to the
              // viewport, not <header>. With absolute + short-page (cards fit
              // in 1 row), body height ≈ viewport and absolute-positioned
              // elements don't push body taller — so when the popover
              // extends below the visible area, the browser has nothing to
              // scroll into view and the bottom half (語言 / 關閉) silently
              // gets clipped. fixed avoids that entirely: maxHeight clamps
              // the popover inside the viewport every time.
              position: "fixed", top: 50, right: 8, zIndex: 50,
              background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "12px 14px", minWidth: 280, boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
              // 58px = top(50) + bottom gutter(8). Ensures the popover always
              // fits within viewport and scrolls internally if content is
              // taller than available space.
              maxHeight: "calc(100vh - 58px)",
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

            {/* Pin-waiting toggle — orthogonal to sortMode. Default on so a
                user never misses a session blocked on their input. */}
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 14, marginBottom: 8, paddingTop: 12, borderTop: "1px solid var(--border)" }}>{t("settings.pinWaitingTitle")}</div>
            <label
              style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, color: "var(--fg)", cursor: "pointer", userSelect: "none",
                padding: "4px 0",
              }}
              title={t("settings.pinWaitingTitleAttr")}
            >
              <input
                type="checkbox"
                checked={pinWaiting}
                onChange={(e) => setPinWaiting((e.currentTarget as HTMLInputElement).checked)}
                style={{ margin: 0, width: 14, height: 14 }}
              />
              <span>{t("settings.pinWaitingLabel")}</span>
            </label>
            <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginTop: 4, lineHeight: 1.5 }}>
              {t("settings.pinWaitingHelp")}
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

            {/* Footer row: version on the left (low-emphasis, monospace-ish)
                + close on the right. Version is informational only — clicking
                does nothing. Sourced from vite-injected __APP_VERSION__ so it
                always matches the built bundle, not whatever is running on
                disk in dev mode. */}
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--fg-subtle)",
                    fontVariantNumeric: "tabular-nums",
                    userSelect: "text",
                  }}
                  title={`miki-moni v${__APP_VERSION__}`}
                >v{__APP_VERSION__}</span>
                {updateInfo?.hasUpdate && updateInfo.latest && (
                  <UpdateBadge latest={updateInfo.latest} />
                )}
              </span>
              <button class="btn-ghost" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setShowSettings(false)}>{t("settings.close")}</button>
            </div>
          </div>
        )}
      </header>

      {/* Dashboard — single view. Tabs removed; click a cell to open the
          modal big-card. Modal owns its own expanded transcript view. */}
      <div style={{ marginTop: 12, marginBottom: 20 }} />
      {displaySessions.length === 0 ? (
        <div class="card" style={{ padding: "24px 14px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
          <div>{t("overview.noSessions")}</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>{t("overview.openPanelHint")}</div>
          <div style={{ fontSize: 11 }}>{t("overview.runHooks")}<code>pnpm install:hooks</code></div>
        </div>
      ) : (
        <GridOverview
          sessions={displaySessions.filter((s) => {
            if (statusFilter === "all") return true;
            if (statusFilter === "live") return s.status === "active" || s.status === "waiting";
            return s.status === statusFilter;
          }).filter((s) => {
            if (agentFilter === "all") return true;
            return agentOf(s) === agentFilter;
          }).filter((s) => {
            // Hidden filter is orthogonal to status filter. Default view excludes
            // hidden cards; the 🙈 chip flips showHidden true to inspect them.
            const uuid = s.session_uuid ?? "";
            return showHidden ? hiddenSet.has(uuid) : !hiddenSet.has(uuid);
          })}
          sortMode={sortMode}
          pinWaiting={pinWaiting}
          previews={previews}
          activities={activities}
          streaming={streaming}
          userOverlay={userOverlay}
          pendingAsks={asks}
          dismissedAsks={dismissedAsks}
          onReopenAsk={reopenAskForSession}
          hiddenBanners={hiddenAskBanners}
          onHideBanner={hideBannerForSession}
          getClientType={getClientType}
          onSetClientType={setClientType}
          onQuickSend={openQuickSend}
          onOpenModal={openCellModal}
          showHidden={showHidden}
          onHide={hideSession}
          onUnhide={unhideSession}
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
          onReopenAsk={reopenAskForSession}
          bannerHidden={modalFor.session_uuid ? hiddenAskBanners.has(modalFor.session_uuid) : false}
          onHideBanner={hideBannerForSession}
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
          streamingStartTs={modalFor.session_uuid ? streamingStartTs[modalFor.session_uuid] : undefined}
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
              const qid = ask.question_id;
              setAsks((prev) => { const next = { ...prev }; delete next[askUuid]; return next; });
              setDismissedAsks((prev) => { const next = new Set(prev); next.delete(askUuid); return next; });
              setHiddenAskBanners((prev) => { if (!prev.has(askUuid)) return prev; const next = new Set(prev); next.delete(askUuid); return next; });
              // Clear persisted qid flags — the answered question shouldn't
              // sit in LS forever (bounded but still wasted).
              setDismissedAskQids((prev) => { if (!prev.has(qid)) return prev; const next = new Set(prev); next.delete(qid); saveQidSetToLS(ASK_DISMISSED_LS_KEY, next); return next; });
              setHiddenAskBannerQids((prev) => { if (!prev.has(qid)) return prev; const next = new Set(prev); next.delete(qid); saveQidSetToLS(ASK_HIDDEN_BANNER_LS_KEY, next); return next; });
              addLog("info", `ask answered`, { uuid: askUuid.slice(0, 8), project: s?.project_name });
            }}
            onDismiss={() => {
              // Modal closed but question still pending — flag it so card
              // pulses red + shows 🔔, and persist by question_id so F5 /
              // WS reconnect doesn't resurrect the modal.
              dismissAskForSession(askUuid);
            }}
          />
        );
      })()}

      {monitOpen && <MonitPanel onClose={() => setMonitOpen(false)}/>}
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
