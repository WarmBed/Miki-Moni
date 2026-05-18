import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { deriveSharedSecret, toBase64, fromBase64 } from "./crypto.js";
import type { PairedPeer } from "./config.js";
import type { Plaintext } from "./relay-protocol.js";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";  // 31 chars
const PAIRING_TOKEN_LENGTH = 16;
const PAIRING_TOKEN_BYTES = 16;
// Largest multiple of 31 that fits in a byte (256). Reject anything ≥ this
// to remove modulo bias when sampling a 31-char alphabet from a uniform
// byte source. See pairing-code.ts for the same trick on the worker side.
const PAIRING_BYTE_MAX = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;  // 248

export function generateNewPairingToken(): string {
  let out = "";
  while (out.length < PAIRING_TOKEN_LENGTH) {
    // Oversize: typical loop completes in 1-2 iterations.
    const bytes = nacl.randomBytes(32);
    for (let i = 0; i < bytes.length && out.length < PAIRING_TOKEN_LENGTH; i++) {
      const b = bytes[i]!;
      if (b >= PAIRING_BYTE_MAX) continue;  // reject biased range
      out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
    }
  }
  return out;
}

export interface PairingQrInput {
  worker_url: string;
  pairing_token: string;
  daemon_pubkey: string;   // kept for backwards-compat; not used in new URL
  device_name: string;     // kept for backwards-compat; not used in new URL
  /** Override the PWA URL — used by self-hosters whose Pages project isn't
   *  at miki-moni.pages.dev. Defaults to the hosted convenience URL. */
  phone_pwa_url?: string;
}

/** Hosted PWA URL — phone camera opens this directly. Self-hosters override via
 *  Config.remote.phone_pwa_url + pass through the input. */
export const PHONE_PWA_URL = "https://miki-moni.pages.dev/";

/** HTTPS URL with token + relay + daemon pubkey in the URL fragment.
 *
 *  Including `&k=<daemon_x25519_pubkey_b64>` closes the relay-MITM hole:
 *  during pair_init the worker sends a pubkey to the phone; without an
 *  out-of-band reference, an honest-but-curious worker could substitute
 *  its own pubkey, derive shared secrets with both sides, and silently
 *  decrypt every envelope. With `k=` the phone compares the worker-
 *  supplied pubkey against the one in the QR and aborts on mismatch.
 *
 *  Fragment is never sent to the server, so the token + key don't leak
 *  into CF/Pages access logs.
 *
 *  Older QRs without `k=` still work — phones fall back to trust-on-first-
 *  use with a console warning. The fix is forward-only.
 */
export function pairingQrPayload(input: PairingQrInput): string {
  const fragment =
    `t=${input.pairing_token}` +
    `&r=${encodeURIComponent(input.worker_url)}` +
    `&k=${encodeURIComponent(input.daemon_pubkey)}`;
  const base = input.phone_pwa_url ?? PHONE_PWA_URL;
  return `${base}#${fragment}`;
}

export function computePeerId(peerPubkeyBase64: string): string {
  return createHash("sha256")
    .update(peerPubkeyBase64)
    .digest("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 16);
}

type PairingState = "pending" | "paired" | "expired";

export interface PairOffer {
  phone_pk: string;   // base64
  phone_name: string;
}

export interface PairResult {
  peer: PairedPeer;
  pairAck: Extract<Plaintext, { kind: "pair_ack" }>;
}

export class PairingSession {
  readonly pairingToken: string;
  state: PairingState = "pending";
  private readonly createdAt: number = Date.now();
  private readonly daemonPrivkey: Uint8Array;
  private readonly daemonPubkey: Uint8Array;

  constructor(daemonPrivkey: Uint8Array, daemonPubkey: Uint8Array) {
    this.daemonPrivkey = daemonPrivkey;
    this.daemonPubkey = daemonPubkey;
    this.pairingToken = toBase64(nacl.randomBytes(PAIRING_TOKEN_BYTES));
  }

  isExpired(): boolean {
    return Date.now() - this.createdAt >= PAIRING_TOKEN_TTL_MS;
  }

  handleOffer(offer: PairOffer): PairResult {
    if (this.state !== "pending") {
      throw new Error(
        `PairingSession already in state '${this.state}'; cannot accept new offer`,
      );
    }
    const phonePubkey = fromBase64(offer.phone_pk);
    const sharedSecret = deriveSharedSecret(this.daemonPrivkey, phonePubkey);
    const peer: PairedPeer = {
      peer_id: computePeerId(offer.phone_pk),
      peer_name: offer.phone_name,
      peer_pubkey: offer.phone_pk,
      shared_secret: toBase64(sharedSecret),
      paired_at: Date.now(),
      last_seen_at: null,
    };
    this.state = "paired";
    return { peer, pairAck: { kind: "pair_ack", ok: true } };
  }
}
