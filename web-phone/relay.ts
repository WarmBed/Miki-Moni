/**
 * relay.ts — Browser-compatible crypto wrappers using tweetnacl + tweetnacl-util.
 * Mirrors src/crypto.ts and src/relay-protocol.ts for the phone web client.
 */

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

export interface Keypair {
  pubkey: Uint8Array;
  privkey: Uint8Array;
}

export interface Envelope {
  v: number;
  to: string;
  ct: string;
  nonce: string;
  ts: number;
}

export function generateKeypair(): Keypair {
  const kp = nacl.box.keyPair();
  return { pubkey: kp.publicKey, privkey: kp.secretKey };
}

export function deriveSharedSecret(myPriv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return nacl.box.before(theirPub, myPriv);
}

export function encrypt(plaintext: string, secret: Uint8Array): { ct: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ptBytes = naclUtil.decodeUTF8(plaintext);
  const ctBytes = nacl.secretbox(ptBytes, nonce, secret);
  return { ct: toBase64(ctBytes), nonce: toBase64(nonce) };
}

export function decrypt(ct: string, nonce: string, secret: Uint8Array): string | null {
  const ctBytes = fromBase64(ct);
  const nonceBytes = fromBase64(nonce);
  if (nonceBytes.length !== nacl.secretbox.nonceLength) return null;
  const ptBytes = nacl.secretbox.open(ctBytes, nonceBytes, secret);
  if (!ptBytes) return null;
  return naclUtil.encodeUTF8(ptBytes);
}

export function toBase64(bytes: Uint8Array): string {
  return naclUtil.encodeBase64(bytes);
}

export function fromBase64(s: string): Uint8Array {
  return naclUtil.decodeBase64(s);
}

export function encodeEnvelope(
  plaintext: object,
  secret: Uint8Array,
  to: string,
): Envelope {
  const json = JSON.stringify(plaintext);
  const { ct, nonce } = encrypt(json, secret);
  return { v: 1, to, ct, nonce, ts: Date.now() };
}

export function decodeEnvelope(env: Envelope, secret: Uint8Array): object | null {
  if (env.v !== 1) return null;
  const json = decrypt(env.ct, env.nonce, secret);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
