import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  generateChallenge,
  buildChallengeMessage,
  verifyChallengeResponse,
  deriveDaemonId,
  toBase64,
  fromBase64,
  CHALLENGE_TTL_MS,
} from "../src/handshake.js";

describe("handshake", () => {
  describe("generateChallenge", () => {
    it("returns 32 bytes of random nonce + a timestamp", () => {
      const c = generateChallenge();
      expect(c.nonce.length).toBe(32);
      expect(c.issued_at_ms).toBeGreaterThan(Date.now() - 100);
      expect(c.issued_at_ms).toBeLessThanOrEqual(Date.now());
    });

    it("produces different nonces", () => {
      const a = generateChallenge();
      const b = generateChallenge();
      expect(toBase64(a.nonce)).not.toBe(toBase64(b.nonce));
    });
  });

  describe("buildChallengeMessage", () => {
    it("concatenates nonce + issued_at as bytes the client signs", () => {
      const nonce = new Uint8Array(32).fill(7);
      const msg = buildChallengeMessage(nonce, 1700000000000);
      expect(msg).toBeInstanceOf(Uint8Array);
      // Must be deterministic
      const msg2 = buildChallengeMessage(nonce, 1700000000000);
      expect(toBase64(msg)).toBe(toBase64(msg2));
    });
  });

  describe("verifyChallengeResponse", () => {
    it("accepts a valid sig from the matching keypair", () => {
      const kp = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, kp.secretKey);
      expect(verifyChallengeResponse(c, sig, kp.publicKey, Date.now())).toBe(true);
    });

    it("rejects sig from wrong key", () => {
      const a = nacl.sign.keyPair();
      const b = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, a.secretKey);
      expect(verifyChallengeResponse(c, sig, b.publicKey, Date.now())).toBe(false);
    });

    it("rejects expired challenge (now > issued_at + TTL)", () => {
      const kp = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, kp.secretKey);
      const future = c.issued_at_ms + CHALLENGE_TTL_MS + 1;
      expect(verifyChallengeResponse(c, sig, kp.publicKey, future)).toBe(false);
    });

    it("accepts at the boundary (now == issued_at + TTL)", () => {
      const kp = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, kp.secretKey);
      const at = c.issued_at_ms + CHALLENGE_TTL_MS;
      expect(verifyChallengeResponse(c, sig, kp.publicKey, at)).toBe(true);
    });
  });

  describe("deriveDaemonId", () => {
    it("returns 32 hex chars (16 bytes of SHA-256 truncated)", async () => {
      const pub = new Uint8Array(32).fill(1);
      const id = await deriveDaemonId(pub);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("is deterministic for the same pubkey", async () => {
      const pub = new Uint8Array(32).fill(2);
      const a = await deriveDaemonId(pub);
      const b = await deriveDaemonId(pub);
      expect(a).toBe(b);
    });

    it("differs for different pubkeys", async () => {
      const a = await deriveDaemonId(new Uint8Array(32).fill(3));
      const b = await deriveDaemonId(new Uint8Array(32).fill(4));
      expect(a).not.toBe(b);
    });
  });
});
