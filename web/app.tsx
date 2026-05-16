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
        <span class="text-xs text-slate-500 ml-auto">{s.status}</span>
      </div>
      <div class="text-xs text-slate-500 font-mono">{s.cwd}</div>
      {s.last_message_preview && (
        <div class="text-sm text-slate-300 line-clamp-2">{s.last_message_preview}</div>
      )}
      <div class="flex gap-2 mt-2">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none"
          rows={2}
          placeholder="Send a prompt to this session..."
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 text-sm"
          disabled={!draft.trim()}
          onClick={() => { onSend(s.cwd, draft); setDraft(""); }}
        >Send</button>
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
      <h1 class="text-2xl font-bold mb-6">cc-hub</h1>
      {sessions.length === 0 && (
        <div class="text-slate-500 text-center py-10">No sessions yet. Open a Claude Code panel in any VSCode window.</div>
      )}
      <div class="grid gap-4">
        {sessions.map((s) => <Card key={s.cwd} s={s} onFocus={onFocus} onSend={onSend} />)}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
