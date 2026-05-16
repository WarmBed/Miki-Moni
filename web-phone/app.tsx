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

const STATUS_LABEL: Record<Session["status"], string> = {
  active: "進行中",
  waiting: "等你回應",
  idle: "閒置",
  stale: "已斷線",
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
      setErrorMsg("JSON 格式錯了——請貼上終端機印出來的那一整段 JSON。");
      setStatus("error");
      return;
    }

    const { worker_url, pairing_token, daemon_pk, name: daemonName } = parsed;
    if (!worker_url || !pairing_token || !daemon_pk || !daemonName) {
      setErrorMsg("JSON 必須有這幾個欄位：worker_url、pairing_token、daemon_pk、name");
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
          reject(new Error("配對逾時（30 秒沒收到 daemon 回應）"));
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
              reject(new Error("daemon 沒回傳 pair_ack 或拒絕了配對"));
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
          reject(new Error("WebSocket 連線失敗——確認 mock-worker 有跑（pnpm dev:all）"));
        };

        ws.onclose = (ev) => {
          clearTimeout(timer);
          if (!ev.wasClean) {
            reject(new Error(`連線被中斷（code ${ev.code}）`));
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
        <h1 class="text-2xl font-bold mb-2">cc-hub 配對</h1>
        <p class="text-slate-400 mb-6 text-sm">把這台瀏覽器跟你電腦上的 cc-hub daemon 配對</p>

        <div class="bg-slate-900 rounded-lg border border-slate-800 p-5 flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">配對 JSON</label>
            <textarea
              class="bg-slate-800 rounded px-3 py-2 text-sm font-mono resize-y min-h-[8rem] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder={'貼上終端機 pnpm pair --new 印出來的 JSON\n\n{"worker_url":"ws://...","pairing_token":"...","daemon_pk":"...","name":"..."}'}
              value={jsonText}
              onInput={(e) => setJsonText((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">這台裝置的名稱</label>
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
            {status === "connecting" ? "配對中…" : "開始配對"}
          </button>
        </div>

        <p class="text-xs text-slate-600 mt-4 text-center">
          在電腦終端機跑 <code class="font-mono">pnpm pair --new</code>，把印出來的 JSON 整段複製貼到上面那欄。
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
        <span class="text-xs text-slate-500 ml-auto flex-shrink-0">{STATUS_LABEL[s.status]}</span>
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
          叫起視窗
        </button>
      </div>
      <div class="flex gap-2 mt-1">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
          rows={2}
          placeholder="輸入 prompt 送給這個 session…"
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 text-sm transition-colors"
          disabled={!draft.trim()}
          onClick={() => { onSend(s.cwd, draft); setDraft(""); }}
        >
          送出
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
  connected: "已連線",
  connecting: "連線中…",
  reconnecting: "重新連線中…",
  error: "連線錯誤",
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
          解除配對
        </button>
      </header>

      <main class="max-w-2xl mx-auto p-4 flex flex-col gap-4">
        {sessions.length === 0 && connStatus === "connected" && (
          <div class="text-slate-500 text-center py-10 text-sm">
            <p>目前沒有任何 session。</p>
            <p class="text-xs mt-2">在 VSCode 開 Claude Code panel 就會冒出來。</p>
            <p class="text-xs mt-1">若 daemon 還沒裝 hooks，請在電腦執行 <code class="bg-slate-800 px-1 rounded">pnpm install:hooks</code></p>
          </div>
        )}
        {sessions.length === 0 && connStatus !== "connected" && (
          <div class="text-slate-600 text-center py-10 text-sm">
            等待連線…
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
