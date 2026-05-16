import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

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

function Card({ s, onFocus, onSend }: {
  s: Session;
  onFocus: (cwd: string) => void;
  onSend: (cwd: string, prompt: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div class="rounded-lg border border-slate-800 p-4 bg-slate-900 flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class={`w-3 h-3 rounded-full ${STATUS_COLOR[s.status]}`} />
        <button
          class="text-lg font-semibold text-left hover:underline"
          onClick={() => onFocus(s.cwd)}
        >{s.project_name}</button>
        <span class="text-xs text-slate-500 ml-auto">{STATUS_LABEL[s.status]}</span>
      </div>
      <div class="text-xs text-slate-500 font-mono">{s.cwd}</div>
      {s.last_message_preview && (
        <div class="text-sm text-slate-300 line-clamp-2">{s.last_message_preview}</div>
      )}
      <div class="flex gap-2 mt-2">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none"
          rows={2}
          placeholder="輸入 prompt 送給這個 session…"
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 text-sm"
          disabled={!draft.trim()}
          onClick={() => { onSend(s.cwd, draft); setDraft(""); }}
        >送出</button>
      </div>
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    fetch("/sessions").then((r) => r.json()).then(setSessions);
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "session_changed") {
        setSessions((prev) => {
          const others = prev.filter((s) => s.cwd !== msg.session.cwd);
          return [msg.session, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
      }
    };
    return () => ws.close();
  }, []);

  const onFocus = (cwd: string) =>
    fetch("/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const onSend = (cwd: string, prompt: string) =>
    fetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, prompt }) });

  return (
    <div class="max-w-4xl mx-auto p-6">
      <h1 class="text-2xl font-bold mb-2">cc-hub</h1>
      <p class="text-xs text-slate-500 mb-6">本機儀表板 · 多個 VSCode Claude session 集中監控 · 點專案名稱可叫起對應視窗</p>
      {sessions.length === 0 && (
        <div class="text-slate-500 text-center py-10">
          <p>目前沒有任何 session。</p>
          <p class="text-xs mt-2">在任何 VSCode 視窗開 Claude Code panel，這裡就會冒出來。</p>
          <p class="text-xs mt-1">如果沒反應，可能還沒裝 hooks，請執行 <code class="bg-slate-800 px-1 rounded">pnpm install:hooks</code></p>
        </div>
      )}
      <div class="grid gap-4">
        {sessions.map((s) => <Card key={s.cwd} s={s} onFocus={onFocus} onSend={onSend} />)}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
