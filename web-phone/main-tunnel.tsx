// web-phone/main-tunnel.tsx — bootstrap for the full-fidelity remote client.
//
// Flow:
//   1. Show a pair-or-load splash.
//   2. If URL has #t=…&r=… (QR scan / camera deep-link) → auto-pair.
//   3. If localStorage has a saved PhoneState → reconnect via sig.
//   4. Otherwise → show PairForm (with QR scanner) for first-time pairing.
//   5. Once we have an authed relay WS, install TunnelTransport into
//      web/api.ts and dynamic-import web/app.tsx — which auto-mounts the
//      full dashboard (same one as 127.0.0.1:8765) into #app.
//
// This file is the entry-point named in web-phone/index.html. The simplified
// `web-phone/app.tsx` is retained as a fallback for the old build but no
// longer loaded by the production bundle.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
// Both stylesheets: tailwind utilities for our pair UI, dashboard CSS for web/app.
import "./style.css";
import "../web/style.css";
import {
  fromBase64,
  performPairing,
  connectAuthed,
  computePeerIdFromB64,
  normalizePairingCode,
  isValidPairingCode,
} from "./relay";
import {
  loadState,
  saveState,
  clearState,
  loadOrCreateIdentity,
  type PhoneState,
} from "./store";
import { QrScanner } from "./qr-scanner";
import { setTransport } from "../web/api";
import { TunnelTransport } from "../web/transport-tunnel";

// ── URL-hash auto-pair ───────────────────────────────────────────────────────

function parsePairFragment(fragment: string): { token: string; relay: string } | null {
  try {
    const hash = fragment.replace(/^#/, "");
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const token = params.get("t");
    const relay = params.get("r");
    if (!token || !relay || !isValidPairingCode(token)) return null;
    return { token, relay };
  } catch {
    return null;
  }
}

function parsePairFromScannedText(text: string): { token: string; relay: string } | null {
  const hashIdx = text.indexOf("#");
  if (hashIdx >= 0) return parsePairFragment(text.slice(hashIdx + 1));
  if (/^[\w-]+=/.test(text)) return parsePairFragment(text);
  return null;
}

function clearHash(): void {
  try {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch { /* ignore */ }
}

const DEFAULT_RELAY_URL = "https://relay.f1telemetrystationpro.org";

function getDefaultRelayUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get("relay") ?? DEFAULT_RELAY_URL;
  } catch {
    return DEFAULT_RELAY_URL;
  }
}

// ── Connect: open relay WS, install TunnelTransport, mount web/app ───────────

async function activateTunnel(state: PhoneState): Promise<void> {
  const identity = await loadOrCreateIdentity();
  const ws = connectAuthed(state.relay_url!, state.daemon_id, identity);

  // Wait for relay's "ready" before we hand control to web/app.tsx (which will
  // immediately start firing apiFetch / apiWebSocket calls).
  await new Promise<void>((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (m && m.type === "ready") {
          ws.removeEventListener("message", onMessage);
          resolve();
        }
      } catch { /* not a control msg; the TunnelTransport will handle envelopes later */ }
    };
    const onError = () => reject(new Error("relay ws error before ready"));
    const onClose = (ev: CloseEvent) => reject(new Error(`relay ws closed (${ev.code}) ${ev.reason}`));
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError, { once: true } as any);
    ws.addEventListener("close", onClose, { once: true } as any);
    setTimeout(() => reject(new Error("relay ready timeout (10s)")), 10_000);
  });

  // Register our peer_id so daemon→phone envelopes can be precisely routed.
  const peerId = await computePeerIdFromB64(state.phone_pk_b64);
  ws.send(JSON.stringify({ type: "register_peer_id", peer_id: peerId }));

  // Install transport BEFORE importing web/app.tsx — its auto-mount calls
  // apiFetch immediately, and would throw if no transport were installed.
  const sharedSecret = fromBase64(state.shared_secret_b64);
  setTransport(new TunnelTransport({ ws, sharedSecret }));

  // Dynamic-import web/app.tsx — its tail invokes mountApp() which renders the
  // full dashboard into #app, replacing our splash.
  await import("../web/app");
}

// ── Pair UI ──────────────────────────────────────────────────────────────────

interface PairProps {
  relayUrl: string;
  onPaired: (state: PhoneState) => void;
}

function PairScreen({ relayUrl, onPaired }: PairProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const normalized = normalizePairingCode(input);
  const valid = isValidPairingCode(normalized);

  async function pair(token: string, useRelay: string) {
    setBusy(true); setError(null);
    try {
      const identity = await loadOrCreateIdentity();
      const peer = await performPairing(useRelay, token, identity);
      const next: PhoneState = {
        relay_url: useRelay,
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
    } catch (e: unknown) {
      setError(e instanceof Error ? (e.message || "pairing_failed") : "pairing_failed");
    } finally {
      setBusy(false);
    }
  }

  function handleScan(text: string) {
    setScanning(false);
    const parsed = parsePairFromScannedText(text);
    if (!parsed) {
      setError(`掃到了但不是配對 QR：${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
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
            在電腦終端機跑 <code class="bg-slate-800 px-1 rounded font-mono">pnpm pair --new</code>
          </p>

          <div class="flex flex-col gap-1">
            <label class="text-sm text-slate-300 font-medium">16 碼配對碼</label>
            <input
              type="text"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={input}
              onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !busy) void pair(normalized, relayUrl);
              }}
              disabled={busy}
              autoFocus
              class="bg-slate-800 rounded px-3 py-3 text-lg font-mono tracking-widest uppercase focus:outline-none"
              style={{ border: `2px solid ${valid ? "#2db75a" : "#374151"}` }}
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
            onClick={() => void pair(normalized, relayUrl)}
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

// ── Bootstrap ────────────────────────────────────────────────────────────────

function Bootstrap() {
  const [state, setState] = useState<PhoneState | null>(() => loadState());
  const [phase, setPhase] = useState<"checking" | "pairing-from-hash" | "connecting" | "error">("checking");
  const [error, setError] = useState<string | null>(null);

  // First effect: handle URL-hash auto-pair OR resolve into "connecting"/"pair-needed"
  useEffect(() => {
    if (state) { setPhase("connecting"); return; }
    const fromHash = parsePairFragment(window.location.hash);
    if (!fromHash) { setPhase("checking"); return; }  // show PairScreen
    clearHash();
    setPhase("pairing-from-hash");
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
        setState(next);   // triggers the second effect
      } catch (e: unknown) {
        setError(e instanceof Error ? (e.message || "auto_pair_failed") : "auto_pair_failed");
        setPhase("error");
      }
    })();
  }, []);

  // Second effect: once we have state, open tunnel + mount web/App
  useEffect(() => {
    if (!state || phase !== "connecting") return;
    void (async () => {
      try {
        await activateTunnel(state);
        // activateTunnel mounted web/App over #app — no further React from us.
      } catch (e: unknown) {
        setError(e instanceof Error ? (e.message || "tunnel_failed") : "tunnel_failed");
        setPhase("error");
      }
    })();
  }, [state, phase]);

  if (phase === "error") {
    return (
      <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div class="max-w-md text-center">
          <div class="text-lg font-bold text-red-400 mb-2">連線錯誤</div>
          <div class="text-sm text-slate-400 mb-4">{error}</div>
          <button
            class="bg-slate-700 hover:bg-slate-600 rounded px-4 py-2 text-sm"
            onClick={() => { clearState(); window.location.reload(); }}
          >
            清除狀態並重新配對
          </button>
        </div>
      </div>
    );
  }

  if (phase === "pairing-from-hash") {
    return (
      <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div class="text-center">
          <div class="text-lg">配對中…</div>
          <div class="text-sm text-slate-500 mt-2">正在跟 daemon 完成 handshake</div>
        </div>
      </div>
    );
  }

  if (phase === "connecting") {
    return (
      <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div class="text-center">
          <div class="text-lg">連線中…</div>
          <div class="text-sm text-slate-500 mt-2">透過 relay 連到 daemon · {state?.daemon_id?.slice(0, 12)}…</div>
        </div>
      </div>
    );
  }

  if (!state) {
    return <PairScreen relayUrl={getDefaultRelayUrl()} onPaired={setState} />;
  }

  return null;
}

render(<Bootstrap />, document.getElementById("app")!);
