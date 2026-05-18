import WebSocket from "ws";
import { fromBase64, toBase64, sign as signMsg, deriveSharedSecret } from "./crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "./relay-protocol.js";
import { addPairedPeer, saveConfig, touchPeerLastSeen, type Config, type PairedPeer } from "./config.js";
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

// CF Workers' edge enforces a 100s idle WebSocket timeout on the Free/Pro
// plan. The peer-ping the daemon exchanges with paired phones doesn't help
// here — it's tunnelled inside encrypted envelopes that the worker never
// inspects, so from CF's perspective the underlying connection is idle.
// Send an app-level JSON keepalive directly to the relay every 50s; the DO
// short-circuits these without broadcasting (worker/src/daemon-relay.ts).
const KEEPALIVE_INTERVAL_MS = 50_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private storeListener: ((s: Session) => void) | null = null;
  private peers: PeerSecrets[] = [];
  private ready = false;
  private keepaliveTimer: NodeJS.Timeout | null = null;

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
    this.stopKeepalive();
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
        this.startKeepalive();
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

    // ── Optional approval gate ────────────────────────────────────────────
    // Persistent pair tokens are bearer credentials — anyone with the QR can
    // pair forever (the token never invalidates on use). For security-conscious
    // operators, MIKI_PAIR_REQUIRE_APPROVAL=1 makes every NEW pair require
    // explicit approval before persistence. Approval channel today: a TTY
    // y/N prompt in the daemon's console; if stdin isn't a TTY we deny (the
    // daemon was probably launched detached, no human to ask).
    //
    // Default off keeps the current zero-friction UX. Pair via QR remains the
    // happy path; this is opt-in for shared workstations / kiosks.
    if (process.env.MIKI_PAIR_REQUIRE_APPROVAL === "1") {
      const peerName = typeof msg.phone_name === "string" ? msg.phone_name : "phone";
      const approved = await this.promptForPairApproval(peerName, peer_id);
      if (!approved) {
        if (this.ws) {
          this.ws.send(JSON.stringify({ type: "pair_nack", error: "denied_by_operator" }));
        }
        // eslint-disable-next-line no-console
        console.warn(`[relay] denied pair from ${peerName} (id=${peer_id.slice(0, 8)}…)`);
        return;
      }
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

    // PERSIST FIRST, then ACK. The previous order swallowed save errors and
    // ACKed anyway — leaving in-memory peers + a happy phone, but next daemon
    // restart had no record of this peer (paired_peers IS the source of
    // truth; there's no rebuild path) → phone reconnects, daemon can't
    // decrypt anything, phone sees a silent stale-tunnel error.
    const prevConfig = this.deps.config;
    const nextConfig = addPairedPeer(this.deps.config, peer);
    this.deps.config = nextConfig;
    try {
      await saveConfig(this.deps.configPath ?? CONFIG_FILE, nextConfig);
    } catch (err) {
      // Rollback in-memory mutation so the daemon's state stays consistent
      // with disk. Tell the phone we couldn't pair so it doesn't think it's
      // bound, and notify the user (disk full / perms are operator-level
      // failures that deserve a notification, not a silent log line).
      this.deps.config = prevConfig;
      if (this.ws) {
        this.ws.send(JSON.stringify({ type: "pair_nack", error: "persist_failed", detail: String(err).slice(0, 200) }));
      }
      void this.deps.notifier?.notify({
        project: "miki-moni",
        message: `Pair failed: couldn't save peer to config.json (${String(err).slice(0, 80)}).`,
      });
      return;
    }

    // Persisted — now we can safely hot-add and ACK.
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
    this.stopKeepalive();
    this.ws = null;
    this.ready = false;
    if (this.stopRequested) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), wait);
  }

  /** Periodic JSON keepalive — defeats CF's 100s idle-WS timeout. The DO
   *  short-circuits messages of type "keepalive" without broadcasting, so
   *  this costs one billable request every 50s (~52k/month per daemon,
   *  well under the free-tier 100k/day per worker). */
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.send(JSON.stringify({ type: "keepalive" })); } catch { /* */ }
    }, KEEPALIVE_INTERVAL_MS);
    // unref so the timer doesn't pin the event loop open for shutdown
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
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
      // Record liveness so the LRU prune in addPairedPeer can tell active
      // devices from orphaned PWA installs. Fire-and-forget — we only need
      // approximate timestamps, not every envelope.
      this.touchPeerSeen(p.peer.peer_id);
      void this.dispatchPlaintext(pt, p);
      return;
    }
    // No peer could decrypt — drop silently
  }

  // Throttle: only persist last_seen_at to disk once per peer per minute.
  // Decryption is hot (every keystroke from phone) but disk cadence is fine.
  private lastSeenStampedAt = new Map<string, number>();
  private static readonly LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

  private touchPeerSeen(peerId: string): void {
    const now = Date.now();
    const last = this.lastSeenStampedAt.get(peerId) ?? 0;
    if (now - last < RelayClient.LAST_SEEN_PERSIST_INTERVAL_MS) return;
    this.lastSeenStampedAt.set(peerId, now);
    // Mutate in-memory config + persist async. Failures here are non-fatal.
    const next = touchPeerLastSeen(this.deps.config, peerId, now);
    if (!next) return;
    (this.deps as { config: Config }).config = next;
    void saveConfig(this.deps.configPath ?? CONFIG_FILE, next).catch((err) => {
      // Stale stamp on disk is harmless; just log so we know if disk is sad.
      // eslint-disable-next-line no-console
      console.warn(`[relay] touchPeerLastSeen save failed: ${String(err)}`);
    });
  }

  /**
   * Block until the operator approves or denies a new pair, or timeout (60s)
   * elapses (auto-deny). Used only when MIKI_PAIR_REQUIRE_APPROVAL=1. Returns
   * true iff the user explicitly typed "y" or "yes" at the daemon's TTY.
   *
   * Non-TTY launch (detached daemon, systemd) → auto-deny: there's no human
   * to ask, and silently auto-accepting would defeat the whole point of the
   * opt-in. Users running this mode should keep the daemon foregrounded.
   */
  private async promptForPairApproval(peerName: string, peerId: string): Promise<boolean> {
    if (!process.stdin.isTTY) {
      // eslint-disable-next-line no-console
      console.warn(`[relay] MIKI_PAIR_REQUIRE_APPROVAL=1 but stdin is not a TTY — auto-denying pair from ${peerName} (${peerId.slice(0, 8)}…)`);
      return false;
    }
    // eslint-disable-next-line no-console
    console.log(`\n[approval] Pair request from "${peerName}" (peer id=${peerId.slice(0, 8)}…). Approve? [y/N]`);
    void this.deps.notifier?.notify({
      project: "miki-moni",
      message: `Pair request from ${peerName} — approve in the daemon terminal.`,
    });
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        process.stdin.off("data", onData);
        // eslint-disable-next-line no-console
        console.log("[approval] timed out (60s) — denying.");
        resolve(false);
      }, 60_000);
      const onData = (buf: Buffer) => {
        const ans = buf.toString().trim().toLowerCase();
        clearTimeout(timer);
        process.stdin.off("data", onData);
        resolve(ans === "y" || ans === "yes");
      };
      process.stdin.on("data", onData);
    });
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
