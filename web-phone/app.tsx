import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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
import { t, useLocale, LOCALES, LOCALE_LABELS, type Locale } from "@shared/i18n";

type AgentId = "claude" | "codex";
type SessionStatus = "active" | "waiting" | "idle" | "stale";

interface AskOption { label: string; description: string }
interface AskQuestion { question: string; header: string; multiSelect?: boolean; options: AskOption[] }
interface PendingAsk { question_id: string; questions: AskQuestion[] }

interface Session {
  cwd: string;
  session_uuid: string | null;
  agent?: AgentId;
  project_name: string;
  status: SessionStatus;
  last_event_at: number;
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
  vscode_pid?: number | null;
  wrapped?: boolean;
  activity?: string | null;
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto" | null;
  current_model?: string | null;
  current_effort?: string | null;
  pending_ask?: PendingAsk | null;
}

interface ToolUseInfo { id: string; name: string; description?: string; input: unknown; input_summary: string }
interface ToolResultInfo { tool_use_id?: string; content: string; truncated: boolean; is_error?: boolean }
interface TranscriptTurn {
  ts: string;
  role: "user" | "assistant" | "system";
  text: string;
  tool_use?: ToolUseInfo;
  tool_result?: ToolResultInfo;
  images?: Array<{ media_type: string; data: string }>;
  raw_type?: string;
}
interface TranscriptResp {
  session_uuid: string;
  transcript_path: string | null;
  file_size: number;
  last_modified: string | null;
  turn_count: number;
  turns: TranscriptTurn[];
  pending?: boolean;
}
interface AttachedImage { media_type: string; data: string; name: string }
interface SendResp { ok?: boolean; mode?: string; session_uuid?: string; requested_session_uuid?: string; reply?: string; duration_ms?: number; error?: string; url?: string }
interface ProxyResponse { status: number; headers?: Record<string, string>; body?: string }

interface MetricPoint {
  ts: number;
  ttft_ms: number | null;
  tps: number | null;
  agent?: AgentId | null;
  project_name?: string | null;
}

type ConnStatus = "connecting" | "connected" | "reconnecting" | "error";
type MonitWindow = "1h" | "6h" | "24h" | "48h";
type AgentFilter = "all" | AgentId;

interface LogEntry { ts: number; level: "info" | "warn" | "error"; msg: string; ctx?: Record<string, unknown> }

const DEFAULT_RELAY_URL = "https://relay.f1telemetrystationpro.org";
const MONIT_WINS: MonitWindow[] = ["1h", "6h", "24h", "48h"];
const STATUS_COLOR: Record<SessionStatus, string> = {
  active: "bg-emerald-500",
  waiting: "bg-amber-500",
  idle: "bg-slate-500",
  stale: "bg-red-500",
};
const CONN_DOT: Record<ConnStatus, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500",
  error: "bg-red-500",
};

const TAG = "%c[miki-moni-phone]";
const TAG_STYLE = "color:#f472b6;font-weight:bold";

function clog(label: string, ctx?: Record<string, unknown>): void { console.log(TAG, TAG_STYLE, label, ctx ?? ""); }
function cwarn(label: string, ctx?: Record<string, unknown>): void { console.warn(TAG, TAG_STYLE, label, ctx ?? ""); }
function cerr(label: string, ctx?: Record<string, unknown>): void { console.error(TAG, TAG_STYLE, label, ctx ?? ""); }

function statusLabel(s: SessionStatus): string { return t(`status.${s}`); }
function connLabel(c: ConnStatus): string { return t(`phone.conn.${c}`); }
function agentOf(s: Session): AgentId { return s.agent === "codex" ? "codex" : "claude"; }
function sessionKey(s: Session): string { return s.session_uuid ?? `cwd:${s.cwd}`; }
function isUuidReady(s: Session): s is Session & { session_uuid: string } { return typeof s.session_uuid === "string" && s.session_uuid.length > 0; }
function formatClock(input: string | number | null | undefined): string {
  if (!input) return "";
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString("zh-TW", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatRelative(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  return `${Math.floor(hr / 24)} 天前`;
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-TW", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}
function appendQueryParam(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}
function getRelayUrl(): string {
  try { return new URLSearchParams(window.location.search).get("relay") ?? DEFAULT_RELAY_URL; }
  catch { return DEFAULT_RELAY_URL; }
}
function parsePairFragment(fragment: string): { token: string; relay: string } | null {
  try {
    const params = new URLSearchParams(fragment.replace(/^#/, ""));
    const token = params.get("t");
    const relay = params.get("r");
    if (!token || !relay || !isValidPairingCode(token)) return null;
    return { token, relay };
  } catch { return null; }
}
function parsePairFromHash(): { token: string; relay: string } | null { return parsePairFragment(window.location.hash); }
function parsePairFromScannedText(text: string): { token: string; relay: string } | null {
  const hashIdx = text.indexOf("#");
  if (hashIdx >= 0) return parsePairFragment(text.slice(hashIdx + 1));
  if (/^[\w-]+=/.test(text)) return parsePairFragment(text);
  return null;
}
function clearHash(): void {
  try { history.replaceState(null, "", window.location.pathname + window.location.search); }
  catch { /* ignore */ }
}
function imageUrl(img: { media_type: string; data: string }): string {
  return img.data.startsWith("data:") ? img.data : `data:${img.media_type};base64,${img.data}`;
}
function safeJson(text: string | undefined): unknown {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}
async function filesToImages(files: FileList | null): Promise<AttachedImage[]> {
  if (!files) return [];
  const out: AttachedImage[] = [];
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("image read failed"));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    });
    const [, data = ""] = dataUrl.split(",", 2);
    out.push({ media_type: file.type, data, name: file.name });
  }
  return out;
}

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
      {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_LABELS[l]}</option>)}
    </select>
  );
}

function PairForm({ relayUrl, onPaired, autoPairError }: {
  relayUrl: string;
  onPaired: (state: PhoneState) => void;
  autoPairError?: string | null;
}) {
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
      const next: PhoneState = {
        relay_url: useRelayUrl,
        daemon_id: peer.daemon_id,
        daemon_name: peer.daemon_id,
        daemon_pk_b64: peer.daemon_pubkey_b64,
        shared_secret_b64: peer.shared_secret_b64,
        phone_pk_b64: identity.encryption_pubkey,
        phone_privkey_b64: identity.encryption_privkey,
        paired_at: Date.now(),
      };
      saveState(next);
      onPaired(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "pairing_failed");
    } finally {
      setBusy(false);
    }
  }

  if (scanning) return <QrScanner onScan={(text) => {
    setScanning(false);
    const parsed = parsePairFromScannedText(text);
    if (!parsed) { setError(t("phone.pair.errorScannedQr", { text: text.slice(0, 60) })); return; }
    void pair(parsed.token, parsed.relay);
  }} onCancel={() => setScanning(false)} />;

  const instruction = t("phone.pair.instruction", { cmd: "__CMD__" }).split("__CMD__");

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
            {instruction[0]}<code class="bg-slate-800 px-1 rounded font-mono">miki pair</code>{instruction[1] ?? ""}
          </p>
          <label class="text-sm text-slate-300 font-medium">{t("phone.pair.codeLabel")}</label>
          <input
            type="text"
            placeholder={t("phone.pair.codePlaceholder")}
            value={input}
            onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid && !busy) void pair(normalized, relayUrl); }}
            disabled={busy}
            class="bg-slate-800 rounded px-3 py-3 text-lg font-mono tracking-widest uppercase focus:outline-none focus:ring-2 transition-all border border-slate-700"
            autoFocus
          />
          {error && <div class="bg-red-950 border border-red-800 rounded px-3 py-2 text-sm text-red-300">{error}</div>}
          <button
            class="rounded px-4 py-2 font-medium text-sm transition-colors text-white disabled:opacity-50 bg-indigo-600"
            disabled={!valid || busy}
            onClick={() => void pair(normalized, relayUrl)}
          >
            {busy ? t("phone.pair.busy") : t("phone.pair.submit")}
          </button>
          <button
            class="rounded px-4 py-2 font-medium text-sm transition-colors text-slate-100 bg-slate-700 hover:bg-slate-600"
            disabled={busy}
            onClick={() => { setError(null); setScanning(true); }}
          >
            Scan QR
          </button>
        </div>
        <p class="text-xs text-slate-600 mt-4 text-center">
          {t("phone.pair.relayLabel")} <code class="font-mono">{relayUrl}</code>
        </p>
      </div>
    </div>
  );
}

function AgentBadge({ agent }: { agent: AgentId }) {
  return (
    <span class={`text-[11px] rounded-full px-2 py-0.5 border ${agent === "codex" ? "border-emerald-400/50 text-emerald-200 bg-emerald-950/40" : "border-orange-400/50 text-orange-200 bg-orange-950/40"}`}>
      {agent === "codex" ? "Codex" : "Claude"}
    </span>
  );
}

function SessionCard({ s, onOpen, onFocus, onSend, onInterrupt }: {
  s: Session;
  onOpen: (s: Session) => void;
  onFocus: (s: Session) => void;
  onSend: (s: Session, prompt: string, images?: AttachedImage[]) => Promise<void>;
  onInterrupt: (s: Session) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const agent = agentOf(s);
  const canSend = isUuidReady(s) && (draft.trim().length > 0 || images.length > 0);

  async function submit() {
    if (!canSend) return;
    const text = draft;
    const sendImages = images;
    setDraft(""); setImages([]);
    await onSend(s, text, sendImages);
  }

  return (
    <div class="rounded-lg border border-slate-800 bg-slate-900 p-4 flex flex-col gap-3">
      <button class="text-left" onClick={() => onOpen(s)}>
        <div class="flex items-center gap-2">
          <span class={`w-3 h-3 rounded-full flex-shrink-0 ${STATUS_COLOR[s.status]}`} />
          <span class="text-base font-semibold truncate">{s.project_name}</span>
          <AgentBadge agent={agent} />
          {s.wrapped && <span class="text-[11px] text-indigo-200 border border-indigo-400/50 bg-indigo-950/40 rounded-full px-2 py-0.5">wrapped</span>}
          <span class="text-xs text-slate-500 ml-auto">{formatRelative(s.last_event_at)}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span>{statusLabel(s.status)}</span>
          {s.activity && <span>{s.activity}</span>}
          {s.permission_mode && <span>{s.permission_mode}</span>}
          {s.current_model && <span>{s.current_model}</span>}
          {s.current_effort && <span>{s.current_effort}</span>}
        </div>
        <div class="mt-2 text-xs text-slate-500 font-mono break-all">{s.cwd}</div>
        <div class="mt-1 text-[10px] text-slate-600 font-mono break-all">
          {s.session_uuid ?? <span class="text-amber-400">{t("phone.session.noUuid")}</span>}
        </div>
        <div class="mt-2 min-h-12 text-sm text-slate-300 line-clamp-3">
          {s.last_message_preview || "No preview yet"}
          {s.status === "active" && <span class="phone-cursor phone-cursor--streaming" aria-label="streaming">▍</span>}
          {s.status === "waiting" && <span class="phone-cursor phone-cursor--thinking" aria-label="thinking">▍</span>}
        </div>
      </button>
      {s.pending_ask && <div class="rounded border border-amber-700 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">Waiting for answer: {s.pending_ask.questions[0]?.header ?? "question"}</div>}
      <div class="flex gap-2">
        <button class="bg-slate-700 hover:bg-slate-600 rounded px-3 py-1 text-sm" onClick={() => onOpen(s)}>Open</button>
        <button class="bg-slate-700 hover:bg-slate-600 rounded px-3 py-1 text-sm" onClick={() => onFocus(s)}>Focus</button>
        <button class="bg-slate-800 hover:bg-slate-700 rounded px-3 py-1 text-sm" onClick={() => onInterrupt(s)}>Stop</button>
      </div>
      {images.length > 0 && (
        <div class="flex gap-2 overflow-x-auto">
          {images.map((img, i) => (
            <button key={`${img.name}-${i}`} class="relative shrink-0" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
              <img src={imageUrl(img)} class="w-14 h-14 object-cover rounded border border-slate-700" />
              <span class="absolute -top-1 -right-1 bg-slate-950 border border-slate-700 rounded-full text-[10px] px-1">x</span>
            </button>
          ))}
        </div>
      )}
      <div class="flex gap-2">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          rows={2}
          placeholder={agent === "codex" ? "輸入 Codex prompt..." : t("phone.session.promptPlaceholder")}
          value={draft}
          disabled={!isUuidReady(s)}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
          }}
        />
        <div class="flex flex-col gap-2">
          <label class="bg-slate-800 hover:bg-slate-700 rounded px-3 py-2 text-sm text-center cursor-pointer">
            img
            <input class="hidden" type="file" accept="image/*" multiple onChange={(e) => {
              void filesToImages((e.currentTarget as HTMLInputElement).files).then((next) => setImages((prev) => [...prev, ...next]));
              (e.currentTarget as HTMLInputElement).value = "";
            }} />
          </label>
          <button class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 py-2 text-sm" disabled={!canSend} onClick={() => void submit()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MetricChart({ data, field, color, label, unit, fleetAvg }: {
  data: MetricPoint[];
  field: "ttft_ms" | "tps";
  color: string;
  label: string;
  unit: string;
  fleetAvg: number | null;
}) {
  const clean = data.filter((p) => p[field] != null);
  if (clean.length === 0) return <div class="flex items-center justify-center h-20 text-xs text-slate-500">{label}: 暫無資料</div>;
  const values = clean.map((p) => p[field] ?? 0);
  const maxV = Math.max(...values, fleetAvg ?? 0, 1);
  const W = 320, H = 72, PAD = 6;
  const pts = clean.map((p, i) => {
    const x = PAD + (i / Math.max(clean.length - 1, 1)) * (W - 2 * PAD);
    const y = H - PAD - ((p[field] ?? 0) / maxV) * (H - 2 * PAD);
    return [x, y] as [number, number];
  });
  const linePath = "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L");
  const fleetY = fleetAvg != null ? H - PAD - (fleetAvg / maxV) * (H - 2 * PAD) : null;
  return (
    <div>
      <div class="flex justify-between text-xs mb-1 text-slate-400">
        <span>{label} ({unit})</span>
        <span>{values[values.length - 1]?.toFixed(field === "tps" ? 1 : 0)}{unit}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} class="block">
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} />
        {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={2.5} fill={color} />)}
        {fleetY != null && <line x1={PAD} y1={fleetY} x2={W - PAD} y2={fleetY} stroke="#fca5a5" strokeWidth={1.5} strokeDasharray="4 3" />}
      </svg>
      {fleetAvg != null && <div class="text-[10px] text-slate-500">fleet average: {fleetAvg.toFixed(field === "tps" ? 1 : 0)}{unit}</div>}
    </div>
  );
}

function MonitPanel({ proxyRequest }: { proxyRequest: (path: string) => Promise<unknown> }) {
  const [win, setWin] = useState<MonitWindow>("24h");
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [data, setData] = useState<MetricPoint[]>([]);
  const [fleetTtft, setFleetTtft] = useState<number | null>(null);
  const [fleetTps, setFleetTps] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const agentPart = agent === "all" ? "" : `&agent=${agent}`;
      const res = await proxyRequest(`/metrics?window=${win}${agentPart}`) as {
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
  useEffect(() => { void load(); }, [win, agent]);

  return (
    <div class="border border-slate-800 rounded-lg bg-slate-900 p-3 mb-2">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm font-semibold text-indigo-200">Monit</span>
        <span class="text-xs text-slate-500">{data.length} turns</span>
        <button class="ml-auto px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-400" onClick={() => void load()}>refresh</button>
      </div>
      <div class="flex flex-wrap gap-1 mb-3">
        {(["all", "claude", "codex"] as AgentFilter[]).map((a) => (
          <button key={a} class={`px-2 py-1 rounded text-xs ${agent === a ? "bg-indigo-700 text-indigo-50" : "bg-slate-800 text-slate-400"}`} onClick={() => setAgent(a)}>{a === "all" ? "All" : a === "claude" ? "Claude" : "Codex"}</button>
        ))}
        <span class="w-px bg-slate-800 mx-1" />
        {MONIT_WINS.map((w) => (
          <button key={w} class={`px-2 py-1 rounded text-xs ${win === w ? "bg-indigo-700 text-indigo-50" : "bg-slate-800 text-slate-400"}`} onClick={() => setWin(w)}>{w}</button>
        ))}
      </div>
      {loading && <div class="text-xs text-center py-6 text-slate-500">Loading...</div>}
      {error && <div class="text-xs py-2 text-red-300">{error}</div>}
      {!loading && !error && (
        <div class="flex flex-col gap-4">
          <MetricChart data={data} field="ttft_ms" color="#4ade80" label="TTFT" unit="ms" fleetAvg={fleetTtft} />
          <MetricChart data={data} field="tps" color="#60a5fa" label="TPS" unit="/s" fleetAvg={fleetTps} />
        </div>
      )}
    </div>
  );
}

function TurnView({ turn, agent, durationMs }: { turn: TranscriptTurn; agent: AgentId; durationMs?: number }) {
  const isUser = turn.role === "user" && !turn.tool_result;
  const isTool = !!turn.tool_use || !!turn.tool_result;
  const label = turn.tool_result ? "tool" : turn.role === "assistant" ? agent : turn.role;
  return (
    <div class={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div class={`max-w-[92%] rounded-2xl border px-4 py-3 text-sm whitespace-pre-wrap break-words ${
        isUser ? "bg-slate-100 text-slate-900 border-slate-300 rounded-tr-sm" :
        isTool ? "bg-slate-900 text-slate-200 border-slate-700" :
        "bg-emerald-950/30 text-slate-100 border-emerald-800/60 rounded-tl-sm"
      }`}>
        <div class="flex items-center gap-2 mb-1 text-[11px] uppercase tracking-wide opacity-70">
          <span>{label}</span>
          <span class="normal-case">{formatClock(turn.ts)}</span>
          {durationMs != null && <span class="normal-case">{durationMs} ms</span>}
        </div>
        {turn.text && <div>{turn.text}</div>}
        {turn.images && turn.images.length > 0 && (
          <div class="mt-2 grid grid-cols-2 gap-2">
            {turn.images.map((img, i) => <img key={i} src={imageUrl(img)} class="rounded border border-slate-700 max-h-48 object-contain bg-slate-950" />)}
          </div>
        )}
        {turn.tool_use && (
          <details class="mt-2 rounded bg-slate-950/70 border border-slate-700 p-2">
            <summary class="cursor-pointer text-xs text-indigo-200">{turn.tool_use.name}: {turn.tool_use.input_summary}</summary>
            <pre class="mt-2 text-[11px] overflow-x-auto">{JSON.stringify(turn.tool_use.input, null, 2)}</pre>
          </details>
        )}
        {turn.tool_result && (
          <details class="mt-2 rounded bg-slate-950/70 border border-slate-700 p-2" open={turn.tool_result.is_error === true}>
            <summary class={`cursor-pointer text-xs ${turn.tool_result.is_error ? "text-red-200" : "text-slate-300"}`}>tool result{turn.tool_result.truncated ? " (truncated)" : ""}</summary>
            <pre class="mt-2 text-[11px] overflow-x-auto">{turn.tool_result.content}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function AskPanel({ ask, onAnswer }: { ask: PendingAsk; onAnswer: (answers: string[]) => Promise<void> }) {
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const answers = ask.questions.map((q, i) => {
      const picked = Array.from(selected[i] ?? []);
      return picked.length > 0 ? picked.join(", ") : "";
    });
    setBusy(true);
    try { await onAnswer(answers); } finally { setBusy(false); }
  }

  return (
    <div class="rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm">
      <div class="font-semibold text-amber-100 mb-2">Agent needs input</div>
      {ask.questions.map((q, qi) => (
        <div key={qi} class="mb-3">
          <div class="text-amber-100">{q.header || q.question}</div>
          <div class="text-xs text-amber-200/70 mb-2">{q.question}</div>
          <div class="flex flex-col gap-2">
            {q.options.map((opt) => {
              const checked = selected[qi]?.has(opt.label) ?? false;
              return (
                <label key={opt.label} class={`rounded border px-3 py-2 ${checked ? "border-amber-300 bg-amber-900/60" : "border-amber-800 bg-slate-950/20"}`}>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`ask-${qi}`}
                    checked={checked}
                    class="mr-2"
                    onChange={() => setSelected((prev) => {
                      const next = { ...prev };
                      const set = q.multiSelect ? new Set(next[qi] ?? []) : new Set<string>();
                      if (checked) set.delete(opt.label); else set.add(opt.label);
                      next[qi] = set;
                      return next;
                    })}
                  />
                  <span>{opt.label}</span>
                  {opt.description && <div class="pl-6 text-xs text-amber-200/70">{opt.description}</div>}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      <button class="bg-amber-500 text-slate-950 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={() => void submit()}>
        Send answer
      </button>
    </div>
  );
}

function ModelOverride({ value, onSubmit }: { value: string | null | undefined; onSubmit: (model: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  return (
    <div class="flex gap-1">
      <input
        class="min-w-0 flex-1 bg-slate-800 rounded px-2 py-1 text-xs"
        value={draft}
        placeholder="model"
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !busy) {
            setBusy(true);
            void onSubmit(draft).finally(() => setBusy(false));
          }
        }}
      />
      <button
        class="bg-slate-700 rounded px-2 py-1 text-xs disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onSubmit(draft).finally(() => setBusy(false));
        }}
      >
        set
      </button>
    </div>
  );
}

function SessionDetail({ session, onClose, proxyRequest, refreshSessions, onSessionUuidChanged }: {
  session: Session;
  onClose: () => void;
  proxyRequest: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  refreshSessions: () => Promise<void>;
  onSessionUuidChanged: (oldKey: string, newUuid: string) => void;
}) {
  const [transcript, setTranscript] = useState<TranscriptResp | null>(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const agent = agentOf(session);
  const uuid = session.session_uuid;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  async function loadTranscript() {
    if (!uuid) return;
    const res = await proxyRequest(`/sessions/${encodeURIComponent(uuid)}/transcript?limit=200`) as TranscriptResp;
    setTranscript(res);
    setTimeout(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, 0);
  }

  useEffect(() => {
    setTranscript(null); setError(null); setDurationMs(null);
    void loadTranscript().catch((e) => setError(e instanceof Error ? e.message : String(e)));
    const timer = window.setInterval(() => {
      if (session.status === "active" || session.status === "waiting") void loadTranscript().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [uuid]);

  async function send() {
    if (!uuid || busy) return;
    if (!draft.trim() && images.length === 0) return;
    setBusy(true); setError(null); setDurationMs(null);
    const oldKey = sessionKey(session);
    try {
      const res = await proxyRequest("/send", {
        method: "POST",
        body: {
          session_uuid: uuid,
          prompt: draft,
          submit: false,
          images: images.map(({ media_type, data }) => ({ media_type, data })),
        },
      }) as SendResp;
      if (res.duration_ms != null) setDurationMs(res.duration_ms);
      if (res.session_uuid && res.session_uuid !== uuid) onSessionUuidChanged(oldKey, res.session_uuid);
      setDraft(""); setImages([]);
      await refreshSessions();
      await loadTranscript();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function interrupt() {
    if (!uuid) return;
    setError(null);
    try {
      await proxyRequest("/wrap/interrupt", { method: "POST", body: { session_uuid: uuid } });
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function answerAsk(answers: string[]) {
    if (!uuid || !session.pending_ask) return;
    await proxyRequest("/wrap/answer", { method: "POST", body: { session_uuid: uuid, question_id: session.pending_ask.question_id, answers } });
    await refreshSessions();
  }

  async function setPermission(mode: string) {
    if (!uuid) return;
    await proxyRequest("/wrap/permission-mode", { method: "POST", body: { session_uuid: uuid, mode } });
    await refreshSessions();
  }
  async function setEffort(effort: string) {
    if (!uuid) return;
    await proxyRequest("/wrap/effort", { method: "POST", body: { session_uuid: uuid, effort } });
    await refreshSessions();
  }
  async function setModel(model: string) {
    if (!uuid) return;
    await proxyRequest("/wrap/model", { method: "POST", body: { session_uuid: uuid, model } });
    await refreshSessions();
  }

  const lastAssistantIndex = useMemo(() => {
    const turns = transcript?.turns ?? [];
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i]?.role === "assistant" && !turns[i]?.tool_use && !turns[i]?.tool_result) return i;
    return -1;
  }, [transcript]);

  return (
    <div class="fixed inset-0 bg-slate-950 text-slate-100 z-50 flex flex-col">
      <header class="border-b border-slate-800 px-4 py-3 flex items-center gap-2">
        <span class={`w-3 h-3 rounded-full ${STATUS_COLOR[session.status]}`} />
        <div class="min-w-0">
          <div class="font-semibold truncate">{session.project_name}</div>
          <div class="text-[11px] text-slate-500 truncate">{session.cwd}</div>
        </div>
        <AgentBadge agent={agent} />
        <button class="ml-auto text-slate-400 px-2 py-1" onClick={onClose}>Close</button>
      </header>
      <div class="border-b border-slate-800 px-4 py-2 flex flex-wrap gap-2 text-xs">
        {session.wrapped && <span class="rounded bg-indigo-950 border border-indigo-700 px-2 py-1">wrapped</span>}
        {session.activity && <span class="rounded bg-slate-800 px-2 py-1">{session.activity}</span>}
        {uuid && <span class="rounded bg-slate-800 px-2 py-1 font-mono truncate max-w-full">{uuid}</span>}
        <button class="rounded bg-slate-800 px-2 py-1" onClick={() => void loadTranscript()}>reload</button>
        <button class="rounded bg-slate-800 px-2 py-1" onClick={() => void interrupt()}>interrupt</button>
      </div>
      {session.wrapped && agent === "claude" && (
        <div class="border-b border-slate-800 px-4 py-2 grid grid-cols-3 gap-2">
          <select class="bg-slate-800 rounded px-2 py-1 text-xs" value={session.permission_mode ?? "default"} onChange={(e) => void setPermission((e.currentTarget as HTMLSelectElement).value)}>
            {["default", "acceptEdits", "bypassPermissions", "plan", "auto"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select class="bg-slate-800 rounded px-2 py-1 text-xs" value={session.current_effort ?? ""} onChange={(e) => void setEffort((e.currentTarget as HTMLSelectElement).value)}>
            {["", "low", "medium", "high", "xhigh", "max"].map((m) => <option key={m} value={m}>{m || "effort"}</option>)}
          </select>
          <ModelOverride value={session.current_model} onSubmit={setModel} />
        </div>
      )}
      <div ref={scrollRef} class="flex-1 overflow-y-auto p-4 space-y-3">
        {session.pending_ask && <AskPanel ask={session.pending_ask} onAnswer={answerAsk} />}
        {error && <div class="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200">{error}</div>}
        {!uuid && <div class="text-center text-slate-500 py-10">This session has no UUID yet.</div>}
        {uuid && !transcript && <div class="text-center text-slate-500 py-10">Loading transcript...</div>}
        {transcript?.pending && <div class="text-center text-slate-500 text-sm py-4">CLI launched, waiting for first turn.</div>}
        {transcript?.turns.map((turn, i) => <TurnView key={`${turn.ts}-${i}`} turn={turn} agent={agent} durationMs={agent === "codex" && i === lastAssistantIndex && durationMs != null ? durationMs : undefined} />)}
      </div>
      <div class="border-t border-slate-800 p-3 space-y-2">
        {images.length > 0 && (
          <div class="flex gap-2 overflow-x-auto">
            {images.map((img, i) => (
              <button key={`${img.name}-${i}`} class="relative shrink-0" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                <img src={imageUrl(img)} class="w-16 h-16 object-cover rounded border border-slate-700" />
                <span class="absolute -top-1 -right-1 bg-slate-950 border border-slate-700 rounded-full text-[10px] px-1">x</span>
              </button>
            ))}
          </div>
        )}
        <div class="flex gap-2">
          <textarea
            class="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
            rows={2}
            value={draft}
            placeholder={agent === "codex" ? "輸入 Codex prompt..." : "輸入 Claude prompt..."}
            onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send(); }}
          />
          <div class="flex flex-col gap-2">
            <label class="bg-slate-800 hover:bg-slate-700 rounded px-3 py-2 text-sm text-center cursor-pointer">
              img
              <input class="hidden" type="file" accept="image/*" multiple onChange={(e) => {
                void filesToImages((e.currentTarget as HTMLInputElement).files).then((next) => setImages((prev) => [...prev, ...next]));
                (e.currentTarget as HTMLInputElement).value = "";
              }} />
            </label>
            <button class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 py-2 text-sm" disabled={busy || !uuid || (!draft.trim() && images.length === 0)} onClick={() => void send()}>
              {busy ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewCliModal({ onClose, onStart }: { onClose: () => void; onStart: (cwd: string, agent: AgentId) => Promise<void> }) {
  const [cwd, setCwd] = useState("");
  const [agent, setAgent] = useState<AgentId>("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div class="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
      <div class="w-full max-w-md rounded-t-xl sm:rounded-xl bg-slate-900 border border-slate-700 p-4 text-slate-100">
        <div class="flex items-center mb-3">
          <h2 class="font-semibold">新增 CLI</h2>
          <button class="ml-auto text-slate-400" onClick={onClose}>Close</button>
        </div>
        <div class="space-y-3">
          <select class="w-full bg-slate-800 rounded px-3 py-2" value={agent} onChange={(e) => setAgent((e.currentTarget as HTMLSelectElement).value as AgentId)}>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
          <input class="w-full bg-slate-800 rounded px-3 py-2 font-mono text-sm" value={cwd} placeholder="D:\\code\\cc-hub" onInput={(e) => setCwd((e.currentTarget as HTMLInputElement).value)} />
          {error && <div class="text-sm text-red-300">{error}</div>}
          <button class="w-full bg-indigo-600 rounded px-3 py-2 disabled:opacity-50" disabled={busy || !cwd.trim()} onClick={() => {
            setBusy(true); setError(null);
            void onStart(cwd.trim(), agent).then(onClose).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
          }}>{busy ? "Starting..." : "Start"}</button>
        </div>
      </div>
    </div>
  );
}

function DashboardScreen({ state, onUnpair }: { state: PhoneState; onUnpair: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<ConnStatus>("connecting");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [unpairing, setUnpairing] = useState(false);
  const [monitOpen, setMonitOpen] = useState(false);
  const [newCliOpen, setNewCliOpen] = useState(false);
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const mountedRef = useRef(true);
  const unpairingRef = useRef(false);
  const pendingRequestsRef = useRef<Map<string, (data: ProxyResponse) => void>>(new Map());
  const sharedSecret = fromBase64(state.shared_secret_b64);
  const selectedSession = selectedKey ? sessions.find((s) => sessionKey(s) === selectedKey) ?? null : null;

  useEffect(() => { void computePeerIdFromB64(state.phone_pk_b64).then(setMyPeerId); }, [state.phone_pk_b64]);

  function addLog(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, msg, ctx };
    setLog((prev) => [entry, ...prev].slice(0, 50));
    (level === "error" ? cerr : level === "warn" ? cwarn : clog)(msg, ctx);
  }
  function mergeSessions(nextSessions: Session[]) {
    setSessions((prev) => {
      const map = new Map(prev.map((s) => [sessionKey(s), s]));
      for (const s of nextSessions) map.set(sessionKey(s), s);
      return Array.from(map.values()).sort((a, b) => b.last_event_at - a.last_event_at);
    });
  }
  function replaceSessions(nextSessions: Session[]) {
    setSessions(nextSessions.sort((a, b) => b.last_event_at - a.last_event_at));
  }
  function sendEncrypted(plain: object, label: string): boolean {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addLog("error", `send failed: ${label}`, { state: ws?.readyState ?? "no-ws" });
      return false;
    }
    const env = encodeEnvelope(plain, sharedSecret, "daemon");
    ws.send(JSON.stringify(env));
    return true;
  }
  function proxyRequest(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request_id = Math.random().toString(36).slice(2);
      const timer = window.setTimeout(() => {
        pendingRequestsRef.current.delete(request_id);
        reject(new Error("proxy timeout"));
      }, 30_000);
      pendingRequestsRef.current.set(request_id, (res) => {
        window.clearTimeout(timer);
        if (res.status >= 400) {
          const parsed = safeJson(res.body);
          const message = typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error?: unknown }).error) : String(res.body ?? `HTTP ${res.status}`);
          reject(new Error(message));
          return;
        }
        resolve(safeJson(res.body));
      });
      const headers = init.body === undefined ? undefined : { "content-type": "application/json" };
      const ok = sendEncrypted({
        kind: "http_proxy",
        path,
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        request_id,
      }, "http_proxy");
      if (!ok) {
        window.clearTimeout(timer);
        pendingRequestsRef.current.delete(request_id);
        reject(new Error("ws not open"));
      }
    });
  }
  async function refreshSessions() {
    const res = await proxyRequest("/sessions") as Session[];
    if (Array.isArray(res)) replaceSessions(res);
  }
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
      try { ws.send(JSON.stringify({ type: "revoke_self" })); } catch { /* ignore */ }
      setTimeout(() => { if (mountedRef.current) finalizeUnpair(); }, 1500);
    } else {
      finalizeUnpair();
    }
  }
  function attachWsHandlers(ws: WebSocket) {
    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      backoffRef.current = 1000;
      setConnStatus("connected");
      void computePeerIdFromB64(state.phone_pk_b64).then((peer_id) => {
        if (!mountedRef.current) return;
        try { ws.send(JSON.stringify({ type: "register_peer_id", peer_id })); } catch { /* ignore */ }
      });
      sendEncrypted({ kind: "request_snapshot" }, "request_snapshot");
      void refreshSessions().catch((e) => addLog("warn", "sessions refresh failed", { error: String(e) }));
    };
    ws.onmessage = (ev) => {
      let raw: any;
      try { raw = JSON.parse(ev.data as string); }
      catch { addLog("warn", "non-json ws message"); return; }
      if (raw?.type === "revoked_ok" || raw?.type === "phone_revoked") { finalizeUnpair(); return; }
      const env = raw as Envelope;
      if (typeof env.to === "string" && env.to.startsWith("phone:")) {
        const targetPeerId = env.to.slice("phone:".length);
        if (myPeerId && targetPeerId !== myPeerId) return;
      }
      const plain = decodeEnvelope(env, sharedSecret) as { kind?: string; sessions?: Session[]; session?: Session; request_id?: string; status?: number; headers?: Record<string, string>; body?: string } | null;
      if (!plain) { addLog("warn", "envelope decode failed"); return; }
      if (plain.kind === "state_snapshot" && Array.isArray(plain.sessions)) {
        replaceSessions(plain.sessions);
        void refreshSessions().catch(() => undefined);
      } else if (plain.kind === "event" && plain.session) {
        mergeSessions([plain.session]);
        void refreshSessions().catch(() => undefined);
      } else if (plain.kind === "http_proxy_response" && plain.request_id) {
        const resolver = pendingRequestsRef.current.get(plain.request_id);
        if (resolver) {
          pendingRequestsRef.current.delete(plain.request_id);
          resolver({ status: plain.status ?? 502, headers: plain.headers, body: plain.body });
        }
      }
    };
    ws.onerror = () => { setConnStatus("error"); addLog("error", "ws error"); };
    ws.onclose = (ev) => {
      if (!mountedRef.current || unpairingRef.current) return;
      setConnStatus("reconnecting");
      const delay = Math.min(backoffRef.current, 60_000);
      addLog("warn", "ws closed, reconnecting", { delay, code: ev.code });
      backoffRef.current = delay * 2;
      setTimeout(connect, delay);
    };
  }
  function connect() {
    if (!mountedRef.current) return;
    setConnStatus("connecting");
    if (state.relay_url) {
      void loadOrCreateIdentity().then((identity) => {
        if (!mountedRef.current) return;
        const ws = connectAuthed(state.relay_url!, state.daemon_id, identity);
        wsRef.current = ws;
        attachWsHandlers(ws);
      }).catch((e) => { addLog("error", "identity failed", { error: String(e) }); setConnStatus("error"); });
      return;
    }
    const workerUrl = state.worker_url ?? "";
    const phoneWsBase = workerUrl.replace(/\/v1\/daemon($|\?)/, "/v1/phone$1");
    const wsUrl = appendQueryParam(phoneWsBase, "daemon_id", state.daemon_id);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    attachWsHandlers(ws);
  }

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, []);

  async function focusSession(s: Session) {
    try {
      await proxyRequest("/focus", { method: "POST", body: isUuidReady(s) ? { session_uuid: s.session_uuid } : { cwd: s.cwd } });
    } catch (e) {
      addLog("warn", "focus failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  async function sendPrompt(s: Session, prompt: string, images: AttachedImage[] = []) {
    if (!isUuidReady(s)) return;
    const oldKey = sessionKey(s);
    try {
      const res = await proxyRequest("/send", {
        method: "POST",
        body: { session_uuid: s.session_uuid, prompt, submit: false, images: images.map(({ media_type, data }) => ({ media_type, data })) },
      }) as SendResp;
      if (res.session_uuid && res.session_uuid !== s.session_uuid) onSessionUuidChanged(oldKey, res.session_uuid);
      await refreshSessions();
    } catch (e) {
      addLog("error", "send failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  async function interruptSession(s: Session) {
    if (!isUuidReady(s)) return;
    try {
      await proxyRequest("/wrap/interrupt", { method: "POST", body: { session_uuid: s.session_uuid } });
      await refreshSessions();
    } catch (e) {
      addLog("warn", "interrupt failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  async function startCli(cwd: string, agent: AgentId) {
    const res = await proxyRequest("/wrap/start", { method: "POST", body: { cwd, agent } }) as { session_uuid?: string };
    await refreshSessions();
    if (res.session_uuid) setSelectedKey(res.session_uuid);
  }
  function onSessionUuidChanged(oldKey: string, newUuid: string) {
    setSelectedKey((cur) => cur === oldKey ? newUuid : cur);
  }

  return (
    <div class="min-h-screen bg-slate-950 text-slate-100">
      <header class="sticky top-0 z-30 bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <h1 class="text-lg font-bold truncate">miki-moni <span class="text-indigo-400">{state.daemon_name}</span></h1>
        <div class="ml-auto flex items-center gap-2">
          <span class={`w-2.5 h-2.5 rounded-full ${CONN_DOT[connStatus]}`} />
          <span class="text-xs text-slate-400">{connLabel(connStatus)}</span>
        </div>
        <button class="rounded px-2 py-1 text-xs bg-slate-800 text-slate-300" onClick={() => setNewCliOpen(true)}>CLI</button>
        <button class={`rounded px-2 py-1 text-xs ${monitOpen ? "bg-indigo-700 text-indigo-50" : "bg-slate-800 text-slate-300"}`} onClick={() => setMonitOpen((m) => !m)}>Monit</button>
        <PhoneLocaleSelector />
        <button class="bg-slate-700 hover:bg-slate-600 disabled:opacity-60 rounded px-3 py-1 text-sm" onClick={requestUnpair} disabled={unpairing}>{unpairing ? t("phone.header.unpairing") : t("phone.header.unpair")}</button>
      </header>
      {monitOpen && <div class="sticky top-[57px] z-20 bg-slate-950 border-b border-slate-800 p-4"><MonitPanel proxyRequest={proxyRequest} /></div>}
      <main class="max-w-2xl mx-auto p-4 flex flex-col gap-4">
        {sessions.length === 0 && connStatus === "connected" && (
          <div class="text-slate-500 text-center py-10 text-sm space-y-2">
            <p class="text-base">{t("phone.empty.title")}</p>
            <p class="text-xs text-slate-600">{t("phone.empty.twoOptions")}</p>
          </div>
        )}
        {sessions.map((s) => (
          <SessionCard
            key={sessionKey(s)}
            s={s}
            onOpen={(target) => setSelectedKey(sessionKey(target))}
            onFocus={(target) => void focusSession(target)}
            onSend={sendPrompt}
            onInterrupt={(target) => void interruptSession(target)}
          />
        ))}
        <div class="mt-4 border border-slate-800 rounded-lg bg-slate-900/50">
          <div class="flex items-center px-3 py-2 border-b border-slate-800">
            <span class="text-xs font-semibold text-slate-400">{t("phone.log.title")}</span>
            <button class="ml-auto text-xs text-slate-500 hover:text-slate-300" onClick={() => setLog([])}>{t("phone.log.clear")}</button>
          </div>
          <div class="text-[11px] font-mono p-3 max-h-64 overflow-y-auto">
            {log.length === 0 && <div class="text-slate-600">{t("phone.log.empty")}</div>}
            {log.map((e, i) => (
              <div key={i} class={e.level === "error" ? "text-red-400" : e.level === "warn" ? "text-amber-400" : "text-slate-300"}>
                <span class="text-slate-600">{fmtTime(e.ts)}</span> <span>{e.msg}</span>
                {e.ctx && <span class="text-slate-500"> {JSON.stringify(e.ctx)}</span>}
              </div>
            ))}
          </div>
        </div>
      </main>
      {selectedSession && (
        <SessionDetail
          session={selectedSession}
          onClose={() => setSelectedKey(null)}
          proxyRequest={proxyRequest}
          refreshSessions={refreshSessions}
          onSessionUuidChanged={onSessionUuidChanged}
        />
      )}
      {newCliOpen && <NewCliModal onClose={() => setNewCliOpen(false)} onStart={startCli} />}
    </div>
  );
}

function App() {
  useLocale();
  const [state, setState] = useState<PhoneState | null>(() => loadState());
  const [autoPairError, setAutoPairError] = useState<string | null>(null);
  const [autoPairing, setAutoPairing] = useState(false);
  const relayUrl = getRelayUrl();

  useEffect(() => {
    if (state) return;
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
      } catch (e) {
        setAutoPairError(e instanceof Error ? e.message : "auto_pair_failed");
      } finally {
        setAutoPairing(false);
      }
    })();
  }, []);

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
  if (!state) return <PairForm relayUrl={relayUrl} onPaired={setState} autoPairError={autoPairError} />;
  return <DashboardScreen state={state} onUnpair={() => { clearState(); setState(null); }} />;
}

render(<App />, document.getElementById("app")!);
