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
import { t, useLocale, setLocale, LOCALES, LOCALE_LABELS, type Locale } from "@shared/i18n";

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

interface MetricPoint {
  ts: number;
  ttft_ms: number | null;
  tps: number | null;
}

// Status labels are computed via t() per render so locale switches take effect
// without remounting. Keep STATUS_COLOR (Tailwind class names) static.
function statusLabel(s: Session["status"]): string {
  return t(`status.${s}`);
}

// Compact language selector used in both the pair screen header and the
// dashboard header. Subscribes to locale changes so the surrounding tree
// re-renders when the user flips locales.
function PhoneLocaleSelector() {
  const [locale, setL] = useLocale();
  return (
    <select
      value={locale}
      onChange={(e) => setL((e.currentTarget as HTMLSelectElement).value as Locale)}
      class="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700 focus:outline-none"
      aria-label="Language"
      title="Language"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
      ))}
    </select>
  );
}


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
    if (!valid) { setError(t("phone.pair.errorBadCode")); return; }
    await pair(normalized, relayUrl);
  }

  function handleScan(scannedText: string) {
    setScanning(false);
    const parsed = parsePairFromScannedText(scannedText);
    if (!parsed) {
      const preview = scannedText.slice(0, 60) + (scannedText.length > 60 ? "…" : "");
      setError(t("phone.pair.errorScannedQr", { text: preview }));
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
        <div class="flex items-center justify-between mb-2">
          <h1 class="text-2xl font-bold">{t("phone.pair.title")}</h1>
          <PhoneLocaleSelector />
        </div>
        <p class="text-slate-400 mb-6 text-sm">{t("phone.pair.subtitle")}</p>

        <div class="bg-slate-900 rounded-lg border border-slate-800 p-5 flex flex-col gap-4">
          <p class="text-sm text-slate-400">
            {(() => {
              // The {cmd} segment is rendered as a styled <code>, so split the
              // template ourselves rather than fighting interpolate().
              const parts = t("phone.pair.instruction", { cmd: " CMD " }).split(" CMD ");
              return (
                <>
                  {parts[0]}
                  <code class="bg-slate-800 px-1 rounded font-mono">miki pair</code>
                  {parts[1] ?? ""}
                </>
              );
            })()}
          </p>

          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">{t("phone.pair.codeLabel")}</label>
            <input
              type="text"
              placeholder={t("phone.pair.codePlaceholder")}
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
            {busy ? t("phone.pair.busy") : t("phone.pair.submit")}
          </button>

          <div class="flex items-center gap-3 text-xs text-slate-500">
            <div class="flex-1 h-px bg-slate-800" />
            <span>{t("phone.pair.or")}</span>
            <div class="flex-1 h-px bg-slate-800" />
          </div>

          <button
            class="rounded px-4 py-2 font-medium text-sm transition-colors text-slate-100 bg-slate-700 hover:bg-slate-600 flex items-center justify-center gap-2"
            disabled={busy}
            onClick={() => { setError(null); setScanning(true); }}
          >
            <span>📷</span>
            <span>{t("phone.pair.scan")}</span>
          </button>
        </div>

        <p class="text-xs text-slate-600 mt-4 text-center">
          {t("phone.pair.relayLabel")} <code class="font-mono">{relayUrl}</code>
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
        <span class="text-xs text-slate-500 ml-auto flex-shrink-0">{statusLabel(s.status)}</span>
      </div>
      <div class="text-xs text-slate-500 font-mono break-all">{s.cwd}</div>
      <div class="text-[10px] text-slate-600 font-mono break-all">
        session_uuid: {s.session_uuid ?? <span class="text-amber-400">{t("phone.session.noUuid")}</span>}
      </div>
      {(s.last_message_preview || s.status === "active" || s.status === "waiting") && (
        <div class="text-sm text-slate-300 line-clamp-2">
          {s.last_message_preview}
          {s.status === "active"  && <span class="phone-cursor phone-cursor--streaming" aria-label="streaming">▌</span>}
          {s.status === "waiting" && <span class="phone-cursor phone-cursor--thinking"  aria-label="thinking">▌</span>}
        </div>
      )}
      <div class="flex gap-2 mt-1">
        <button
          class="bg-slate-700 hover:bg-slate-600 rounded px-3 py-1 text-sm transition-colors"
          onClick={() => onFocus(s.cwd)}
        >
          {t("phone.session.focus")}
        </button>
      </div>
      <div class="flex gap-2 mt-1">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
          rows={2}
          placeholder={t("phone.session.promptPlaceholder")}
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 text-sm transition-colors"
          disabled={!draft.trim()}
          onClick={() => { onSend(s.cwd, draft); setDraft(""); }}
        >
          {t("phone.session.send")}
        </button>
      </div>
    </div>
  );
}

// ── Monit Components ─────────────────────────────────────────────────────

function MetricChart({ data, field, color, label, unit, fleetAvg }: {
  data: MetricPoint[];
  field: "ttft_ms" | "tps";
  color: string;
  label: string;
  unit: string;
  fleetAvg: number | null;
}) {
  if (data.length === 0) {
    return (
      <div class="flex items-center justify-center h-14 text-xs" style={{ color: "#475569" }}>
        {label}: no data
      </div>
    );
  }
  const values = data.map(p => p[field] ?? 0);
  const maxV = Math.max(...values, 1);
  const W = 280, H = 56, PAD = 4;
  const pts = data.map((p, i) => {
    const x = PAD + (i / Math.max(data.length - 1, 1)) * (W - 2 * PAD);
    const y = H - PAD - ((p[field] ?? 0) / maxV) * (H - 2 * PAD);
    return [x, y] as [number, number];
  });
  const seg = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  const linePath = "M" + seg;
  const areaPath = linePath +
    ` L${(PAD + W - 2 * PAD).toFixed(1)},${(H - PAD).toFixed(1)}` +
    ` L${PAD},${(H - PAD).toFixed(1)} Z`;
  const fleetY = fleetAvg != null ? H - PAD - (fleetAvg / maxV) * (H - 2 * PAD) : null;
  return (
    <div>
      <div class="text-xs mb-1" style={{ color: "#64748b" }}>{label} ({unit})</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
        <path d={areaPath} fill={color} fillOpacity={0.15} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} />
        {fleetY != null && (
          <line x1={PAD} y1={fleetY} x2={W - PAD} y2={fleetY}
            stroke="#818cf8" strokeWidth={1} strokeDasharray="3 2" />
        )}
      </svg>
    </div>
  );
}

type MonitWindow = "1h" | "6h" | "24h" | "48h";
const MONIT_WINS: MonitWindow[] = ["1h", "6h", "24h", "48h"];

function MonitPanel({ proxyFetch }: { proxyFetch: (path: string) => Promise<unknown> }) {
  const [win, setWin] = useState<MonitWindow>("24h");
  const [data, setData] = useState<MetricPoint[]>([]);
  const [fleetTtft, setFleetTtft] = useState<number | null>(null);
  const [fleetTps, setFleetTps] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(w: MonitWindow) {
    setLoading(true); setError(null);
    try {
      const res = await proxyFetch(`/metrics?window=${w}`) as {
        metrics?: MetricPoint[];
        fleet_avg_ttft?: number | null;
        fleet_avg_tps?: number | null;
      };
      setData(res.metrics ?? []);
      setFleetTtft(res.fleet_avg_ttft ?? null);
      setFleetTps(res.fleet_avg_tps ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(win); }, [win]);

  return (
    <div class="border border-slate-800 rounded-lg bg-slate-900 p-3 mb-2">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm font-semibold" style={{ color: "#a5b4fc" }}>⚡ Monit</span>
        <div class="ml-auto flex gap-1 items-center">
          {MONIT_WINS.map(w => (
            <button
              key={w}
              class="px-2 py-0.5 rounded text-xs transition-colors"
              style={{ background: w === win ? "#3730a3" : "#1e293b", color: w === win ? "#e0e7ff" : "#64748b" }}
              onClick={() => setWin(w)}
            >{w}</button>
          ))}
          <button
            class="ml-1 px-2 py-0.5 rounded text-xs"
            style={{ background: "#1e293b", color: "#64748b" }}
            onClick={() => void load(win)}
          >↺</button>
        </div>
      </div>
      {loading && <div class="text-xs text-center py-3" style={{ color: "#64748b" }}>Loading…</div>}
      {error && <div class="text-xs py-2" style={{ color: "#f87171" }}>{error}</div>}
      {!loading && !error && (
        <div class="flex flex-col gap-3">
          <MetricChart data={data} field="ttft_ms" color="#4ade80" label="TTFT" unit="ms" fleetAvg={fleetTtft} />
          <MetricChart data={data} field="tps" color="#60a5fa" label="TPS" unit="chars/s" fleetAvg={fleetTps} />
          {(fleetTtft != null || fleetTps != null) && (
            <div class="text-[10px] flex gap-4" style={{ color: "#475569" }}>
              {fleetTtft != null && <span>fleet TTFT: <span style={{ color: "#94a3b8" }}>{Math.round(fleetTtft)}ms</span></span>}
              {fleetTps != null && <span>fleet TPS: <span style={{ color: "#94a3b8" }}>{fleetTps.toFixed(1)}</span></span>}
            </div>
          )}
        </div>
      )}
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

function connLabel(c: ConnStatus): string {
  return t(`phone.conn.${c}`);
}

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
  const [monitOpen, setMonitOpen] = useState(false);
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);
  const unpairingRef = useRef(false);
  const pendingRequestsRef = useRef<Map<string, (data: unknown) => void>>(new Map());

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
      addLog("info", t("phone.log.revokeRelay"));
      try { ws.send(JSON.stringify({ type: "revoke_self" })); } catch { /* ignore */ }
      // Safety net: if relay never replies, finalize anyway after 1.5s.
      setTimeout(() => { if (mountedRef.current) finalizeUnpair(); }, 1500);
    } else {
      addLog("warn", t("phone.log.unpairOffline"));
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
      addLog("error", t("phone.log.sendFailWsClosed", { label }), { state: ws?.readyState ?? "no-ws" });
      return false;
    }
    const env = encodeEnvelope(plain, sharedSecret, "daemon");
    ws.send(JSON.stringify(env));
    addLog("info", t("phone.log.encryptedSend", { label }), { kind: (plain as any).kind, envBytes: JSON.stringify(env).length });
    return true;
  }

  function connect() {
    if (!mountedRef.current) return;
    setConnStatus("connecting");

    let ws: WebSocket;
    if (state.relay_url) {
      // New relay-based connection: use signed auth token
      addLog("info", t("phone.log.wsConnectingRelay"), { relay: state.relay_url, daemon_id: state.daemon_id, daemon_name: state.daemon_name });
      // We need identity for connectAuthed — load async then connect
      void loadOrCreateIdentity().then((identity) => {
        if (!mountedRef.current) return;
        const w = connectAuthed(state.relay_url!, state.daemon_id, identity);
        wsRef.current = w;
        attachWsHandlers(w);
      }).catch((e) => {
        addLog("error", t("phone.log.identityFail"), { err: String(e) });
        setConnStatus("error");
      });
      return;
    }
    // Legacy direct-worker connection
    const workerUrl = state.worker_url ?? "";
    const phoneWsBase = workerUrl.replace(/\/v1\/daemon($|\?)/, "/v1/phone$1");
    const wsUrl = appendQueryParam(phoneWsBase, "daemon_id", state.daemon_id);
    addLog("info", t("phone.log.wsConnectingLegacy"), { url: wsUrl, daemon_id: state.daemon_id, daemon_name: state.daemon_name });
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
          addLog("info", t("phone.log.registerPeer"), { peer_id });
        } catch { /* ignore */ }
      });
      addLog("info", t("phone.log.wsOpenSnapshot"));
      sendEncrypted({ kind: "request_snapshot" }, "request_snapshot");
    };

    ws.onmessage = (ev) => {
      if (!mountedRef.current) return;
      let raw: any;
      try { raw = JSON.parse(ev.data as string); }
      catch { addLog("warn", t("phone.log.wsNonJson"), { raw: String(ev.data).slice(0, 80) }); return; }

      // Control-plane messages from relay/daemon (not encrypted envelopes):
      if (raw && typeof raw.type === "string") {
        if (raw.type === "revoked_ok") {
          addLog("info", t("phone.log.revokeOk"));
          finalizeUnpair();
          return;
        }
        if (raw.type === "phone_revoked") {
          // Daemon kicked us — clear local and bounce to pair screen.
          addLog("warn", t("phone.log.revokeKicked"), { by: raw.by ?? "unknown" });
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
        addLog("warn", t("phone.log.envelopeFail"), { to: env.to, ts: env.ts });
        return;
      }
      if (plain.kind === "state_snapshot" && Array.isArray(plain.sessions)) {
        addLog("info", t("phone.log.snapshotReceived", { n: plain.sessions.length }), { cwds: plain.sessions.map((s) => s.cwd) });
        setSessions(plain.sessions as Session[]);
      } else if (plain.kind === "event" && plain.session) {
        const s = plain.session;
        addLog("info", t("phone.log.eventReceived", { project: s.project_name }), { cwd: s.cwd, status: s.status, session_uuid: s.session_uuid });
        setSessions((prev) => {
          const others = prev.filter((x) => x.cwd !== s.cwd);
          return [s, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
      } else if (plain.kind === "http_proxy_response") {
        const reqId = (plain as { request_id?: string }).request_id;
        if (reqId) {
          const resolver = pendingRequestsRef.current.get(reqId);
          if (resolver) {
            pendingRequestsRef.current.delete(reqId);
            try { resolver(JSON.parse((plain as { body?: string }).body ?? "{}")); }
            catch { resolver({}); }
          }
        }
      } else {
        addLog("warn", t("phone.log.unknownKind"), { kind: plain.kind });
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setConnStatus("error");
      addLog("error", t("phone.log.wsError"));
    };

    ws.onclose = (ev) => {
      if (!mountedRef.current) return;
      setConnStatus("reconnecting");
      const delay = Math.min(backoffRef.current, 60_000);
      addLog("warn", t("phone.log.wsCloseReconnect", { delay }), { code: ev.code, reason: ev.reason || t("phone.log.wsCloseReason") });
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
    addLog("info", t("phone.log.focusClick"), { cwd });
    sendEncrypted({ kind: "cmd_focus", cwd }, "cmd_focus");
  };
  const onSend = (cwd: string, prompt: string) => {
    addLog("info", t("phone.log.sendClick"), { cwd, promptLength: prompt.length, promptPreview: prompt.slice(0, 40) });
    sendEncrypted({ kind: "cmd_send", cwd, prompt }, "cmd_send");
  };

  function proxyFetch(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request_id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        pendingRequestsRef.current.delete(request_id);
        reject(new Error("proxy timeout"));
      }, 10_000);
      pendingRequestsRef.current.set(request_id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      const ok = sendEncrypted({ kind: "http_proxy", path, method: "GET", request_id }, "http_proxy");
      if (!ok) {
        clearTimeout(timer);
        pendingRequestsRef.current.delete(request_id);
        reject(new Error("ws not open"));
      }
    });
  }

  return (
    <div class="min-h-screen bg-slate-950 text-slate-100">
      <header class="sticky top-0 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <h1 class="text-lg font-bold">miki-moni · <span class="text-indigo-400">{state.daemon_name}</span></h1>
        <div class="flex items-center gap-2 ml-auto">
          <span class={`w-2.5 h-2.5 rounded-full ${CONN_DOT[connStatus]}`} />
          <span class="text-xs text-slate-400">{connLabel(connStatus)}</span>
        </div>
        <PhoneLocaleSelector />
        <button
          class="rounded px-2 py-1 text-xs transition-colors"
          style={{ background: monitOpen ? "#3730a3" : "#334155", color: "#a5b4fc" }}
          onClick={() => setMonitOpen(m => !m)}
          title="Performance Monit"
        >⚡</button>
        <button
          class="bg-slate-700 hover:bg-slate-600 disabled:opacity-60 rounded px-3 py-1 text-sm ml-1 transition-colors"
          onClick={requestUnpair}
          disabled={unpairing}
        >
          {unpairing ? t("phone.header.unpairing") : t("phone.header.unpair")}
        </button>
      </header>

      {monitOpen && (
        <div
          style={{
            position: "fixed",
            top: 57,
            left: 0,
            right: 0,
            zIndex: 40,
            maxHeight: "70vh",
            overflowY: "auto",
            background: "#020617",
            borderBottom: "1px solid #1e293b",
            padding: "12px 16px 16px",
          }}
        >
          <MonitPanel proxyFetch={proxyFetch} />
        </div>
      )}

      <main class="max-w-2xl mx-auto p-4 flex flex-col gap-4">

        {sessions.length === 0 && connStatus === "connected" && (
          <div class="text-slate-500 text-center py-10 text-sm space-y-2">
            <p class="text-base">{t("phone.empty.title")}</p>
            <p class="text-xs text-slate-600">{t("phone.empty.twoOptions")}</p>
            <ul class="text-xs text-slate-500 list-disc list-inside text-left max-w-xs mx-auto space-y-1">
              <li>{(() => {
                const parts = t("phone.empty.daemonNotRunning", { cmd: " CMD " }).split(" CMD ");
                return <>{parts[0]}<code class="bg-slate-800 px-1 rounded">pnpm start</code>{parts[1] ?? ""}</>;
              })()}</li>
              <li>{t("phone.empty.noClaude")}</li>
            </ul>
            <p class="text-[10px] text-slate-700 mt-3">{(() => {
              const parts = t("phone.empty.hooksHint", { cmd: " CMD " }).split(" CMD ");
              return <>{parts[0]}<code class="bg-slate-800 px-1 rounded">pnpm install:hooks</code>{parts[1] ?? ""}</>;
            })()}</p>
          </div>
        )}
        {sessions.length === 0 && connStatus !== "connected" && (
          <div class="text-slate-600 text-center py-10 text-sm">
            {t("phone.empty.waitingConn")}
          </div>
        )}
        {sessions.map((s) => (
          <SessionCard key={s.cwd} s={s} onFocus={onFocus} onSend={onSend} />
        ))}

        <div class="mt-6 border border-slate-800 rounded-lg bg-slate-900/50">
          <div class="flex items-center px-3 py-2 border-b border-slate-800">
            <span class="text-xs font-semibold text-slate-400">{t("phone.log.title")}{t("phone.log.consoleNote")}</span>
            <button class="ml-auto text-xs text-slate-500 hover:text-slate-300" onClick={() => setLog([])}>{t("phone.log.clear")}</button>
          </div>
          <div class="text-[11px] font-mono p-3 max-h-64 overflow-y-auto">
            {log.length === 0 && <div class="text-slate-600">{t("phone.log.empty")}</div>}
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
  // Subscribe at the root so a locale flip in any child causes the whole tree
  // to re-render — every t() call captured in JSX then picks up new strings.
  useLocale();
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
          <div class="text-lg font-medium mb-2">{t("phone.pair.autoTitle")}</div>
          <div class="text-sm text-slate-500">{t("phone.pair.autoHint")}</div>
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
