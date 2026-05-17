import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  fromBase64,
  encodeEnvelope,
  decodeEnvelope,
  normalizePairingCode,
  isValidPairingCode,
  performPairing,
  connectAuthed,
  computePeerIdFromB64,
  type Envelope,
} from "./relay";
import { loadState, saveState, clearState, loadOrCreateIdentity, type PhoneState } from "./store";
import { QrScanner } from "./qr-scanner";

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

// ── F12 console logging helper ────────────────────────────────────────────
const TAG = "%c[miki-moni-phone]";
const TAG_STYLE = "color:#f472b6;font-weight:bold";

function clog(label: string, ctx?: Record<string, unknown>): void {
  console.log(TAG, TAG_STYLE, label, ctx ?? "");
}
function cwarn(label: string, ctx?: Record<string, unknown>): void {
  console.warn(TAG, TAG_STYLE, label, ctx ?? "");
}
function cerr(label: string, ctx?: Record<string, unknown>): void {
  console.error(TAG, TAG_STYLE, label, ctx ?? "");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function appendQueryParam(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

const DEFAULT_RELAY_URL = "https://relay.f1telemetrystationpro.org";

/** Read relay URL from query param ?relay=... or fall back to production default. */
function getRelayUrl(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("relay") ?? DEFAULT_RELAY_URL;
  } catch {
    return DEFAULT_RELAY_URL;
  }
}

/** Parse pair params from a URL fragment string (no leading '#').
 *  Fragment is used (vs query) so neither Cloudflare nor any web server sees
 *  the pairing token. Shared by hash auto-pair and the QR scanner. */
function parsePairFragment(fragment: string): { token: string; relay: string } | null {
  try {
    const hash = fragment.replace(/^#/, "");
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const token = params.get("t");
    const relay = params.get("r");
    if (!token || !relay) return null;
    if (!isValidPairingCode(token)) return null;
    return { token, relay };
  } catch {
    return null;
  }
}

/** Read pair params from window.location.hash directly. */
function parsePairFromHash(): { token: string; relay: string } | null {
  return parsePairFragment(window.location.hash);
}

/** Pull pair params out of an arbitrary scanned URL or raw fragment.
 *  Handles `https://host/#t=…&r=…` AND a bare `#t=…&r=…` AND a bare `t=…&r=…`. */
function parsePairFromScannedText(text: string): { token: string; relay: string } | null {
  try {
    // Has a "#" in it → take everything after the last #.
    const hashIdx = text.indexOf("#");
    if (hashIdx >= 0) return parsePairFragment(text.slice(hashIdx + 1));
    // No hash but has `t=` and `r=` → treat as raw fragment.
    if (/^[\w-]+=/.test(text)) return parsePairFragment(text);
    return null;
  } catch {
    return null;
  }
}

/** Strip the hash so a refresh doesn't try to pair again (or worse, replay the token). */
function clearHash(): void {
  try {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch { /* ignore */ }
}

// ── Pair Form ──────────────────────────────────────────────────────────────

interface PairFormProps {
  relayUrl: string;
  onPaired: (state: PhoneState) => void;
  autoPairError?: string | null;
}

function PairForm({ relayUrl, onPaired, autoPairError }: PairFormProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(autoPairError ?? null);
  const [scanning, setScanning] = useState(false);

  const normalized = normalizePairingCode(input);
  const valid = isValidPairingCode(normalized);

  async function pair(token: string, useRelayUrl: string) {
    setBusy(true); setError(null);
    try {
      const identity = await loadOrCreateIdentity();
      const peer = await performPairing(useRelayUrl, token, identity);
      const state: PhoneState = {
        relay_url: useRelayUrl,
        daemon_id: peer.daemon_id,
        daemon_name: peer.daemon_id,          // display the daemon_id until we get a name
        daemon_pk_b64: peer.daemon_pubkey_b64,
        shared_secret_b64: peer.shared_secret_b64,
        phone_pk_b64: identity.encryption_pubkey,
        phone_privkey_b64: identity.encryption_privkey,
        paired_at: Date.now(),
      };
      saveState(state);
      onPaired(state);
    } catch (e: unknown) {
      setError(e instanceof Error ? (e.message || "pairing_failed") : "pairing_failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    if (!valid) { setError("Code must be 16 chars from the Crockford base32 alphabet"); return; }
    await pair(normalized, relayUrl);
  }

  function handleScan(scannedText: string) {
    setScanning(false);
    const parsed = parsePairFromScannedText(scannedText);
    if (!parsed) {
      setError(`掃到了但不是配對 QR：${scannedText.slice(0, 60)}${scannedText.length > 60 ? "…" : ""}`);
      return;
    }
    void pair(parsed.token, parsed.relay);
  }

  if (scanning) {
    return <QrScanner onScan={handleScan} onCancel={() => setScanning(false)} />;
  }

  return (
    <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <h1 class="text-2xl font-bold mb-2">miki-moni 配對</h1>
        <p class="text-slate-400 mb-6 text-sm">把這台裝置跟你電腦上的 miki-moni daemon 配對</p>

        <div class="bg-slate-900 rounded-lg border border-slate-800 p-5 flex flex-col gap-4">
          <p class="text-sm text-slate-400">
            在電腦終端機跑 <code class="bg-slate-800 px-1 rounded font-mono">miki pair</code>，輸入它顯示的 16 碼配對碼。
          </p>

          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">配對碼</label>
            <input
              type="text"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={input}
              onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !busy) void handleSubmit();
                if (e.key === "Escape") { setInput(""); setError(null); }
              }}
              disabled={busy}
              autoFocus
              class="bg-slate-800 rounded px-3 py-3 text-lg font-mono tracking-widest uppercase focus:outline-none focus:ring-2 transition-all"
              style={{
                border: `2px solid ${valid ? "#2db75a" : "#374151"}`,
              }}
            />
          </div>

          {error && (
            <div class="bg-red-950 border border-red-800 rounded px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            class="rounded px-4 py-2 font-medium text-sm transition-colors text-white"
            style={{
              background: valid && !busy ? "#3b82f6" : "#374151",
              cursor: valid && !busy ? "pointer" : "not-allowed",
              opacity: valid && !busy ? 1 : 0.6,
            }}
            disabled={!valid || busy}
            onClick={() => void handleSubmit()}
          >
            {busy ? "配對中…" : "開始配對"}
          </button>

          <div class="flex items-center gap-3 text-xs text-slate-500">
            <div class="flex-1 h-px bg-slate-800" />
            <span>或</span>
            <div class="flex-1 h-px bg-slate-800" />
          </div>

          <button
            class="rounded px-4 py-2 font-medium text-sm transition-colors text-slate-100 bg-slate-700 hover:bg-slate-600 flex items-center justify-center gap-2"
            disabled={busy}
            onClick={() => { setError(null); setScanning(true); }}
          >
            <span>📷</span>
            <span>掃 QR Code</span>
          </button>
        </div>

        <p class="text-xs text-slate-600 mt-4 text-center">
          relay: <code class="font-mono">{relayUrl}</code>
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
      <div class="text-[10px] text-slate-600 font-mono break-all">
        session_uuid: {s.session_uuid ?? <span class="text-amber-400">null（沒抓到，叫起/送出可能會開錯 session）</span>}
      </div>
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

interface LogEntry { ts: number; level: "info" | "warn" | "error"; msg: string; ctx?: Record<string, unknown> }
const ACT_LOG_MAX = 50;
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-TW", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function DashboardScreen({ state, onUnpair }: { state: PhoneState; onUnpair: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connStatus, setConnStatus] = useState<ConnStatus>("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [unpairing, setUnpairing] = useState(false);
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);
  const unpairingRef = useRef(false);

  const sharedSecret = fromBase64(state.shared_secret_b64);

  useEffect(() => {
    void computePeerIdFromB64(state.phone_pk_b64).then(setMyPeerId);
  }, [state.phone_pk_b64]);

  function finalizeUnpair() {
    if (!mountedRef.current) return;
    unpairingRef.current = true;
    try { wsRef.current?.close(); } catch { /* ignore */ }
    onUnpair();
  }

  function requestUnpair() {
    if (unpairingRef.current) return;
    unpairingRef.current = true;
    setUnpairing(true);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      addLog("info", "送 revoke_self 給 relay");
      try { ws.send(JSON.stringify({ type: "revoke_self" })); } catch { /* ignore */ }
      // Safety net: if relay never replies, finalize anyway after 1.5s.
      setTimeout(() => { if (mountedRef.current) finalizeUnpair(); }, 1500);
    } else {
      addLog("warn", "WS 未連線；直接清本地（relay 端可能仍有 paired_phones entry，下次連會被擋掉）");
      finalizeUnpair();
    }
  }

  function addLog(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx };
    setLog((prev) => [entry, ...prev].slice(0, ACT_LOG_MAX));
    (level === "error" ? cerr : level === "warn" ? cwarn : clog)(msg, ctx);
  }

  function sendEncrypted(plain: object, label: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addLog("error", `${label}: WS 未連線，無法送出`, { state: ws?.readyState ?? "no-ws" });
      return false;
    }
    const env = encodeEnvelope(plain, sharedSecret, "daemon");
    ws.send(JSON.stringify(env));
    addLog("info", `加密送出 ${label}`, { kind: (plain as any).kind, envBytes: JSON.stringify(env).length });
    return true;
  }

  function connect() {
    if (!mountedRef.current) return;
    setConnStatus("connecting");

    let ws: WebSocket;
    if (state.relay_url) {
      // New relay-based connection: use signed auth token
      addLog("info", `WS 連線中 (relay)`, { relay: state.relay_url, daemon_id: state.daemon_id, daemon_name: state.daemon_name });
      // We need identity for connectAuthed — load async then connect
      void loadOrCreateIdentity().then((identity) => {
        if (!mountedRef.current) return;
        const w = connectAuthed(state.relay_url!, state.daemon_id, identity);
        wsRef.current = w;
        attachWsHandlers(w);
      }).catch((e) => {
        addLog("error", "無法載入 identity", { err: String(e) });
        setConnStatus("error");
      });
      return;
    }
    // Legacy direct-worker connection
    const workerUrl = state.worker_url ?? "";
    const phoneWsBase = workerUrl.replace(/\/v1\/daemon($|\?)/, "/v1/phone$1");
    const wsUrl = appendQueryParam(phoneWsBase, "daemon_id", state.daemon_id);
    addLog("info", `WS 連線中 (legacy)`, { url: wsUrl, daemon_id: state.daemon_id, daemon_name: state.daemon_name });
    ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    attachWsHandlers(ws);
  }

  function attachWsHandlers(ws: WebSocket) {

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      backoffRef.current = 1000;
      setConnStatus("connected");
      // Register our peer_id so the relay can route daemon→phone envelopes
      // precisely to us (no broadcast-noise on other paired phones).
      void computePeerIdFromB64(state.phone_pk_b64).then((peer_id) => {
        if (!mountedRef.current) return;
        try {
          ws.send(JSON.stringify({ type: "register_peer_id", peer_id }));
          addLog("info", "送 register_peer_id", { peer_id });
        } catch { /* ignore */ }
      });
      addLog("info", "WS open — 送 request_snapshot");
      sendEncrypted({ kind: "request_snapshot" }, "request_snapshot");
    };

    ws.onmessage = (ev) => {
      if (!mountedRef.current) return;
      let raw: any;
      try { raw = JSON.parse(ev.data as string); }
      catch { addLog("warn", "WS 收到非 JSON", { raw: String(ev.data).slice(0, 80) }); return; }

      // Control-plane messages from relay/daemon (not encrypted envelopes):
      if (raw && typeof raw.type === "string") {
        if (raw.type === "revoked_ok") {
          addLog("info", "relay 確認 revoke 完成，清除本地狀態");
          finalizeUnpair();
          return;
        }
        if (raw.type === "phone_revoked") {
          // Daemon kicked us — clear local and bounce to pair screen.
          addLog("warn", "daemon 主動解除配對，回到配對畫面", { by: raw.by ?? "unknown" });
          finalizeUnpair();
          return;
        }
      }

      const env = raw as Envelope;

      // If addressed to a different phone, silently drop. This is a defense in
      // depth — Phase A relay routes by `to`, but during the brief window
      // before our register_peer_id lands, or talking to an old worker
      // version, the relay may still broadcast.
      if (typeof env.to === "string" && env.to.startsWith("phone:")) {
        const targetPeerId = env.to.slice("phone:".length);
        if (myPeerId && targetPeerId !== myPeerId) return;
      }

      const plain = decodeEnvelope(env, sharedSecret) as {
        kind?: string;
        sessions?: Session[];
        session?: Session;
        echo?: string;
      } | null;
      if (!plain) {
        addLog("warn", "envelope 解密失敗 — 可能對方不是這個 peer", { to: env.to, ts: env.ts });
        return;
      }
      if (plain.kind === "state_snapshot" && Array.isArray(plain.sessions)) {
        addLog("info", `state_snapshot — 收到 ${plain.sessions.length} 個 session`, { cwds: plain.sessions.map((s) => s.cwd) });
        setSessions(plain.sessions as Session[]);
      } else if (plain.kind === "event" && plain.session) {
        const s = plain.session;
        addLog("info", `event — ${s.project_name}`, { cwd: s.cwd, status: s.status, session_uuid: s.session_uuid });
        setSessions((prev) => {
          const others = prev.filter((x) => x.cwd !== s.cwd);
          return [s, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
      } else {
        addLog("warn", `不認識的訊息 kind`, { kind: plain.kind });
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setConnStatus("error");
      addLog("error", "WS error");
    };

    ws.onclose = (ev) => {
      if (!mountedRef.current) return;
      setConnStatus("reconnecting");
      const delay = Math.min(backoffRef.current, 60_000);
      addLog("warn", `WS close — ${delay}ms 後重連`, { code: ev.code, reason: ev.reason || "(無)" });
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

  const onFocus = (cwd: string) => {
    addLog("info", `click 叫起視窗`, { cwd });
    sendEncrypted({ kind: "cmd_focus", cwd }, "cmd_focus");
  };
  const onSend = (cwd: string, prompt: string) => {
    addLog("info", `click 送出 prompt`, { cwd, promptLength: prompt.length, promptPreview: prompt.slice(0, 40) });
    sendEncrypted({ kind: "cmd_send", cwd, prompt }, "cmd_send");
  };

  return (
    <div class="min-h-screen bg-slate-950 text-slate-100">
      <header class="sticky top-0 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <h1 class="text-lg font-bold">miki-moni · <span class="text-indigo-400">{state.daemon_name}</span></h1>
        <div class="flex items-center gap-2 ml-auto">
          <span class={`w-2.5 h-2.5 rounded-full ${CONN_DOT[connStatus]}`} />
          <span class="text-xs text-slate-400">{CONN_LABEL[connStatus]}</span>
        </div>
        <button
          class="bg-slate-700 hover:bg-slate-600 disabled:opacity-60 rounded px-3 py-1 text-sm ml-3 transition-colors"
          onClick={requestUnpair}
          disabled={unpairing}
        >
          {unpairing ? "解除中…" : "解除配對"}
        </button>
      </header>

      <main class="max-w-2xl mx-auto p-4 flex flex-col gap-4">
        {sessions.length === 0 && connStatus === "connected" && (
          <div class="text-slate-500 text-center py-10 text-sm space-y-2">
            <p class="text-base">⚪ 連上 relay，但還沒有 session</p>
            <p class="text-xs text-slate-600">兩個可能：</p>
            <ul class="text-xs text-slate-500 list-disc list-inside text-left max-w-xs mx-auto space-y-1">
              <li>電腦的 daemon 沒在跑 → 終端機跑 <code class="bg-slate-800 px-1 rounded">pnpm start</code></li>
              <li>daemon 有跑，但你還沒開任何 Claude Code session → 開一個就會出現</li>
            </ul>
            <p class="text-[10px] text-slate-700 mt-3">若 hooks 還沒裝：<code class="bg-slate-800 px-1 rounded">pnpm install:hooks</code></p>
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

        <div class="mt-6 border border-slate-800 rounded-lg bg-slate-900/50">
          <div class="flex items-center px-3 py-2 border-b border-slate-800">
            <span class="text-xs font-semibold text-slate-400">活動紀錄（同步輸出到 F12 Console）</span>
            <button class="ml-auto text-xs text-slate-500 hover:text-slate-300" onClick={() => setLog([])}>清空</button>
          </div>
          <div class="text-[11px] font-mono p-3 max-h-64 overflow-y-auto">
            {log.length === 0 && <div class="text-slate-600">尚無活動。WS 連上、配對後送出 cmd、收到 event 都會即時顯示。</div>}
            {log.map((e, i) => (
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
      </main>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<PhoneState | null>(() => loadState());
  const [autoPairError, setAutoPairError] = useState<string | null>(null);
  const [autoPairing, setAutoPairing] = useState(false);
  const relayUrl = getRelayUrl();

  // Auto-pair from URL fragment (#t=...&r=...) once on mount. Idempotent —
  // hash is cleared after first attempt so refresh doesn't replay the token.
  useEffect(() => {
    if (state) return; // already paired; ignore any leftover hash
    const fromHash = parsePairFromHash();
    if (!fromHash) return;
    clearHash();
    setAutoPairing(true);
    void (async () => {
      try {
        const identity = await loadOrCreateIdentity();
        const peer = await performPairing(fromHash.relay, fromHash.token, identity);
        const next: PhoneState = {
          relay_url: fromHash.relay,
          daemon_id: peer.daemon_id,
          daemon_name: peer.daemon_id,
          daemon_pk_b64: peer.daemon_pubkey_b64,
          shared_secret_b64: peer.shared_secret_b64,
          phone_pk_b64: identity.encryption_pubkey,
          phone_privkey_b64: identity.encryption_privkey,
          paired_at: Date.now(),
        };
        saveState(next);
        setState(next);
      } catch (e: unknown) {
        setAutoPairError(e instanceof Error ? (e.message || "auto_pair_failed") : "auto_pair_failed");
      } finally {
        setAutoPairing(false);
      }
    })();
  }, []);

  function handlePaired(s: PhoneState) {
    setState(s);
  }

  function handleUnpair() {
    clearState();
    setState(null);
  }

  if (autoPairing) {
    return (
      <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div class="text-center">
          <div class="text-lg font-medium mb-2">配對中…</div>
          <div class="text-sm text-slate-500">正在跟 daemon 完成 handshake</div>
        </div>
      </div>
    );
  }
  if (!state) {
    return <PairForm relayUrl={relayUrl} onPaired={handlePaired} autoPairError={autoPairError} />;
  }
  return <DashboardScreen state={state} onUnpair={handleUnpair} />;
}

render(<App />, document.getElementById("app")!);
