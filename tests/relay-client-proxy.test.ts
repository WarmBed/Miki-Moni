/**
 * Tests for RelayClient http_proxy + ws_proxy handlers (remote RPC tunnel).
 *
 * We spin up a real local HTTP/WS server (echoes paths back) to verify the
 * RelayClient forwards requests/responses correctly, then poke the daemon
 * directly by feeding decrypted plaintexts into its dispatch path.
 *
 * The mocked relay WS captures outbound envelopes so we can decrypt + assert
 * the response shape without standing up a real CF Worker.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { AddressInfo } from "node:net";
import { RelayClient } from "../src/relay-client.js";
import { encodeEnvelope, decodeEnvelope, type Plaintext, type Envelope } from "../src/relay-protocol.js";
import { generateKeypair, generateSigningKeypair, toBase64, fromBase64, deriveSharedSecret } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import type { VscodeBridge } from "../src/vscode-bridge.js";
import type { Config, PairedPeer } from "../src/config.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let localServer: http.Server;
let localPort: number;
let localWss: WebSocketServer;

function makeStubBridge(): VscodeBridge {
  return {
    focus: async () => {},
    send: async () => {},
  } as unknown as VscodeBridge;
}

function makeStore(): SessionStore {
  const tmp = path.join(os.tmpdir(), `miki-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  return new SessionStore(tmp);
}

function makeConfigWithOnePeer(): { cfg: Config; peer: PairedPeer; phoneEncPriv: Uint8Array; sharedSecret: Uint8Array } {
  const daemonBox = generateKeypair();
  const daemonSign = generateSigningKeypair();
  const phoneBox = generateKeypair();
  const sharedSecret = deriveSharedSecret(daemonBox.privkey, phoneBox.pubkey);
  const peer: PairedPeer = {
    peer_id: "TESTPEER123ABCDE",
    peer_name: "test-phone",
    peer_pubkey: toBase64(phoneBox.pubkey),
    shared_secret: toBase64(sharedSecret),
    paired_at: Date.now(),
    last_seen_at: null,
  };
  const cfg: Config = {
    device: {
      name: "test-daemon",
      pubkey: toBase64(daemonBox.pubkey),
      privkey: toBase64(daemonBox.privkey),
      signing_pubkey: toBase64(daemonSign.pubkey),
      signing_privkey: toBase64(daemonSign.privkey),
      created_at: Date.now(),
    },
    remote: { worker_url: "ws://localhost:0" },  // not used in these unit tests
    paired_peers: [peer],
  };
  return { cfg, peer, phoneEncPriv: phoneBox.privkey, sharedSecret };
}

beforeAll(async () => {
  localServer = http.createServer((req, res) => {
    if (req.url === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ session_uuid: "abc", cwd: "/x", project_name: "x" }]));
      return;
    }
    if (req.url === "/error500") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    if (req.url === "/echo-method") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.method);
      return;
    }
    res.writeHead(404).end("not_found");
  });
  localWss = new WebSocketServer({ noServer: true });
  localServer.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      localWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (raw) => ws.send("echo:" + raw.toString()));
      });
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  localPort = (localServer.address() as AddressInfo).port;
});

afterAll(async () => {
  // Force-close any lingering WS clients so the HTTP server can shut down cleanly.
  for (const c of localWss.clients) { try { c.terminate(); } catch { /* */ } }
  await new Promise<void>((resolve) => localWss.close(() => resolve()));
  await new Promise<void>((resolve) => {
    localServer.closeAllConnections?.();  // Node 18+
    localServer.close(() => resolve());
  });
});

describe("RelayClient — http_proxy handler", () => {
  let store: SessionStore;
  let outbound: Envelope[];
  let client: any;  // RelayClient with private members poked

  beforeEach(() => {
    store = makeStore();
    outbound = [];
    const { cfg } = makeConfigWithOnePeer();
    client = new RelayClient({ config: cfg, store, bridge: makeStubBridge(), localHttpPort: localPort });
    // Inject a stub WS so sendToPeer captures outbound envelopes.
    (client as any).ws = {
      readyState: 1,  // WebSocket.OPEN
      send: (data: string) => { outbound.push(JSON.parse(data)); },
    };
  });

  afterEach(() => store.close());

  async function send(pt: Plaintext, secret: Uint8Array, peer: PairedPeer): Promise<void> {
    // Feed straight into dispatchPlaintext to bypass nonce/freshness checks.
    const p = { peer, sharedSecret: secret, recentNonces: new Map() };
    await (client as any).dispatchPlaintext(pt, p);
  }

  it("GET /sessions tunnels through to localhost and returns 200 JSON", async () => {
    const { peer, sharedSecret } = makeConfigWithOnePeer();
    await send({
      kind: "http_proxy",
      request_id: "r1",
      method: "GET",
      path: "/sessions",
    }, sharedSecret, peer);

    expect(outbound).toHaveLength(1);
    const env = outbound[0]!;
    expect(env.to).toBe(`phone:${peer.peer_id}`);
    const pt = decodeEnvelope(env, sharedSecret) as any;
    expect(pt.kind).toBe("http_proxy_response");
    expect(pt.request_id).toBe("r1");
    expect(pt.status).toBe(200);
    expect(JSON.parse(pt.body)[0].session_uuid).toBe("abc");
  });

  it("preserves 500 status from upstream", async () => {
    const { peer, sharedSecret } = makeConfigWithOnePeer();
    await send({ kind: "http_proxy", request_id: "r2", method: "GET", path: "/error500" },
      sharedSecret, peer);
    const pt = decodeEnvelope(outbound[0]!, sharedSecret) as any;
    expect(pt.status).toBe(500);
    expect(pt.body).toBe("boom");
  });

  it("POSTs the method through", async () => {
    const { peer, sharedSecret } = makeConfigWithOnePeer();
    await send({ kind: "http_proxy", request_id: "r3", method: "POST", path: "/echo-method",
      headers: { "content-type": "application/json" }, body: '{"x":1}' },
      sharedSecret, peer);
    const pt = decodeEnvelope(outbound[0]!, sharedSecret) as any;
    expect(pt.body).toBe("POST");
  });

  it("returns 502 when localhost is unreachable", async () => {
    const { cfg, peer, sharedSecret } = makeConfigWithOnePeer();
    const badClient: any = new RelayClient({
      config: cfg, store, bridge: makeStubBridge(),
      localHttpPort: 1,  // unlikely to have anything listening
    });
    const badOut: Envelope[] = [];
    badClient.ws = { readyState: 1, send: (d: string) => { badOut.push(JSON.parse(d)); } };
    const p = { peer, sharedSecret, recentNonces: new Map() };
    await badClient.dispatchPlaintext(
      { kind: "http_proxy", request_id: "rX", method: "GET", path: "/sessions" },
      p,
    );
    const pt = decodeEnvelope(badOut[0]!, sharedSecret) as any;
    expect(pt.status).toBe(502);
    expect(pt.body).toContain("tunnel_error");
  });
});

describe("RelayClient — ws_proxy handlers", () => {
  let store: SessionStore;
  let outbound: Envelope[];
  let client: any;

  beforeEach(() => {
    store = makeStore();
    outbound = [];
    const { cfg } = makeConfigWithOnePeer();
    client = new RelayClient({ config: cfg, store, bridge: makeStubBridge(), localHttpPort: localPort });
    (client as any).ws = { readyState: 1, send: (data: string) => { outbound.push(JSON.parse(data)); } };
  });

  afterEach(() => store.close());

  async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate() && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!predicate()) throw new Error("waitFor timed out");
  }

  it("ws_proxy_open opens a local WS, ws_proxy_send round-trips, server reply forwarded as ws_proxy_msg", async () => {
    const { peer, sharedSecret } = makeConfigWithOnePeer();
    const p = { peer, sharedSecret, recentNonces: new Map() };

    await (client as any).dispatchPlaintext(
      { kind: "ws_proxy_open", tunnel_ws_id: "t1", path: "/ws" }, p,
    );

    // Wait for "opened" ack
    await waitFor(() => outbound.some((e) => {
      const pt = decodeEnvelope(e, sharedSecret) as any;
      return pt?.kind === "ws_proxy_opened" && pt.tunnel_ws_id === "t1";
    }));

    // Client sends data → server echoes
    await (client as any).dispatchPlaintext(
      { kind: "ws_proxy_send", tunnel_ws_id: "t1", data: "hello" }, p,
    );
    await waitFor(() => outbound.some((e) => {
      const pt = decodeEnvelope(e, sharedSecret) as any;
      return pt?.kind === "ws_proxy_msg" && pt.data === "echo:hello";
    }));
  });

  it("ws_proxy_close closes the local WS and is idempotent", async () => {
    const { peer, sharedSecret } = makeConfigWithOnePeer();
    const p = { peer, sharedSecret, recentNonces: new Map() };
    await (client as any).dispatchPlaintext(
      { kind: "ws_proxy_open", tunnel_ws_id: "t2", path: "/ws" }, p,
    );
    await waitFor(() => outbound.some((e) => {
      const pt = decodeEnvelope(e, sharedSecret) as any;
      return pt?.kind === "ws_proxy_opened";
    }));

    await (client as any).dispatchPlaintext(
      { kind: "ws_proxy_close", tunnel_ws_id: "t2", code: 1000, reason: "bye" }, p,
    );
    // Second close: no throw
    await (client as any).dispatchPlaintext(
      { kind: "ws_proxy_close", tunnel_ws_id: "t2" }, p,
    );
  });
});
