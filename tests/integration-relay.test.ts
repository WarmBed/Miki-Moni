import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import nacl from "tweetnacl";
import { generateKeypair, generateSigningKeypair, deriveSharedSecret, toBase64 } from "../src/crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope } from "../src/relay-protocol.js";
import { SessionStore } from "../src/session-store.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import { RelayClient } from "../src/relay-client.js";
import type { Config, PairedPeer } from "../src/config.js";

describe("daemon <-> mock-Worker <-> phone integration", () => {
  let wss: WebSocketServer;
  let port: number;
  let daemonConn: WebSocket | null = null;
  let phoneConn: WebSocket | null = null;

  beforeEach(async () => {
    daemonConn = null;
    phoneConn = null;
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    port = (wss.address() as any).port;
    wss.on("connection", (ws, req) => {
      const url = req.url || "";
      if (url.startsWith("/v1/daemon")) {
        daemonConn = ws;
        // Perform challenge-response handshake before relaying
        const nonce = nacl.randomBytes(32);
        const issued_at_ms = Date.now();
        ws.send(JSON.stringify({ type: "challenge", nonce: toBase64(nonce), issued_at_ms }));
        ws.once("message", (raw: any) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "challenge_response") {
            ws.send(JSON.stringify({ type: "ready", daemon_id: "test-id" }));
          }
          // After handshake, relay subsequent messages to phone
          ws.on("message", (data) => phoneConn?.send(data));
        });
      } else if (url.startsWith("/v1/phone")) {
        phoneConn = ws;
        ws.on("message", (raw) => daemonConn?.send(raw));
      }
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("daemon broadcasts session_changed; phone decrypts; phone sends cmd_focus; daemon executes", async () => {
    const daemonKp = generateKeypair();
    const daemonSign = generateSigningKeypair();
    const phoneKp = generateKeypair();
    const shared = deriveSharedSecret(daemonKp.privkey, phoneKp.pubkey);

    const peer: PairedPeer = {
      peer_id: "peer1",
      peer_name: "iPhone",
      peer_pubkey: toBase64(phoneKp.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0,
      last_seen_at: null,
    };
    const cfg: Config = {
      device: {
        name: "test",
        pubkey: toBase64(daemonKp.pubkey),
        privkey: toBase64(daemonKp.privkey),
        signing_pubkey: toBase64(daemonSign.pubkey),
        signing_privkey: toBase64(daemonSign.privkey),
        created_at: 0,
      },
      remote: {
        worker_url: `ws://127.0.0.1:${port}/v1/daemon`,
      },
      paired_peers: [peer],
    };

    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\target",
      session_uuid: "uuid-target",
      agent: "claude",
      project_name: "target",
      status: "waiting",
      last_event_at: 1,
      last_message_preview: "",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });

    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => {
      launches.push(url);
    });

    const client = new RelayClient({ config: cfg, store, bridge });
    await client.start();
    await new Promise((r) => setTimeout(r, 150));  // allow time for challenge-response handshake

    // Phone connects and listens for events
    const phoneEvents: any[] = [];
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/phone`);
    await new Promise<void>((r) => phone.on("open", () => r()));
    phone.on("message", (raw) => {
      try {
        const env = JSON.parse(raw.toString()) as Envelope;
        const pt = decodeEnvelope(env, shared);
        if (pt) phoneEvents.push(pt);
      } catch {
        // Ignore parse errors
      }
    });

    // Daemon emits a session_changed → phone should receive an encrypted event
    store.upsert({
      cwd: "d:\\code\\new",
      session_uuid: "u-new",
      agent: "claude",
      project_name: "new",
      status: "active",
      last_event_at: Date.now(),
      last_message_preview: "",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(phoneEvents.some((pt) => pt.kind === "event" && pt.session?.cwd === "d:\\code\\new")).toBe(true);

    // Phone sends cmd_focus → daemon should call bridge.focus
    const cmdEnv = encodeEnvelope({ kind: "cmd_focus", cwd: "d:\\code\\target" }, shared, "daemon");
    phone.send(JSON.stringify(cmdEnv));
    await new Promise((r) => setTimeout(r, 100));
    expect(launches).toContain("vscode://anthropic.claude-code/open?session=uuid-target");

    phone.close();
    await client.stop();
    store.close();
  });
});
