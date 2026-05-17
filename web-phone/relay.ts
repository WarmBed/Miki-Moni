import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import type { Identity } from "./store.js";

// ─── Crypto utilities (used by app.tsx) ──────────────────────────────────────

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

const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function normalizePairingCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

export function isValidPairingCode(input: string): boolean {
  if (input.length !== 16) return false;
  for (const ch of input) if (!PAIRING_ALPHABET.includes(ch)) return false;
  return true;
}

export interface PairResult {
  daemon_id: string;           // hex string, may be "unknown" if server didn't send it
  daemon_pubkey_b64: string;   // X25519 encryption key
  shared_secret_b64: string;   // X25519 ECDH result
}

/** Run the pairing handshake with the relay using a freshly-typed/scanned pairing code.
 *  Browsers can't set custom headers on WebSocket, so we encode the pairing token in
 *  the URL query string. Worker accepts both header and query-string forms. */
export async function performPairing(
  relayUrl: string,
  pairingToken: string,
  identity: Identity,
): Promise<PairResult> {
  const base = relayUrl.replace(/^https?:/, (m) => (m === "https:" ? "wss:" : "ws:"));
  const wsUrl = `${base}/v1/phone?token=${encodeURIComponent(pairingToken)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let daemonPubkeyB64: string | null = null;
    let sharedSecret: Uint8Array | null = null;
    let settled = false;

    ws.onerror = () => { if (!settled) { settled = true; reject(new Error("ws_error")); } };
    ws.onclose = (ev) => {
      if (settled) return;
      settled = true;
      reject(new Error(`ws_closed:${ev.code}`));
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }

      if (msg.type === "pair_init") {
        daemonPubkeyB64 = msg.daemon_pubkey as string;
        const daemon_pub = naclUtil.decodeBase64(daemonPubkeyB64);
        const phone_priv = naclUtil.decodeBase64(identity.encryption_privkey);
        sharedSecret = nacl.box.before(daemon_pub, phone_priv);
        ws.send(JSON.stringify({
          type: "pair_offer",
          phone_pubkey: identity.encryption_pubkey,
          // Signing pubkey is the one the worker stores for reconnect-sig
          // verification; daemon uses encryption pubkey for shared secret.
          phone_sign_pubkey: identity.signing_pubkey,
        }));
        return;
      }
      if (msg.type === "pair_ack" && daemonPubkeyB64 && sharedSecret && !settled) {
        settled = true;
        const daemon_id = (msg.daemon_id as string) ?? "unknown";
        resolve({
          daemon_id,
          daemon_pubkey_b64: daemonPubkeyB64,
          shared_secret_b64: naclUtil.encodeBase64(sharedSecret),
        });
        ws.close();
      }
    };
  });
}

/** Compute the addressable peer_id for this phone — must match
 *  src/pairing.ts:computePeerId exactly (daemon uses the same algo to address
 *  envelopes via `to: "phone:<peer_id>"`). */
export async function computePeerIdFromB64(peerPubkeyBase64: string): Promise<string> {
  const buf = new TextEncoder().encode(peerPubkeyBase64);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hashBuf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/[+/=]/g, "").slice(0, 16);
}

/** Connect using stored pair credentials (reconnect mode). */
export function connectAuthed(
  relayUrl: string,
  daemon_id: string,
  identity: Identity,
): WebSocket {
  // Sign daemon_id + utc_minute with our Ed25519 signing key
  const utcMinute = Math.floor(Date.now() / 60_000);
  const daemonIdBytes = new TextEncoder().encode(daemon_id);
  const msg = new Uint8Array(daemonIdBytes.length + 8);
  msg.set(daemonIdBytes, 0);
  new DataView(msg.buffer, daemonIdBytes.length, 8).setBigUint64(0, BigInt(utcMinute), false);
  const priv = naclUtil.decodeBase64(identity.signing_privkey);
  const sig = nacl.sign.detached(msg, priv);

  const base = relayUrl.replace(/^https?:/, (m) => (m === "https:" ? "wss:" : "ws:"));
  const url = new URL(`${base}/v1/phone`);
  url.searchParams.set("daemon_id", daemon_id);
  url.searchParams.set("phone_pubkey", identity.signing_pubkey);
  url.searchParams.set("sig", naclUtil.encodeBase64(sig));
  return new WebSocket(url.toString());
}
