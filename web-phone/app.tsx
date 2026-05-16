import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  generateKeypair,
  deriveSharedSecret,
  toBase64,
  fromBase64,
  encodeEnvelope,
  decodeEnvelope,
  type Envelope,
} from "./relay";
import { loadState, saveState, clearState, type PhoneState } from "./store";

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

const STATUS_COLOR: Record<Session["status"], string> = {
  active: "bg-emerald-500",
  waiting: "bg-amber-500",
  idle: "bg-slate-500",
  stale: "bg-red-500",
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert daemon's /v1/daemon URL to /v1/phone URL on the same host.
 * e.g. ws://127.0.0.1:8787/v1/daemon → ws://127.0.0.1:8787/v1/phone
 */
function daemonUrlToPhoneUrl(workerUrl: string): string {
  return workerUrl.replace(/\/v1\/daemon($|\?)/, "/v1/phone$1");
}

/**
 * Compute daemon_id from daemon_pk_b64 the same way the daemon does.
 * strips non-alphanumeric chars from base64 and takes first 16 chars.
 */
function computeDaemonId(daemonPkB64: string): string {
  return daemonPkB64.replace(/[+/=]/g, "").slice(0, 16);
}

function appendQueryParam(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

// ── Pair Screen ────────────────────────────────────────────────────────────

interface PairScreenProps {
  onPaired: (state: PhoneState) => void;
}

function PairScreen({ onPaired }: PairScreenProps) {
  const [jsonText, setJsonText] = useState("");
  const [phoneName, setPhoneName] = useState("browser");
  const [status, setStatus] = useState<"idle" | "connecting" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handlePair() {
    setStatus("connecting");
    setErrorMsg("");

    let parsed: { worker_url?: string; pairing_token?: string; daemon_pk?: string; name?: string };
    try {
      parsed = JSON.parse(jsonText.trim());
    } catch {
      setErrorMsg("Invalid JSON — paste the exact JSON from the terminal.");
      setStatus("error");
      return;
    }

    const { worker_url, pairing_token, daemon_pk, name: daemonName } = parsed;
    if (!worker_url || !pairing_token || !daemon_pk || !daemonName) {
      setErrorMsg("JSON must have: worker_url, pairing_token, daemon_pk, name.");
      setStatus("error");
      return;
    }

    // Generate phone keypair
    const { pubkey: phonePub, privkey: phonePriv } = generateKeypair();
    const phonePkB64 = toBase64(phonePub);
    const phonePrivB64 = toBase64(phonePriv);

    // Build phone WebSocket URL
    const phoneWsBase = daemonUrlToPhoneUrl(worker_url);
    const wsUrl = appendQueryParam(phoneWsBase, "pairing_token", pairing_token);

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Pairing timed out after 30s"));
        }, 30_000);

        ws.onopen = () => {
          // Send pair_offer as raw JSON (pre-shared-secret)
          ws.send(JSON.stringify({
            kind: "pair_offer",
            phone_pk: phonePkB64,
            phone_name: phoneName || "browser",
          }));
        };

        ws.onmessage = (ev) => {
          clearTimeout(timer);
          try {
            const env: Envelope = JSON.parse(ev.data as string);
            const daemonPubBytes = fromBase64(daemon_pk);
            const sharedSecret = deriveSharedSecret(phonePriv, daemonPubBytes);
            const plain = decodeEnvelope(env, sharedSecret) as { kind?: string; ok?: boolean } | null;
            if (!plain || plain.kind !== "pair_ack" || !plain.ok) {
              ws.close();
              reject(new Error("pair_ack not received or rejected by daemon"));
              return;
            }
            ws.close();

            const daemonId = computeDaemonId(daemon_pk);
            const state: PhoneState = {
              worker_url,
              daemon_id: daemonId,
              daemon_name: daemonName,
              daemon_pk_b64: daemon_pk,
              shared_secret_b64: toBase64(sharedSecret),
              phone_pk_b64: phonePkB64,
              phone_privkey_b64: phonePrivB64,
              paired_at: Date.now(),
            };
            saveState(state);
            resolve();
            onPaired(state);
          } catch (e) {
            ws.close();
            reject(e);
          }
        };

        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("WebSocket connection failed. Is the mock-worker running?"));
        };

        ws.onclose = (ev) => {
          clearTimeout(timer);
          if (!ev.wasClean) {
            reject(new Error(`Connection closed unexpectedly (code ${ev.code})`));
          }
        };
      });
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  return (
    <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <h1 class="text-2xl font-bold mb-2">cc-hub</h1>
        <p class="text-slate-400 mb-6 text-sm">Pair your phone browser with the cc-hub daemon.</p>

        <div class="bg-slate-900 rounded-lg border border-slate-800 p-5 flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">Pairing JSON</label>
            <textarea
              class="bg-slate-800 rounded px-3 py-2 text-sm font-mono resize-y min-h-[8rem] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder={'Paste the JSON printed by: pnpm pair --new\n\n{"worker_url":"ws://...","pairing_token":"...","daemon_pk":"...","name":"..."}'}
              value={jsonText}
              onInput={(e) => setJsonText((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">Phone name</label>
            <input
              class="bg-slate-800 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
              type="text"
              value={phoneName}
              onInput={(e) => setPhoneName((e.currentTarget as HTMLInputElement).value)}
              placeholder="browser"
            />
          </div>

          {errorMsg && (
            <div class="bg-red-950 border border-red-800 rounded px-3 py-2 text-sm text-red-300">
              {errorMsg}
            </div>
          )}

          <button
            class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded px-4 py-2 font-medium text-sm transition-colors"
            disabled={status === "connecting" || !jsonText.trim()}
            onClick={handlePair}
          >
            {status === "connecting" ? "Pairing…" : "Pair"}
          </button>
        </div>

        <p class="text-xs text-slate-600 mt-4 text-center">
          Run <code class="font-mono">pnpm pair --new</code> in the daemon terminal, then copy the JSON here.
        </p>
      </div>
    </div>
  );
}

// ── Session Card ───────────────────────────────────────────────────────────

function SessionCard({
  s,
  onFocus,
  onSend,
}: {
  s: Session;
  onFocus: (cwd: string) => void;
  onSend: (cwd: string, prompt: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div class="rounded-lg border border-slate-800 p-4 bg-slate-900 flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class={`w-3 h-3 rounded-full flex-shrink-0 ${STATUS_COLOR[s.status]}`} />
        <span class="text-base font-semibold truncate">{s.project_name}</span>
        <span class="text-xs text-slate-500 ml-auto flex-shrink-0">{s.status}</span>
      </div>
      <div class="text-xs text-slate-500 font-mono break-all">{s.cwd}</div>
      {s.last_message_preview && (
        <div class="text-sm text-slate-300 line-clamp-2">{s.last_message_preview}</div>
      )}
      <div class="flex gap-2 mt-1">
        <button
          class="bg-slate-700 hover:bg-slate-600 rounded px-3 py-1 text-sm transition-colors"
          onClick={() => onFocus(s.cwd)}
        >
          Focus
        </button>
      </div>
      <div class="flex gap-2 mt-1">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
          rows={2}
          placeholder="Send a prompt to this session…"
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 text-sm transition-colors"
          disabled={!draft.trim()}
          onClick={() => { onSend(s.cwd, draft); setDraft(""); }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── Dashboard Screen ───────────────────────────────────────────────────────

type ConnStatus = "connecting" | "connected" | "reconnecting" | "error";

const CONN_DOT: Record<ConnStatus, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500",
  error: "bg-red-500",
};

const CONN_LABEL: Record<ConnStatus, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  error: "Error",
};

function DashboardScreen({ state, onUnpair }: { state: PhoneState; onUnpair: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connStatus, setConnStatus] = useState<ConnStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);

  const sharedSecret = fromBase64(state.shared_secret_b64);

  function sendEncrypted(plain: object) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const env = encodeEnvelope(plain, sharedSecret, "daemon");
    ws.send(JSON.stringify(env));
  }

  function connect() {
    if (!mountedRef.current) return;
    setConnStatus("connecting");

    const phoneWsBase = daemonUrlToPhoneUrl(state.worker_url);
    const wsUrl = appendQueryParam(phoneWsBase, "daemon_id", state.daemon_id);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      backoffRef.current = 1000;
      setConnStatus("connected");
      sendEncrypted({ kind: "request_snapshot" });
    };

    ws.onmessage = (ev) => {
      if (!mountedRef.current) return;
      try {
        const env: Envelope = JSON.parse(ev.data as string);
        const plain = decodeEnvelope(env, sharedSecret) as {
          kind?: string;
          sessions?: Session[];
          session?: Session;
        } | null;
        if (!plain) return;

        if (plain.kind === "state_snapshot" && Array.isArray(plain.sessions)) {
          setSessions(plain.sessions as Session[]);
        } else if (plain.kind === "event" && plain.session) {
          setSessions((prev) => {
            const others = prev.filter((s) => s.cwd !== plain.session!.cwd);
            return [plain.session!, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
          });
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setConnStatus("error");
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnStatus("reconnecting");
      const delay = Math.min(backoffRef.current, 60_000);
      backoffRef.current = delay * 2;
      setTimeout(connect, delay);
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
    };
  }, []);

  const onFocus = (cwd: string) => sendEncrypted({ kind: "cmd_focus", cwd });
  const onSend = (cwd: string, prompt: string) => sendEncrypted({ kind: "cmd_send", cwd, prompt });

  return (
    <div class="min-h-screen bg-slate-950 text-slate-100">
      <header class="sticky top-0 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <h1 class="text-lg font-bold">cc-hub · <span class="text-indigo-400">{state.daemon_name}</span></h1>
        <div class="flex items-center gap-2 ml-auto">
          <span class={`w-2.5 h-2.5 rounded-full ${CONN_DOT[connStatus]}`} />
          <span class="text-xs text-slate-400">{CONN_LABEL[connStatus]}</span>
        </div>
        <button
          class="bg-slate-700 hover:bg-slate-600 rounded px-3 py-1 text-sm ml-3 transition-colors"
          onClick={onUnpair}
        >
          Unpair
        </button>
      </header>

      <main class="max-w-2xl mx-auto p-4 flex flex-col gap-4">
        {sessions.length === 0 && connStatus === "connected" && (
          <div class="text-slate-500 text-center py-10 text-sm">
            No sessions yet. Open a Claude Code panel in any VSCode window.
          </div>
        )}
        {sessions.length === 0 && connStatus !== "connected" && (
          <div class="text-slate-600 text-center py-10 text-sm">
            Waiting for connection…
          </div>
        )}
        {sessions.map((s) => (
          <SessionCard key={s.cwd} s={s} onFocus={onFocus} onSend={onSend} />
        ))}
      </main>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<PhoneState | null>(() => loadState());

  function handlePaired(s: PhoneState) {
    setState(s);
  }

  function handleUnpair() {
    clearState();
    setState(null);
  }

  if (!state) {
    return <PairScreen onPaired={handlePaired} />;
  }
  return <DashboardScreen state={state} onUnpair={handleUnpair} />;
}

render(<App />, document.getElementById("app")!);
