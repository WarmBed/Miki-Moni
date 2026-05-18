// Visually-unambiguous base32-ish alphabet — 31 chars: 2-9 (no 0,1) plus
// A-Z minus I, L, O. (The historical comment claimed 32 chars; that was
// wrong by one and produced a misleading entropy figure.)
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const PAIRING_CODE_LENGTH = 16;

/**
 * Generate a fresh random 16-char pairing code.
 *
 * Entropy: log2(31^16) ≈ 79.27 bits, uniformly distributed.
 *
 * The naive `bytes[i] % 31` introduces modulo bias (~3% skew toward the
 * first 8 chars of the alphabet) because 256 isn't a multiple of 31. We
 * use rejection sampling: only accept random bytes < 248 (the largest
 * multiple of 31 that fits in a byte), regenerate otherwise. Expected
 * extra bytes per code: 16 * (256/248 - 1) ≈ 0.5 byte, negligible cost.
 */
export function generatePairingCode(): string {
  const buf = new Uint8Array(32);  // oversize to dodge most reroll loops
  let code = "";
  const maxAcceptable = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length; // 248
  while (code.length < PAIRING_CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && code.length < PAIRING_CODE_LENGTH; i++) {
      const b = buf[i]!;
      if (b >= maxAcceptable) continue;  // reject biased range
      code += PAIRING_CODE_ALPHABET[b % PAIRING_CODE_ALPHABET.length];
    }
  }
  return code;
}

/** Strip hyphens + whitespace, uppercase. */
export function normalizePairingCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Insert hyphens every 4 chars for display (XXXX-XXXX-XXXX-XXXX). */
export function formatPairingCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += 4) {
    groups.push(normalized.slice(i, i + 4));
  }
  return groups.join("-");
}

/** True iff input is exactly 16 chars from our alphabet (no hyphens, uppercase). */
export function isValidPairingCode(input: string): boolean {
  if (input.length !== PAIRING_CODE_LENGTH) return false;
  for (const ch of input) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
