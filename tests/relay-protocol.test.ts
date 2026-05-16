import { describe, it, expect } from "vitest";
import { generateKeypair, deriveSharedSecret, encrypt } from "../src/crypto.js";
import {
  encodeEnvelope,
  decodeEnvelope,
  type Envelope,
  type Plaintext,
} from "../src/relay-protocol.js";

describe("relay-protocol", () => {
  it("encode → decode round-trip preserves payload", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const secret = deriveSharedSecret(a.privkey, b.pubkey);
    const msg: Plaintext = { kind: "ping", echo: "abc" };
    const env = encodeEnvelope(msg, secret, "phone:xyz");
    expect(env.v).toBe(1);
    expect(env.to).toBe("phone:xyz");
    expect(env.ct).toBeTruthy();
    expect(env.nonce).toBeTruthy();
    expect(env.ts).toBeTypeOf("number");

    const decoded = decodeEnvelope(env, secret);
    expect(decoded).toEqual(msg);
  });

  it("decodeEnvelope returns null when version mismatched", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const secret = deriveSharedSecret(a.privkey, b.pubkey);
    const env = encodeEnvelope({ kind: "ping", echo: "x" }, secret, "daemon");
    const bad: Envelope = { ...env, v: 99 };
    expect(decodeEnvelope(bad, secret)).toBeNull();
  });

  it("decodeEnvelope returns null when ciphertext fails to decrypt", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const c = generateKeypair();
    const goodSecret = deriveSharedSecret(a.privkey, b.pubkey);
    const wrongSecret = deriveSharedSecret(a.privkey, c.pubkey);
    const env = encodeEnvelope({ kind: "ping", echo: "x" }, goodSecret, "daemon");
    expect(decodeEnvelope(env, wrongSecret)).toBeNull();
  });

  it("decodeEnvelope returns null when plaintext is not valid JSON-shaped Plaintext", async () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const secret = deriveSharedSecret(a.privkey, b.pubkey);
    const { ct, nonce } = encrypt("not a json object", secret);
    const env: Envelope = { v: 1, to: "daemon", ct, nonce, ts: Date.now() };
    expect(decodeEnvelope(env, secret)).toBeNull();
  });
});
