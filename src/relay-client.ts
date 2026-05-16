import WebSocket from "ws";
import { fromBase64 } from "./crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "./relay-protocol.js";
import type { Config, PairedPeer } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Session } from "./types.js";

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

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private storeListener: ((s: Session) => void) | null = null;
  private peers: PeerSecrets[] = [];

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

  private connect(): void {
    const remote = this.deps.config.remote!;
    const headers: Record<string, string> = {
      "X-Daemon-Auth": remote.x_daemon_auth_token,
      "X-Daemon-Id": this.peerSelfId(),
    };
    const ws = new WebSocket(remote.worker_url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectMs = RECONNECT_INITIAL_MS;
      // Subscribe to store changes after we're connected
      this.storeListener = (session: Session) => this.broadcastEvent(session);
      this.deps.store.on("session_changed", this.storeListener);
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => { /* swallow; close handler reconnects */ });
  }

  private handleClose(): void {
    if (this.storeListener) {
      this.deps.store.off("session_changed", this.storeListener);
      this.storeListener = null;
    }
    this.ws = null;
    if (this.stopRequested) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), wait);
  }

  private handleMessage(raw: string): void {
    let env: Envelope;
    try { env = JSON.parse(raw); } catch { return; }
    if (typeof env !== "object" || env === null) return;

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

  private async dispatchPlaintext(pt: Plaintext, p: PeerSecrets): Promise<void> {
    switch (pt.kind) {
      case "cmd_focus": {
        const session = this.deps.store.get(pt.cwd);
        if (session) await this.deps.bridge.focus(session.session_uuid);
        return;
      }
      case "cmd_send": {
        const session = this.deps.store.get(pt.cwd);
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

  private peerSelfId(): string {
    // Stable derivation from daemon pubkey
    return this.deps.config.device.pubkey.replace(/[+/=]/g, "").slice(0, 16);
  }
}
