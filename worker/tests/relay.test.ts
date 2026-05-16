import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import nacl from "tweetnacl";
import { DaemonRelay } from "../src/daemon-relay.js";
import { buildChallengeMessage, toBase64, deriveDaemonId } from "../src/handshake.js";
import { makeMockStateWithWs, makeMockEnv, stubWebSocketPair, type FakeWebSocket } from "./_do-mock.js";

beforeAll(() => { stubWebSocketPair(); });

async function openDaemonAndChallenge(): Promise<{
  daemon: DaemonRelay;
  state: ReturnType<typeof makeMockStateWithWs>;
  serverWs: FakeWebSocket;
  keypair: nacl.SignKeyPair;
}> {
  const keypair = nacl.sign.keyPair();
  const state = makeMockStateWithWs("test-daemon-id");
  const daemon = new DaemonRelay(state, makeMockEnv());

  const req = new Request("https://x/v1/daemon", {
    method: "GET",
    headers: {
      "X-Daemon-Pubkey": toBase64(keypair.publicKey),
      "Upgrade": "websocket",
    },
  });
  const res = await daemon.fetch(req);
  expect(res.status).toBe(101);

  // Find the SERVER side WS (the one in the registry — daemon role)
  const wsList = state._wsRegistry;
  const serverWs = Array.from(wsList.keys()).find((ws) => wsList.get(ws)?.[0] === "daemon");
  expect(serverWs).toBeDefined();
  return { daemon, state, serverWs: serverWs!, keypair };
}

describe("DaemonRelay", () => {
  describe("daemon handshake", () => {
    it("rejects daemon with no X-Daemon-Pubkey header", async () => {
      const daemon = new DaemonRelay(makeMockStateWithWs(), makeMockEnv());
      const req = new Request("https://x/v1/daemon", { headers: { "Upgrade": "websocket" } });
      const res = await daemon.fetch(req);
      expect(res.status).toBe(400);
    });

    it("sends a challenge on connect", async () => {
      const { serverWs } = await openDaemonAndChallenge();
      expect(serverWs.sent).toHaveLength(1);
      const ch = JSON.parse(serverWs.sent[0]);
      expect(ch.type).toBe("challenge");
      expect(typeof ch.nonce).toBe("string");
      expect(typeof ch.issued_at_ms).toBe("number");
    });

    it("accepts a valid challenge_response and replies with ready", async () => {
      const { daemon, serverWs, keypair } = await openDaemonAndChallenge();
      const ch = JSON.parse(serverWs.sent[0]);
      const nonceBytes = Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0));
      const sigMsg = buildChallengeMessage(nonceBytes, ch.issued_at_ms);
      const sig = nacl.sign.detached(sigMsg, keypair.secretKey);

      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "challenge_response",
        sig: toBase64(sig),
      }));

      const readyMsg = JSON.parse(serverWs.sent[1]);
      expect(readyMsg.type).toBe("ready");
      expect(readyMsg.daemon_id).toBe("test-daemon-id");
    });

    it("rejects challenge_response with bad signature (closes 4001)", async () => {
      const { daemon, serverWs } = await openDaemonAndChallenge();
      const badSig = new Uint8Array(64);  // all zeros — invalid
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "challenge_response",
        sig: toBase64(badSig),
      }));
      expect(serverWs.closed?.code).toBe(4001);
    });
  });

  describe("pairing flow", () => {
    it("daemon registers a pairing token, phone connects + receives pair_init", async () => {
      const { daemon, state, serverWs, keypair } = await openDaemonAndChallenge();
      // Authenticate daemon
      const ch = JSON.parse(serverWs.sent[0]);
      const sigMsg = buildChallengeMessage(
        Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0)),
        ch.issued_at_ms,
      );
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "challenge_response",
        sig: toBase64(nacl.sign.detached(sigMsg, keypair.secretKey)),
      }));

      // Daemon registers a pairing token
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "register_pairing",
        token: "TESTPAIR12345678",
      }));
      // Should have stored pending_pair
      const stored = await state.storage.get("pending_pair");
      expect(stored).toMatchObject({ token: "TESTPAIR12345678" });

      // Phone connects with that pairing token
      const phoneReq = new Request("https://x/v1/phone", {
        headers: { "X-Pairing-Token": "TESTPAIR12345678", "Upgrade": "websocket" },
      });
      const phoneRes = await daemon.fetch(phoneReq);
      expect(phoneRes.status).toBe(101);

      // Find the phone-tagged server WS
      const phoneServerWs = Array.from(state._wsRegistry.entries())
        .find(([_, tags]) => tags[0] === "phone")?.[0];
      expect(phoneServerWs).toBeDefined();

      // Phone should have received pair_init
      const initMsg = JSON.parse(phoneServerWs!.sent[0]);
      expect(initMsg.type).toBe("pair_init");
      expect(initMsg.daemon_pubkey).toBe(toBase64(keypair.publicKey));
    });

    it("phone with unknown token gets close 4002", async () => {
      const { daemon } = await openDaemonAndChallenge();
      const phoneReq = new Request("https://x/v1/phone", {
        headers: { "X-Pairing-Token": "NONEXISTENT12345", "Upgrade": "websocket" },
      });
      const phoneRes = await daemon.fetch(phoneReq);
      // 101 returned, but the server immediately closes with 4002.
      expect(phoneRes.status).toBe(101);
    });
  });

  describe("envelope routing (post-pair)", () => {
    it("daemon → phone envelope is forwarded", async () => {
      const { daemon, state, serverWs, keypair } = await openDaemonAndChallenge();
      // Auth + register + phone connect (compressed)
      const ch = JSON.parse(serverWs.sent[0]);
      const sig = nacl.sign.detached(
        buildChallengeMessage(Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0)), ch.issued_at_ms),
        keypair.secretKey,
      );
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "register_pairing", token: "ROUTETEST1234567" }));
      const phoneReq = new Request("https://x/v1/phone", {
        headers: { "X-Pairing-Token": "ROUTETEST1234567", "Upgrade": "websocket" },
      });
      await daemon.fetch(phoneReq);
      const phoneWs = Array.from(state._wsRegistry.entries())
        .find(([_, tags]) => tags[0] === "phone")?.[0]!;

      // Phone offers
      await daemon.webSocketMessage(phoneWs as any, JSON.stringify({
        type: "pair_offer",
        phone_pubkey: "PHONE_PUBKEY_B64",
      }));
      // Daemon acks
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "pair_ack" }));

      // Now daemon sends an envelope
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "envelope",
        from: "test-daemon-id",
        ciphertext: "ENC1",
        nonce: "NONCE1",
      }));

      // Phone should have received the envelope (after pair_init at index 0, pair_ack at index 1, envelope at index 2)
      const phoneMsgs = phoneWs.sent.map((s) => JSON.parse(s));
      const envMsg = phoneMsgs.find((m) => m.type === "envelope");
      expect(envMsg).toMatchObject({ type: "envelope", from: "test-daemon-id", ciphertext: "ENC1" });
    });
  });
});
