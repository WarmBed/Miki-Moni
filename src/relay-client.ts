import WebSocket from "ws";
import { fromBase64, toBase64, sign as signMsg, deriveSharedSecret } from "./crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "./relay-protocol.js";
import { addPairedPeer, saveConfig, type Config, type PairedPeer } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Session } from "./types.js";
import type { Notifier } from "./notifier.js";
import { computePeerId } from "./pairing.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PORT_FILE, CONFIG_FILE } from "./data-dir.js";

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const NONCE_FRESHNESS_MS = 60_000;
const DEFAULT_LOCAL_PORT = 8765;
const HTTP_PROXY_TIMEOUT_MS = 30_000;

export interface RelayClientDeps {
  config: Config;
  store: SessionStore;
  bridge: VscodeBridge;
  /** Optional notifier — fires when a new phone completes pairing so the user
   *  sees "+1 device" instead of silent permanent-QR pairs. */
  notifier?: Notifier;
  /** Where to persist newly-paired peers. Defaults to data-dir CONFIG_FILE.
   *  Override for tests. */
  configPath?: string;
  /** Override the localhost port the daemon's HTTP server is on (default 8765).
   *  Plumbed for tests; production reads from MIKI_LOCAL_PORT env if set. */
  localHttpPort?: number;
}

interface PeerSecrets {
  peer: PairedPeer;
  sharedSecret: Uint8Array;
  recentNonces: Map<string, number>;  // nonce → seen-at ms
}

function buildChallengeMessage(nonce: Uint8Array, issued_at_ms: number): Uint8Array {
  const out = new Uint8Array(nonce.length + 8);
  out.set(nonce, 0);
  new DataView(out.buffer, nonce.length, 8).setBigUint64(0, BigInt(issued_at_ms), false);
  return out;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private storeListener: ((s: Session) => void) | null = null;
  private peers: PeerSecrets[] = [];
  private ready = false;

  constructor(private deps: RelayClientDeps) {
    this.peers = deps.config.paired_peers.map((p) => ({
      peer: p,
      sharedSecret: fromBase64(p.shared_secret),
      recentNonces: new Map(),
    }));
  }

  async start(): Promise<void> {
    if (!this.deps.config.remote) {
      throw new Error("RelayClient cannot start without config.remote.worker_url");
    }
    this.stopRequested = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.storeListener) {
      this.deps.store.off("session_changed", this.storeListener);
      this.storeListener = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private daemonIdHex(): string {
    const pub = fromBase64(this.deps.config.device.signing_pubkey);
    return createHash("sha256").update(pub).digest("hex").slice(0, 32);
  }

  private connect(): void {
    const remote = this.deps.config.remote!;
    // Use worker_url AS-IS (test passes ws://localhost:N, prod passes wss://relay.f1telemetrystationpro.org)
    // Append /v1/daemon if not already in the URL.
    const baseUrl = remote.worker_url.replace(/\/$/, "");
    const url = baseUrl.includes("/v1/") ? baseUrl : `${baseUrl}/v1/daemon`;
    const headers: Record<string, string> = {
      "X-Daemon-Pubkey": this.deps.config.device.signing_pubkey,
      "X-Daemon-Enc-Pubkey": this.deps.config.device.pubkey,    // X25519, for phone ECDH
      "X-Daemon-Id": this.daemonIdHex(),
    };
    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    this.ready = false;

    ws.on("open", () => { /* wait for challenge from server */ });
    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => { /* swallow; close handler reconnects */ });
  }

  private handleMessage(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    if (!this.ready) {
      if (msg.type === "challenge") {
        const nonce = fromBase64(msg.nonce);
        const sigMsg = buildChallengeMessage(nonce, msg.issued_at_ms);
        const priv = fromBase64(this.deps.config.device.signing_privkey);
        const sig = signMsg(sigMsg, priv);
        this.ws!.send(JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));
        return;
      }
      if (msg.type === "ready") {
        this.ready = true;
        this.reconnectMs = RECONNECT_INITIAL_MS;
        this.storeListener = (session: Session) => this.broadcastEvent(session);
        this.deps.store.on("session_changed", this.storeListener);
        // Re-register the persistent pair token (if configured). This keeps
        // the QR alive across daemon restarts and ensures the relay
        // coordinator has the entry after its own state resets.
        const persistToken = this.deps.config.remote?.pair_token;
        if (persistToken && this.ws) {
          this.ws.send(JSON.stringify({
            type: "register_pairing",
            token: persistToken,
            persistent: true,
          }));
        }
        return;
      }
      // Drop any other messages received before ready
      return;
    }

    // Post-ready: envelope routing
    if (msg.type === "envelope") {
      this.handleEnvelope(msg as Envelope);
      return;
    }

    // Phone scanned the persistent QR — handle pairing here so the daemon
    // doesn't need a separate `pnpm pair --new` running.
    if (msg.type === "pair_offer") {
      void this.handlePairOffer(msg);
      return;
    }

    // Phone (or daemon-side CLI) revoked a paired phone — relay forwards.
    // Mirror in local config so the next restart's peers list is clean.
    if (msg.type === "phone_revoked") {
      void this.handlePhoneRevoked(msg);
      return;
    }

    // Legacy: envelopes sent without a wrapper type field (current relay sends plain Envelope objects)
    if (typeof msg.ts === "number" && typeof msg.nonce === "string") {
      this.handleEnvelope(msg as Envelope);
    }
  }

  // ── Permanent-QR pairing ────────────────────────────────────────────────────
  // When a phone scans the persistent QR, the worker forwards its pair_offer
  // here. We derive the shared secret, persist the new peer, and ack — same
  // logic the one-shot `pnpm pair --new` CLI used to do.

  private daemonIdHex_cached: string | null = null;
  private daemonId(): string {
    if (!this.daemonIdHex_cached) this.daemonIdHex_cached = this.daemonIdHex();
    return this.daemonIdHex_cached;
  }

  private async handlePairOffer(msg: any): Promise<void> {
    const phonePubB64 = typeof msg.phone_pubkey === "string" ? msg.phone_pubkey : "";
    if (!phonePubB64) return;
    const phoneSignPubB64 = typeof msg.phone_sign_pubkey === "string" ? msg.phone_sign_pubkey : undefined;

    // Idempotency: if we've already paired this phone (same X25519 pubkey),
    // just re-ack — phone may have lost local state and is re-pairing.
    const peer_id = computePeerId(phonePubB64);
    const existing = this.deps.config.paired_peers.find((p) => p.peer_id === peer_id);
    if (existing) {
      if (this.ws) {
        this.ws.send(JSON.stringify({ type: "pair_ack", daemon_id: this.daemonId() }));
      }
      return;
    }

    const phonePub = fromBase64(phonePubB64);
    const encPriv = fromBase64(this.deps.config.device.privkey);
    const sharedSecret = deriveSharedSecret(encPriv, phonePub);

    const peer: PairedPeer = {
      peer_id,
      peer_name: typeof msg.phone_name === "string" ? msg.phone_name : "phone",
      peer_pubkey: phonePubB64,
      peer_sign_pubkey: phoneSignPubB64,
      shared_secret: toBase64(sharedSecret),
      paired_at: Date.now(),
      last_seen_at: null,
    };

    // Mutate in-memory config + persist to disk.
    this.deps.config = addPairedPeer(this.deps.config, peer);
    try {
      await saveConfig(this.deps.configPath ?? CONFIG_FILE, this.deps.config);
    } catch { /* swallow — pair_ack still goes out, next restart will rebuild */ }

    // Hot-add to peers so envelopes from this phone start decrypting immediately.
    this.peers.push({ peer, sharedSecret, recentNonces: new Map() });

    if (this.ws) {
      this.ws.send(JSON.stringify({ type: "pair_ack", daemon_id: this.daemonId() }));
    }

    void this.deps.notifier?.notify({
      project: "miki-moni",
      message: `New device paired: ${peer.peer_name} (${peer_id.slice(0, 8)}…)`,
    });
  }

  private async handlePhoneRevoked(msg: any): Promise<void> {
    const signPk = typeof msg.phone_pubkey_b64 === "string" ? msg.phone_pubkey_b64 : "";
    if (!signPk) return;
    const before = this.deps.config.paired_peers.length;
    this.deps.config = {
      ...this.deps.config,
      paired_peers: this.deps.config.paired_peers.filter((p) => p.peer_sign_pubkey !== signPk),
    };
    if (this.deps.config.paired_peers.length === before) return;
    this.peers = this.peers.filter((p) => p.peer.peer_sign_pubkey !== signPk);
    try {
      await saveConfig(this.deps.configPath ?? CONFIG_FILE, this.deps.config);
    } catch { /* swallow */ }
    void this.deps.notifier?.notify({
      project: "miki-moni",
      message: `Device unpaired (${signPk.slice(0, 8)}…)`,
    });
  }

  private handleClose(): void {
    if (this.storeListener) {
      this.deps.store.off("session_changed", this.storeListener);
      this.storeListener = null;
    }
    this.ws = null;
    this.ready = false;
    if (this.stopRequested) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), wait);
  }

  private handleEnvelope(env: Envelope): void {
    // Freshness check
    if (typeof env.ts !== "number" || Math.abs(Date.now() - env.ts) > NONCE_FRESHNESS_MS) return;

    // Try each peer's secret until one decrypts. (Phone could send before identifying themselves.)
    for (const p of this.peers) {
      // Replay check
      if (p.recentNonces.has(env.nonce)) continue;
      const pt = decodeEnvelope(env, p.sharedSecret);
      if (!pt) continue;
      // Accept
      p.recentNonces.set(env.nonce, Date.now());
      this.pruneNonces(p);
      void this.dispatchPlaintext(pt, p);
      return;
    }
    // No peer could decrypt — drop silently
  }

  private pruneNonces(p: PeerSecrets): void {
    const cutoff = Date.now() - NONCE_FRESHNESS_MS;
    for (const [n, t] of p.recentNonces) {
      if (t < cutoff) p.recentNonces.delete(n);
    }
  }

  private resolveCmdSession(pt: { session_uuid?: string; cwd?: string }) {
    if (pt.session_uuid) return this.deps.store.get(pt.session_uuid);
    if (pt.cwd) return this.deps.store.getByCwd(pt.cwd)[0];
    return undefined;
  }

  private async dispatchPlaintext(pt: Plaintext, p: PeerSecrets): Promise<void> {
    switch (pt.kind) {
      case "cmd_focus": {
        const session = this.resolveCmdSession(pt);
        if (session) await this.deps.bridge.focus(session.session_uuid);
        return;
      }
      case "cmd_send": {
        const session = this.resolveCmdSession(pt);
        if (session) await this.deps.bridge.send(session.session_uuid, pt.prompt);
        return;
      }
      case "request_snapshot": {
        const snapshot = { kind: "state_snapshot" as const, sessions: this.deps.store.list() };
        this.sendToPeer(p, snapshot);
        return;
      }
      case "ping": {
        this.sendToPeer(p, { kind: "pong", echo: pt.echo });
        return;
      }
      case "http_proxy": {
        await this.handleHttpProxy(pt, p);
        return;
      }
      case "ws_proxy_open": {
        await this.handleWsProxyOpen(pt, p);
        return;
      }
      case "ws_proxy_send": {
        this.handleWsProxySend(pt, p);
        return;
      }
      case "ws_proxy_close": {
        this.handleWsProxyClose(pt, p);
        return;
      }
      default:
        return;  // ignore other kinds for now
    }
  }

  // ── Remote RPC tunnel ──────────────────────────────────────────────────────
  // server.ts is unchanged — these handlers re-issue calls against the same
  // localhost endpoints the local dashboard uses, then ship the response back
  // through the encrypted relay channel.

  private localPort(): number {
    if (this.deps.localHttpPort) return this.deps.localHttpPort;
    const env = Number(process.env.MIKI_LOCAL_PORT);
    if (Number.isFinite(env) && env > 0) return env;
    // Daemon writes the chosen port (8765 + n if taken) into ~/.miki-moni/port
    // at startup. Read it so the tunnel proxy hits whatever port the local
    // server is actually on, without needing env var configuration.
    try {
      const p = Number(readFileSync(PORT_FILE, "utf8").trim());
      if (Number.isFinite(p) && p > 0) return p;
    } catch { /* file may not exist yet during early startup */ }
    return DEFAULT_LOCAL_PORT;
  }

  private async handleHttpProxy(
    pt: Extract<Plaintext, { kind: "http_proxy" }>,
    p: PeerSecrets,
  ): Promise<void> {
    const url = `http://127.0.0.1:${this.localPort()}${pt.path}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), HTTP_PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: pt.method,
        headers: pt.headers ?? undefined,
        body: pt.body ?? undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      this.sendToPeer(p, {
        kind: "http_proxy_response",
        request_id: pt.request_id,
        status: res.status,
        headers,
        body: text,
      });
    } catch (err) {
      this.sendToPeer(p, {
        kind: "http_proxy_response",
        request_id: pt.request_id,
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `tunnel_error: ${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** tunnel_ws_id -> local WebSocket connection, scoped per peer. */
  private tunnelWsByPeer = new Map<string, Map<string, WebSocket>>();

  private peerTunnels(p: PeerSecrets): Map<string, WebSocket> {
    let m = this.tunnelWsByPeer.get(p.peer.peer_id);
    if (!m) { m = new Map(); this.tunnelWsByPeer.set(p.peer.peer_id, m); }
    return m;
  }

  private async handleWsProxyOpen(
    pt: Extract<Plaintext, { kind: "ws_proxy_open" }>,
    p: PeerSecrets,
  ): Promise<void> {
    const url = `ws://127.0.0.1:${this.localPort()}${pt.path}`;
    const localWs = new WebSocket(url);
    this.peerTunnels(p).set(pt.tunnel_ws_id, localWs);
    localWs.on("open", () => {
      this.sendToPeer(p, { kind: "ws_proxy_opened", tunnel_ws_id: pt.tunnel_ws_id });
    });
    localWs.on("message", (raw) => {
      this.sendToPeer(p, {
        kind: "ws_proxy_msg",
        tunnel_ws_id: pt.tunnel_ws_id,
        data: raw.toString(),
      });
    });
    localWs.on("close", (code, reason) => {
      this.peerTunnels(p).delete(pt.tunnel_ws_id);
      this.sendToPeer(p, {
        kind: "ws_proxy_close",
        tunnel_ws_id: pt.tunnel_ws_id,
        code, reason: reason?.toString() ?? "",
      });
    });
    localWs.on("error", (err) => {
      this.peerTunnels(p).delete(pt.tunnel_ws_id);
      this.sendToPeer(p, {
        kind: "ws_proxy_close",
        tunnel_ws_id: pt.tunnel_ws_id,
        code: 1011,
        reason: `tunnel_error: ${(err as Error).message}`,
      });
    });
  }

  private handleWsProxySend(
    pt: Extract<Plaintext, { kind: "ws_proxy_send" }>,
    p: PeerSecrets,
  ): void {
    const local = this.peerTunnels(p).get(pt.tunnel_ws_id);
    if (!local || local.readyState !== WebSocket.OPEN) return;
    local.send(pt.data, (_err) => { /* swallow */ });
  }

  private handleWsProxyClose(
    pt: Extract<Plaintext, { kind: "ws_proxy_close" }>,
    p: PeerSecrets,
  ): void {
    const local = this.peerTunnels(p).get(pt.tunnel_ws_id);
    if (!local) return;
    this.peerTunnels(p).delete(pt.tunnel_ws_id);
    try { local.close(pt.code ?? 1000, pt.reason ?? ""); } catch { /* ignore */ }
  }

  private broadcastEvent(session: Session): void {
    for (const p of this.peers) {
      this.sendToPeer(p, { kind: "event", session });
    }
  }

  private sendToPeer(p: PeerSecrets, msg: Plaintext): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const env = encodeEnvelope(msg, p.sharedSecret, `phone:${p.peer.peer_id}`);
    this.ws.send(JSON.stringify(env), (_err) => { /* swallow */ });
  }
}
