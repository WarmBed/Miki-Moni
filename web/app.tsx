import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

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

const STATUS_COLOR: Record<Session["status"], string> = {
  active: "bg-emerald-500",
  waiting: "bg-amber-500",
  idle: "bg-slate-500",
  stale: "bg-red-500",
};

const STATUS_LABEL: Record<Session["status"], string> = {
  active: "進行中",
  waiting: "等你回應",
  idle: "閒置",
  stale: "已斷線",
};

// ── F12 console logging helper ────────────────────────────────────────────
const TAG = "%c[cc-hub]";
const TAG_STYLE = "color:#818cf8;font-weight:bold";

function clog(label: string, ctx?: Record<string, unknown>): void {
  console.log(TAG, label, ctx ?? "");
}
function cwarn(label: string, ctx?: Record<string, unknown>): void {
  console.warn(TAG, label, ctx ?? "");
}
function cerr(label: string, ctx?: Record<string, unknown>): void {
  console.error(TAG, label, ctx ?? "");
}

// ── In-page activity log (also goes to F12) ───────────────────────────────

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
}

const ACT_LOG_MAX = 50;

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-TW", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

// ── Card ──────────────────────────────────────────────────────────────────

type ActionResult = { ok: boolean; label: string; url?: string; reply?: string; durationMs?: number; ts: number } | null;

function Card({ s, onFocus, onSend }: {
  s: Session;
  onFocus: (session_uuid: string) => Promise<{ ok: boolean; status: number; url?: string }>;
  onSend: (session_uuid: string, prompt: string, submit: boolean) => Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number }>;
}) {
  const [draft, setDraft] = useState("");
  const [submitMode, setSubmitMode] = useState(true);  // default = real submit (headless), users opt out for prefill
  const [busy, setBusy] = useState(false);
  const [focusResult, setFocusResult] = useState<ActionResult>(null);
  const [sendResult, setSendResult] = useState<ActionResult>(null);
  const sessionUuid = s.session_uuid ?? "";

  async function handleFocus() {
    clog("click 叫起視窗", { cwd: s.cwd, session_uuid: s.session_uuid, project_name: s.project_name });
    setFocusResult(null);
    const r = await onFocus(sessionUuid);
    setFocusResult({ ok: r.ok, label: r.ok ? `daemon OK (HTTP ${r.status})—現在 Alt+Tab 去看 VSCode` : `失敗 HTTP ${r.status}`, url: r.url, ts: Date.now() });
    setTimeout(() => setFocusResult(null), 30000);
  }
  async function handleSend() {
    const prompt = draft.trim();
    if (!prompt) return;
    clog("click 送出", { cwd: s.cwd, session_uuid: s.session_uuid, project_name: s.project_name, mode: submitMode ? "submit" : "prefill", promptPreview: prompt.slice(0, 40), promptLength: prompt.length });
    setSendResult(null);
    setBusy(true);
    try {
      const r = await onSend(sessionUuid, prompt, submitMode);
      const label = !r.ok
        ? `失敗 HTTP ${r.status}`
        : submitMode
          ? `Claude 已回覆 (${r.duration_ms ?? "?"} ms)—訊息已寫入 transcript，VSCode 應該看到新對話`
          : `已預填 (HTTP ${r.status})—請 Alt+Tab 到 VSCode 按 Enter 送出`;
      setSendResult({ ok: r.ok, label, url: r.url, reply: r.reply, durationMs: r.duration_ms, ts: Date.now() });
      setDraft("");
    } finally {
      setBusy(false);
    }
    setTimeout(() => setSendResult(null), 120000);
  }

  return (
    <div class="rounded-lg border border-slate-800 p-4 bg-slate-900 flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class={`w-3 h-3 rounded-full ${STATUS_COLOR[s.status]}`} />
        <button
          class="text-lg font-semibold text-left hover:underline"
          onClick={handleFocus}
        >{s.project_name}</button>
        <span class="text-xs text-slate-500 ml-auto">{STATUS_LABEL[s.status]}</span>
      </div>
      <div class="text-xs text-slate-500 font-mono break-all">{s.cwd}</div>
      <div class="text-[10px] text-slate-600 font-mono break-all">
        session_uuid: {s.session_uuid ?? <span class="text-amber-400">null（沒抓到 uuid，叫起/送出可能會開錯 session）</span>}
      </div>
      {s.last_message_preview && (
        <div class="text-sm text-slate-300 line-clamp-2">{s.last_message_preview}</div>
      )}
      {focusResult && (
        <div class="text-xs">
          <div class={focusResult.ok ? "text-emerald-400" : "text-red-400"}>叫起視窗：{focusResult.label}</div>
          {focusResult.url && (
            <div class="mt-1 text-slate-500 font-mono break-all">
              URI：<a href={focusResult.url} class="text-indigo-300 hover:underline">{focusResult.url}</a>
              <button class="ml-2 text-slate-400 hover:text-slate-200" onClick={() => navigator.clipboard?.writeText(focusResult.url!)}>📋 複製</button>
              <button class="ml-2 text-slate-400 hover:text-slate-200" onClick={() => window.open(focusResult.url!, "_self")}>🔄 瀏覽器再開一次</button>
            </div>
          )}
        </div>
      )}
      <div class="flex gap-2 mt-2">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
          rows={2}
          placeholder={submitMode ? "輸入 prompt 真的送給這個 session（會花 API 費用）…" : "輸入 prompt 預填到 input box（不送出、零成本）…"}
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
          disabled={busy}
        />
        <button
          class={`disabled:opacity-30 rounded px-3 text-sm ${submitMode ? "bg-rose-600 hover:bg-rose-500" : "bg-indigo-600 hover:bg-indigo-500"}`}
          disabled={!draft.trim() || busy}
          onClick={handleSend}
          title={submitMode ? "headless 模式：真的 submit + Claude 回應（花費 API$）" : "prefill 模式：只塞進 input box，你按 Enter 才送"}
        >{busy ? "⌛" : submitMode ? "真送出 💸" : "預填"}</button>
      </div>
      <label class="text-[11px] text-slate-500 select-none cursor-pointer">
        <input type="checkbox" checked={submitMode} onChange={(e) => setSubmitMode((e.currentTarget as HTMLInputElement).checked)} class="mr-1 align-middle" />
        真送出模式（headless `claude -r {sessionUuid.slice(0, 8)}... -p`，會花 API 錢）
      </label>
      {submitMode && (
        <div class="text-[10px] text-amber-400/80">
          ⚠️ Windows 已知限制：真送出模式 prompt 內若含中文/emoji 會被切碼（claude.exe stdin codepage 問題）。請暫時用英文 prompt，或切到「預填」模式。
        </div>
      )}
      {sendResult && (
        <div class="text-xs">
          <div class={sendResult.ok ? "text-emerald-400" : "text-red-400"}>送 prompt：{sendResult.label}</div>
          {sendResult.reply && (
            <div class="mt-1 p-2 bg-slate-800/50 border border-slate-700 rounded">
              <div class="text-[10px] text-slate-500 mb-1">Claude 回覆：</div>
              <div class="text-slate-300 whitespace-pre-wrap">{sendResult.reply}</div>
            </div>
          )}
          {sendResult.url && (
            <div class="mt-1 text-slate-500 font-mono break-all">
              URI：<a href={sendResult.url} class="text-indigo-300 hover:underline">{sendResult.url}</a>
              <button class="ml-2 text-slate-400 hover:text-slate-200" onClick={() => navigator.clipboard?.writeText(sendResult.url!)}>📋 複製</button>
              <button class="ml-2 text-slate-400 hover:text-slate-200" onClick={() => window.open(sendResult.url!, "_self")}>🔄 瀏覽器再開一次</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Activity log panel ────────────────────────────────────────────────────

function ActivityLog({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  return (
    <div class="mt-8 border border-slate-800 rounded-lg bg-slate-900/50">
      <div class="flex items-center px-3 py-2 border-b border-slate-800">
        <span class="text-xs font-semibold text-slate-400">活動紀錄（同步輸出到 F12 Console）</span>
        <button class="ml-auto text-xs text-slate-500 hover:text-slate-300" onClick={onClear}>清空</button>
      </div>
      <div class="text-xs font-mono p-3 max-h-64 overflow-y-auto">
        {entries.length === 0 && <div class="text-slate-600">尚無活動，按任何按鈕或等 hook 事件就會冒出來。</div>}
        {entries.map((e, i) => (
          <div key={i} class={
            e.level === "error" ? "text-red-400" :
            e.level === "warn" ? "text-amber-400" :
            "text-slate-300"
          }>
            <span class="text-slate-600">{fmtTime(e.ts)}</span>{" "}
            <span>{e.msg}</span>
            {e.ctx && <span class="text-slate-500"> {JSON.stringify(e.ctx)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [wsConn, setWsConn] = useState<"connecting" | "open" | "closed">("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef(log);
  logRef.current = log;

  function addLog(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx };
    setLog((prev) => [entry, ...prev].slice(0, ACT_LOG_MAX));
    (level === "error" ? cerr : level === "warn" ? cwarn : clog)(msg, ctx);
  }

  useEffect(() => {
    addLog("info", "啟動 — 抓 /sessions 初始狀態");
    fetch("/sessions")
      .then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, body: j })))
      .then((r) => {
        if (!r.ok) { addLog("error", `GET /sessions 失敗`, { status: r.status }); return; }
        const list = r.body as Session[];
        setSessions(list);
        addLog("info", `GET /sessions 200 — 收到 ${list.length} 個 session`, { cwds: list.map((s) => s.cwd) });
      })
      .catch((e) => addLog("error", `GET /sessions throw`, { error: String(e) }));

    const wsUrl = `ws://${location.host}/ws`;
    addLog("info", `WS 連線中`, { url: wsUrl });
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => { setWsConn("open"); addLog("info", "WS open"); };
    ws.onclose = (ev) => { setWsConn("closed"); addLog("warn", `WS close`, { code: ev.code, reason: ev.reason || "(無)" }); };
    ws.onerror = () => { addLog("error", "WS error"); };
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { addLog("error", "WS 收到非 JSON", { raw: String(ev.data).slice(0, 80) }); return; }
      if (msg.type === "session_changed") {
        const s = msg.session as Session;
        addLog("info", `WS session_changed`, {
          cwd: s.cwd,
          project: s.project_name,
          status: s.status,
          session_uuid: s.session_uuid,
        });
        setSessions((prev) => {
          const others = prev.filter((x) => x.session_uuid !== s.session_uuid);
          return [s, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
      } else {
        addLog("warn", `WS 不認識的 type`, { type: msg.type });
      }
    };

    return () => ws.close();
  }, []);

  async function onFocus(session_uuid: string): Promise<{ ok: boolean; status: number; url?: string }> {
    addLog("info", `POST /focus`, { session_uuid });
    try {
      const r = await fetch("/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_uuid }) });
      let body: any = null;
      try { body = await r.json(); } catch { /* may be empty */ }
      const url: string | undefined = body?.url;
      const ctx = { session_uuid, status: r.status, url, body };
      if (r.ok) addLog("info", `/focus ${r.status} — daemon 已叫起 URI`, ctx);
      else addLog("error", `/focus 失敗`, ctx);
      return { ok: r.ok, status: r.status, url };
    } catch (e) {
      addLog("error", `/focus throw`, { session_uuid, error: String(e) });
      return { ok: false, status: 0 };
    }
  }
  async function onSend(session_uuid: string, prompt: string, submit: boolean): Promise<{ ok: boolean; status: number; url?: string; reply?: string; duration_ms?: number }> {
    addLog("info", `POST /send (mode=${submit ? "submit" : "prefill"})`, { session_uuid, promptLength: prompt.length, promptPreview: prompt.slice(0, 40) });
    try {
      const r = await fetch("/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid, prompt, submit }),
      });
      let body: any = null;
      try { body = await r.json(); } catch { /* may be empty */ }
      const url: string | undefined = body?.url;
      const reply: string | undefined = body?.reply;
      const duration_ms: number | undefined = body?.duration_ms;
      const ctx = { session_uuid, status: r.status, mode: body?.mode, url, replyPreview: reply?.slice(0, 80), duration_ms };
      if (r.ok) {
        if (submit) addLog("info", `/send ${r.status} — Claude 回覆（${duration_ms}ms）${reply?.slice(0, 60)}`, ctx);
        else addLog("info", `/send ${r.status} — URI 已 prefill（未送出）`, ctx);
      } else {
        addLog("error", `/send 失敗`, { ...ctx, body });
      }
      return { ok: r.ok, status: r.status, url, reply, duration_ms };
    } catch (e) {
      addLog("error", `/send throw`, { session_uuid, error: String(e) });
      return { ok: false, status: 0 };
    }
  }

  return (
    <div class="max-w-4xl mx-auto p-6">
      <div class="flex items-center gap-2 mb-2">
        <h1 class="text-2xl font-bold">cc-hub</h1>
        <span class={`ml-2 w-2 h-2 rounded-full ${wsConn === "open" ? "bg-emerald-500" : wsConn === "connecting" ? "bg-amber-500" : "bg-red-500"}`} />
        <span class="text-xs text-slate-500">{wsConn === "open" ? "WS 已連線" : wsConn === "connecting" ? "連線中…" : "WS 已斷"}</span>
      </div>
      <p class="text-xs text-slate-500 mb-6">本機儀表板 · 點專案名稱叫起 VSCode 視窗 · 按下按鈕後請 F12 看 Console / 看下方活動紀錄</p>
      {sessions.length === 0 && (
        <div class="text-slate-500 text-center py-10">
          <p>目前沒有任何 session。</p>
          <p class="text-xs mt-2">在 VSCode 開 Claude Code panel 就會冒出來。</p>
          <p class="text-xs mt-1">沒反應的話可能還沒裝 hooks：<code class="bg-slate-800 px-1 rounded">pnpm install:hooks</code></p>
        </div>
      )}
      <div class="grid gap-4">
        {sessions.map((s) => <Card key={s.session_uuid ?? s.cwd} s={s} onFocus={onFocus} onSend={onSend} />)}
      </div>
      <ActivityLog entries={log} onClear={() => setLog([])} />
    </div>
  );
}

render(<App />, document.getElementById("app")!);
