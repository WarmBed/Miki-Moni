// Crockford base32 alphabet — no 0/O/1/I/L (visually unambiguous).
// 32 characters: 2-9 (no 0,1) plus A-Z minus I,L,O.
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const PAIRING_CODE_LENGTH = 16;

/** Generate a fresh random 16-char pairing code. ~76 bits entropy (log2(32^16)). */
export function generatePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[bytes[i]! % PAIRING_CODE_ALPHABET.length];
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
