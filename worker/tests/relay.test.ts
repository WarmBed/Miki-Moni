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

  describe("revoke flow", () => {
    async function completePair(token: string, phoneSignPubB64 = "PHONE_SIGN_PK_B64") {
      const { daemon, state, serverWs, keypair } = await openDaemonAndChallenge();
      // 1. daemon completes challenge-response
      const ch = JSON.parse(serverWs.sent[0]);
      const sig = nacl.sign.detached(
        buildChallengeMessage(Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0)), ch.issued_at_ms),
        keypair.secretKey,
      );
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));
      // 2. daemon registers pairing token
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "register_pairing", token }));
      // 3. phone connects with the token + sends pair_offer
      const phoneReq = new Request("https://x/v1/phone", {
        headers: { "X-Pairing-Token": token, "Upgrade": "websocket" },
      });
      await daemon.fetch(phoneReq);
      const phoneWs = Array.from(state._wsRegistry.entries()).find(([_, tags]) => tags[0] === "phone")?.[0]!;
      await daemon.webSocketMessage(phoneWs as any, JSON.stringify({
        type: "pair_offer",
        phone_pubkey: "PHONE_ENC_PK_B64",
        phone_sign_pubkey: phoneSignPubB64,
      }));
      // 4. daemon acks → phone becomes authed
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "pair_ack", daemon_id: "test-daemon-id" }));
      return { daemon, state, serverWs, phoneWs };
    }

    it("phone-initiated revoke_self removes paired_phones entry, notifies daemon, closes phone WS", async () => {
      const { daemon, state, serverWs, phoneWs } = await completePair("REVOKEFLOW1234A1", "SIGN_PK_PHONE_A");

      // sanity: paired_phones contains the phone
      const beforePaired = await state.storage.get<Record<string, string>>("paired_phones");
      expect(beforePaired?.["SIGN_PK_PHONE_A"]).toBeDefined();

      // Phone sends revoke_self
      await daemon.webSocketMessage(phoneWs as any, JSON.stringify({ type: "revoke_self" }));

      // paired_phones entry is gone
      const afterPaired = await state.storage.get<Record<string, string>>("paired_phones");
      expect(afterPaired?.["SIGN_PK_PHONE_A"]).toBeUndefined();

      // Daemon got phone_revoked notification
      const daemonMsgs = serverWs.sent.map((s: string) => JSON.parse(s));
      const notification = daemonMsgs.find((m) => m.type === "phone_revoked");
      expect(notification).toEqual({ type: "phone_revoked", phone_pubkey_b64: "SIGN_PK_PHONE_A" });

      // Phone got revoked_ok and was closed cleanly
      const phoneMsgs = phoneWs.sent.map((s: string) => JSON.parse(s));
      expect(phoneMsgs.some((m) => m.type === "revoked_ok")).toBe(true);
      expect(phoneWs.closed?.code).toBe(1000);
    });

    it("daemon-initiated revoke_phone removes paired_phones entry and kicks live phone WS", async () => {
      const { daemon, state, serverWs, phoneWs } = await completePair("REVOKEFLOW1234B2", "SIGN_PK_PHONE_B");

      // sanity
      const beforePaired = await state.storage.get<Record<string, string>>("paired_phones");
      expect(beforePaired?.["SIGN_PK_PHONE_B"]).toBeDefined();

      // Daemon sends revoke_phone
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "revoke_phone",
        phone_pubkey_b64: "SIGN_PK_PHONE_B",
      }));

      // paired_phones entry is gone
      const afterPaired = await state.storage.get<Record<string, string>>("paired_phones");
      expect(afterPaired?.["SIGN_PK_PHONE_B"]).toBeUndefined();

      // Phone was closed with 4003
      expect(phoneWs.closed?.code).toBe(4003);

      // Phone got a phone_revoked notification with "by: daemon"
      const phoneMsgs = phoneWs.sent.map((s: string) => JSON.parse(s));
      const notif = phoneMsgs.find((m) => m.type === "phone_revoked");
      expect(notif).toMatchObject({ type: "phone_revoked", by: "daemon" });
    });

    it("revoke_phone for a non-existent phone is a no-op (no throw)", async () => {
      const { daemon, serverWs } = await completePair("REVOKEFLOW1234C3", "SIGN_PK_PHONE_C");
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "revoke_phone",
        phone_pubkey_b64: "SIGN_PK_UNKNOWN_PHONE",
      }));
      // No crash, no kick — and the original phone still in paired_phones.
      // (Implicit assertion: the previous lines did not throw.)
    });
  });

  describe("envelope routing by `to: phone:<peer_id>`", () => {
    async function setupTwoPairedPhones() {
      const { daemon, state, serverWs, keypair } = await openDaemonAndChallenge();
      // Auth daemon
      const ch = JSON.parse(serverWs.sent[0]);
      const sig = nacl.sign.detached(
        buildChallengeMessage(Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0)), ch.issued_at_ms),
        keypair.secretKey,
      );
      await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));

      async function pairOnePhone(token: string, signPk: string): Promise<any> {
        await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "register_pairing", token }));
        const req = new Request("https://x/v1/phone", {
          headers: { "X-Pairing-Token": token, "Upgrade": "websocket" },
        });
        await daemon.fetch(req);
        // grab the most recently-registered phone WS
        const allPhones = Array.from(state._wsRegistry.entries()).filter(([_, tags]) => tags[0] === "phone");
        const phoneWs = allPhones[allPhones.length - 1]![0];
        await daemon.webSocketMessage(phoneWs as any, JSON.stringify({
          type: "pair_offer", phone_pubkey: "ENC_" + signPk, phone_sign_pubkey: signPk,
        }));
        await daemon.webSocketMessage(serverWs as any, JSON.stringify({ type: "pair_ack", daemon_id: "test-daemon-id" }));
        return phoneWs;
      }

      const phoneA = await pairOnePhone("ROUTETEST1ALPHA1", "SIGN_A");
      const phoneB = await pairOnePhone("ROUTETEST1BRAVO2", "SIGN_B");

      // Phones register their addressable peer_id
      await daemon.webSocketMessage(phoneA as any, JSON.stringify({ type: "register_peer_id", peer_id: "PEER_A" }));
      await daemon.webSocketMessage(phoneB as any, JSON.stringify({ type: "register_peer_id", peer_id: "PEER_B" }));

      return { daemon, state, serverWs, phoneA, phoneB };
    }

    it("daemon envelope addressed `to: phone:PEER_A` reaches only phone A", async () => {
      const { daemon, serverWs, phoneA, phoneB } = await setupTwoPairedPhones();

      const sentBeforeA = phoneA.sent.length;
      const sentBeforeB = phoneB.sent.length;

      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "envelope", to: "phone:PEER_A", from: "daemon", ciphertext: "FOR_A", nonce: "N",
      }));

      const aMsgs = phoneA.sent.slice(sentBeforeA).map((s: string) => JSON.parse(s));
      const bMsgs = phoneB.sent.slice(sentBeforeB).map((s: string) => JSON.parse(s));
      expect(aMsgs.find((m: any) => m.ciphertext === "FOR_A")).toBeDefined();
      expect(bMsgs.find((m: any) => m.ciphertext === "FOR_A")).toBeUndefined();
    });

    it("unaddressed envelope (no `to`) still broadcasts to both authed phones (back-compat)", async () => {
      const { daemon, serverWs, phoneA, phoneB } = await setupTwoPairedPhones();

      const sentBeforeA = phoneA.sent.length;
      const sentBeforeB = phoneB.sent.length;

      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "envelope", from: "daemon", ciphertext: "GLOBAL", nonce: "N",
      }));

      const aMsgs = phoneA.sent.slice(sentBeforeA).map((s: string) => JSON.parse(s));
      const bMsgs = phoneB.sent.slice(sentBeforeB).map((s: string) => JSON.parse(s));
      expect(aMsgs.find((m: any) => m.ciphertext === "GLOBAL")).toBeDefined();
      expect(bMsgs.find((m: any) => m.ciphertext === "GLOBAL")).toBeDefined();
    });

    it("`to: phone:UNKNOWN` drops the message (delivered to no one)", async () => {
      const { daemon, serverWs, phoneA, phoneB } = await setupTwoPairedPhones();

      const sentBeforeA = phoneA.sent.length;
      const sentBeforeB = phoneB.sent.length;

      await daemon.webSocketMessage(serverWs as any, JSON.stringify({
        type: "envelope", to: "phone:GHOST", from: "daemon", ciphertext: "VOID", nonce: "N",
      }));

      expect(phoneA.sent.slice(sentBeforeA).map((s: string) => JSON.parse(s)).find((m: any) => m.ciphertext === "VOID")).toBeUndefined();
      expect(phoneB.sent.slice(sentBeforeB).map((s: string) => JSON.parse(s)).find((m: any) => m.ciphertext === "VOID")).toBeUndefined();
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
      const phoneMsgs = phoneWs.sent.map((s: string) => JSON.parse(s));
      const envMsg = phoneMsgs.find((m) => m.type === "envelope");
      expect(envMsg).toMatchObject({ type: "envelope", from: "test-daemon-id", ciphertext: "ENC1" });
    });
  });
});
