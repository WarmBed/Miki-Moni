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

// ── Tool box (IN/OUT) ──────────────────────────────────────────────────────

function ToolUseBox({ t }: { t: TranscriptTurn }) {
  const u = t.tool_use!;
  const inputStr = typeof u.input === "string" ? u.input : JSON.stringify(u.input, null, 2);
  return (
    <div class="toolbox" style={{ marginTop: 4 }}>
      <div class="toolbox-head">
        <span class="dot dot-active" style={{ width: 6, height: 6 }} />
        <span>{u.name}</span>
        {u.description && <span style={{ color: "var(--fg-subtle)" }}>{u.description}</span>}
      </div>
      <div class="toolbox-row">
        <div class="toolbox-label">IN</div>
        <pre class="toolbox-content" style={{ margin: 0 }}>{inputStr}</pre>
      </div>
    </div>
  );
}

function ToolResultBox({ t }: { t: TranscriptTurn }) {
  const r = t.tool_result!;
  return (
    <div class="toolbox" style={{ marginTop: 4 }}>
      <div class="toolbox-row">
        <div class="toolbox-label">OUT</div>
        <pre class={"toolbox-content" + (r.is_error ? " is-error" : "")} style={{ margin: 0 }}>
          {r.content || "(empty)"}
          {r.truncated && <div style={{ color: "var(--fg-subtle)", fontSize: 10, marginTop: 4 }}>…[truncated]</div>}
        </pre>
      </div>
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
  const [submitMode, setSubmitMode] = useState(true);
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
        <button class="btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setCollapsed(true)} title="收合">▴</button>
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
        <label style={{ fontSize: 11, color: "var(--fg-subtle)", cursor: "pointer", userSelect: "none" }}>
          <input
            type="checkbox"
            checked={submitMode}
            onChange={(e) => setSubmitMode((e.currentTarget as HTMLInputElement).checked)}
            style={{ marginRight: 6, verticalAlign: "middle" }}
          />
          真送出模式（會花 API 費用）
        </label>
        {submitMode && (
          <div style={{ fontSize: 10, color: "var(--warn)" }}>
            ⚠️ Windows 已知限制：prompt 含中文/emoji 會被 codepage 切碼，請暫用英文 prompt 或切「預填」。
          </div>
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
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);

  function addLog(level: LogEntry["level"], msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx };
    setLog((prev) => [entry, ...prev].slice(0, ACT_LOG_MAX));
    (level === "error" ? cerr : level === "warn" ? cwarn : clog)(msg, ctx);
  }

  useEffect(() => {
    addLog("info", "啟動 — 抓 /sessions 初始狀態");
    fetch("/sessions").then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j })))
      .then((r) => {
        if (!r.ok) { addLog("error", `GET /sessions 失敗`, { status: r.status }); return; }
        const list = r.body as Session[];
        setSessions(list);
        addLog("info", `GET /sessions 200 — 收到 ${list.length} 個 session`, { cwds: list.map((s) => s.cwd) });
      })
      .catch((e) => addLog("error", `GET /sessions throw`, { error: String(e) }));

    const wsUrl = `ws://${location.host}/ws`;
    addLog("info", "WS 連線中", { url: wsUrl });
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => { setWsConn("open"); addLog("info", "WS open"); };
    ws.onclose = (ev) => { setWsConn("closed"); addLog("warn", "WS close", { code: ev.code, reason: ev.reason || "(無)" }); };
    ws.onerror = () => { addLog("error", "WS error"); };
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { addLog("error", "WS 收到非 JSON", { raw: String(ev.data).slice(0, 80) }); return; }
      if (msg.type === "session_changed") {
        const s = msg.session as Session;
        addLog("info", "WS session_changed", { cwd: s.cwd, project: s.project_name, status: s.status, uuid: s.session_uuid });
        setSessions((prev) => {
          const others = prev.filter((x) => x.session_uuid !== s.session_uuid);
          return [s, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
      } else {
        addLog("warn", "WS 不認識的 type", { type: msg.type });
      }
    };

    return () => ws.close();
  }, []);

  async function onFocus(uuid: string) {
    addLog("info", "POST /focus", { uuid });
    try {
      const r = await fetch("/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/focus ${r.status}`, { uuid, url: body?.url, body });
      return { ok: r.ok, status: r.status, url: body?.url };
    } catch (e) { addLog("error", "/focus throw", { uuid, error: String(e) }); return { ok: false, status: 0 }; }
  }
  async function onSend(uuid: string, prompt: string, submit: boolean) {
    addLog("info", `POST /send (mode=${submit ? "submit" : "prefill"})`, { uuid, len: prompt.length, preview: prompt.slice(0, 40) });
    try {
      const r = await fetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid: uuid, prompt, submit }) });
      let body: any = null; try { body = await r.json(); } catch {}
      addLog(r.ok ? "info" : "error", `/send ${r.status}`, { uuid, mode: body?.mode, url: body?.url, reply_preview: body?.reply?.slice(0, 60), duration_ms: body?.duration_ms });
      return { ok: r.ok, status: r.status, url: body?.url, reply: body?.reply, duration_ms: body?.duration_ms };
    } catch (e) { addLog("error", "/send throw", { uuid, error: String(e) }); return { ok: false, status: 0 }; }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 24px 64px" }}>
      {/* Top nav */}
      <header style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>cc-hub</h1>
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>本機儀表板</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--fg-subtle)" }}>
          <span class={`dot ${wsConn === "open" ? "dot-active" : wsConn === "connecting" ? "dot-waiting" : "dot-stale"}`} style={{ width: 6, height: 6 }} />
          {wsConn === "open" ? "WS connected" : wsConn === "connecting" ? "connecting…" : "WS disconnected"}
        </div>
      </header>

      <SummaryBanner sessions={sessions} />

      {/* Cards */}
      <section>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span class="section-label">Sessions</span>
          <span style={{ marginLeft: 8, color: "var(--fg-subtle)", fontSize: 11 }}>{sessions.length} 筆</span>
        </div>
        {sessions.length === 0 ? (
          <div class="card" style={{ padding: "24px 14px", textAlign: "center", color: "var(--fg-subtle)", fontSize: 13 }}>
            <div>目前沒有 session。</div>
            <div style={{ fontSize: 11, marginTop: 6 }}>在任何 VSCode 視窗開 Claude Code panel 就會冒出來。</div>
            <div style={{ fontSize: 11 }}>沒反應的話：<code>pnpm install:hooks</code></div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sessions.map((s, i) => <Card key={s.session_uuid ?? s.cwd} s={s} defaultExpanded={i === 0} onFocus={onFocus} onSend={onSend} />)}
          </div>
        )}
      </section>

      <ActivityLog entries={log} onClear={() => setLog([])} />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
