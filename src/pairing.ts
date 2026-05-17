import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { deriveSharedSecret, toBase64, fromBase64 } from "./crypto.js";
import type { PairedPeer } from "./config.js";
import type { Plaintext } from "./relay-protocol.js";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 16;
const PAIRING_TOKEN_BYTES = 16;

export function generateNewPairingToken(): string {
  const bytes = nacl.randomBytes(PAIRING_TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_TOKEN_LENGTH; i++) {
    out += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
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

/** HTTPS URL with token + relay in the URL fragment. Fragment is never sent to
 *  the server, so the token doesn't leak into CF/Pages access logs. */
export function pairingQrPayload(input: PairingQrInput): string {
  const fragment = `t=${input.pairing_token}&r=${encodeURIComponent(input.worker_url)}`;
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
