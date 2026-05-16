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
  last_tool_use: { name: string; description?: string } | null;
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
  const bgClass = isUser ? "turn-bg-user" : "turn-bg-assistant";
  return (
    <div class={bgClass} style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
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

type ActionResult = { ok: boolean; label: string; url?: string; reply?: string; durationMs?: number; diag?: string; ts: number } | null;

function Card({ s, defaultExpanded, clientType, onSetClientType, onFocus, onSend }: {
  s: Session;
  defaultExpanded: boolean;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onFocus: (uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (uuid: string, prompt: string, submit: boolean) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number; diag?: string }>;
}) {
  const isCli = clientType === "cli";
  const [collapsed, setCollapsed] = useState(!defaultExpanded);
  const [draft, setDraft] = useState("");
  // Default = prefill (free, uses your already-running VSCode panel session).
  // 真送出 (-p headless) is OPT-IN — it spawns a NEW claude.exe that re-loads
  // the whole session context through cache → burns real $ for large sessions
  // BEFORE generating any token.
  const [submitMode, setSubmitMode] = useState(false);
  // CLI session can ONLY use submitMode (vscode:// URI doesn't reach a terminal).
  // Force it on whenever clientType flips to cli.
  useEffect(() => { if (isCli && !submitMode) setSubmitMode(true); }, [isCli]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (!prompt) return;
    clog("click send", { cwd: s.cwd, uuid: sessionUuid, mode: submitMode ? "submit" : "prefill+enter", len: prompt.length });
    setSendResult(null);
    setBusy(true);
    try {
      const r = await onSend(sessionUuid, prompt, submitMode);
      const label = !r.ok
        ? `失敗 HTTP ${r.status}`
        : submitMode
          ? `Claude 已回覆 (${r.duration_ms ?? "?"} ms)`
          : `已送出到 VSCode panel（Enter 已自動按）`;
      setSendResult({ ok: r.ok, label, url: r.url, reply: r.reply, durationMs: r.duration_ms, diag: r.diag, ts: Date.now() });
      setDraft("");
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
  // When defaultExpanded (tab view): card fills viewport, transcript flex:1 in middle,
  // bottom section (meta + composer) sticks to bottom.
  // When inline (legacy): natural height.
  const fixedHeight = defaultExpanded;
  return (
    <div class="card" style={fixedHeight ? { display: "flex", flexDirection: "column", height: "calc(100vh - 220px)", minHeight: 480 } : undefined}>
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
        <ClientTypeBadge
          type={clientType}
          onToggle={() => onSetClientType(sessionUuid, isCli ? "vscode" : "cli")}
          size="md"
        />
        <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{STATUS_LABEL[s.status]}</span>
        <span style={{ color: "var(--fg-subtle)", fontSize: 11, marginLeft: 8 }}>{fmtRelative(s.last_event_at)}</span>
        <button
          class="btn-ghost"
          style={{ marginLeft: "auto", fontSize: 11 }}
          onClick={handleFocus}
          title={isCli ? "🚫 CLI session 不支援同步（URI handler 只開 VSCode）" : "同步 VSCode panel — 觸發 vscode:// URI handler 強制 extension 重新從 JSONL 讀 session（已開的 tab 可能只 refocus，請配合 Cmd/Ctrl+Shift+P → Developer: Reload Window 確保 hot-reload）"}
          disabled={isCli}
        >🔄 同步</button>
        <button class="btn-ghost" onClick={() => setCollapsed(true)} title="收合">▴</button>
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
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              style={{ flex: 1, minHeight: 38, fontSize: 13 }}
              rows={2}
              placeholder={submitMode ? "輸入 prompt 真的送給這個 session（會花 API 費用）…" : "輸入 prompt 一鍵送給這個 session（透過你 VSCode panel）…"}
              value={draft}
              onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
              disabled={busy}
            />
            <button
              class={submitMode ? "btn-warn" : "btn-primary"}
              disabled={!draft.trim() || busy}
              onClick={handleSend}
              title={submitMode ? "headless `claude -p`（新 process、重 load cache、花 API$）" : "vscode:// URI prefill + 自動按 Enter（用 panel 既有 session、cache 熱、~free）"}
            >
              {busy ? "⌛" : submitMode ? "真送出 💸" : "送出"}
            </button>
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
            {isCli ? (
              <>
                📟 <strong style={{ color: "#a8740d" }}>CLI session</strong>：vscode:// URI 沒辦法塞進 terminal，所以只能走 spawn {"`claude -r <uuid> -p`"}（會花 $$，新 process 不會出現在你 terminal 視覺輸出，但 JSONL 會更新 → dashboard 看得到）。
              </>
            ) : submitMode ? (
              <>
                💸 <strong style={{ color: "var(--accent)" }}>真送出</strong>：spawn `claude -p` 新 process、重 load 整個 session cache、call API → 大 session 可能花 $2-5+。<br />
                <span style={{ color: "var(--warn)" }}>⚠️ Windows 限制：prompt 含中文/emoji 會被切碼，請用英文。</span>
              </>
            ) : (
              <>
                🚀 <strong style={{ color: "var(--pass)" }}>送出</strong>：vscode:// URI 把 prompt 塞進你現有 VSCode panel 的 input box，自動按 Enter → 走你 panel 已 loaded 的 session（cache 全熱、不重 load、近乎零成本）。⚠️ 按下後別動鍵盤/滑鼠 800ms，避免 Enter 落到別的視窗。
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

// ── Grid overview cell ────────────────────────────────────────────────────

function Cell({ s, preview, clientType, onSetClientType, onQuickSend, onOpenTab, onSync }: {
  s: Session;
  preview?: SessionPreview;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenTab: (uuid: string) => void;
  onSync: (uuid: string) => void;
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

  function handleClick(ev: MouseEvent) {
    onQuickSend(s, ev.clientX, ev.clientY);
  }

  const USER_MAX = 140;
  const ASSISTANT_MAX = 260;

  return (
    <div class={"cell" + (flashing ? " cell-flash" : "")} onClick={handleClick} style={{ borderTop: `3px solid ${c.border}` }}>
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
      <div class="cell-cwd" style={{ color: c.label, display: "flex", alignItems: "center", gap: 6 }} title={s.cwd}>
        <strong style={{ fontWeight: 600 }}>{s.project_name}</strong>
        <ClientTypeBadge
          type={clientType}
          onToggle={() => onSetClientType(s.session_uuid ?? "", clientType === "cli" ? "vscode" : "cli")}
        />
        {s.wrapped && (
          <span class="client-badge client-badge-wrap" title="這個 session 被 `cch claude` wrapper 接管 — 送出走 push、不再 spawn / 不花 $$">🔌 wrapped</span>
        )}
      </div>
      <div class="cell-preview cell-convo">
        {!lastUser && !lastAssistant && !lastTool ? (
          <span class="cell-empty">(尚未開始對話)</span>
        ) : (
          <>
            {lastTool && (
              <div class="cell-turn cell-turn-tool" title={lastTool.description || lastTool.name}>
                <div class="cell-turn-role">🔧 tool</div>
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
                <div class="cell-turn-role">assistant</div>
                <div class="cell-turn-body">{lastAssistant.slice(0, ASSISTANT_MAX)}{lastAssistant.length > ASSISTANT_MAX ? "…" : ""}</div>
              </div>
            )}
            {lastUser && (
              <div class="cell-turn cell-turn-user">
                <div class="cell-turn-role">user</div>
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
      </div>
    </div>
  );
}

// ── Grid overview (sessions grouped by cwd) ──────────────────────────

function GridOverview({ sessions, previews, getClientType, onSetClientType, onQuickSend, onOpenTab, onSync }: {
  sessions: Session[];
  previews: Record<string, SessionPreview>;
  getClientType: (uuid: string | null | undefined) => ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onQuickSend: (s: Session, x: number, y: number) => void;
  onOpenTab: (uuid: string) => void;
  onSync: (uuid: string) => void;
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
          clientType={getClientType(s.session_uuid)}
          onSetClientType={onSetClientType}
          onQuickSend={onQuickSend}
          onOpenTab={onOpenTab}
          onSync={onSync}
        />
      ))}
    </div>
  );
}

// ── Popover (quick-send at mouse position) ───────────────────────────

function Popover({ s, x, y, clientType, onSetClientType, onClose, onSend, onOpenTab, onSync }: {
  s: Session;
  x: number;
  y: number;
  clientType: ClientType;
  onSetClientType: (uuid: string, type: ClientType) => void;
  onClose: () => void;
  onSend: (uuid: string, prompt: string, submit: boolean) => Promise<{ ok: boolean; status: number; reply?: string; duration_ms?: number }>;
  onOpenTab: (uuid: string) => void;
  onSync: (uuid: string) => void;
}) {
  const isCli = clientType === "cli";
  const [prompt, setPrompt] = useState("");
  // CLI sessions: force submitMode (真送出) since prefill (vscode:// URI) can't reach a terminal.
  const [submitMode, setSubmitMode] = useState(isCli);  // default = prefill (free); CLI = forced submit
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
          : `已送出到 VSCode panel`;
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
          <ClientTypeBadge
            type={clientType}
            onToggle={() => onSetClientType(s.session_uuid ?? "", isCli ? "vscode" : "cli")}
          />
          <button
            class="btn-ghost"
            style={{ marginLeft: "auto", padding: "2px 6px" }}
            onClick={() => onSync(s.session_uuid ?? "")}
            title={isCli ? "🚫 CLI session 不支援同步（URI handler 只開 VSCode）" : "同步 VSCode panel"}
            disabled={isCli}
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
          placeholder={isCli ? "CLI session：只能用真送出（spawn claude -p）" : (submitMode ? "輸入 prompt 真的送出（會花 API$）…" : "輸入 prompt 預填到 VSCode input box…")}
          value={prompt}
          onInput={(e) => setPrompt((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend(); }}
          disabled={busy}
          style={{ width: "100%", minHeight: 80, fontSize: 13, fontFamily: "inherit", marginBottom: 8 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!isCli && (
            <button
              class="btn-ghost"
              style={{ fontSize: 10, padding: "2px 6px" }}
              onClick={() => setShowAdvanced((v) => !v)}
              title="切換到 -p headless 模式（會花錢）"
            >{showAdvanced ? "▾ adv" : "▸ adv"}</button>
          )}
          <button
            class={submitMode ? "btn-warn" : "btn-primary"}
            disabled={!prompt.trim() || busy}
            onClick={handleSend}
            style={{ marginLeft: "auto" }}
          >
            {busy ? "⌛" : submitMode ? "真送出 💸" : "送出"}
          </button>
        </div>
        {!isCli && showAdvanced && (
          <label style={{ fontSize: 10, color: "var(--fg-subtle)", cursor: "pointer", marginTop: 4, display: "block" }}>
            <input type="checkbox" checked={submitMode} onChange={(e) => setSubmitMode((e.currentTarget as HTMLInputElement).checked)} style={{ marginRight: 4, verticalAlign: "middle" }} />
            真送出（spawn `claude -p`，重 load context 會花 $$）
          </label>
        )}
        <div style={{ marginTop: 4, fontSize: 10, color: "var(--fg-subtle)" }}>
          {isCli
            ? "📟 CLI session：vscode:// URI 沒辦法塞進 terminal，所以只開放真送出（spawn 新 claude -p，會花 $$，不會出現在你 terminal 那個 session 的視覺輸出，但會更新到 JSONL）。"
            : submitMode
              ? "💸 真送出：新 process、重 load cache、call API"
              : "🚀 送出：餵進你 VSCode panel input box + 自動按 Enter（cache 熱、~free）·別動鍵盤 800ms"}
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

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [clientTypes, setClientTypesState] = useState<Record<string, ClientType>>(() => loadClientTypesFromLS());

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
      addLog(r.ok ? "info" : "error", `/send ${r.status}`, { mode: body?.mode, reply_preview: body?.reply?.slice(0, 60), duration_ms: body?.duration_ms, diag: body?.diag });
      // refresh previews so the cell shows the new reply
      if (r.ok && submit) scheduleRefresh();
      return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms, diag: body?.diag };
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
              getClientType={getClientType}
              onSetClientType={setClientType}
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
          return <Card s={s} defaultExpanded={true} clientType={getClientType(s.session_uuid)} onSetClientType={setClientType} onFocus={onFocus} onSend={onSend} />;
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
          onSync={(uuid) => { void onFocus(uuid); }}
        />
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
