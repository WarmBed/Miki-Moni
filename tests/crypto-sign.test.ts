import { describe, it, expect } from "vitest";
import {
  generateSigningKeypair,
  sign,
  verify,
  toBase64,
  fromBase64,
} from "../src/crypto.js";

describe("crypto sign/verify (Ed25519)", () => {
  it("generates 32-byte pub + 64-byte priv keys", () => {
    const kp = generateSigningKeypair();
    expect(kp.pubkey.length).toBe(32);
    expect(kp.privkey.length).toBe(64);  // nacl.sign uses 64-byte secret (includes pub)
  });

  it("sign + verify round-trip succeeds with matching keys", () => {
    const kp = generateSigningKeypair();
    const msg = new TextEncoder().encode("hello world");
    const sig = sign(msg, kp.privkey);
    expect(verify(msg, sig, kp.pubkey)).toBe(true);
  });

  it("verify rejects sig from wrong key", () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = sign(msg, a.privkey);
    expect(verify(msg, sig, b.pubkey)).toBe(false);
  });

  it("verify rejects sig over wrong message", () => {
    const kp = generateSigningKeypair();
    const sig = sign(new TextEncoder().encode("hello"), kp.privkey);
    expect(verify(new TextEncoder().encode("HELLO"), sig, kp.pubkey)).toBe(false);
  });

  it("sig is 64 bytes", () => {
    const kp = generateSigningKeypair();
    const sig = sign(new TextEncoder().encode("x"), kp.privkey);
    expect(sig.length).toBe(64);
  });

  it("base64 round-trips signing keys cleanly", () => {
    const kp = generateSigningKeypair();
    const pubB64 = toBase64(kp.pubkey);
    const privB64 = toBase64(kp.privkey);
    expect(fromBase64(pubB64)).toEqual(kp.pubkey);
    expect(fromBase64(privB64)).toEqual(kp.privkey);
  });
});
