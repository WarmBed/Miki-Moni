import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

export interface Keypair {
  pubkey: Uint8Array;  // 32 bytes
  privkey: Uint8Array; // 32 bytes
}

export function generateKeypair(): Keypair {
  const kp = nacl.box.keyPair();
  return { pubkey: kp.publicKey, privkey: kp.secretKey };
}

export function deriveSharedSecret(myPrivkey: Uint8Array, theirPubkey: Uint8Array): Uint8Array {
  // X25519 ECDH; same output for both sides
  return nacl.box.before(theirPubkey, myPrivkey);
}

export interface Encrypted {
  ct: string;     // base64
  nonce: string;  // base64 (24 bytes)
}

export function encrypt(plaintext: string, sharedSecret: Uint8Array): Encrypted {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ptBytes = naclUtil.decodeUTF8(plaintext);
  const ctBytes = nacl.secretbox(ptBytes, nonce, sharedSecret);
  return { ct: toBase64(ctBytes), nonce: toBase64(nonce) };
}

export function decrypt(ct: string, nonce: string, sharedSecret: Uint8Array): string | null {
  const ctBytes = fromBase64(ct);
  const nonceBytes = fromBase64(nonce);
  if (nonceBytes.length !== nacl.secretbox.nonceLength) return null;
  const ptBytes = nacl.secretbox.open(ctBytes, nonceBytes, sharedSecret);
  if (!ptBytes) return null;
  return naclUtil.encodeUTF8(ptBytes);
}

export function toBase64(bytes: Uint8Array): string {
  return naclUtil.encodeBase64(bytes);
}

export function fromBase64(s: string): Uint8Array {
  return naclUtil.decodeBase64(s);
}
