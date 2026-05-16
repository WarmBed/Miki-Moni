import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  toBase64,
  fromBase64,
} from "../src/crypto.js";

describe("crypto", () => {
  describe("generateKeypair", () => {
    it("returns 32-byte pubkey and 32-byte privkey", () => {
      const kp = generateKeypair();
      expect(kp.pubkey).toHaveLength(32);
      expect(kp.privkey).toHaveLength(32);
    });

    it("returns different keys on each call", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      expect(toBase64(a.pubkey)).not.toBe(toBase64(b.pubkey));
    });
  });

  describe("deriveSharedSecret", () => {
    it("two parties derive the same secret", () => {
      const alice = generateKeypair();
      const bob = generateKeypair();
      const aliceSees = deriveSharedSecret(alice.privkey, bob.pubkey);
      const bobSees = deriveSharedSecret(bob.privkey, alice.pubkey);
      expect(toBase64(aliceSees)).toBe(toBase64(bobSees));
    });

    it("different pairs derive different secrets", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const c = generateKeypair();
      const ab = deriveSharedSecret(a.privkey, b.pubkey);
      const ac = deriveSharedSecret(a.privkey, c.pubkey);
      expect(toBase64(ab)).not.toBe(toBase64(ac));
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("encrypts and decrypts a plaintext string", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const secret = deriveSharedSecret(a.privkey, b.pubkey);
      const { ct, nonce } = encrypt("hello world", secret);
      const pt = decrypt(ct, nonce, secret);
      expect(pt).toBe("hello world");
    });

    it("decrypts to null with wrong key", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const c = generateKeypair();
      const goodSecret = deriveSharedSecret(a.privkey, b.pubkey);
      const wrongSecret = deriveSharedSecret(a.privkey, c.pubkey);
      const { ct, nonce } = encrypt("hello", goodSecret);
      expect(decrypt(ct, nonce, wrongSecret)).toBeNull();
    });

    it("decrypts to null with tampered ciphertext", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const secret = deriveSharedSecret(a.privkey, b.pubkey);
      const { ct, nonce } = encrypt("hello", secret);
      const tampered = ct.slice(0, -2) + "xx";
      expect(decrypt(tampered, nonce, secret)).toBeNull();
    });

    it("encrypt produces different nonces on repeat calls", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const secret = deriveSharedSecret(a.privkey, b.pubkey);
      const e1 = encrypt("x", secret);
      const e2 = encrypt("x", secret);
      expect(e1.nonce).not.toBe(e2.nonce);
    });
  });

  describe("base64 helpers", () => {
    it("round-trip", () => {
      const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual([1, 2, 3, 250, 251, 252]);
    });
  });
});
