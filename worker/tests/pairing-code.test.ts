import { describe, it, expect } from "vitest";
import {
  generatePairingCode,
  normalizePairingCode,
  formatPairingCode,
  isValidPairingCode,
  PAIRING_CODE_ALPHABET,
} from "../src/pairing-code.js";

describe("pairing-code", () => {
  describe("generatePairingCode", () => {
    it("returns 16 chars from the Crockford base32 alphabet", () => {
      const code = generatePairingCode();
      expect(code).toHaveLength(16);
      for (const ch of code) {
        expect(PAIRING_CODE_ALPHABET).toContain(ch);
      }
    });

    it("produces different codes on each call (entropy check)", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) seen.add(generatePairingCode());
      expect(seen.size).toBe(100);
    });

    it("never includes ambiguous chars 0/O/1/I/L", () => {
      for (let i = 0; i < 100; i++) {
        const code = generatePairingCode();
        for (const bad of ["0", "O", "1", "I", "L"]) {
          expect(code).not.toContain(bad);
        }
      }
    });
  });

  describe("normalizePairingCode", () => {
    it("strips hyphens", () => {
      expect(normalizePairingCode("K7H2-X9PN-RT4B-MWQ8")).toBe("K7H2X9PNRT4BMWQ8");
    });

    it("uppercases lowercase input", () => {
      expect(normalizePairingCode("k7h2x9pnrt4bmwq8")).toBe("K7H2X9PNRT4BMWQ8");
    });

    it("strips whitespace", () => {
      expect(normalizePairingCode(" K7H2 X9PN RT4B MWQ8 ")).toBe("K7H2X9PNRT4BMWQ8");
    });
  });

  describe("formatPairingCode", () => {
    it("inserts hyphens every 4 chars for display", () => {
      expect(formatPairingCode("K7H2X9PNRT4BMWQ8")).toBe("K7H2-X9PN-RT4B-MWQ8");
    });
  });

  describe("isValidPairingCode", () => {
    it("accepts a valid normalized 16-char code", () => {
      expect(isValidPairingCode("K7H2X9PNRT4BMWQ8")).toBe(true);
    });

    it("rejects wrong length", () => {
      expect(isValidPairingCode("K7H2X9PN")).toBe(false);
      expect(isValidPairingCode("K7H2X9PNRT4BMWQ88")).toBe(false);
    });

    it("rejects ambiguous chars", () => {
      expect(isValidPairingCode("0K7H2X9PNRT4BMWQ")).toBe(false);
      expect(isValidPairingCode("IK7H2X9PNRT4BMWQ")).toBe(false);
    });

    it("rejects unnormalized input (hyphens / lowercase)", () => {
      expect(isValidPairingCode("K7H2-X9PN-RT4B-MWQ8")).toBe(false);
      expect(isValidPairingCode("k7h2x9pnrt4bmwq8")).toBe(false);
    });
  });
});
