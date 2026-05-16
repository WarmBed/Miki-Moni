import nacl from "tweetnacl";

export const CHALLENGE_TTL_MS = 10_000;  // 10s — daemon must respond fast

export interface Challenge {
  nonce: Uint8Array;       // 32 random bytes
  issued_at_ms: number;
}

/** Generate a fresh challenge for the daemon to sign. */
export function generateChallenge(): Challenge {
  return {
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    issued_at_ms: Date.now(),
  };
}

/**
 * Build the bytes the client is expected to sign: nonce (32B) ++ issued_at_ms (8B big-endian).
 * Deterministic — both sides must compute the same bytes.
 */
export function buildChallengeMessage(nonce: Uint8Array, issued_at_ms: number): Uint8Array {
  const out = new Uint8Array(32 + 8);
  out.set(nonce, 0);
  // 8-byte big-endian timestamp
  const view = new DataView(out.buffer, 32, 8);
  view.setBigUint64(0, BigInt(issued_at_ms), false);
  return out;
}

/** Verify a challenge response. Returns true iff sig is valid AND challenge not expired. */
export function verifyChallengeResponse(
  challenge: Challenge,
  sig: Uint8Array,
  pubkey: Uint8Array,
  now_ms: number,
): boolean {
  if (now_ms > challenge.issued_at_ms + CHALLENGE_TTL_MS) return false;
  const msg = buildChallengeMessage(challenge.nonce, challenge.issued_at_ms);
  return nacl.sign.detached.verify(msg, sig, pubkey);
}

/** daemon_id = first 16 bytes of SHA-256(signing_pubkey), hex-encoded (32 chars). */
export async function deriveDaemonId(signing_pubkey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", signing_pubkey);
  const bytes = new Uint8Array(hash).slice(0, 16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Base64 helpers (workerd has atob/btoa but Uint8Array helpers are clearer) ──

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
