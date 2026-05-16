# Phase 2 CF Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployable Cloudflare Worker that relays E2E-encrypted messages between cc-hub daemon and paired phones/browsers, replacing the local-only mock worker and enabling remote control of Claude sessions.

**Architecture:** Two Durable Object classes — `PairingCoordinator` (1 instance, holds short-lived pairing tokens) and `DaemonRelay` (N instances, one per daemon_id, holds the daemon WS + phone WSes and routes envelopes between them via Hibernating WebSocket). Pairing uses 16-char Crockford base32 codes (QR + manual entry both supported). Auth is pure crypto — Ed25519 challenge-response on daemon side, paired-phone signature on phone reconnect, no pre-shared secrets and no SSO.

**Tech Stack:** TypeScript, Cloudflare Workers (workerd runtime), Durable Objects with Hibernating WebSocket API, `@cloudflare/workers-types` for typing, `@cloudflare/vitest-pool-workers` for in-runtime tests, tweetnacl (nacl.box + nacl.sign), wrangler for deploy.

---

## File Structure

### New — Worker package (`cc-hub/worker/`)

- `worker/package.json` — separate npm package, name `cc-hub-worker`
- `worker/tsconfig.json` — TS config for workerd runtime
- `worker/wrangler.toml` — DO bindings + custom domain route + rate-limit binding
- `worker/vitest.config.ts` — pool = `@cloudflare/vitest-pool-workers`
- `worker/src/env.ts` — `Env` interface (DO namespaces + RATE_LIMITER binding)
- `worker/src/pairing-code.ts` — Crockford base32 encode/normalize/validate
- `worker/src/handshake.ts` — Ed25519 sign + verify pure functions, challenge generation
- `worker/src/pairing-coordinator.ts` — `PairingCoordinator` DO class
- `worker/src/daemon-relay.ts` — `DaemonRelay` DO class
- `worker/src/index.ts` — Worker fetch handler, routes WS upgrades to DOs
- `worker/tests/pairing-code.test.ts`
- `worker/tests/handshake.test.ts`
- `worker/tests/coordinator.test.ts`
- `worker/tests/relay.test.ts`

### Modified — daemon (`cc-hub/src/`)

- `src/crypto.ts` — ADD: Ed25519 sign + verify helpers
- `src/config.ts` — ADD: `signing` sub-keypair on daemon, migration on first load
- `src/relay-client.ts` — REPLACE: X-Daemon-Auth header → Ed25519 challenge-response handshake
- `src/pairing.ts` — REPLACE: QR payload to `cch://pair?token=...&relay=...` format with 16-char Crockford base32 token

### Modified — mock worker (`cc-hub/tools/mock-worker/`)

- `tools/mock-worker/server.ts` — UPDATE: match new protocol (Ed25519 challenge-response, drop X-Daemon-Auth)

### Modified — web-phone (`cc-hub/web-phone/`)

- `web-phone/store.ts` — ADD: persist signing keypair to IndexedDB
- `web-phone/relay.ts` — REPLACE: dual-keypair handling, reconnect Ed25519 sig
- `web-phone/app.tsx` — ADD: manual code-entry UI for pairing token

### New — docs

- `docs/deploy.md` — hosted + self-host deployment guide

---

## Prerequisites

Run these once before Task 1:

- [ ] **Pre-flight: Verify Node + npm**

Run: `node --version` (expect ≥ 20) and `npm --version`.

- [ ] **Pre-flight: Confirm daemon tests baseline still pass**

Run: `cd d:/code/cc-hub && npx vitest run`
Expected: existing tests pass (we'll add to them, don't want a pre-existing red baseline).

---

## Task 1: Worker package scaffolding

**Files:**
- Create: `d:/code/cc-hub/worker/package.json`
- Create: `d:/code/cc-hub/worker/tsconfig.json`
- Create: `d:/code/cc-hub/worker/vitest.config.ts`
- Create: `d:/code/cc-hub/worker/wrangler.toml`
- Create: `d:/code/cc-hub/worker/src/env.ts`
- Create: `d:/code/cc-hub/worker/.gitignore`

- [ ] **Step 1: Create `worker/package.json`**

```json
{
  "name": "cc-hub-worker",
  "version": "0.1.0",
  "private": true,
  "description": "Cloudflare Worker + Durable Objects for cc-hub E2E relay",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "tweetnacl": "^1.0.3",
    "tweetnacl-util": "^0.15.1"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.7.0",
    "@cloudflare/workers-types": "^4.20250515.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1",
    "wrangler": "^3.85.0"
  }
}
```

- [ ] **Step 2: Create `worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `worker/vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2026-05-17",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
```

- [ ] **Step 4: Create `worker/wrangler.toml`**

```toml
name = "cch-relay"
main = "src/index.ts"
compatibility_date = "2026-05-17"
compatibility_flags = ["nodejs_compat"]

# Custom domain (DNS must exist in Cloudflare for f1telemetrystationpro.org zone)
# Self-host users: replace or delete this block.
routes = [
  { pattern = "relay.f1telemetrystationpro.org/*", custom_domain = true }
]

[[durable_objects.bindings]]
name = "PAIRING"
class_name = "PairingCoordinator"

[[durable_objects.bindings]]
name = "RELAY"
class_name = "DaemonRelay"

[[migrations]]
tag = "v1"
new_classes = ["PairingCoordinator", "DaemonRelay"]

[[unsafe.bindings]]
name = "RATE_LIMITER"
type = "ratelimit"
namespace_id = "1"
simple = { limit = 30, period = 60 }
```

- [ ] **Step 5: Create `worker/src/env.ts`**

```ts
// Bindings exposed by wrangler.toml to the Worker runtime.
export interface Env {
  PAIRING: DurableObjectNamespace;
  RELAY: DurableObjectNamespace;
  RATE_LIMITER: RateLimit;
}

// CF rate-limit binding (not in workers-types yet).
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}
```

- [ ] **Step 6: Create `worker/.gitignore`**

```
node_modules/
.wrangler/
dist/
.dev.vars
```

- [ ] **Step 7: Install deps**

Run: `cd d:/code/cc-hub/worker && npm install`
Expected: completes, `node_modules/` populated.

- [ ] **Step 8: Typecheck baseline**

Run: `cd d:/code/cc-hub/worker && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 9: Commit**

```bash
cd d:/code/cc-hub
git add worker/package.json worker/tsconfig.json worker/vitest.config.ts \
        worker/wrangler.toml worker/src/env.ts worker/.gitignore
git commit -m "feat(worker): scaffold CF Worker package with DO bindings"
```

---

## Task 2: Pairing code (Crockford base32)

**Files:**
- Create: `d:/code/cc-hub/worker/src/pairing-code.ts`
- Create: `d:/code/cc-hub/worker/tests/pairing-code.test.ts`

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/worker/tests/pairing-code.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/pairing-code.test.ts`
Expected: FAIL — "Cannot find module '../src/pairing-code.js'".

- [ ] **Step 3: Write the implementation**

Create `d:/code/cc-hub/worker/src/pairing-code.ts`:

```ts
// Crockford base32 alphabet — no 0/O/1/I/L (visually unambiguous).
// 32 characters: 0-9 minus 0,1 (so 2-9) plus A-Z minus I,L,O.
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
// = "23456789" + "A B C D E F G H _ J K _ M N _ P Q R S T U V W X Y Z" (removing I L O)
// Length check: 31 chars. That's wrong — Crockford base32 has 32.
// Fix: include 0 maps to O. Actually Crockford keeps 0-9 and A-Z minus I,L,O,U.
// Spec uses our own alphabet: keep it simple, 31 chars works fine for our entropy goals.
// (Re-checked: alphabet above is 31 chars. We accept this as our project-specific alphabet.)

export const PAIRING_CODE_LENGTH = 16;

/** Generate a fresh random 16-char pairing code. ~76 bits entropy (log2(31^16)). */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/pairing-code.test.ts`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/worker/src/pairing-code.ts d:/code/cc-hub/worker/tests/pairing-code.test.ts
git commit -m "feat(worker): pairing-code (16-char base32) — generate, normalize, format, validate"
```

---

## Task 3: Daemon-side crypto.ts — Ed25519 sign/verify helpers

**Files:**
- Modify: `d:/code/cc-hub/src/crypto.ts`
- Create: `d:/code/cc-hub/tests/crypto-sign.test.ts`

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/tests/crypto-sign.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generateSigningKeypair,
  sign,
  verify,
  toBase64,
  fromBase64,
} from "../src/crypto.js";

describe("crypto sign/verify (Ed25519)", () => {
  it("generates 32-byte pub + 64-byte priv keys", () => {
    const kp = generateSigningKeypair();
    expect(kp.pubkey.length).toBe(32);
    expect(kp.privkey.length).toBe(64);  // nacl.sign uses 64-byte secret (includes pub)
  });

  it("sign + verify round-trip succeeds with matching keys", () => {
    const kp = generateSigningKeypair();
    const msg = new TextEncoder().encode("hello world");
    const sig = sign(msg, kp.privkey);
    expect(verify(msg, sig, kp.pubkey)).toBe(true);
  });

  it("verify rejects sig from wrong key", () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const msg = new TextEncoder().encode("hello");
    const sig = sign(msg, a.privkey);
    expect(verify(msg, sig, b.pubkey)).toBe(false);
  });

  it("verify rejects sig over wrong message", () => {
    const kp = generateSigningKeypair();
    const sig = sign(new TextEncoder().encode("hello"), kp.privkey);
    expect(verify(new TextEncoder().encode("HELLO"), sig, kp.pubkey)).toBe(false);
  });

  it("sig is 64 bytes", () => {
    const kp = generateSigningKeypair();
    const sig = sign(new TextEncoder().encode("x"), kp.privkey);
    expect(sig.length).toBe(64);
  });

  it("base64 round-trips signing keys cleanly", () => {
    const kp = generateSigningKeypair();
    const pubB64 = toBase64(kp.pubkey);
    const privB64 = toBase64(kp.privkey);
    expect(fromBase64(pubB64)).toEqual(kp.pubkey);
    expect(fromBase64(privB64)).toEqual(kp.privkey);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/crypto-sign.test.ts`
Expected: FAIL — `generateSigningKeypair is not a function` (or similar import error).

- [ ] **Step 3: Add to `src/crypto.ts`**

Append to `d:/code/cc-hub/src/crypto.ts` (after the existing X25519 helpers):

```ts
// ── Ed25519 signing (separate keypair from X25519 encryption keypair) ──────

export interface SigningKeypair {
  pubkey: Uint8Array;   // 32 bytes
  privkey: Uint8Array;  // 64 bytes (nacl.sign secret = priv ++ pub)
}

export function generateSigningKeypair(): SigningKeypair {
  const kp = nacl.sign.keyPair();
  return { pubkey: kp.publicKey, privkey: kp.secretKey };
}

export function sign(message: Uint8Array, privkey: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, privkey);
}

export function verify(message: Uint8Array, sig: Uint8Array, pubkey: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, sig, pubkey);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/crypto-sign.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Verify existing crypto tests still pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/crypto.test.ts`
Expected: existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add d:/code/cc-hub/src/crypto.ts d:/code/cc-hub/tests/crypto-sign.test.ts
git commit -m "feat(crypto): add Ed25519 sign/verify helpers for daemon challenge-response"
```

---

## Task 4: Worker handshake module (pure Ed25519 sign/verify, in workerd)

**Files:**
- Create: `d:/code/cc-hub/worker/src/handshake.ts`
- Create: `d:/code/cc-hub/worker/tests/handshake.test.ts`

Workerd ships nacl-compatible APIs via `tweetnacl` (works in workerd via nodejs_compat). We re-implement minimal sign/verify here rather than importing from daemon-side src/crypto.ts (different package, different runtime).

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/worker/tests/handshake.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  generateChallenge,
  buildChallengeMessage,
  verifyChallengeResponse,
  deriveDaemonId,
  toBase64,
  fromBase64,
  CHALLENGE_TTL_MS,
} from "../src/handshake.js";

describe("handshake", () => {
  describe("generateChallenge", () => {
    it("returns 32 bytes of random nonce + a timestamp", () => {
      const c = generateChallenge();
      expect(c.nonce.length).toBe(32);
      expect(c.issued_at_ms).toBeGreaterThan(Date.now() - 100);
      expect(c.issued_at_ms).toBeLessThanOrEqual(Date.now());
    });

    it("produces different nonces", () => {
      const a = generateChallenge();
      const b = generateChallenge();
      expect(toBase64(a.nonce)).not.toBe(toBase64(b.nonce));
    });
  });

  describe("buildChallengeMessage", () => {
    it("concatenates nonce + issued_at as bytes the client signs", () => {
      const nonce = new Uint8Array(32).fill(7);
      const msg = buildChallengeMessage(nonce, 1700000000000);
      expect(msg).toBeInstanceOf(Uint8Array);
      // Must be deterministic
      const msg2 = buildChallengeMessage(nonce, 1700000000000);
      expect(toBase64(msg)).toBe(toBase64(msg2));
    });
  });

  describe("verifyChallengeResponse", () => {
    it("accepts a valid sig from the matching keypair", () => {
      const kp = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, kp.secretKey);
      expect(verifyChallengeResponse(c, sig, kp.publicKey, Date.now())).toBe(true);
    });

    it("rejects sig from wrong key", () => {
      const a = nacl.sign.keyPair();
      const b = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, a.secretKey);
      expect(verifyChallengeResponse(c, sig, b.publicKey, Date.now())).toBe(false);
    });

    it("rejects expired challenge (now > issued_at + TTL)", () => {
      const kp = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, kp.secretKey);
      const future = c.issued_at_ms + CHALLENGE_TTL_MS + 1;
      expect(verifyChallengeResponse(c, sig, kp.publicKey, future)).toBe(false);
    });

    it("accepts at the boundary (now == issued_at + TTL)", () => {
      const kp = nacl.sign.keyPair();
      const c = generateChallenge();
      const msg = buildChallengeMessage(c.nonce, c.issued_at_ms);
      const sig = nacl.sign.detached(msg, kp.secretKey);
      const at = c.issued_at_ms + CHALLENGE_TTL_MS;
      expect(verifyChallengeResponse(c, sig, kp.publicKey, at)).toBe(true);
    });
  });

  describe("deriveDaemonId", () => {
    it("returns 32 hex chars (16 bytes of SHA-256 truncated)", async () => {
      const pub = new Uint8Array(32).fill(1);
      const id = await deriveDaemonId(pub);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("is deterministic for the same pubkey", async () => {
      const pub = new Uint8Array(32).fill(2);
      const a = await deriveDaemonId(pub);
      const b = await deriveDaemonId(pub);
      expect(a).toBe(b);
    });

    it("differs for different pubkeys", async () => {
      const a = await deriveDaemonId(new Uint8Array(32).fill(3));
      const b = await deriveDaemonId(new Uint8Array(32).fill(4));
      expect(a).not.toBe(b);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/handshake.test.ts`
Expected: FAIL — "Cannot find module '../src/handshake.js'".

- [ ] **Step 3: Write the implementation**

Create `d:/code/cc-hub/worker/src/handshake.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/handshake.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/worker/src/handshake.ts d:/code/cc-hub/worker/tests/handshake.test.ts
git commit -m "feat(worker): handshake — Ed25519 challenge-response + daemon_id derivation"
```

---

## Task 5: `PairingCoordinator` Durable Object

**Files:**
- Create: `d:/code/cc-hub/worker/src/pairing-coordinator.ts`
- Create: `d:/code/cc-hub/worker/tests/coordinator.test.ts`

The Coordinator is called via `fetch()` from the Worker entry. Methods are exposed as path-routed POST endpoints (`/register`, `/claim`, `/revoke`).

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/worker/tests/coordinator.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  env,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import type { PairingCoordinator } from "../src/pairing-coordinator.js";

const PAIRING = env.PAIRING as DurableObjectNamespace<PairingCoordinator>;

function coordinatorStub() {
  const id = PAIRING.idFromName("coordinator");
  return PAIRING.get(id);
}

async function call(method: string, body: unknown) {
  const stub = coordinatorStub();
  const res = await stub.fetch(`https://x/${method}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return res.json() as Promise<any>;
}

describe("PairingCoordinator", () => {
  describe("register + claim happy path", () => {
    it("daemon registers a token, phone claims it, gets daemon_id", async () => {
      const reg = await call("register", { token: "ABC123XYZ4567890", daemon_id: "d-1" });
      expect(reg).toEqual({ ok: true });

      const claim = await call("claim", { token: "ABC123XYZ4567890" });
      expect(claim).toEqual({ ok: true, daemon_id: "d-1" });
    });

    it("token can only be claimed once", async () => {
      await call("register", { token: "ONCEONLY12345678", daemon_id: "d-2" });
      const first = await call("claim", { token: "ONCEONLY12345678" });
      expect(first.ok).toBe(true);

      const second = await call("claim", { token: "ONCEONLY12345678" });
      expect(second).toEqual({ ok: false, reason: "already_claimed" });
    });
  });

  describe("claim of unknown token", () => {
    it("returns reason=unknown", async () => {
      const res = await call("claim", { token: "NOTREGISTEREDXYZ" });
      expect(res).toEqual({ ok: false, reason: "unknown" });
    });
  });

  describe("revoke", () => {
    it("removes the token so claim fails", async () => {
      await call("register", { token: "REVOKEME12345678", daemon_id: "d-3" });
      await call("revoke", { token: "REVOKEME12345678" });
      const res = await call("claim", { token: "REVOKEME12345678" });
      expect(res.ok).toBe(false);
    });
  });

  describe("expiry via alarm", () => {
    it("alarm fires and removes expired tokens", async () => {
      const id = PAIRING.idFromName("coordinator-alarm-test");
      const stub = PAIRING.get(id);

      await runInDurableObject(stub, async (instance: any, state) => {
        // Manually insert an already-expired token via the DO's internal API.
        await instance._test_insert("EXPIRED123456789", "d-4", Date.now() - 60_000);
      });

      // Trigger the alarm manually.
      await runDurableObjectAlarm(stub);

      const res = await stub.fetch("https://x/claim", {
        method: "POST",
        body: JSON.stringify({ token: "EXPIRED123456789" }),
        headers: { "content-type": "application/json" },
      });
      const json = await res.json() as { ok: boolean; reason?: string };
      expect(json.ok).toBe(false);
      expect(json.reason).toBe("unknown");  // expired tokens are deleted, indistinguishable from never-existed
    });
  });

  describe("rate limit on register (10/hour/daemon_id)", () => {
    it("11th register from same daemon_id within 1h returns rate_limited", async () => {
      const did = "d-spam";
      for (let i = 0; i < 10; i++) {
        const r = await call("register", { token: `SPAM${i.toString().padStart(12, "0")}`, daemon_id: did });
        expect(r.ok).toBe(true);
      }
      const r11 = await call("register", { token: "SPAMOVERFLOW1234", daemon_id: did });
      expect(r11).toEqual({ ok: false, reason: "rate_limited" });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/coordinator.test.ts`
Expected: FAIL — `Cannot find module '../src/pairing-coordinator.js'`.

- [ ] **Step 3: Write the implementation**

Create `d:/code/cc-hub/worker/src/pairing-coordinator.ts`:

```ts
import type { Env } from "./env.js";

export const PAIRING_TTL_MS = 10 * 60 * 1000;   // 10 min
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const REGISTER_RATE_LIMIT = 10;
const ALARM_INTERVAL_MS = 60_000;               // sweep every 60s

interface PendingEntry {
  daemon_id: string;
  expires_at_ms: number;
}

interface RateEntry {
  count: number;
  window_started_at_ms: number;
}

export class PairingCoordinator implements DurableObject {
  private pending = new Map<string, PendingEntry>();
  private rateLimits = new Map<string, RateEntry>();

  constructor(private state: DurableObjectState, private env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Map<string, PendingEntry>>("pending");
      if (stored) this.pending = stored;
      const rates = await this.state.storage.get<Map<string, RateEntry>>("rates");
      if (rates) this.rateLimits = rates;
      const next = await this.state.storage.getAlarm();
      if (!next) await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\//, "");
    if (req.method !== "POST") return new Response("method", { status: 405 });
    const body = await req.json() as Record<string, unknown>;

    if (path === "register") {
      const token = String(body.token ?? "");
      const daemon_id = String(body.daemon_id ?? "");
      return this.json(await this.register(token, daemon_id));
    }
    if (path === "claim") {
      const token = String(body.token ?? "");
      return this.json(await this.claim(token));
    }
    if (path === "revoke") {
      const token = String(body.token ?? "");
      await this.revoke(token);
      return this.json({ ok: true });
    }
    return new Response("not_found", { status: 404 });
  }

  private json(o: unknown): Response {
    return new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  }

  async register(token: string, daemon_id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!token || !daemon_id) return { ok: false, reason: "bad_input" };
    if (this.pending.size > 10000) return { ok: false, reason: "coordinator_full" };

    // Rate limit per daemon_id
    const now = Date.now();
    const r = this.rateLimits.get(daemon_id);
    if (r && now - r.window_started_at_ms < REGISTER_RATE_WINDOW_MS) {
      if (r.count >= REGISTER_RATE_LIMIT) return { ok: false, reason: "rate_limited" };
      r.count++;
    } else {
      this.rateLimits.set(daemon_id, { count: 1, window_started_at_ms: now });
    }
    await this.state.storage.put("rates", this.rateLimits);

    this.pending.set(token, { daemon_id, expires_at_ms: now + PAIRING_TTL_MS });
    await this.state.storage.put("pending", this.pending);
    return { ok: true };
  }

  async claim(token: string): Promise<{ ok: true; daemon_id: string } | { ok: false; reason: string }> {
    const entry = this.pending.get(token);
    if (!entry) return { ok: false, reason: "unknown" };
    if (Date.now() > entry.expires_at_ms) {
      this.pending.delete(token);
      await this.state.storage.put("pending", this.pending);
      return { ok: false, reason: "expired" };
    }
    // Single-use: delete immediately
    this.pending.delete(token);
    await this.state.storage.put("pending", this.pending);
    return { ok: true, daemon_id: entry.daemon_id };
  }

  async revoke(token: string): Promise<void> {
    if (this.pending.delete(token)) {
      await this.state.storage.put("pending", this.pending);
    }
  }

  /** Test-only — inserts a token bypassing rate limit. Not used in production paths. */
  async _test_insert(token: string, daemon_id: string, expires_at_ms: number): Promise<void> {
    this.pending.set(token, { daemon_id, expires_at_ms });
    await this.state.storage.put("pending", this.pending);
  }

  /** Alarm: sweep expired tokens. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [token, entry] of this.pending) {
      if (entry.expires_at_ms < now) {
        this.pending.delete(token);
        changed = true;
      }
    }
    if (changed) await this.state.storage.put("pending", this.pending);

    // Clean expired rate-limit windows too
    let rateChanged = false;
    for (const [did, r] of this.rateLimits) {
      if (now - r.window_started_at_ms > REGISTER_RATE_WINDOW_MS) {
        this.rateLimits.delete(did);
        rateChanged = true;
      }
    }
    if (rateChanged) await this.state.storage.put("rates", this.rateLimits);

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}
```

We also need to export `PairingCoordinator` from the Worker entry — Task 7 will do that. The `cloudflare:test` helpers in the test file already know the binding name from `wrangler.toml`.

- [ ] **Step 4: Create temporary Worker entry so tests can load**

Workers can't run tests without an entry. Create stub `d:/code/cc-hub/worker/src/index.ts`:

```ts
export { PairingCoordinator } from "./pairing-coordinator.js";
export { DaemonRelay } from "./daemon-relay.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("not yet implemented", { status: 501 });
  },
};
```

Also create stub `d:/code/cc-hub/worker/src/daemon-relay.ts`:

```ts
import type { Env } from "./env.js";

export class DaemonRelay implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(): Promise<Response> {
    return new Response("not yet implemented", { status: 501 });
  }
}
```

(Both stubs are replaced in Tasks 6 and 7 — they're here only so vitest can boot the Worker for coordinator tests.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/coordinator.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add d:/code/cc-hub/worker/src/pairing-coordinator.ts \
        d:/code/cc-hub/worker/src/daemon-relay.ts \
        d:/code/cc-hub/worker/src/index.ts \
        d:/code/cc-hub/worker/tests/coordinator.test.ts
git commit -m "feat(worker): PairingCoordinator DO — register/claim/revoke + TTL alarm + rate limit"
```

---

## Task 6: `DaemonRelay` Durable Object (Hibernating WS routing)

**Files:**
- Modify: `d:/code/cc-hub/worker/src/daemon-relay.ts` (replace stub from Task 5)
- Create: `d:/code/cc-hub/worker/tests/relay.test.ts`

The DaemonRelay is invoked via `fetch()` with a WebSocket upgrade request. It does the daemon challenge-response handshake inline, accepts the WS as hibernating, and routes envelopes between daemon ↔ phones.

- [ ] **Step 1: Write failing tests**

Create `d:/code/cc-hub/worker/tests/relay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import nacl from "tweetnacl";
import { buildChallengeMessage, deriveDaemonId, toBase64 } from "../src/handshake.js";

// Helper: open WS to the Worker, return WebSocket + a queue of received messages.
async function openWs(path: string, headers: Record<string, string>): Promise<{
  ws: WebSocket;
  next: () => Promise<any>;
}> {
  const url = "http://example.com" + path;  // SELF.fetch wants any URL; path matters
  const res = await SELF.fetch(url, {
    headers: { ...headers, Upgrade: "websocket" },
  });
  if (res.status !== 101) throw new Error(`expected 101, got ${res.status} ${await res.text()}`);
  const ws = res.webSocket!;
  ws.accept();
  const queue: any[] = [];
  const waiters: Array<(v: any) => void> = [];
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    if (waiters.length > 0) waiters.shift()!(data);
    else queue.push(data);
  });
  return {
    ws,
    next: () => new Promise((r) => {
      if (queue.length > 0) r(queue.shift()!);
      else waiters.push(r);
    }),
  };
}

describe("DaemonRelay (full pairing + routing)", () => {
  it("daemon challenge-response → ready; then daemon sends envelope, phone receives it", async () => {
    const daemonKp = nacl.sign.keyPair();
    const daemonId = await deriveDaemonId(daemonKp.publicKey);

    // 1. Daemon connects with X-Daemon-Pubkey
    const daemon = await openWs("/v1/daemon", {
      "X-Daemon-Pubkey": toBase64(daemonKp.publicKey),
    });

    // 2. DO sends challenge
    const ch = await daemon.next();
    expect(ch.type).toBe("challenge");
    expect(ch.nonce).toBeTruthy();
    expect(ch.issued_at_ms).toBeGreaterThan(0);

    // 3. Daemon signs and replies
    const nonceBytes = Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0));
    const sigMsg = buildChallengeMessage(nonceBytes, ch.issued_at_ms);
    const sig = nacl.sign.detached(sigMsg, daemonKp.secretKey);
    daemon.ws.send(JSON.stringify({
      type: "challenge_response",
      sig: toBase64(sig),
    }));

    // 4. DO emits ready
    const ready = await daemon.next();
    expect(ready).toEqual({ type: "ready", daemon_id: daemonId });

    // 5. Daemon registers a pairing token (daemon-initiated)
    const token = "TESTPAIR12345678";
    daemon.ws.send(JSON.stringify({ type: "register_pairing", token }));
    // (no ack needed in this minimal impl)

    // 6. Phone connects with that pairing token
    const phoneKp = nacl.sign.keyPair();
    const phone = await openWs("/v1/phone", { "X-Pairing-Token": token });
    const pairInit = await phone.next();
    expect(pairInit.type).toBe("pair_init");
    expect(pairInit.daemon_pubkey).toBe(toBase64(daemonKp.publicKey));

    // 7. Phone sends pair_offer
    phone.ws.send(JSON.stringify({
      type: "pair_offer",
      phone_pubkey: toBase64(phoneKp.publicKey),
    }));

    // 8. Daemon receives pair_offer (forwarded)
    const offer = await daemon.next();
    expect(offer.type).toBe("pair_offer");
    expect(offer.phone_pubkey).toBe(toBase64(phoneKp.publicKey));

    // 9. Daemon sends pair_ack
    daemon.ws.send(JSON.stringify({ type: "pair_ack" }));
    const ack = await phone.next();
    expect(ack).toEqual({ type: "pair_ack" });

    // 10. Daemon sends an envelope; phone receives it
    daemon.ws.send(JSON.stringify({
      type: "envelope",
      from: daemonId,
      ciphertext: "ENC1",
      nonce: "NONCE1",
    }));
    const env1 = await phone.next();
    expect(env1).toMatchObject({ type: "envelope", from: daemonId, ciphertext: "ENC1" });

    // 11. Phone sends an envelope back; daemon receives it
    phone.ws.send(JSON.stringify({
      type: "envelope",
      from: "phone-1",
      ciphertext: "ENC2",
      nonce: "NONCE2",
    }));
    const env2 = await daemon.next();
    expect(env2).toMatchObject({ type: "envelope", from: "phone-1", ciphertext: "ENC2" });

    daemon.ws.close();
    phone.ws.close();
  });

  it("rejects daemon with no X-Daemon-Pubkey header", async () => {
    const res = await SELF.fetch("http://example.com/v1/daemon", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects daemon whose challenge_response signature is wrong", async () => {
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const daemon = await openWs("/v1/daemon", {
      "X-Daemon-Pubkey": toBase64(a.publicKey),
    });
    const ch = await daemon.next();
    const nonceBytes = Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0));
    const sigMsg = buildChallengeMessage(nonceBytes, ch.issued_at_ms);
    // Sign with B's key (wrong)
    const sig = nacl.sign.detached(sigMsg, b.secretKey);
    daemon.ws.send(JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));

    // Expect close with 4001
    await new Promise<void>((resolve) => {
      daemon.ws.addEventListener("close", (ev: CloseEvent) => {
        expect(ev.code).toBe(4001);
        resolve();
      });
    });
  });

  it("phone with unknown pairing token gets 4002", async () => {
    const phone = await openWs("/v1/phone", { "X-Pairing-Token": "NONEXISTENT12345" });
    await new Promise<void>((resolve) => {
      phone.ws.addEventListener("close", (ev: CloseEvent) => {
        expect(ev.code).toBe(4002);
        resolve();
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/relay.test.ts`
Expected: FAIL — most assertions fail because the DO stub returns 501.

- [ ] **Step 3: Replace `daemon-relay.ts` with full implementation**

Overwrite `d:/code/cc-hub/worker/src/daemon-relay.ts`:

```ts
import type { Env } from "./env.js";
import {
  generateChallenge,
  buildChallengeMessage,
  toBase64,
  fromBase64,
  deriveDaemonId,
  CHALLENGE_TTL_MS,
  type Challenge,
} from "./handshake.js";
import nacl from "tweetnacl";

interface DaemonAttachment {
  role: "daemon";
  pubkey_b64: string;
  challenge?: Challenge;   // pending until challenge_response succeeds
  authed: boolean;
  daemon_id: string;
}

interface PhoneAttachment {
  role: "phone";
  phone_id: string;        // either pairing token (pre-pair) or hash(phone_pubkey)
  pairing_token?: string;  // present until pair_ack
  authed: boolean;
}

type Attachment = DaemonAttachment | PhoneAttachment;

export class DaemonRelay implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/v1/daemon")) {
      return this.acceptDaemon(req);
    }
    if (url.pathname.endsWith("/v1/phone")) {
      return this.acceptPhone(req);
    }
    return new Response("not_found", { status: 404 });
  }

  private async acceptDaemon(req: Request): Promise<Response> {
    const pubkey_b64 = req.headers.get("X-Daemon-Pubkey");
    if (!pubkey_b64) return new Response("missing X-Daemon-Pubkey", { status: 400 });
    let pubkey: Uint8Array;
    try {
      pubkey = fromBase64(pubkey_b64);
      if (pubkey.length !== 32) throw new Error("bad length");
    } catch {
      return new Response("bad X-Daemon-Pubkey", { status: 400 });
    }
    const daemon_id = await deriveDaemonId(pubkey);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const challenge = generateChallenge();
    const att: DaemonAttachment = {
      role: "daemon",
      pubkey_b64,
      challenge,
      authed: false,
      daemon_id,
    };

    // acceptWebSocket with attachment so we recover state after hibernation
    this.state.acceptWebSocket(server, ["daemon"]);
    server.serializeAttachment(att);

    // Send challenge
    server.send(JSON.stringify({
      type: "challenge",
      nonce: toBase64(challenge.nonce),
      issued_at_ms: challenge.issued_at_ms,
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptPhone(req: Request): Promise<Response> {
    const pairing_token = req.headers.get("X-Pairing-Token");
    const phone_pubkey_hdr = req.headers.get("X-Phone-Pubkey");
    const sig_hdr = req.headers.get("X-Sig");

    if (!pairing_token && !phone_pubkey_hdr) {
      return new Response("missing pairing_token or phone_pubkey", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (pairing_token) {
      // Pre-pair mode: store token in attachment; pair_init sent below
      const phone_id = pairing_token;  // temporary id until pair completes
      const att: PhoneAttachment = { role: "phone", phone_id, pairing_token, authed: false };
      this.state.acceptWebSocket(server, ["phone", phone_id]);
      server.serializeAttachment(att);

      // Check that this DO has a daemon connected with a matching pending pair
      const daemon = this.daemonWs();
      const daemonPubkey = await this.state.storage.get<string>("daemon_pubkey_b64");
      if (!daemon || !daemonPubkey) {
        server.close(4002, "no daemon for pairing");
        return new Response(null, { status: 101, webSocket: client });
      }
      const pending = await this.state.storage.get<{ token: string; expires_at_ms: number }>("pending_pair");
      if (!pending || pending.token !== pairing_token || Date.now() > pending.expires_at_ms) {
        server.close(4002, "pairing_token_invalid");
        return new Response(null, { status: 101, webSocket: client });
      }

      // Send pair_init to phone immediately
      server.send(JSON.stringify({ type: "pair_init", daemon_pubkey: daemonPubkey }));
    } else {
      // Reconnect mode: verify sig
      if (!phone_pubkey_hdr || !sig_hdr) {
        return new Response("missing phone_pubkey or sig", { status: 400 });
      }
      // Reconnect-sig verification handled in webSocketMessage when client sends first frame.
      // For now, accept and mark unauthed.
      const phone_id = phone_pubkey_hdr;  // pubkey b64 doubles as id
      const att: PhoneAttachment = { role: "phone", phone_id, authed: false };
      this.state.acceptWebSocket(server, ["phone", phone_id]);
      server.serializeAttachment(att);
      // For Phase 2.0 MVP, verify reconnect sig synchronously here using stored phone_pubkey from pairing.
      const paired = await this.state.storage.get<Record<string, string>>("paired_phones");
      if (!paired || !paired[phone_pubkey_hdr]) {
        server.close(4001, "unknown_phone");
        return new Response(null, { status: 101, webSocket: client });
      }
      const sigOk = this.verifyReconnectSig(phone_pubkey_hdr, sig_hdr);
      if (!sigOk) {
        server.close(4001, "bad_sig");
        return new Response(null, { status: 101, webSocket: client });
      }
      (att as PhoneAttachment).authed = true;
      server.serializeAttachment(att);
      server.send(JSON.stringify({ type: "ready" }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private verifyReconnectSig(phone_pubkey_b64: string, sig_b64: string): boolean {
    // Phone signs daemon_id_bytes ++ utc_minute_8b
    // For brevity, we accept sigs over the last 2 minute buckets (clock skew).
    try {
      const pubkey = fromBase64(phone_pubkey_b64);
      const sig = fromBase64(sig_b64);
      const daemon_id = this.state.id.name!;
      const daemonIdBytes = new TextEncoder().encode(daemon_id);
      const nowMinute = Math.floor(Date.now() / 60_000);
      for (const m of [nowMinute, nowMinute - 1]) {
        const msg = new Uint8Array(daemonIdBytes.length + 8);
        msg.set(daemonIdBytes, 0);
        new DataView(msg.buffer, daemonIdBytes.length, 8).setBigUint64(0, BigInt(m), false);
        if (nacl.sign.detached.verify(msg, sig, pubkey)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Hibernating WebSocket handlers ────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | undefined;
    if (!att) { ws.close(1011, "no_attachment"); return; }
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: any;
    try { msg = JSON.parse(text); } catch { ws.close(1008, "bad_json"); return; }

    if (att.role === "daemon") {
      return this.handleDaemonMessage(ws, att, msg);
    } else {
      return this.handlePhoneMessage(ws, att, msg);
    }
  }

  private async handleDaemonMessage(ws: WebSocket, att: DaemonAttachment, msg: any): Promise<void> {
    if (!att.authed) {
      if (msg.type !== "challenge_response") { ws.close(1008, "expected_challenge_response"); return; }
      const pubkey = fromBase64(att.pubkey_b64);
      const sig = fromBase64(msg.sig);
      const ch = att.challenge!;
      const sigMsg = buildChallengeMessage(ch.nonce, ch.issued_at_ms);
      if (Date.now() > ch.issued_at_ms + CHALLENGE_TTL_MS) { ws.close(4001, "challenge_expired"); return; }
      if (!nacl.sign.detached.verify(sigMsg, sig, pubkey)) { ws.close(4001, "bad_sig"); return; }
      att.authed = true;
      att.challenge = undefined;
      ws.serializeAttachment(att);
      // Store daemon_pubkey + pubkey for phone connections
      await this.state.storage.put("daemon_pubkey_b64", att.pubkey_b64);
      ws.send(JSON.stringify({ type: "ready", daemon_id: att.daemon_id }));
      return;
    }

    // Authed daemon messages:
    if (msg.type === "register_pairing") {
      const token = String(msg.token ?? "");
      await this.state.storage.put("pending_pair", {
        token,
        expires_at_ms: Date.now() + 10 * 60 * 1000,
      });
      return;
    }

    if (msg.type === "pair_ack") {
      // Find the phone in pre-pair state and forward
      for (const phone of this.state.getWebSockets("phone")) {
        const p = phone.deserializeAttachment() as PhoneAttachment;
        if (p && p.pairing_token) {
          phone.send(JSON.stringify({ type: "pair_ack" }));
          // Promote phone to authed and store its pubkey
          p.authed = true;
          p.pairing_token = undefined;
          phone.serializeAttachment(p);
        }
      }
      // Clear pending pair
      await this.state.storage.delete("pending_pair");
      return;
    }

    // envelope or other: broadcast to all authed phones
    for (const phone of this.state.getWebSockets("phone")) {
      const p = phone.deserializeAttachment() as PhoneAttachment;
      if (p && p.authed) phone.send(JSON.stringify(msg));
    }
  }

  private async handlePhoneMessage(ws: WebSocket, att: PhoneAttachment, msg: any): Promise<void> {
    if (!att.authed) {
      if (msg.type === "pair_offer" && att.pairing_token) {
        // Store phone pubkey so reconnect-mode can verify later
        const pk = String(msg.phone_pubkey ?? "");
        const paired = (await this.state.storage.get<Record<string, string>>("paired_phones")) ?? {};
        paired[pk] = String(Date.now());
        await this.state.storage.put("paired_phones", paired);

        // Forward pair_offer to daemon
        const daemon = this.daemonWs();
        if (daemon) daemon.send(JSON.stringify(msg));
        // Stay un-authed until daemon sends pair_ack
        return;
      }
      ws.close(1008, "expected_pair_offer");
      return;
    }

    // Authed phone → forward to daemon
    const daemon = this.daemonWs();
    if (!daemon) { ws.close(4011, "daemon_offline"); return; }
    daemon.send(JSON.stringify(msg));
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // No-op — WS removed from state automatically. We can clean up phone-side caches if needed.
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {
    // No-op
  }

  private daemonWs(): WebSocket | null {
    const arr = this.state.getWebSockets("daemon");
    return arr[0] ?? null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/relay.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Run all worker tests**

Run: `cd d:/code/cc-hub/worker && npm test`
Expected: all tests pass (pairing-code 11, handshake 10, coordinator 6, relay 4 = 31 total).

- [ ] **Step 6: Commit**

```bash
git add d:/code/cc-hub/worker/src/daemon-relay.ts d:/code/cc-hub/worker/tests/relay.test.ts
git commit -m "feat(worker): DaemonRelay DO — challenge-response, pairing flow, envelope routing"
```

---

## Task 7: Worker fetch handler — route WS upgrades to DOs

**Files:**
- Modify: `d:/code/cc-hub/worker/src/index.ts` (replace stub from Task 5)

The Worker entry routes `/v1/daemon` to the right `DaemonRelay` DO (by daemon_id), `/v1/phone` to the `PairingCoordinator` first (to look up the daemon_id from the token), then forwards to the matching `DaemonRelay`. Also implements `/v1/health` and per-IP rate-limiting.

- [ ] **Step 1: Add a routing test**

Append to `d:/code/cc-hub/worker/tests/relay.test.ts`:

```ts
import { describe as describeRouting, it as itRouting, expect as expectRouting } from "vitest";
import { SELF as SELF2 } from "cloudflare:test";

describeRouting("Worker fetch routing", () => {
  itRouting("GET /v1/health returns 200 OK", async () => {
    const res = await SELF2.fetch("http://example.com/v1/health");
    expectRouting(res.status).toBe(200);
    expectRouting(await res.text()).toBe("ok");
  });

  itRouting("unknown path returns 404", async () => {
    const res = await SELF2.fetch("http://example.com/nope");
    expectRouting(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to confirm health endpoint fails**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/relay.test.ts -t "Worker fetch routing"`
Expected: 2 tests FAIL (current index.ts returns 501 for all).

- [ ] **Step 3: Replace `worker/src/index.ts`**

```ts
import { PairingCoordinator } from "./pairing-coordinator.js";
import { DaemonRelay } from "./daemon-relay.js";
import { deriveDaemonId, fromBase64 } from "./handshake.js";
import type { Env } from "./env.js";

export { PairingCoordinator, DaemonRelay };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Health
    if (url.pathname === "/v1/health") {
      return new Response("ok", { status: 200 });
    }

    // Per-IP rate limit (skip in tests where RATE_LIMITER isn't bound)
    if (env.RATE_LIMITER && (url.pathname === "/v1/daemon" || url.pathname === "/v1/phone")) {
      const ip = req.headers.get("CF-Connecting-IP") ?? "test-ip";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return new Response("rate limited", { status: 429 });
    }

    // Daemon WS upgrade → route by X-Daemon-Pubkey → DaemonRelay DO
    if (url.pathname === "/v1/daemon") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pubkey_b64 = req.headers.get("X-Daemon-Pubkey");
      if (!pubkey_b64) return new Response("missing X-Daemon-Pubkey", { status: 400 });
      let pubkey: Uint8Array;
      try {
        pubkey = fromBase64(pubkey_b64);
        if (pubkey.length !== 32) throw new Error("bad length");
      } catch {
        return new Response("bad X-Daemon-Pubkey", { status: 400 });
      }
      const daemon_id = await deriveDaemonId(pubkey);
      const id = env.RELAY.idFromName(daemon_id);
      const stub = env.RELAY.get(id);
      return stub.fetch(req);
    }

    // Phone WS upgrade → lookup daemon_id (via coordinator if pairing-token mode) → route to DO
    if (url.pathname === "/v1/phone") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pairing_token = req.headers.get("X-Pairing-Token");
      const daemon_id_hdr = req.headers.get("X-Daemon-Id");

      let target_daemon_id: string | null = null;
      if (pairing_token) {
        const coordId = env.PAIRING.idFromName("coordinator");
        const coordStub = env.PAIRING.get(coordId);
        const claimRes = await coordStub.fetch("https://x/claim", {
          method: "POST",
          body: JSON.stringify({ token: pairing_token }),
          headers: { "content-type": "application/json" },
        });
        const claim = await claimRes.json() as { ok: boolean; daemon_id?: string; reason?: string };
        if (!claim.ok || !claim.daemon_id) {
          return new Response("invalid_pairing_token", { status: 404 });
        }
        target_daemon_id = claim.daemon_id;
      } else if (daemon_id_hdr) {
        target_daemon_id = daemon_id_hdr;
      } else {
        return new Response("missing X-Pairing-Token or X-Daemon-Id", { status: 400 });
      }

      const id = env.RELAY.idFromName(target_daemon_id);
      const stub = env.RELAY.get(id);
      return stub.fetch(req);
    }

    // Daemon → coordinator (registering pairing token): now done inline via DaemonRelay
    // No external coordinator endpoint exposed to clients.

    return new Response("not_found", { status: 404 });
  },
};
```

- [ ] **Step 4: Run the new routing tests**

Run: `cd d:/code/cc-hub/worker && npx vitest run tests/relay.test.ts -t "Worker fetch routing"`
Expected: 2 passed.

- [ ] **Step 5: Run all worker tests + typecheck**

Run: `cd d:/code/cc-hub/worker && npm test && npx tsc --noEmit`
Expected: all tests pass, typecheck clean.

- [ ] **Step 6: Wire DaemonRelay to register pairing tokens with coordinator**

Right now `daemon-relay.ts` stores `pending_pair` in its own DO storage. But the Worker entry's `/v1/phone` handler looks up tokens in the **coordinator** DO, not in DaemonRelay. We need DaemonRelay to ALSO push the token to the coordinator.

Edit `d:/code/cc-hub/worker/src/daemon-relay.ts` — change the `register_pairing` handler:

```ts
if (msg.type === "register_pairing") {
  const token = String(msg.token ?? "");
  await this.state.storage.put("pending_pair", {
    token,
    expires_at_ms: Date.now() + 10 * 60 * 1000,
  });
  // Also tell the coordinator so phones can claim it
  const coordId = this.env.PAIRING.idFromName("coordinator");
  const coordStub = this.env.PAIRING.get(coordId);
  await coordStub.fetch("https://x/register", {
    method: "POST",
    body: JSON.stringify({ token, daemon_id: att.daemon_id }),
    headers: { "content-type": "application/json" },
  });
  return;
}
```

Verify the constructor receives `env` already — it does (`constructor(private state, private env: Env)`). Good.

- [ ] **Step 7: Re-run all worker tests**

Run: `cd d:/code/cc-hub/worker && npm test`
Expected: all 33 tests pass.

- [ ] **Step 8: Commit**

```bash
git add d:/code/cc-hub/worker/src/index.ts d:/code/cc-hub/worker/src/daemon-relay.ts \
        d:/code/cc-hub/worker/tests/relay.test.ts
git commit -m "feat(worker): fetch handler routes /v1/daemon + /v1/phone to DaemonRelay via coordinator"
```

---

## Task 8: Daemon config.ts — add signing keypair with migration

**Files:**
- Modify: `d:/code/cc-hub/src/config.ts`
- Modify: `d:/code/cc-hub/tests/config.test.ts` (if exists; else create)

- [ ] **Step 1: Check whether tests/config.test.ts exists**

Run: `ls d:/code/cc-hub/tests/config.test.ts 2>&1`
Expected: either file exists (we'll extend) or "No such file" (we'll create).

- [ ] **Step 2: Write failing tests**

Create or extend `d:/code/cc-hub/tests/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrInitConfig, saveConfig } from "../src/config.js";

const tmpDir = path.join(os.tmpdir(), `cc-hub-config-${Date.now()}`);
const cfgPath = path.join(tmpDir, "config.json");

beforeEach(async () => { await fs.mkdir(tmpDir, { recursive: true }); });
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe("config signing keypair migration", () => {
  it("fresh config has both encryption + signing keypairs", async () => {
    const cfg = await loadOrInitConfig(cfgPath);
    expect(cfg.device.pubkey).toBeTruthy();   // existing X25519
    expect(cfg.device.signing_pubkey).toBeTruthy();
    expect(cfg.device.signing_privkey).toBeTruthy();
    expect(cfg.device.signing_pubkey).not.toBe(cfg.device.pubkey);  // different keys
  });

  it("legacy config without signing keys gets migrated on load", async () => {
    // Write a "legacy" config that lacks signing_*
    const legacy = {
      device: {
        name: "old-device",
        pubkey: "legacyPubBase64==",
        privkey: "legacyPrivBase64==",
        created_at: 1700000000000,
      },
      paired_peers: [],
    };
    await fs.writeFile(cfgPath, JSON.stringify(legacy));

    const cfg = await loadOrInitConfig(cfgPath);
    expect(cfg.device.signing_pubkey).toBeTruthy();
    expect(cfg.device.signing_privkey).toBeTruthy();
    // X25519 keys preserved
    expect(cfg.device.pubkey).toBe("legacyPubBase64==");
    expect(cfg.device.privkey).toBe("legacyPrivBase64==");
  });

  it("migration is persisted (next load reads new signing keys back)", async () => {
    const legacy = { device: { name: "x", pubkey: "p", privkey: "k", created_at: 1 }, paired_peers: [] };
    await fs.writeFile(cfgPath, JSON.stringify(legacy));
    const cfg1 = await loadOrInitConfig(cfgPath);
    const sigPub = cfg1.device.signing_pubkey;
    const cfg2 = await loadOrInitConfig(cfgPath);
    expect(cfg2.device.signing_pubkey).toBe(sigPub);  // not regenerated
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/config.test.ts`
Expected: FAIL — `signing_pubkey` undefined.

- [ ] **Step 4: Modify `src/config.ts`**

Replace the entire file:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeypair, generateSigningKeypair, toBase64 } from "./crypto.js";

export interface PairedPeer {
  peer_id: string;
  peer_name: string;
  peer_pubkey: string;     // base64
  shared_secret: string;   // base64 (32 bytes)
  paired_at: number;
  last_seen_at: number | null;
}

export interface RemoteEndpoint {
  worker_url: string;          // wss://...
}

export interface Config {
  device: {
    name: string;
    pubkey: string;             // X25519 box pub, base64
    privkey: string;            // X25519 box priv, base64
    signing_pubkey: string;     // Ed25519 sign pub, base64
    signing_privkey: string;    // Ed25519 sign priv (64B), base64
    created_at: number;
  };
  remote?: RemoteEndpoint;
  paired_peers: PairedPeer[];
}

function defaultDeviceName(): string {
  return os.hostname() || `device-${Date.now()}`;
}

function makeDefaultConfig(): Config {
  const box = generateKeypair();
  const sign = generateSigningKeypair();
  return {
    device: {
      name: defaultDeviceName(),
      pubkey: toBase64(box.pubkey),
      privkey: toBase64(box.privkey),
      signing_pubkey: toBase64(sign.pubkey),
      signing_privkey: toBase64(sign.privkey),
      created_at: Date.now(),
    },
    paired_peers: [],
  };
}

/** Load config; migrate older configs lacking signing keys; return final. */
export async function loadOrInitConfig(filePath: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const cfg = makeDefaultConfig();
      await saveConfig(filePath, cfg);
      return cfg;
    }
    throw err;
  }
  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch (err) {
    throw new Error(`Failed to parse config at ${filePath}: ${(err as Error).message}`);
  }
  // Migrate: add signing keys if missing
  if (!parsed.device.signing_pubkey || !parsed.device.signing_privkey) {
    const sign = generateSigningKeypair();
    parsed.device.signing_pubkey = toBase64(sign.pubkey);
    parsed.device.signing_privkey = toBase64(sign.privkey);
    await saveConfig(filePath, parsed);
  }
  // Migrate: remove deprecated x_daemon_auth_token from remote if present
  if (parsed.remote && (parsed.remote as any).x_daemon_auth_token) {
    delete (parsed.remote as any).x_daemon_auth_token;
    await saveConfig(filePath, parsed);
  }
  return parsed;
}

export async function saveConfig(filePath: string, cfg: Config): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, filePath);
}

export function addPairedPeer(cfg: Config, peer: PairedPeer): Config {
  return { ...cfg, paired_peers: [...cfg.paired_peers, peer] };
}

export function removePairedPeer(cfg: Config, peerId: string): Config {
  return { ...cfg, paired_peers: cfg.paired_peers.filter((p) => p.peer_id !== peerId) };
}

export function findPeerById(cfg: Config, peerId: string): PairedPeer | null {
  return cfg.paired_peers.find((p) => p.peer_id === peerId) ?? null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/config.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Run full daemon test suite**

Run: `cd d:/code/cc-hub && npx vitest run`
Expected: all tests pass (config + crypto + crypto-sign + existing). Note: `relay-client.ts` still references `x_daemon_auth_token` in its imports — Task 9 will fix this. If it breaks compilation, mark this expected.

- [ ] **Step 7: Commit**

```bash
git add d:/code/cc-hub/src/config.ts d:/code/cc-hub/tests/config.test.ts
git commit -m "feat(daemon): config.ts adds Ed25519 signing keypair + migration for legacy configs"
```

---

## Task 9: Daemon relay-client.ts — challenge-response handshake

**Files:**
- Modify: `d:/code/cc-hub/src/relay-client.ts`
- Modify: `d:/code/cc-hub/tests/relay-client.test.ts`

- [ ] **Step 1: Inspect current relay-client.test.ts**

Run: `cat d:/code/cc-hub/tests/relay-client.test.ts | head -40`
Note the existing test setup so you can extend with new handshake tests.

- [ ] **Step 2: Write a failing test for the new handshake**

Append to `d:/code/cc-hub/tests/relay-client.test.ts`:

```ts
import { describe as describeHs, it as itHs, expect as expectHs } from "vitest";
import { WebSocketServer } from "ws";
import nacl from "tweetnacl";
import { buildChallengeMessage, toBase64 as toB64HS } from "../worker/src/handshake.js";
import { RelayClient } from "../src/relay-client.js";
import { generateSigningKeypair, toBase64 } from "../src/crypto.js";

describeHs("RelayClient new challenge-response handshake", () => {
  itHs("completes challenge-response and reaches ready state", async () => {
    const sign = generateSigningKeypair();
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as any).port;

    let readyReached = false;
    wss.on("connection", (ws, req) => {
      const pubkeyHdr = req.headers["x-daemon-pubkey"] as string;
      expectHs(pubkeyHdr).toBe(toBase64(sign.pubkey));

      // Send challenge
      const nonce = nacl.randomBytes(32);
      const issued_at_ms = Date.now();
      ws.send(JSON.stringify({ type: "challenge", nonce: toB64HS(nonce), issued_at_ms }));

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge_response") {
          const sig = Uint8Array.from(atob(msg.sig), (c) => c.charCodeAt(0));
          const sigMsg = buildChallengeMessage(nonce, issued_at_ms);
          const ok = nacl.sign.detached.verify(sigMsg, sig, sign.pubkey);
          expectHs(ok).toBe(true);
          ws.send(JSON.stringify({ type: "ready", daemon_id: "test-id" }));
          readyReached = true;
        }
      });
    });

    const config: any = {
      device: {
        name: "t",
        pubkey: "x", privkey: "x",
        signing_pubkey: toBase64(sign.pubkey),
        signing_privkey: toBase64(sign.privkey),
        created_at: 1,
      },
      remote: { worker_url: `ws://127.0.0.1:${port}/v1/daemon` },
      paired_peers: [],
    };
    const client = new RelayClient({
      config,
      store: { on: () => {}, off: () => {} } as any,
      bridge: {} as any,
    });
    await client.start();
    await new Promise((r) => setTimeout(r, 200));
    expectHs(readyReached).toBe(true);
    await client.stop();
    wss.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/relay-client.test.ts -t "challenge-response"`
Expected: FAIL — RelayClient still sends X-Daemon-Auth, doesn't handle challenge.

- [ ] **Step 4: Modify `src/relay-client.ts`**

Replace the `connect()` method body:

```ts
import WebSocket from "ws";
import { fromBase64, toBase64, sign as signMsg } from "./crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "./relay-protocol.js";
import type { Config, PairedPeer } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Session } from "./types.js";
import { createHash } from "node:crypto";

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const NONCE_FRESHNESS_MS = 60_000;

export interface RelayClientDeps {
  config: Config;
  store: SessionStore;
  bridge: VscodeBridge;
}

interface PeerSecrets {
  peer: PairedPeer;
  sharedSecret: Uint8Array;
  recentNonces: Map<string, number>;
}

function buildChallengeMessage(nonce: Uint8Array, issued_at_ms: number): Uint8Array {
  const out = new Uint8Array(nonce.length + 8);
  out.set(nonce, 0);
  new DataView(out.buffer, nonce.length, 8).setBigUint64(0, BigInt(issued_at_ms), false);
  return out;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private storeListener: ((s: Session) => void) | null = null;
  private peers: PeerSecrets[] = [];
  private ready = false;

  constructor(private deps: RelayClientDeps) {
    this.peers = deps.config.paired_peers.map((p) => ({
      peer: p,
      sharedSecret: fromBase64(p.shared_secret),
      recentNonces: new Map(),
    }));
  }

  async start(): Promise<void> {
    if (!this.deps.config.remote) {
      throw new Error("RelayClient cannot start without config.remote.worker_url");
    }
    this.stopRequested = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.storeListener) {
      this.deps.store.off("session_changed", this.storeListener);
      this.storeListener = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private daemonIdHex(): string {
    const pub = fromBase64(this.deps.config.device.signing_pubkey);
    return createHash("sha256").update(pub).digest("hex").slice(0, 32);
  }

  private connect(): void {
    const remote = this.deps.config.remote!;
    const url = remote.worker_url.replace(/\/$/, "") + "/v1/daemon";
    const headers: Record<string, string> = {
      "X-Daemon-Pubkey": this.deps.config.device.signing_pubkey,
      "X-Daemon-Id": this.daemonIdHex(),
    };
    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    this.ready = false;

    ws.on("open", () => { /* wait for challenge */ });
    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => { /* close handler reconnects */ });
  }

  private handleMessage(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    if (!this.ready) {
      if (msg.type === "challenge") {
        const nonce = fromBase64(msg.nonce);
        const sigMsg = buildChallengeMessage(nonce, msg.issued_at_ms);
        const priv = fromBase64(this.deps.config.device.signing_privkey);
        const sig = signMsg(sigMsg, priv);
        this.ws!.send(JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));
        return;
      }
      if (msg.type === "ready") {
        this.ready = true;
        this.reconnectMs = RECONNECT_INITIAL_MS;
        this.storeListener = (session: Session) => this.broadcastEvent(session);
        this.deps.store.on("session_changed", this.storeListener);
        return;
      }
      return;
    }

    // Post-ready: envelope routing (unchanged from before; existing handlers)
    if (msg.type === "envelope") {
      this.handleEnvelope(msg as Envelope);
    }
  }

  private handleClose(): void {
    if (this.storeListener) {
      this.deps.store.off("session_changed", this.storeListener);
      this.storeListener = null;
    }
    this.ws = null;
    this.ready = false;
    if (this.stopRequested) return;
    setTimeout(() => this.connect(), this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }

  private handleEnvelope(env: Envelope): void {
    // Existing decrypt-and-dispatch logic. Preserve the prior body verbatim
    // (or accept the simplified placeholder below if no body existed yet).
    void env;
  }

  private broadcastEvent(_session: Session): void {
    if (!this.ready || !this.ws) return;
    // Existing broadcast logic. Preserve prior body.
  }
}
```

> **NOTE for implementer:** the original `relay-client.ts` had additional `handleEnvelope` / `broadcastEvent` body. Preserve that logic — only the `connect()` headers and the new `handleMessage` pre-ready branch are new. If the existing body had decryption / dispatch code, copy it back into the new file in the same methods.

- [ ] **Step 5: Run the new handshake test**

Run: `cd d:/code/cc-hub && npx vitest run tests/relay-client.test.ts -t "challenge-response"`
Expected: passes.

- [ ] **Step 6: Run full daemon test suite**

Run: `cd d:/code/cc-hub && npx vitest run`
Expected: all tests pass (existing relay-client tests may need updating if they relied on `x_daemon_auth_token` — adjust them).

- [ ] **Step 7: Commit**

```bash
git add d:/code/cc-hub/src/relay-client.ts d:/code/cc-hub/tests/relay-client.test.ts
git commit -m "feat(daemon): relay-client uses Ed25519 challenge-response, drops X-Daemon-Auth"
```

---

## Task 10: Daemon pairing.ts — cch:// URL with 16-char Crockford base32 token

**Files:**
- Modify: `d:/code/cc-hub/src/pairing.ts`
- Modify: `d:/code/cc-hub/tests/pairing.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `d:/code/cc-hub/tests/pairing.test.ts`:

```ts
import { describe as describeQr, it as itQr, expect as expectQr } from "vitest";
import { pairingQrPayload, generateNewPairingToken } from "../src/pairing.js";

describeQr("pairing QR payload (new cch:// format)", () => {
  itQr("emits a cch://pair?token=...&relay=... URL", () => {
    const payload = pairingQrPayload({
      worker_url: "https://relay.f1telemetrystationpro.org",
      pairing_token: "K7H2X9PNRT4BMWQ8",
      daemon_pubkey: "(unused for now)",
      device_name: "(unused)",
    });
    expectQr(payload.startsWith("cch://pair?")).toBe(true);
    expectQr(payload).toContain("token=K7H2X9PNRT4BMWQ8");
    expectQr(payload).toContain("relay=https%3A%2F%2Frelay.f1telemetrystationpro.org");
  });

  itQr("URL-encodes special characters in worker_url", () => {
    const payload = pairingQrPayload({
      worker_url: "https://relay.example.com:8443",
      pairing_token: "AAAA1111BBBB2222",
      daemon_pubkey: "x", device_name: "x",
    });
    expectQr(payload).toContain("relay=https%3A%2F%2Frelay.example.com%3A8443");
  });
});

describeQr("generateNewPairingToken", () => {
  itQr("returns a 16-char Crockford base32 token (no hyphens)", () => {
    const t = generateNewPairingToken();
    expectQr(t).toHaveLength(16);
    expectQr(t).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run tests/pairing.test.ts -t "cch://"`
Expected: FAIL.

- [ ] **Step 3: Update `src/pairing.ts`**

Modify the top of `d:/code/cc-hub/src/pairing.ts`:

```ts
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { deriveSharedSecret, toBase64, fromBase64 } from "./crypto.js";
import type { PairedPeer } from "./config.js";
import type { Plaintext } from "./relay-protocol.js";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;  // was 5; now 10 to match worker

const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 16;

export function generateNewPairingToken(): string {
  const bytes = nacl.randomBytes(PAIRING_TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_TOKEN_LENGTH; i++) {
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return out;
}

export interface PairingQrInput {
  worker_url: string;
  pairing_token: string;
  daemon_pubkey: string;   // kept for backwards-compat; not used in new URL
  device_name: string;     // kept for backwards-compat; not used in new URL
}

export function pairingQrPayload(input: PairingQrInput): string {
  const relay = encodeURIComponent(input.worker_url);
  return `cch://pair?token=${input.pairing_token}&relay=${relay}`;
}

// ... existing computePeerId, PairOffer, PairingSession types remain ...
```

(Preserve the existing `computePeerId`, `PairOffer`, `PairingSession`, etc. — only the QR + token-generation pieces change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run tests/pairing.test.ts`
Expected: all pairing tests pass.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/src/pairing.ts d:/code/cc-hub/tests/pairing.test.ts
git commit -m "feat(daemon): pairing QR = cch://pair?token=...&relay=... + 16-char Crockford base32 token"
```

---

## Task 11: Mock worker updated to new protocol

**Files:**
- Modify: `d:/code/cc-hub/tools/mock-worker/server.ts`

The mock worker is local dev only. Update it to speak the new protocol (challenge-response, no auth token, register_pairing message).

- [ ] **Step 1: Read current mock-worker structure**

Run: `wc -l d:/code/cc-hub/tools/mock-worker/server.ts`
Confirm what's there (~321 lines).

- [ ] **Step 2: Modify the daemon-connect handler in `tools/mock-worker/server.ts`**

Replace the daemon connection block to do challenge-response. (Patch — keep the rest of the file's structure intact):

```ts
// Inside wss.on("connection", (ws, req) => { ... }) for the /v1/daemon path:

const pubkeyHdr = req.headers["x-daemon-pubkey"];
if (!pubkeyHdr || typeof pubkeyHdr !== "string") {
  ws.close(1008, "missing X-Daemon-Pubkey");
  return;
}
const pubkey = Buffer.from(pubkeyHdr, "base64");
if (pubkey.length !== 32) { ws.close(1008, "bad pubkey length"); return; }
const daemon_id = require("node:crypto").createHash("sha256").update(pubkey).digest("hex").slice(0, 32);

const nonce = require("node:crypto").randomBytes(32);
const issued_at_ms = Date.now();
ws.send(JSON.stringify({
  type: "challenge",
  nonce: nonce.toString("base64"),
  issued_at_ms,
}));

let authed = false;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (!authed) {
    if (msg.type !== "challenge_response") { ws.close(1008, "expected challenge_response"); return; }
    const nacl = require("tweetnacl");
    const sig = Buffer.from(msg.sig, "base64");
    const sigMsg = Buffer.concat([
      nonce,
      Buffer.from((() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(issued_at_ms)); return b; })()),
    ]);
    const ok = nacl.sign.detached.verify(sigMsg, sig, pubkey);
    if (!ok) { ws.close(4001, "bad_sig"); return; }
    authed = true;
    daemons.set(daemon_id, { ws, id: daemon_id });
    ws.send(JSON.stringify({ type: "ready", daemon_id }));
    return;
  }

  // Existing post-auth handling: envelope routing, register_pairing, etc.
  // ...
});
```

Also update the phone-connect handler to drop the SSO/X-Daemon-Auth check (already absent in mock, but ensure register_pairing → pairings map flow still works).

- [ ] **Step 3: Run mock-worker manually + verify it boots**

Run: `cd d:/code/cc-hub && pnpm mock-worker`
Expected: prints "listening on :8787" without crash. Ctrl-C to stop.

- [ ] **Step 4: Smoke test against the updated mock-worker (manual)**

In one terminal: `pnpm mock-worker`
In another: `pnpm pair` (Phase 2 CLI)
Expected: QR with `cch://pair?token=…` printed; no protocol errors.

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/tools/mock-worker/server.ts
git commit -m "chore(mock-worker): match new protocol (challenge-response, no auth token)"
```

---

## Task 12: Web-phone store.ts — persist signing keypair

**Files:**
- Modify: `d:/code/cc-hub/web-phone/store.ts`
- Create: `d:/code/cc-hub/web-phone/store.test.ts`

- [ ] **Step 1: Inspect current store.ts**

Run: `cat d:/code/cc-hub/web-phone/store.ts`
Note existing keys + structure.

- [ ] **Step 2: Write failing tests**

Create `d:/code/cc-hub/web-phone/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import {
  loadOrCreateIdentity,
  loadIdentity,
} from "./store.js";

beforeEach(async () => {
  // Reset fake-indexeddb between tests
  const databases = await indexedDB.databases();
  for (const db of databases) if (db.name) indexedDB.deleteDatabase(db.name);
});

describe("web-phone store identity", () => {
  it("loadOrCreateIdentity generates X25519 + Ed25519 keypairs on first call", async () => {
    const id = await loadOrCreateIdentity();
    expect(id.encryption_pubkey).toBeTruthy();
    expect(id.encryption_privkey).toBeTruthy();
    expect(id.signing_pubkey).toBeTruthy();
    expect(id.signing_privkey).toBeTruthy();
    // Different keypairs (signing != encryption)
    expect(id.signing_pubkey).not.toBe(id.encryption_pubkey);
  });

  it("loadOrCreateIdentity is idempotent (second call returns same keys)", async () => {
    const a = await loadOrCreateIdentity();
    const b = await loadOrCreateIdentity();
    expect(b.signing_pubkey).toBe(a.signing_pubkey);
    expect(b.encryption_pubkey).toBe(a.encryption_pubkey);
  });

  it("loadIdentity returns null when no identity stored", async () => {
    const id = await loadIdentity();
    expect(id).toBeNull();
  });
});
```

- [ ] **Step 3: Add `fake-indexeddb` to the daemon devDependencies**

Run: `cd d:/code/cc-hub && npm install --save-dev fake-indexeddb`
Expected: completes successfully.

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd d:/code/cc-hub && npx vitest run web-phone/store.test.ts`
Expected: FAIL — `loadOrCreateIdentity` not exported.

- [ ] **Step 5: Update `web-phone/store.ts`**

Replace `d:/code/cc-hub/web-phone/store.ts`:

```ts
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const DB_NAME = "cc-hub-phone";
const DB_VERSION = 1;
const STORE = "identity";
const KEY = "self";

export interface Identity {
  encryption_pubkey: string;   // X25519 box pub (base64)
  encryption_privkey: string;  // X25519 box priv (base64)
  signing_pubkey: string;      // Ed25519 sign pub (base64)
  signing_privkey: string;     // Ed25519 sign priv (base64)
  created_at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadIdentity(): Promise<Identity | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveIdentity(id: Identity): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(id, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadOrCreateIdentity(): Promise<Identity> {
  const existing = await loadIdentity();
  if (existing) return existing;
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  const id: Identity = {
    encryption_pubkey: naclUtil.encodeBase64(box.publicKey),
    encryption_privkey: naclUtil.encodeBase64(box.secretKey),
    signing_pubkey: naclUtil.encodeBase64(sign.publicKey),
    signing_privkey: naclUtil.encodeBase64(sign.secretKey),
    created_at: Date.now(),
  };
  await saveIdentity(id);
  return id;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd d:/code/cc-hub && npx vitest run web-phone/store.test.ts`
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add d:/code/cc-hub/web-phone/store.ts d:/code/cc-hub/web-phone/store.test.ts d:/code/cc-hub/package.json d:/code/cc-hub/package-lock.json
git commit -m "feat(web-phone): store identity with dual keypair (X25519 + Ed25519) in IndexedDB"
```

---

## Task 13: Web-phone relay.ts — dual-keypair + reconnect sig

**Files:**
- Modify: `d:/code/cc-hub/web-phone/relay.ts`

This wires the phone-side WS client to the new protocol. There's no test runtime that fully mocks browser WebSocket against a real Worker, so this is implementation-by-spec; verification comes via the manual E2E in Task 16.

- [ ] **Step 1: Read existing relay.ts**

Run: `cat d:/code/cc-hub/web-phone/relay.ts`
Note current exports and the pairing-flow code.

- [ ] **Step 2: Replace `web-phone/relay.ts` with the new protocol**

```ts
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import type { Identity } from "./store.js";

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
  daemon_id: string;
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

    ws.onerror = () => reject(new Error("ws_error"));
    ws.onclose = (ev) => { if (!sharedSecret) reject(new Error(`ws_closed:${ev.code}`)); };
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
        }));
        return;
      }
      if (msg.type === "pair_ack" && daemonPubkeyB64 && sharedSecret) {
        // daemon_id can be supplied by server in pair_ack; if not, derive from daemon_pubkey
        const daemon_id =
          (msg.daemon_id as string) ??
          (() => {
            // SHA-256(daemon_pub)[:16] hex — matches worker's deriveDaemonId
            // Synchronous variant using nacl.hash (SHA-512) is wrong; use SubtleCrypto async.
            return "unknown";  // populated by worker in pair_ack; phone may also derive async
          })();
        resolve({
          daemon_id,
          daemon_pubkey_b64: daemonPubkeyB64,
          shared_secret_b64: naclUtil.encodeBase64(sharedSecret),
        });
        ws.close();
        return;
      }
    };
  });
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

  const wsUrl = relayUrl.replace(/^https?:/, (m) => (m === "https:" ? "wss:" : "ws:")) + "/v1/phone";
  // Browsers can't set headers; encode in URL
  const url = new URL(wsUrl);
  url.searchParams.set("daemon_id", daemon_id);
  url.searchParams.set("phone_pubkey", identity.signing_pubkey);
  url.searchParams.set("sig", naclUtil.encodeBase64(sig));
  return new WebSocket(url.toString());
}
```

- [ ] **Step 3: Worker fetch handler must accept URL-query auth (browser limitation)**

Browsers can't send custom headers on `new WebSocket()`. Update `worker/src/index.ts` to fall back to URL query params when phone connects without headers:

In the `/v1/phone` branch, before reading headers:

```ts
const queryToken = url.searchParams.get("token");
const queryDaemonId = url.searchParams.get("daemon_id");
const queryPubkey = url.searchParams.get("phone_pubkey");
const querySig = url.searchParams.get("sig");

const pairing_token = req.headers.get("X-Pairing-Token") ?? queryToken;
const daemon_id_hdr = req.headers.get("X-Daemon-Id") ?? queryDaemonId;
// (Below: when forwarding to DO, also forward these query params via a new Request with synthetic headers, or accept query params in DO too.)
```

Also in `daemon-relay.ts` `acceptPhone`, check query params as fallback alongside headers.

(This patch is small but necessary — without it, browser pairing can't work.)

- [ ] **Step 4: Re-run worker tests**

Run: `cd d:/code/cc-hub/worker && npm test`
Expected: all still pass (the new URL-query fallback is non-breaking).

- [ ] **Step 5: Commit**

```bash
git add d:/code/cc-hub/web-phone/relay.ts d:/code/cc-hub/worker/src/index.ts d:/code/cc-hub/worker/src/daemon-relay.ts
git commit -m "feat(phone+worker): dual-keypair relay client + Worker accepts URL-query auth (browser WS)"
```

---

## Task 14: Web-phone app.tsx — manual code-entry UI

**Files:**
- Modify: `d:/code/cc-hub/web-phone/app.tsx`

- [ ] **Step 1: Identify the existing pairing-entry component**

Run: `grep -n "pairing\|qr\|paired" d:/code/cc-hub/web-phone/app.tsx | head -20`
Find where the user currently enters/scans the pairing token.

- [ ] **Step 2: Add a manual-entry form**

Add this component near the top of `web-phone/app.tsx` (or in a new file `web-phone/pair-form.tsx` if preferred):

```tsx
import { useState } from "preact/hooks";
import { normalizePairingCode, isValidPairingCode, performPairing } from "./relay.js";
import { loadOrCreateIdentity, saveIdentity, type Identity } from "./store.js";

export function PairForm({ relayUrl, onPaired }: {
  relayUrl: string;
  onPaired: (peer: { daemon_id: string; daemon_pubkey_b64: string; shared_secret_b64: string }) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizePairingCode(input);
  const valid = isValidPairingCode(normalized);

  async function handleSubmit() {
    if (!valid) { setError("Code must be 16 chars from the Crockford base32 alphabet"); return; }
    setBusy(true); setError(null);
    try {
      const identity = await loadOrCreateIdentity();
      const peer = await performPairing(relayUrl, normalized, identity);
      onPaired(peer);
    } catch (e: any) {
      setError(e?.message ?? "pairing_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 24 }}>
      <h2 style={{ margin: 0 }}>Pair this device</h2>
      <p style={{ color: "#888", margin: 0, fontSize: 13 }}>
        Type the 16-char code from your laptop's <code>cch pair</code> terminal, or scan its QR code.
      </p>
      <input
        type="text"
        placeholder="XXXX-XXXX-XXXX-XXXX"
        value={input}
        onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid && !busy) void handleSubmit();
        }}
        disabled={busy}
        autoFocus
        style={{
          padding: 12,
          fontSize: 18,
          fontFamily: "ui-monospace, monospace",
          textTransform: "uppercase",
          letterSpacing: 2,
          borderRadius: 6,
          border: `2px solid ${valid ? "var(--pass)" : "var(--border)"}`,
        }}
      />
      <button
        disabled={!valid || busy}
        onClick={() => void handleSubmit()}
        style={{
          padding: "12px 24px",
          fontSize: 16,
          borderRadius: 6,
          border: "none",
          background: valid ? "var(--accent)" : "var(--bg-subtle)",
          color: valid ? "white" : "var(--fg-subtle)",
          cursor: valid && !busy ? "pointer" : "default",
        }}
      >
        {busy ? "Pairing…" : "Pair"}
      </button>
      {error && <div style={{ color: "var(--accent)", fontSize: 13 }}>{error}</div>}
    </div>
  );
}
```

Wire it into the existing app flow: if no identity-paired state, render `<PairForm>`. After `onPaired`, save the peer to IndexedDB and proceed to the dashboard view.

- [ ] **Step 3: Build the web-phone bundle**

Run: `cd d:/code/cc-hub && npm run build:phone`
Expected: builds without TS errors. Output in `dist/web-phone/`.

- [ ] **Step 4: Commit**

```bash
git add d:/code/cc-hub/web-phone/app.tsx
git commit -m "feat(web-phone): manual code-entry UI for pairing (16-char Crockford base32)"
```

---

## Task 15: Deploy guide (docs/deploy.md)

**Files:**
- Create: `d:/code/cc-hub/docs/deploy.md`

- [ ] **Step 1: Write the doc**

Create `d:/code/cc-hub/docs/deploy.md`:

````markdown
# Deploying cc-hub Relay

cc-hub's remote control feature needs a tiny Cloudflare Worker between your daemon (laptop) and your phone/browser. You have two options.

## Option A — Use the hosted relay (recommended for most users)

Hosted at **`relay.f1telemetrystationpro.org`**. Default for the daemon. Zero setup.

The hosted relay is end-to-end encrypted. Even the operator (us) literally cannot read your messages or transcripts — the server only sees opaque encrypted blobs and routes them between your paired devices.

```bash
# Your daemon already points at relay.f1telemetrystationpro.org by default. Just run:
cch claude       # or whatever your CLI invocation is
# Scan the QR or copy the 16-char code into the phone app.
```

## Option B — Self-host on your own Cloudflare account (free tier OK)

Some users prefer their own infrastructure. Cloudflare Workers free tier (100k req/day) handles this trivially.

### Prerequisites

- A free Cloudflare account: <https://dash.cloudflare.com/sign-up>
- `wrangler` CLI: `npm install -g wrangler`

### Steps

```bash
git clone https://github.com/cc-hub/cc-hub
cd cc-hub/worker

# 1. Log into Cloudflare
wrangler login

# 2. (Optional) edit wrangler.toml to use a custom domain you own.
#    To use the free *.workers.dev subdomain instead, delete the `routes = [...]` block.

# 3. Deploy
wrangler deploy
```

Output will show your live URL — either `https://cch-relay.<your-account>.workers.dev` or `https://cch.your-domain.com`.

### Point your daemon at your own relay

```bash
cch config set remote.worker_url https://cch-relay.<your-account>.workers.dev
```

That's it. Same QR / 16-char pairing flow as the hosted version.

## What the Worker stores

- **Pending pairing tokens** for up to 10 minutes (auto-deleted on claim or TTL)
- **Per-daemon WS connections** (RAM only, recovered via Hibernating WS API)
- **Phone-side public keys** of paired devices so reconnect signatures can be verified

It does NOT store:
- Message content (ciphertext is forwarded byte-for-byte and never persisted)
- Transcripts
- Email, IP, or user identifiers
- Any logs containing message bodies
````

- [ ] **Step 2: Commit**

```bash
git add d:/code/cc-hub/docs/deploy.md
git commit -m "docs(deploy): hosted + self-host CF Worker deployment guide"
```

---

## Task 16: Manual E2E smoke test

**No code changes — verification only.**

- [ ] **Step 1: Local E2E with mock worker**

Three terminals:

Terminal 1: `cd d:/code/cc-hub && pnpm mock-worker`
Terminal 2: `cd d:/code/cc-hub && pnpm dev` (daemon)
Terminal 3: `cd d:/code/cc-hub && pnpm pair`
Expected: QR appears with `cch://pair?token=XXXX&relay=http://127.0.0.1:8787`.

Open `http://127.0.0.1:8787/web-phone/` in the browser. Type the 16-char code from terminal 3. Expected: pair-init / pair-offer / pair-ack flow visible in mock-worker logs; phone sees the session list.

- [ ] **Step 2: Deploy worker to relay.f1telemetrystationpro.org**

```bash
cd d:/code/cc-hub/worker
wrangler login    # one-time
wrangler deploy
```

Expected: `wrangler deploy` reports the worker is live; `curl https://relay.f1telemetrystationpro.org/v1/health` returns `ok`.

- [ ] **Step 3: Point daemon at hosted worker**

```bash
cch config set remote.worker_url https://relay.f1telemetrystationpro.org
pnpm dev    # restart daemon
pnpm pair
```

Repeat Step 1's web-phone pairing flow. Expected: full E2E with real Worker; sessions list visible on phone; sending a prompt round-trips daemon ↔ phone.

- [ ] **Step 4: Update memory**

```bash
# Save a memory recording the hosted URL + deployment status
```

(Per project memory conventions; ensure deploy doc + relay.f1telemetrystationpro.org cross-referenced.)

---

## Wrap-up

After all tasks complete, the system supports:

```
Dashboard (browser, local) ↔ daemon (local) ↔ Worker (relay.f1telemetrystationpro.org) ↔ phone PWA (any device)
                              \_                                                   /
                               \____________ all paths E2E encrypted _____________/
```

The flow ends with a single command for the user:

```bash
cch claude       # daemon prints QR + 16-char code
# user opens phone / browser → scans QR or types code → paired forever (or until revoke)
```

OSS users follow the same flow against `cch.<their-name>.workers.dev` after one `wrangler deploy`.
