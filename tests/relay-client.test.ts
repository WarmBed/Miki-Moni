import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import nacl from "tweetnacl";
import { generateKeypair, generateSigningKeypair, deriveSharedSecret, toBase64, fromBase64 } from "../src/crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "../src/relay-protocol.js";
import { SessionStore } from "../src/session-store.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import { RelayClient } from "../src/relay-client.js";
import type { Config, PairedPeer } from "../src/config.js";

function makeConfig(daemonPubkey: string, daemonPrivkey: string, peer: PairedPeer, workerUrl: string, signingKeypair?: { pubkey: Uint8Array; privkey: Uint8Array }): Config {
  const sign = signingKeypair ?? generateSigningKeypair();
  return {
    device: {
      name: "test",
      pubkey: daemonPubkey,
      privkey: daemonPrivkey,
      signing_pubkey: toBase64(sign.pubkey),
      signing_privkey: toBase64(sign.privkey),
      created_at: 0,
    },
    remote: { worker_url: workerUrl },
    paired_peers: [peer],
  };
}

/** Helper: attach a challenge-response handshake to a WebSocket server connection. */
function attachHandshake(ws: import("ws").WebSocket): void {
  const nonce = nacl.randomBytes(32);
  const issued_at_ms = Date.now();
  ws.send(JSON.stringify({ type: "challenge", nonce: toBase64(nonce), issued_at_ms }));
  ws.once("message", (raw: any) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "challenge_response") {
      ws.send(JSON.stringify({ type: "ready", daemon_id: "test-id" }));
    }
  });
}

describe("RelayClient", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverReceived: Envelope[] = [];
  let serverConn: import("ws").WebSocket | null = null;

  beforeEach(async () => {
    serverReceived = [];
    serverConn = null;
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    port = (wss.address() as any).port;
    wss.on("connection", (ws) => {
      serverConn = ws;
      attachHandshake(ws);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        // Skip handshake messages from the recording
        if (msg.type === "challenge_response") return;
        serverReceived.push(msg as Envelope);
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("connects to worker and survives a session_changed by sending an encrypted envelope per peer", async () => {
    const daemon = generateKeypair();
    const phone = generateKeypair();
    const shared = deriveSharedSecret(daemon.privkey, phone.pubkey);
    const peer: PairedPeer = {
      peer_id: "peer1",
      peer_name: "iPhone",
      peer_pubkey: toBase64(phone.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0,
      last_seen_at: null,
    };
    const cfg = makeConfig(toBase64(daemon.pubkey), toBase64(daemon.privkey), peer, `ws://127.0.0.1:${port}/v1/daemon`);

    const store = new SessionStore(":memory:");
    const bridge = new VscodeBridge(async () => { /* no-op */ });
    const client = new RelayClient({ config: cfg, store, bridge });

    await client.start();
    await new Promise((r) => setTimeout(r, 50));  // let WS open

    store.upsert({
      agent: "claude",
      cwd: "d:\\code\\x", session_uuid: "u", project_name: "x",
      status: "active", last_event_at: Date.now(),
      last_message_preview: "", tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(serverReceived.length).toBeGreaterThanOrEqual(1);
    const env = serverReceived[serverReceived.length - 1]!;
    expect(env.to).toBe("phone:peer1");
    const pt = decodeEnvelope(env, shared);
    expect(pt?.kind).toBe("event");

    await client.stop();
    store.close();
  });

  it("decrypts cmd_focus and calls bridge.focus with peer's session_uuid", async () => {
    const daemon = generateKeypair();
    const phone = generateKeypair();
    const shared = deriveSharedSecret(daemon.privkey, phone.pubkey);
    const peer: PairedPeer = {
      peer_id: "peer1",
      peer_name: "iPhone",
      peer_pubkey: toBase64(phone.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0,
      last_seen_at: null,
    };
    const cfg = makeConfig(toBase64(daemon.pubkey), toBase64(daemon.privkey), peer, `ws://127.0.0.1:${port}/v1/daemon`);

    const store = new SessionStore(":memory:");
    store.upsert({
      agent: "claude",
      cwd: "d:\\code\\target", session_uuid: "uuid-target", project_name: "target",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const client = new RelayClient({ config: cfg, store, bridge });

    await client.start();
    await new Promise((r) => setTimeout(r, 50));

    const cmdEnv = encodeEnvelope({ kind: "cmd_focus", cwd: "d:\\code\\target" }, shared, "daemon");
    serverConn!.send(JSON.stringify(cmdEnv));
    await new Promise((r) => setTimeout(r, 50));

    expect(launches).toContain("vscode://anthropic.claude-code/open?session=uuid-target");

    await client.stop();
    store.close();
  });

  it("drops messages that fail to decrypt (wrong key) without crashing", async () => {
    const daemon = generateKeypair();
    const phone = generateKeypair();
    const someoneElse = generateKeypair();
    const shared = deriveSharedSecret(daemon.privkey, phone.pubkey);
    const wrongShared = deriveSharedSecret(daemon.privkey, someoneElse.pubkey);
    const peer: PairedPeer = {
      peer_id: "peer1", peer_name: "iPhone",
      peer_pubkey: toBase64(phone.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0, last_seen_at: null,
    };
    const cfg = makeConfig(toBase64(daemon.pubkey), toBase64(daemon.privkey), peer, `ws://127.0.0.1:${port}/v1/daemon`);
    const store = new SessionStore(":memory:");
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const client = new RelayClient({ config: cfg, store, bridge });
    await client.start();
    await new Promise((r) => setTimeout(r, 50));

    const badEnv = encodeEnvelope({ kind: "cmd_focus", cwd: "x" }, wrongShared, "daemon");
    serverConn!.send(JSON.stringify(badEnv));
    await new Promise((r) => setTimeout(r, 50));

    expect(launches).toEqual([]);  // unaffected
    await client.stop();
    store.close();
  });
});

describe("RelayClient new challenge-response handshake", () => {
  it("completes challenge-response and reaches ready state", async () => {
    const sign = generateSigningKeypair();
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as any).port;

    let readyReached = false;
    wss.on("connection", (ws, req) => {
      const pubkeyHdr = req.headers["x-daemon-pubkey"] as string;
      expect(pubkeyHdr).toBe(toBase64(sign.pubkey));

      // Send challenge
      const nonce = nacl.randomBytes(32);
      const issued_at_ms = Date.now();
      ws.send(JSON.stringify({ type: "challenge", nonce: toBase64(nonce), issued_at_ms }));

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge_response") {
          const sig = fromBase64(msg.sig);
          // Build the signed message: nonce (32B) ++ issued_at_ms (8B big-endian)
          const sigMsg = new Uint8Array(40);
          sigMsg.set(nonce, 0);
          new DataView(sigMsg.buffer, 32, 8).setBigUint64(0, BigInt(issued_at_ms), false);
          const ok = nacl.sign.detached.verify(sigMsg, sig, sign.pubkey);
          expect(ok).toBe(true);
          ws.send(JSON.stringify({ type: "ready", daemon_id: "test-id" }));
          readyReached = true;
        }
      });
    });

    const config: any = {
      device: {
        name: "t",
        pubkey: "x", privkey: "x",
        signing_pubkey: toBase64(sign.pubkey),
        signing_privkey: toBase64(sign.privkey),
        created_at: 1,
      },
      remote: { worker_url: `ws://127.0.0.1:${port}` },
      paired_peers: [],
    };
    const client = new RelayClient({
      config,
      store: { on: () => {}, off: () => {} } as any,
      bridge: {} as any,
    });
    await client.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(readyReached).toBe(true);
    await client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does NOT send X-Daemon-Auth header", async () => {
    const sign = generateSigningKeypair();
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as any).port;

    let authHeaderSeen: string | undefined;
    wss.on("connection", (_ws, req) => {
      authHeaderSeen = req.headers["x-daemon-auth"] as string | undefined;
      // Don't bother completing handshake — just check headers
    });

    const config: any = {
      device: {
        name: "t", pubkey: "x", privkey: "x",
        signing_pubkey: toBase64(sign.pubkey),
        signing_privkey: toBase64(sign.privkey),
        created_at: 1,
      },
      remote: { worker_url: `ws://127.0.0.1:${port}` },
      paired_peers: [],
    };
    const client = new RelayClient({
      config,
      store: { on: () => {}, off: () => {} } as any,
      bridge: {} as any,
    });
    await client.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(authHeaderSeen).toBeUndefined();
    await client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});
