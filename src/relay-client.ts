import WebSocket from "ws";
import { fromBase64, toBase64, sign as signMsg } from "./crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "./relay-protocol.js";
import type { Config, PairedPeer } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Session } from "./types.js";
import { createHash } from "node:crypto";

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const NONCE_FRESHNESS_MS = 60_000;

export interface RelayClientDeps {
  config: Config;
  store: SessionStore;
  bridge: VscodeBridge;
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

    // Legacy: envelopes sent without a wrapper type field (current relay sends plain Envelope objects)
    if (typeof msg.ts === "number" && typeof msg.nonce === "string") {
      this.handleEnvelope(msg as Envelope);
    }
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
      default:
        return;  // ignore other kinds for now
    }
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
