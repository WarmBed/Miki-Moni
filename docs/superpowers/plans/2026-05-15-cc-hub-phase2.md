# cc-hub Phase 2 v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local daemon side of an end-to-end encrypted remote-access path: phone/browser → Cloudflare Worker (user writes) → cc-hub daemon. Worker is a blind pubsub pipe; TweetNaCl X25519 + secretbox provides E2E so Worker cannot read prompts or session state.

**Architecture:** Daemon connects outbound (WSS) to user's Worker. Each paired peer (phone) has a long-term X25519 keypair; pairing derives a shared secret via Curve25519 ECDH that the Worker never sees. All subsequent messages are wrapped in `nacl.secretbox` envelopes. Pairing happens via terminal QR (5-min token, scanned by phone). Supports multiple paired devices.

**Tech Stack:** TweetNaCl + tweetnacl-util (crypto), qrcode-terminal (CLI QR), reuses Phase 1 ws + express + better-sqlite3.

**Spec reference:** `docs/superpowers/specs/2026-05-15-cc-hub-phase2-design.md`

---

## File Structure (lock-in — additions only; Phase 1 files unchanged except `src/index.ts` wiring)

```
src/
  crypto.ts            (Task 2)   TweetNaCl wrapper: keypair, derive, encrypt, decrypt, base64
  config.ts            (Task 3)   ~/.cc-hub/config.json CRUD, atomic write
  relay-protocol.ts    (Task 4)   Envelope + plaintext message types + encode/decode
  pairing.ts           (Task 5)   PairingSession state machine + QR payload + render
  relay-client.ts      (Task 6)   Outbound WS to Worker, reconnect, dispatch
  cli/
    pair.ts            (Task 7)   `pnpm pair --new|--list|--revoke` CLI
  index.ts             (Task 8)   MODIFIED: read config, optionally start RelayClient

tests/
  crypto.test.ts       (Task 2)
  config.test.ts       (Task 3)
  relay-protocol.test.ts (Task 4)
  pairing.test.ts      (Task 5)
  relay-client.test.ts (Task 6)
  integration-relay.test.ts (Task 9)  end-to-end with in-process mock Worker

docs/protocols/        (Task 10)
  relay-protocol.md
  pairing-protocol.md
  worker-skeleton.md
```

Each new file ≤ ~200 lines. Tests live next to the unit they cover.

---

## Task 1: Install Phase 2 Dependencies + Gitignore Cleanup

**Files:**
- Modify: `d:/code/cc-hub/package.json`
- Modify: `d:/code/cc-hub/.gitignore`

- [ ] **Step 1: Add Phase 2 deps to package.json**

Edit `dependencies` and `devDependencies` in `package.json`:

```json
{
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^5.0.0",
    "node-notifier": "^10.0.1",
    "pino": "^9.4.0",
    "qrcode-terminal": "^0.12.0",
    "tweetnacl": "^1.0.3",
    "tweetnacl-util": "^0.15.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^5.0.0",
    "@types/node": "^20.16.0",
    "@types/node-notifier": "^8.0.5",
    "@types/qrcode-terminal": "^0.12.2",
    "@types/ws": "^8.5.12",
    "autoprefixer": "...keep existing version...",
    "postcss": "...keep existing version...",
    "preact": "^10.24.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "tailwindcss": "^3.4.13",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.1"
  }
}
```

Also add the `pair` script:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build:web": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "install:hooks": "tsx src/install-hooks.ts",
    "pair": "tsx src/cli/pair.ts"
  }
}
```

(Read the current package.json first; keep postcss/autoprefixer versions from Task 17 fix-up. Only delta is adding three deps + one devDep + one script.)

- [ ] **Step 2: Update .gitignore to silence Phase 1 noise**

Replace `.gitignore` content with:

```
node_modules/
dist/
coverage/
*.log
.cc-hub/
build/
.npmrc
```

(`build/` and `.npmrc` are node-gyp / pnpm artefacts left by Phase 1; gitignoring them keeps `git status` clean.)

- [ ] **Step 3: Run pnpm install**

Run: `pnpm install`
Expected: tweetnacl, tweetnacl-util, qrcode-terminal, @types/qrcode-terminal installed. No build errors.

- [ ] **Step 4: Verify typecheck still clean**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Verify tests still pass (30 from Phase 1)**

Run: `pnpm test`
Expected: 30 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore
git commit -m "chore(phase2): add tweetnacl + qrcode-terminal deps; tidy .gitignore"
```

---

## Task 2: Crypto Module

**Files:**
- Create: `d:/code/cc-hub/src/crypto.ts`
- Test: `d:/code/cc-hub/tests/crypto.test.ts`

Thin TweetNaCl wrapper. Uses `nacl.box.keyPair` for X25519 keypair, `nacl.box.before(pub, priv)` to derive Curve25519 shared key, `nacl.secretbox` for authenticated encryption with the shared key.

- [ ] **Step 1: Write failing tests**

Create `tests/crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  toBase64,
  fromBase64,
} from "../src/crypto.js";

describe("crypto", () => {
  describe("generateKeypair", () => {
    it("returns 32-byte pubkey and 32-byte privkey", () => {
      const kp = generateKeypair();
      expect(kp.pubkey).toHaveLength(32);
      expect(kp.privkey).toHaveLength(32);
    });

    it("returns different keys on each call", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      expect(toBase64(a.pubkey)).not.toBe(toBase64(b.pubkey));
    });
  });

  describe("deriveSharedSecret", () => {
    it("two parties derive the same secret", () => {
      const alice = generateKeypair();
      const bob = generateKeypair();
      const aliceSees = deriveSharedSecret(alice.privkey, bob.pubkey);
      const bobSees = deriveSharedSecret(bob.privkey, alice.pubkey);
      expect(toBase64(aliceSees)).toBe(toBase64(bobSees));
    });

    it("different pairs derive different secrets", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const c = generateKeypair();
      const ab = deriveSharedSecret(a.privkey, b.pubkey);
      const ac = deriveSharedSecret(a.privkey, c.pubkey);
      expect(toBase64(ab)).not.toBe(toBase64(ac));
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("encrypts and decrypts a plaintext string", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const secret = deriveSharedSecret(a.privkey, b.pubkey);
      const { ct, nonce } = encrypt("hello world", secret);
      const pt = decrypt(ct, nonce, secret);
      expect(pt).toBe("hello world");
    });

    it("decrypts to null with wrong key", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const c = generateKeypair();
      const goodSecret = deriveSharedSecret(a.privkey, b.pubkey);
      const wrongSecret = deriveSharedSecret(a.privkey, c.pubkey);
      const { ct, nonce } = encrypt("hello", goodSecret);
      expect(decrypt(ct, nonce, wrongSecret)).toBeNull();
    });

    it("decrypts to null with tampered ciphertext", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const secret = deriveSharedSecret(a.privkey, b.pubkey);
      const { ct, nonce } = encrypt("hello", secret);
      const tampered = ct.slice(0, -2) + "xx";
      expect(decrypt(tampered, nonce, secret)).toBeNull();
    });

    it("encrypt produces different nonces on repeat calls", () => {
      const a = generateKeypair();
      const b = generateKeypair();
      const secret = deriveSharedSecret(a.privkey, b.pubkey);
      const e1 = encrypt("x", secret);
      const e2 = encrypt("x", secret);
      expect(e1.nonce).not.toBe(e2.nonce);
    });
  });

  describe("base64 helpers", () => {
    it("round-trip", () => {
      const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual([1, 2, 3, 250, 251, 252]);
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test crypto`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/crypto.ts**

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test crypto`
Expected: all crypto tests pass (~9 tests). Full suite: 39 passed.

- [ ] **Step 5: Commit**

```bash
git add src/crypto.ts tests/crypto.test.ts
git commit -m "feat(crypto): TweetNaCl wrapper (X25519 keypair, ECDH, secretbox)"
```

---

## Task 3: Config Module

**Files:**
- Create: `d:/code/cc-hub/src/config.ts`
- Test: `d:/code/cc-hub/tests/config.test.ts`

CRUD for `~/.cc-hub/config.json`. Atomic write via tmpfile + rename. Auto-creates default config (with new device keypair) on first call.

- [ ] **Step 1: Write failing tests**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadOrInitConfig,
  saveConfig,
  addPairedPeer,
  removePairedPeer,
  findPeerById,
  type Config,
  type PairedPeer,
} from "../src/config.js";

let tmpPath: string;

beforeEach(async () => {
  tmpPath = path.join(os.tmpdir(), `cc-hub-test-${Date.now()}-${Math.random()}.json`);
});

describe("config loadOrInitConfig", () => {
  it("creates default config with device keypair when file missing", async () => {
    const cfg = await loadOrInitConfig(tmpPath);
    expect(cfg.device.name).toBeTruthy();
    expect(cfg.device.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cfg.device.privkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cfg.paired_peers).toEqual([]);
    expect(cfg.remote).toBeUndefined();
    // Persisted
    const reread = await loadOrInitConfig(tmpPath);
    expect(reread.device.pubkey).toBe(cfg.device.pubkey);
  });

  it("loads existing config without regenerating keys", async () => {
    const first = await loadOrInitConfig(tmpPath);
    const second = await loadOrInitConfig(tmpPath);
    expect(second.device.privkey).toBe(first.device.privkey);
  });

  it("throws clear error when file exists but is malformed JSON", async () => {
    await fs.writeFile(tmpPath, "{ not valid json");
    await expect(loadOrInitConfig(tmpPath)).rejects.toThrow(/parse/i);
  });
});

describe("config addPairedPeer / removePairedPeer / findPeerById", () => {
  it("addPairedPeer appends a peer immutably", async () => {
    const cfg = await loadOrInitConfig(tmpPath);
    const peer: PairedPeer = {
      peer_id: "abc123",
      peer_name: "iPhone",
      peer_pubkey: "pk==",
      shared_secret: "ss==",
      paired_at: 1715760000000,
      last_seen_at: null,
    };
    const next = addPairedPeer(cfg, peer);
    expect(cfg.paired_peers).toHaveLength(0);
    expect(next.paired_peers).toHaveLength(1);
    expect(next.paired_peers[0]?.peer_id).toBe("abc123");
  });

  it("removePairedPeer removes by id", async () => {
    let cfg = await loadOrInitConfig(tmpPath);
    cfg = addPairedPeer(cfg, { peer_id: "a", peer_name: "A", peer_pubkey: "1", shared_secret: "s1", paired_at: 1, last_seen_at: null });
    cfg = addPairedPeer(cfg, { peer_id: "b", peer_name: "B", peer_pubkey: "2", shared_secret: "s2", paired_at: 2, last_seen_at: null });
    cfg = removePairedPeer(cfg, "a");
    expect(cfg.paired_peers).toHaveLength(1);
    expect(cfg.paired_peers[0]?.peer_id).toBe("b");
  });

  it("findPeerById returns peer or null", async () => {
    let cfg = await loadOrInitConfig(tmpPath);
    cfg = addPairedPeer(cfg, { peer_id: "x", peer_name: "X", peer_pubkey: "p", shared_secret: "s", paired_at: 1, last_seen_at: null });
    expect(findPeerById(cfg, "x")?.peer_name).toBe("X");
    expect(findPeerById(cfg, "nope")).toBeNull();
  });
});

describe("config saveConfig", () => {
  it("persists changes through round-trip", async () => {
    let cfg = await loadOrInitConfig(tmpPath);
    cfg = addPairedPeer(cfg, { peer_id: "p1", peer_name: "P1", peer_pubkey: "pk", shared_secret: "ss", paired_at: 1, last_seen_at: null });
    await saveConfig(tmpPath, cfg);
    const reloaded = await loadOrInitConfig(tmpPath);
    expect(reloaded.paired_peers).toHaveLength(1);
    expect(reloaded.paired_peers[0]?.peer_id).toBe("p1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test config`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/config.ts**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeypair, toBase64 } from "./crypto.js";

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
  x_daemon_auth_token: string;
}

export interface Config {
  device: {
    name: string;
    pubkey: string;   // base64
    privkey: string;  // base64
    created_at: number;
  };
  remote?: RemoteEndpoint;
  paired_peers: PairedPeer[];
}

function defaultDeviceName(): string {
  return os.hostname() || `device-${Date.now()}`;
}

function makeDefaultConfig(): Config {
  const kp = generateKeypair();
  return {
    device: {
      name: defaultDeviceName(),
      pubkey: toBase64(kp.pubkey),
      privkey: toBase64(kp.privkey),
      created_at: Date.now(),
    },
    paired_peers: [],
  };
}

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
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    throw new Error(`Failed to parse config at ${filePath}: ${(err as Error).message}`);
  }
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

- [ ] **Step 4: Run tests**

Run: `pnpm test config`
Expected: all config tests pass (8 tests). Full suite: 47 passed.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): ~/.cc-hub/config.json CRUD with atomic write"
```

---

## Task 4: Relay Protocol

**Files:**
- Create: `d:/code/cc-hub/src/relay-protocol.ts`
- Test: `d:/code/cc-hub/tests/relay-protocol.test.ts`

Defines the wire envelope shape, the plaintext message kinds, and encode/decode helpers that combine `crypto.ts` with the envelope format.

- [ ] **Step 1: Write failing tests**

Create `tests/relay-protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateKeypair, deriveSharedSecret } from "../src/crypto.js";
import {
  encodeEnvelope,
  decodeEnvelope,
  type Envelope,
  type Plaintext,
} from "../src/relay-protocol.js";

describe("relay-protocol", () => {
  it("encode → decode round-trip preserves payload", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const secret = deriveSharedSecret(a.privkey, b.pubkey);
    const msg: Plaintext = { kind: "ping", echo: "abc" };
    const env = encodeEnvelope(msg, secret, "phone:xyz");
    expect(env.v).toBe(1);
    expect(env.to).toBe("phone:xyz");
    expect(env.ct).toBeTruthy();
    expect(env.nonce).toBeTruthy();
    expect(env.ts).toBeTypeOf("number");

    const decoded = decodeEnvelope(env, secret);
    expect(decoded).toEqual(msg);
  });

  it("decodeEnvelope returns null when version mismatched", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const secret = deriveSharedSecret(a.privkey, b.pubkey);
    const env = encodeEnvelope({ kind: "ping", echo: "x" }, secret, "daemon");
    const bad: Envelope = { ...env, v: 99 };
    expect(decodeEnvelope(bad, secret)).toBeNull();
  });

  it("decodeEnvelope returns null when ciphertext fails to decrypt", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const c = generateKeypair();
    const goodSecret = deriveSharedSecret(a.privkey, b.pubkey);
    const wrongSecret = deriveSharedSecret(a.privkey, c.pubkey);
    const env = encodeEnvelope({ kind: "ping", echo: "x" }, goodSecret, "daemon");
    expect(decodeEnvelope(env, wrongSecret)).toBeNull();
  });

  it("decodeEnvelope returns null when plaintext is not valid JSON-shaped Plaintext", () => {
    // Construct an envelope whose ciphertext decrypts to bogus JSON
    const a = generateKeypair();
    const b = generateKeypair();
    const secret = deriveSharedSecret(a.privkey, b.pubkey);
    // Use encodeEnvelope on a string that's not a Plaintext — encode it ourselves at the crypto layer
    const { encrypt } = await import("../src/crypto.js");
    const { ct, nonce } = encrypt("not a json object", secret);
    const env: Envelope = { v: 1, to: "daemon", ct, nonce, ts: Date.now() };
    expect(decodeEnvelope(env, secret)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test relay-protocol`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/relay-protocol.ts**

```ts
import { encrypt, decrypt } from "./crypto.js";
import type { Session } from "./types.js";

export const PROTOCOL_VERSION = 1;

export interface Envelope {
  v: number;
  to: string;       // "daemon" | `phone:${peer_id}`
  ct: string;       // base64
  nonce: string;    // base64 (24 bytes)
  ts: number;       // sender unix ms
}

// Plaintext kinds (after decryption)
export type Plaintext =
  | { kind: "event"; session: Session }
  | { kind: "state_snapshot"; sessions: Session[] }
  | { kind: "cmd_focus"; cwd: string }
  | { kind: "cmd_send"; cwd: string; prompt: string }
  | { kind: "request_snapshot" }
  | { kind: "ping"; echo: string }
  | { kind: "pong"; echo: string }
  | { kind: "pair_offer"; phone_pk: string; phone_name: string }
  | { kind: "pair_ack"; ok: boolean }
  | { kind: "pair_reject"; reason: string };

export function encodeEnvelope(
  plaintext: Plaintext,
  sharedSecret: Uint8Array,
  to: string,
): Envelope {
  const json = JSON.stringify(plaintext);
  const { ct, nonce } = encrypt(json, sharedSecret);
  return { v: PROTOCOL_VERSION, to, ct, nonce, ts: Date.now() };
}

export function decodeEnvelope(env: Envelope, sharedSecret: Uint8Array): Plaintext | null {
  if (env.v !== PROTOCOL_VERSION) return null;
  const json = decrypt(env.ct, env.nonce, sharedSecret);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.kind !== "string") return null;
    return parsed as Plaintext;
  } catch {
    return null;
  }
}
```

⚠️ One adjustment: the test on line "decodeEnvelope returns null when plaintext is not valid JSON-shaped Plaintext" uses `await import(...)` inside an `it` callback that wasn't declared async. Fix the test by adding `async`:

```ts
  it("decodeEnvelope returns null when plaintext is not valid JSON-shaped Plaintext", async () => {
```

Apply this fix before running the tests.

- [ ] **Step 4: Run tests**

Run: `pnpm test relay-protocol`
Expected: 4 tests pass. Full suite: 51 passed.

- [ ] **Step 5: Commit**

```bash
git add src/relay-protocol.ts tests/relay-protocol.test.ts
git commit -m "feat(relay-protocol): envelope encode/decode + plaintext message kinds"
```

---

## Task 5: Pairing Module

**Files:**
- Create: `d:/code/cc-hub/src/pairing.ts`
- Test: `d:/code/cc-hub/tests/pairing.test.ts`

Pairing state machine + QR payload helpers. Pure logic; network is handled in Task 7's CLI wrapper. The state machine consumes one `pair_offer` from a phone and produces a `PairedPeer` + an outbound `pair_ack` plaintext.

- [ ] **Step 1: Write failing tests**

Create `tests/pairing.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeypair, deriveSharedSecret, toBase64, fromBase64 } from "../src/crypto.js";
import {
  PairingSession,
  pairingQrPayload,
  computePeerId,
  PAIRING_TOKEN_TTL_MS,
} from "../src/pairing.js";

describe("pairingQrPayload", () => {
  it("returns a JSON string containing worker_url, pairing_token, daemon_pk, name", () => {
    const kp = generateKeypair();
    const payload = pairingQrPayload({
      worker_url: "wss://example.workers.dev",
      pairing_token: "tok123",
      daemon_pubkey: toBase64(kp.pubkey),
      device_name: "mike2-pc",
    });
    const parsed = JSON.parse(payload);
    expect(parsed.worker_url).toBe("wss://example.workers.dev");
    expect(parsed.pairing_token).toBe("tok123");
    expect(parsed.daemon_pk).toBe(toBase64(kp.pubkey));
    expect(parsed.name).toBe("mike2-pc");
  });
});

describe("computePeerId", () => {
  it("returns a deterministic 16-char id derived from pubkey", () => {
    const kp = generateKeypair();
    const id1 = computePeerId(toBase64(kp.pubkey));
    const id2 = computePeerId(toBase64(kp.pubkey));
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(16);
  });

  it("different pubkeys produce different ids", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(computePeerId(toBase64(a.pubkey))).not.toBe(computePeerId(toBase64(b.pubkey)));
  });
});

describe("PairingSession", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts in 'pending' state and produces a 16-byte base64 pairing token", () => {
    const daemonKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);
    expect(session.state).toBe("pending");
    expect(fromBase64(session.pairingToken)).toHaveLength(16);
  });

  it("handleOffer transitions to 'paired' and returns peer + pair_ack plaintext", () => {
    const daemonKp = generateKeypair();
    const phoneKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);

    const result = session.handleOffer({
      phone_pk: toBase64(phoneKp.pubkey),
      phone_name: "iPhone 15",
    });

    expect(session.state).toBe("paired");
    expect(result.peer.peer_name).toBe("iPhone 15");
    expect(result.peer.peer_pubkey).toBe(toBase64(phoneKp.pubkey));
    expect(result.peer.peer_id).toBe(computePeerId(toBase64(phoneKp.pubkey)));
    // Shared secret matches phone-side derivation
    const phoneDerived = deriveSharedSecret(phoneKp.privkey, daemonKp.pubkey);
    expect(result.peer.shared_secret).toBe(toBase64(phoneDerived));
    expect(result.pairAck.kind).toBe("pair_ack");
    expect(result.pairAck.ok).toBe(true);
  });

  it("handleOffer throws when called twice", () => {
    const daemonKp = generateKeypair();
    const phoneKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);
    session.handleOffer({ phone_pk: toBase64(phoneKp.pubkey), phone_name: "x" });
    expect(() => session.handleOffer({ phone_pk: toBase64(phoneKp.pubkey), phone_name: "y" }))
      .toThrow(/already/i);
  });

  it("isExpired() returns true after PAIRING_TOKEN_TTL_MS elapses", () => {
    const daemonKp = generateKeypair();
    const session = new PairingSession(daemonKp.privkey, daemonKp.pubkey);
    expect(session.isExpired()).toBe(false);
    vi.advanceTimersByTime(PAIRING_TOKEN_TTL_MS - 1);
    expect(session.isExpired()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(session.isExpired()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test pairing`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/pairing.ts**

```ts
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { deriveSharedSecret, toBase64, fromBase64 } from "./crypto.js";
import type { PairedPeer } from "./config.js";
import type { Plaintext } from "./relay-protocol.js";

export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;
const PAIRING_TOKEN_BYTES = 16;

export interface PairingQrInput {
  worker_url: string;
  pairing_token: string;
  daemon_pubkey: string;
  device_name: string;
}

export function pairingQrPayload(input: PairingQrInput): string {
  return JSON.stringify({
    worker_url: input.worker_url,
    pairing_token: input.pairing_token,
    daemon_pk: input.daemon_pubkey,
    name: input.device_name,
  });
}

export function computePeerId(peerPubkeyBase64: string): string {
  return createHash("sha256").update(peerPubkeyBase64).digest("base64").replace(/[+/=]/g, "").slice(0, 16);
}

type PairingState = "pending" | "paired" | "expired";

export interface PairOffer {
  phone_pk: string;     // base64
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
      throw new Error(`PairingSession already in state '${this.state}'; cannot accept new offer`);
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test pairing`
Expected: 6 tests pass. Full suite: 57 passed.

- [ ] **Step 5: Commit**

```bash
git add src/pairing.ts tests/pairing.test.ts
git commit -m "feat(pairing): state machine + QR payload + peer-id derivation"
```

---

## Task 6: Relay Client

**Files:**
- Create: `d:/code/cc-hub/src/relay-client.ts`
- Test: `d:/code/cc-hub/tests/relay-client.test.ts`

Outbound WS client to user's Worker. On connect: handshakes (Bearer + daemon-id). Subscribes to `store.session_changed` and pushes envelopes to all paired peers. Receives envelopes, decrypts with matching peer's shared secret, dispatches to `store` / `bridge`. Exponential backoff reconnect.

- [ ] **Step 1: Write failing tests**

Create `tests/relay-client.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { generateKeypair, deriveSharedSecret, toBase64, fromBase64 } from "../src/crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "../src/relay-protocol.js";
import { SessionStore } from "../src/session-store.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import { RelayClient } from "../src/relay-client.js";
import type { Config, PairedPeer } from "../src/config.js";

function makeConfig(daemonPubkey: string, daemonPrivkey: string, peer: PairedPeer, workerUrl: string): Config {
  return {
    device: { name: "test", pubkey: daemonPubkey, privkey: daemonPrivkey, created_at: 0 },
    remote: { worker_url: workerUrl, x_daemon_auth_token: "anti-abuse" },
    paired_peers: [peer],
  };
}

describe("RelayClient", () => {
  let wss: WebSocketServer;
  let port: number;
  let serverReceived: Envelope[] = [];
  let serverConn: import("ws").WebSocket | null = null;

  beforeEach(async () => {
    serverReceived = [];
    serverConn = null;
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    port = (wss.address() as any).port;
    wss.on("connection", (ws) => {
      serverConn = ws;
      ws.on("message", (raw) => {
        serverReceived.push(JSON.parse(raw.toString()));
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("connects to worker and survives a session_changed by sending an encrypted envelope per peer", async () => {
    const daemon = generateKeypair();
    const phone = generateKeypair();
    const shared = deriveSharedSecret(daemon.privkey, phone.pubkey);
    const peer: PairedPeer = {
      peer_id: "peer1",
      peer_name: "iPhone",
      peer_pubkey: toBase64(phone.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0,
      last_seen_at: null,
    };
    const cfg = makeConfig(toBase64(daemon.pubkey), toBase64(daemon.privkey), peer, `ws://127.0.0.1:${port}/v1/daemon`);

    const store = new SessionStore(":memory:");
    const bridge = new VscodeBridge(async () => { /* no-op */ });
    const client = new RelayClient({ config: cfg, store, bridge });

    await client.start();
    await new Promise((r) => setTimeout(r, 50));  // let WS open

    store.upsert({
      cwd: "d:\\code\\x", session_uuid: "u", project_name: "x",
      status: "active", last_event_at: Date.now(),
      last_message_preview: "", tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(serverReceived.length).toBeGreaterThanOrEqual(1);
    const env = serverReceived[serverReceived.length - 1]!;
    expect(env.to).toBe("phone:peer1");
    const pt = decodeEnvelope(env, shared);
    expect(pt?.kind).toBe("event");

    await client.stop();
    store.close();
  });

  it("decrypts cmd_focus and calls bridge.focus with peer's session_uuid", async () => {
    const daemon = generateKeypair();
    const phone = generateKeypair();
    const shared = deriveSharedSecret(daemon.privkey, phone.pubkey);
    const peer: PairedPeer = {
      peer_id: "peer1",
      peer_name: "iPhone",
      peer_pubkey: toBase64(phone.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0,
      last_seen_at: null,
    };
    const cfg = makeConfig(toBase64(daemon.pubkey), toBase64(daemon.privkey), peer, `ws://127.0.0.1:${port}/v1/daemon`);

    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\target", session_uuid: "uuid-target", project_name: "target",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const client = new RelayClient({ config: cfg, store, bridge });

    await client.start();
    await new Promise((r) => setTimeout(r, 50));

    const cmdEnv = encodeEnvelope({ kind: "cmd_focus", cwd: "d:\\code\\target" }, shared, "daemon");
    serverConn!.send(JSON.stringify(cmdEnv));
    await new Promise((r) => setTimeout(r, 50));

    expect(launches).toContain("vscode://anthropic.claude-code/open?session=uuid-target");

    await client.stop();
    store.close();
  });

  it("drops messages that fail to decrypt (wrong key) without crashing", async () => {
    const daemon = generateKeypair();
    const phone = generateKeypair();
    const someoneElse = generateKeypair();
    const shared = deriveSharedSecret(daemon.privkey, phone.pubkey);
    const wrongShared = deriveSharedSecret(daemon.privkey, someoneElse.pubkey);
    const peer: PairedPeer = {
      peer_id: "peer1", peer_name: "iPhone",
      peer_pubkey: toBase64(phone.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0, last_seen_at: null,
    };
    const cfg = makeConfig(toBase64(daemon.pubkey), toBase64(daemon.privkey), peer, `ws://127.0.0.1:${port}/v1/daemon`);
    const store = new SessionStore(":memory:");
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const client = new RelayClient({ config: cfg, store, bridge });
    await client.start();
    await new Promise((r) => setTimeout(r, 50));

    const badEnv = encodeEnvelope({ kind: "cmd_focus", cwd: "x" }, wrongShared, "daemon");
    serverConn!.send(JSON.stringify(badEnv));
    await new Promise((r) => setTimeout(r, 50));

    expect(launches).toEqual([]);  // unaffected
    await client.stop();
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test relay-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/relay-client.ts**

```ts
import WebSocket from "ws";
import { fromBase64 } from "./crypto.js";
import { encodeEnvelope, decodeEnvelope, type Envelope, type Plaintext } from "./relay-protocol.js";
import type { Config, PairedPeer } from "./config.js";
import type { SessionStore } from "./session-store.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Session } from "./types.js";

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
  recentNonces: Map<string, number>;  // nonce → seen-at ms
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private storeListener: ((s: Session) => void) | null = null;
  private peers: PeerSecrets[] = [];

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

  private connect(): void {
    const remote = this.deps.config.remote!;
    const headers: Record<string, string> = {
      "X-Daemon-Auth": remote.x_daemon_auth_token,
      "X-Daemon-Id": this.peerSelfId(),
    };
    const ws = new WebSocket(remote.worker_url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectMs = RECONNECT_INITIAL_MS;
      // Subscribe to store changes after we're connected
      this.storeListener = (session: Session) => this.broadcastEvent(session);
      this.deps.store.on("session_changed", this.storeListener);
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => { /* swallow; close handler reconnects */ });
  }

  private handleClose(): void {
    if (this.storeListener) {
      this.deps.store.off("session_changed", this.storeListener);
      this.storeListener = null;
    }
    this.ws = null;
    if (this.stopRequested) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), wait);
  }

  private handleMessage(raw: string): void {
    let env: Envelope;
    try { env = JSON.parse(raw); } catch { return; }
    if (typeof env !== "object" || env === null) return;

    // Freshness check
    if (typeof env.ts !== "number" || Math.abs(Date.now() - env.ts) > NONCE_FRESHNESS_MS) return;

    // Try each peer's secret until one decrypts. (Phone could send before identifying themselves.)
    for (const p of this.peers) {
      // Replay check
      if (p.recentNonces.has(env.nonce)) continue;
      const pt = decodeEnvelope(env, p.sharedSecret);
      if (!pt) continue;
      // Accept
      p.recentNonces.set(env.nonce, Date.now());
      this.pruneNonces(p);
      void this.dispatchPlaintext(pt, p);
      return;
    }
    // No peer could decrypt — drop silently
  }

  private pruneNonces(p: PeerSecrets): void {
    const cutoff = Date.now() - NONCE_FRESHNESS_MS;
    for (const [n, t] of p.recentNonces) {
      if (t < cutoff) p.recentNonces.delete(n);
    }
  }

  private async dispatchPlaintext(pt: Plaintext, p: PeerSecrets): Promise<void> {
    switch (pt.kind) {
      case "cmd_focus": {
        const session = this.deps.store.get(pt.cwd);
        if (session) await this.deps.bridge.focus(session.session_uuid);
        return;
      }
      case "cmd_send": {
        const session = this.deps.store.get(pt.cwd);
        if (session) await this.deps.bridge.send(session.session_uuid, pt.prompt);
        return;
      }
      case "request_snapshot": {
        const snapshot = { kind: "state_snapshot" as const, sessions: this.deps.store.list() };
        this.sendToPeer(p, snapshot);
        return;
      }
      case "ping": {
        this.sendToPeer(p, { kind: "pong", echo: pt.echo });
        return;
      }
      default:
        return;  // ignore other kinds for now (pair_*, pong, event, state_snapshot don't come downstream)
    }
  }

  private broadcastEvent(session: Session): void {
    for (const p of this.peers) {
      this.sendToPeer(p, { kind: "event", session });
    }
  }

  private sendToPeer(p: PeerSecrets, msg: Plaintext): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const env = encodeEnvelope(msg, p.sharedSecret, `phone:${p.peer.peer_id}`);
    this.ws.send(JSON.stringify(env), (_err) => { /* swallow; close handler reconnects if needed */ });
  }

  private peerSelfId(): string {
    // Daemon identifies itself to the Worker so it can route phone messages to us.
    // Use a stable derivation from our pubkey (Worker doesn't see the actual key).
    return this.deps.config.device.pubkey.replace(/[+/=]/g, "").slice(0, 16);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test relay-client`
Expected: 3 tests pass. Full suite: 60 passed.

- [ ] **Step 5: Commit**

```bash
git add src/relay-client.ts tests/relay-client.test.ts
git commit -m "feat(relay-client): outbound WS with E2E envelopes, reconnect, dispatch"
```

---

## Task 7: Pair CLI

**Files:**
- Create: `d:/code/cc-hub/src/cli/pair.ts`

`pnpm pair --new`: prints QR, opens WS to Worker with `X-Pairing-Token`, waits for `pair_offer` from phone (routed by Worker), completes handshake, persists peer, exits cleanly. `pnpm pair --list`: prints paired peers. `pnpm pair --revoke <peer_id>`: removes peer.

- [ ] **Step 1: Create src/cli/pair.ts**

```ts
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import { loadOrInitConfig, saveConfig, addPairedPeer, removePairedPeer, type Config } from "../config.js";
import { fromBase64, toBase64 } from "../crypto.js";
import { PairingSession, pairingQrPayload, PAIRING_TOKEN_TTL_MS } from "../pairing.js";
import { encodeEnvelope, decodeEnvelope, type Plaintext } from "../relay-protocol.js";

const CONFIG_PATH = path.join(os.homedir(), ".cc-hub", "config.json");

function usage(): never {
  console.error("Usage: pnpm pair [--new | --list | --revoke <peer_id>]");
  console.error("       pnpm pair --new --worker-url=<wss://...> --token=<x-daemon-auth-token>");
  process.exit(1);
}

function parseArgs(argv: string[]): { cmd: "new" | "list" | "revoke"; workerUrl?: string; token?: string; peerId?: string } {
  const args = argv.slice(2);
  if (args.includes("--list")) return { cmd: "list" };
  const revIdx = args.indexOf("--revoke");
  if (revIdx >= 0) {
    const peerId = args[revIdx + 1];
    if (!peerId) usage();
    return { cmd: "revoke", peerId };
  }
  if (args.includes("--new")) {
    const workerUrl = args.find((a) => a.startsWith("--worker-url="))?.split("=")[1];
    const token = args.find((a) => a.startsWith("--token="))?.split("=")[1];
    return { cmd: "new", workerUrl, token };
  }
  usage();
}

async function cmdList(cfg: Config): Promise<void> {
  if (cfg.paired_peers.length === 0) {
    console.log("(no paired peers)");
    return;
  }
  for (const p of cfg.paired_peers) {
    const paired = new Date(p.paired_at).toISOString();
    console.log(`${p.peer_id}  ${p.peer_name}  paired=${paired}  last_seen=${p.last_seen_at ? new Date(p.last_seen_at).toISOString() : "never"}`);
  }
}

async function cmdRevoke(cfg: Config, peerId: string): Promise<void> {
  const before = cfg.paired_peers.length;
  const next = removePairedPeer(cfg, peerId);
  if (next.paired_peers.length === before) {
    console.error(`No peer with id ${peerId}`);
    process.exit(1);
  }
  await saveConfig(CONFIG_PATH, next);
  console.log(`Revoked peer ${peerId}`);
}

async function cmdNew(cfg: Config, workerUrlArg?: string, tokenArg?: string): Promise<void> {
  const workerUrl = workerUrlArg ?? cfg.remote?.worker_url;
  const token = tokenArg ?? cfg.remote?.x_daemon_auth_token;
  if (!workerUrl || !token) {
    console.error("Missing worker URL or daemon auth token.");
    console.error("Either pre-populate ~/.cc-hub/config.json's `remote` field, or pass:");
    console.error("  pnpm pair --new --worker-url=wss://... --token=<token>");
    process.exit(1);
  }

  const daemonPriv = fromBase64(cfg.device.privkey);
  const daemonPub = fromBase64(cfg.device.pubkey);
  const session = new PairingSession(daemonPriv, daemonPub);

  const qrPayload = pairingQrPayload({
    worker_url: workerUrl,
    pairing_token: session.pairingToken,
    daemon_pubkey: cfg.device.pubkey,
    device_name: cfg.device.name,
  });

  console.log("\nScan this QR with your phone (Happy app / cc-hub phone web client):\n");
  qrcode.generate(qrPayload, { small: true });
  console.log(`\nPairing token expires in ${PAIRING_TOKEN_TTL_MS / 60000} minutes.`);
  console.log(`Connecting to ${workerUrl} ...`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(workerUrl, {
      headers: {
        "X-Daemon-Auth": token,
        "X-Pairing-Token": session.pairingToken,
      },
    });

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Pairing timed out"));
    }, PAIRING_TOKEN_TTL_MS);

    ws.on("open", () => { console.log("Connected. Waiting for phone to scan and offer..."); });

    ws.on("message", async (raw) => {
      try {
        const env = JSON.parse(raw.toString());
        // pair_offer arrives plaintext-ish from phone's perspective — but envelope shape is still used,
        // so we attempt all-zero secret? No — pair_offer goes through plaintext channel during pairing.
        // For simplicity, pair_offer arrives as a non-encrypted JSON message during pairing mode
        // (the Worker is the only thing in between and it's been told this is pairing).
        const msg = env.kind ? env : null;  // direct plaintext during pairing
        if (!msg) {
          console.warn("Ignoring non-plaintext message during pairing");
          return;
        }
        if (msg.kind === "pair_offer") {
          const { peer, pairAck } = session.handleOffer({
            phone_pk: msg.phone_pk,
            phone_name: msg.phone_name,
          });
          // Send pair_ack (encrypted) to confirm
          const sharedSecret = fromBase64(peer.shared_secret);
          const ackEnv = encodeEnvelope(pairAck, sharedSecret, `phone:${peer.peer_id}`);
          ws.send(JSON.stringify(ackEnv));

          // Persist
          const updated = addPairedPeer({
            ...cfg,
            remote: { worker_url: workerUrl, x_daemon_auth_token: token },
          }, peer);
          await saveConfig(CONFIG_PATH, updated);

          console.log(`\n✓ Paired ${peer.peer_name} (id=${peer.peer_id})`);
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch (err) {
        console.error("Error handling pairing message:", err);
      }
    });

    ws.on("close", () => {
      if (session.state !== "paired") {
        clearTimeout(timeout);
        reject(new Error("WebSocket closed before pairing completed"));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cfg = await loadOrInitConfig(CONFIG_PATH);
  switch (args.cmd) {
    case "list": await cmdList(cfg); return;
    case "revoke": await cmdRevoke(cfg, args.peerId!); return;
    case "new": await cmdNew(cfg, args.workerUrl, args.token); return;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Smoke-test CLI parsing (no network)**

Run: `pnpm pair --list`
Expected: prints "(no paired peers)" (config file was created if missing).

Run: `pnpm pair --revoke nonexistent`
Expected: prints "No peer with id nonexistent", exit 1.

- [ ] **Step 4: Commit**

```bash
git add src/cli/pair.ts
git commit -m "feat(cli): pair --new/--list/--revoke command"
```

---

## Task 8: Wire RelayClient into Daemon Entry

**Files:**
- Modify: `d:/code/cc-hub/src/index.ts`

On daemon start: load config; if `remote` is set AND `paired_peers` is non-empty, start RelayClient. Otherwise log "remote disabled" and continue Phase 1.

- [ ] **Step 1: Read current src/index.ts**

(Look at the file in full before editing so you preserve all Phase 1 wiring.)

- [ ] **Step 2: Add imports at the top**

Add these lines next to the existing import block:

```ts
import { loadOrInitConfig } from "./config.js";
import { RelayClient } from "./relay-client.js";
```

- [ ] **Step 3: Add config path constant**

Next to `PORT_FILE` and `DB_FILE` constants:

```ts
const CONFIG_FILE = path.join(HUB_HOME, "config.json");
```

- [ ] **Step 4: Wire RelayClient inside `main()`, after `createApp(...)` and before `server.listen(...)`**

Replace the section that says:

```ts
  const { app, server } = createApp({ store, handler, bridge, notifier, webDir });

  // Serve web UI if built
  const express = (await import("express")).default;
  app.use(express.static(webDir, { fallthrough: true }));

  server.listen(port, "127.0.0.1", () => {
```

with:

```ts
  const { app, server } = createApp({ store, handler, bridge, notifier, webDir });

  // Serve web UI if built
  const express = (await import("express")).default;
  app.use(express.static(webDir, { fallthrough: true }));

  // Phase 2: optional remote relay to user's Cloudflare Worker
  const config = await loadOrInitConfig(CONFIG_FILE);
  let relay: RelayClient | null = null;
  if (config.remote && config.paired_peers.length > 0) {
    relay = new RelayClient({ config, store, bridge });
    await relay.start();
    log.info({ worker_url: config.remote.worker_url, peers: config.paired_peers.length }, "relay started");
    console.log(`relay → ${config.remote.worker_url} (${config.paired_peers.length} peer${config.paired_peers.length === 1 ? "" : "s"})`);
  } else {
    log.info("relay disabled (no remote configured or no paired peers)");
  }

  server.listen(port, "127.0.0.1", () => {
```

- [ ] **Step 5: Update shutdown to also stop relay**

Replace the shutdown handler:

```ts
  const shutdown = () => {
    log.info("shutting down");
    server.close(() => { store.close(); process.exit(0); });
  };
```

with:

```ts
  const shutdown = async () => {
    log.info("shutting down");
    if (relay) { try { await relay.stop(); } catch { /* ignore */ } }
    server.close(() => { store.close(); process.exit(0); });
  };
```

- [ ] **Step 6: Verify typecheck + tests**

Run: `pnpm typecheck` — expect exit 0
Run: `pnpm test` — expect 60 passed (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): wire RelayClient into entry point when remote config present"
```

---

## Task 9: End-to-End Integration Test with Mock Worker

**Files:**
- Create: `d:/code/cc-hub/tests/integration-relay.test.ts`

Stands up the full daemon (via createApp) + a mock Worker (WS echo with simple peer-id routing) + a "phone" client (raw WS that knows the shared secret). Verifies the round-trip end-to-end.

- [ ] **Step 1: Write the integration test**

Create `tests/integration-relay.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { generateKeypair, deriveSharedSecret, toBase64, fromBase64 } from "../src/crypto.js";
import { encodeEnvelope, decodeEnvelope } from "../src/relay-protocol.js";
import { SessionStore } from "../src/session-store.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import { RelayClient } from "../src/relay-client.js";
import type { Config, PairedPeer } from "../src/config.js";

describe("daemon ↔ mock-Worker ↔ phone integration", () => {
  let wss: WebSocketServer;
  let port: number;
  let daemonConn: WebSocket | null = null;
  let phoneConn: WebSocket | null = null;

  beforeEach(async () => {
    daemonConn = null;
    phoneConn = null;
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    port = (wss.address() as any).port;
    wss.on("connection", (ws, req) => {
      const url = req.url || "";
      if (url.startsWith("/v1/daemon")) {
        daemonConn = ws;
        ws.on("message", (raw) => phoneConn?.send(raw));
      } else if (url.startsWith("/v1/phone")) {
        phoneConn = ws;
        ws.on("message", (raw) => daemonConn?.send(raw));
      }
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("daemon broadcasts session_changed; phone decrypts; phone sends cmd_focus; daemon executes", async () => {
    const daemonKp = generateKeypair();
    const phoneKp = generateKeypair();
    const shared = deriveSharedSecret(daemonKp.privkey, phoneKp.pubkey);

    const peer: PairedPeer = {
      peer_id: "peer1", peer_name: "iPhone",
      peer_pubkey: toBase64(phoneKp.pubkey),
      shared_secret: toBase64(shared),
      paired_at: 0, last_seen_at: null,
    };
    const cfg: Config = {
      device: { name: "test", pubkey: toBase64(daemonKp.pubkey), privkey: toBase64(daemonKp.privkey), created_at: 0 },
      remote: { worker_url: `ws://127.0.0.1:${port}/v1/daemon`, x_daemon_auth_token: "abc" },
      paired_peers: [peer],
    };

    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\target", session_uuid: "uuid-target", project_name: "target",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });

    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });

    const client = new RelayClient({ config: cfg, store, bridge });
    await client.start();
    await new Promise((r) => setTimeout(r, 50));

    // Phone connects
    const phoneEvents: any[] = [];
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/phone`);
    await new Promise<void>((r) => phone.on("open", () => r()));
    phone.on("message", (raw) => {
      const env = JSON.parse(raw.toString());
      const pt = decodeEnvelope(env, shared);
      if (pt) phoneEvents.push(pt);
    });

    // Daemon emits a session_changed → phone should receive an encrypted event
    store.upsert({
      cwd: "d:\\code\\new", session_uuid: "u-new", project_name: "new",
      status: "active", last_event_at: Date.now(), last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(phoneEvents.some((pt) => pt.kind === "event" && pt.session?.cwd === "d:\\code\\new")).toBe(true);

    // Phone sends cmd_focus → daemon should call bridge.focus
    const cmdEnv = encodeEnvelope({ kind: "cmd_focus", cwd: "d:\\code\\target" }, shared, "daemon");
    phone.send(JSON.stringify(cmdEnv));
    await new Promise((r) => setTimeout(r, 100));
    expect(launches).toContain("vscode://anthropic.claude-code/open?session=uuid-target");

    phone.close();
    await client.stop();
    store.close();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm test integration-relay`
Expected: 1 test passes. Full suite: 61 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/integration-relay.test.ts
git commit -m "test(relay): end-to-end daemon ↔ mock-Worker ↔ phone integration"
```

---

## Task 10: Protocol Documentation

**Files:**
- Create: `d:/code/cc-hub/docs/protocols/relay-protocol.md`
- Create: `d:/code/cc-hub/docs/protocols/pairing-protocol.md`
- Create: `d:/code/cc-hub/docs/protocols/worker-skeleton.md`

These docs are deliverables for the user (who is writing the Worker + phone client).

- [ ] **Step 1: Create docs/protocols/relay-protocol.md**

```markdown
# cc-hub Relay Protocol (v1)

## Overview

Outbound-only WSS from daemon → user's Cloudflare Worker. Worker is a blind pubsub: it routes encrypted envelopes between the daemon and connected phones. Worker MUST NOT log envelope bodies and MUST NOT attempt to decrypt.

## Endpoints (Worker must expose)

- `WSS /v1/daemon` — daemon connects here, single long-lived WS
- `WSS /v1/phone` — phone/browser connects here, may be multiple concurrent
- `GET /v1/health` (optional) — returns 200 OK

## Auth

### Daemon → Worker

Headers on WS upgrade:
- `X-Daemon-Auth: <token>` — pre-shared anti-abuse token. Worker validates against environment variable. NOT used for E2E (Worker is untrusted).
- `X-Daemon-Id: <16-char>` — first 16 alphanumeric chars of base64(daemon.pubkey), used by Worker to route phone messages to the right daemon.
- `X-Pairing-Token: <base64>` (only during pairing mode, mutually exclusive with X-Daemon-Id)

### Phone → Worker

- Cloudflare Access SSO required (Worker checks `CF-Access-Authenticated-User-Email` header).
- `X-Daemon-Id: <16-char>` — which daemon this phone wants to pair with / talk to.
- `X-Pairing-Token: <base64>` (only during pairing mode)

## Routing (Worker logic)

```
state: Map<daemon_id, { daemonWs, phoneWss: Set<WebSocket>, pairingMap: Map<token, [daemonWs, phoneWs]> }>

on /v1/daemon connect:
  if pairing_token present:
    store as pairing-mode daemon under token
    if a phone is waiting on same token, bridge them
  else:
    register as the active daemon for X-Daemon-Id

on /v1/phone connect:
  if pairing_token present: same as daemon (pairing mode)
  else: register phoneWs in phoneWss set for X-Daemon-Id

on message from daemon (relay mode): broadcast raw bytes to all phones for that daemon_id
on message from phone (relay mode): forward raw bytes to that daemon's daemonWs
on message during pairing: bridge between the paired daemon+phone WSs
```

## Envelope Format (relay mode, post-pairing)

```json
{
  "v": 1,
  "to": "daemon" | "phone:<peer_id>",
  "ct": "<base64 ciphertext>",
  "nonce": "<base64 24-byte>",
  "ts": <unix-ms>
}
```

- `v` must be 1. Worker MAY check this and reject unknown versions.
- `to` is a routing hint only. The receiver re-validates by decryption.
- `ct` is `nacl.secretbox(plaintext, nonce, shared_secret)` base64-encoded.
- `nonce` is a 24-byte random value, base64-encoded.
- `ts` is sender's unix-ms timestamp. Receiver SHOULD reject if `|now - ts| > 60_000`.

## Plaintext Message Kinds (inside `ct` after decryption)

```ts
type Plaintext =
  | { kind: "event"; session: Session }                          // daemon → phone
  | { kind: "state_snapshot"; sessions: Session[] }              // daemon → phone (on request)
  | { kind: "cmd_focus"; cwd: string }                           // phone → daemon
  | { kind: "cmd_send"; cwd: string; prompt: string }            // phone → daemon
  | { kind: "request_snapshot" }                                 // phone → daemon
  | { kind: "ping"; echo: string }                               // either direction
  | { kind: "pong"; echo: string }                               // response to ping
  ;
```

`Session` shape — see `src/types.ts` in this repo. JSON-stable fields, no undefined values.

## Worker MUST / MUST NOT

| MUST | MUST NOT |
|---|---|
| Validate `X-Daemon-Auth` against env var | Log envelope `ct`, `nonce`, or decrypted bodies |
| Enforce CF Access on `/v1/phone` | Attempt to parse envelope JSON (you can, but don't read `ct`) |
| Route envelopes raw between paired WSs | Store messages persistently |
| Honor protocol version 1 | Add server-side fields to envelopes |
| Close WS on auth failure with code 4xxx | Block messages based on `to` field (it's a hint, not access control) |

## Versioning

This document specifies v1. Future versions will use a new `v` field value AND a new endpoint path (e.g. `/v2/daemon`). v1 daemons connecting to a v2-only Worker should be rejected at handshake.
```

- [ ] **Step 2: Create docs/protocols/pairing-protocol.md**

```markdown
# cc-hub Pairing Protocol (v1)

## Goal

Securely establish a long-term X25519 shared secret between daemon and a phone, using the Worker only as a short-lived rendezvous. Worker never sees the shared secret.

## Flow

1. **User runs `pnpm pair --new` on the daemon machine.**
2. Daemon:
   - Generates a 16-byte random `pairing_token` (base64-encoded).
   - Connects to Worker `WSS /v1/daemon` with headers:
     - `X-Daemon-Auth: <token>`
     - `X-Pairing-Token: <pairing_token>` (no X-Daemon-Id during pairing)
   - Renders a QR code in the terminal containing this JSON:
     ```json
     {
       "worker_url": "wss://...",
       "pairing_token": "<base64>",
       "daemon_pk": "<base64 daemon long-term pubkey>",
       "name": "<device name>"
     }
     ```
3. **User scans the QR with phone.** Phone now has `worker_url`, `pairing_token`, `daemon_pk`, `name`.
4. Phone:
   - Generates (or retrieves stored) long-term keypair `(PPk, PSk)`.
   - Connects to Worker `WSS /v1/phone` with headers:
     - CF Access SSO (handled by Worker)
     - `X-Pairing-Token: <pairing_token>` (matches the daemon's)
   - Sends pairing message:
     ```json
     { "kind": "pair_offer", "phone_pk": "<base64 PPk>", "phone_name": "<device label>" }
     ```
     **During pairing, messages are sent as raw JSON, NOT inside encrypted envelopes** — neither side has a shared secret yet. The Worker is the only intermediary and is trusted only for the short pairing window.
5. Worker sees both daemon and phone connected with same `pairing_token` and routes the `pair_offer` to the daemon's WS.
6. Daemon:
   - Computes `shared_secret = curve25519(daemon_sk, PPk)`.
   - Persists `{peer_id, peer_name, peer_pubkey, shared_secret, paired_at}` to `~/.cc-hub/config.json` under `paired_peers[]`.
   - `peer_id = base64(sha256(peer_pubkey)).replace(/[+/=]/g, '').slice(0,16)`.
   - Sends an **encrypted** envelope back containing:
     ```json
     { "kind": "pair_ack", "ok": true }
     ```
     This serves as proof-of-possession: phone decrypts using its own `curve25519(phone_sk, daemon_pk)` → if it matches, pairing is confirmed.
7. Phone:
   - Receives the envelope, decrypts with its derived shared secret.
   - If decryption succeeds and `kind === "pair_ack"`, pairing is done.
   - Persists `{daemon_id, worker_url, shared_secret}` to local storage.
8. Both sides close the pairing-mode WS. Daemon will reconnect in **relay mode** on next event (Phase 1 already exists; Phase 2 daemon entry-point starts RelayClient automatically when `paired_peers.length > 0`).

## Pairing Token TTL

5 minutes. After expiry, daemon closes WS and exits the pairing flow. User runs `pnpm pair --new` again.

## Failure Modes

| Failure | Daemon behaviour | Phone behaviour |
|---|---|---|
| QR not scanned within 5 min | Print "Pairing timed out", exit 1 | N/A |
| Phone connects but never sends `pair_offer` | Wait until TTL, then timeout | User cancels |
| `pair_offer` malformed | Drop, wait for next or timeout | Show error |
| `pair_ack` decryption fails on phone side | Daemon thinks it succeeded; phone retries / shows error | Retry pairing |
| Network drop mid-pairing | Close WS, timeout | Retry |

## Security Notes

- The pairing token is **only a rendezvous identifier**. Possession of it does NOT grant pairing — knowledge of the daemon's pubkey (from QR) is the real shared knowledge.
- An attacker who controls the Worker AND gets the pairing token can attempt a MITM: substitute their own pubkey in the QR. **Mitigation**: phone displays a fingerprint of the daemon_pk after pairing; user can compare with daemon's terminal output. (Not implemented in v0.3; deferred to Phase 3.)
- After pairing, the `shared_secret` is the only proof-of-identity. Loss of phone → revoke via `pnpm pair --revoke <peer_id>` on daemon.
```

- [ ] **Step 3: Create docs/protocols/worker-skeleton.md**

```markdown
# Worker Skeleton (Cloudflare Worker example)

This is a starter for the user's Cloudflare Worker. The Worker MUST adhere to `relay-protocol.md` and `pairing-protocol.md`. Implementation choices (Durable Objects vs Hibernation API, KV state) are up to you.

## Minimal contract

```ts
// worker.ts (Cloudflare Worker with Durable Objects)
// This is illustrative — not production-ready

interface Env {
  X_DAEMON_AUTH_TOKEN: string;
  ROUTER: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("OK", { status: 200 });
    }

    // Auth checks
    const path = url.pathname;
    if (path === "/v1/daemon") {
      if (req.headers.get("X-Daemon-Auth") !== env.X_DAEMON_AUTH_TOKEN) {
        return new Response("auth", { status: 401 });
      }
    } else if (path === "/v1/phone") {
      // CF Access populates these headers when SSO is enforced
      const email = req.headers.get("CF-Access-Authenticated-User-Email");
      if (!email) return new Response("sso", { status: 401 });
    } else {
      return new Response("not found", { status: 404 });
    }

    const daemonId = req.headers.get("X-Daemon-Id");
    const pairingToken = req.headers.get("X-Pairing-Token");
    const id = pairingToken ?? daemonId;
    if (!id) return new Response("missing id", { status: 400 });

    // Route to a Durable Object keyed by daemon_id (or pairing_token during pairing)
    const stub = env.ROUTER.get(env.ROUTER.idFromName(id));
    return stub.fetch(req);
  },
};

export class RouterDO {
  private daemonWs: WebSocket | null = null;
  private phoneWss: Set<WebSocket> = new Set();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const role = url.pathname === "/v1/daemon" ? "daemon" : "phone";
    if (role === "daemon") {
      this.daemonWs = server;
    } else {
      this.phoneWss.add(server);
    }

    server.addEventListener("message", (ev) => {
      const data = ev.data;
      if (role === "daemon") {
        for (const phone of this.phoneWss) phone.send(data);
      } else if (this.daemonWs) {
        this.daemonWs.send(data);
      }
    });

    server.addEventListener("close", () => {
      if (role === "daemon" && this.daemonWs === server) this.daemonWs = null;
      else this.phoneWss.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
```

## Notes

- This skeleton uses one DurableObject per daemon_id (or per pairing_token). Pairing-mode and relay-mode use the SAME id space; differentiation is by whether `X-Pairing-Token` was set on connect.
- For pairing, the same DO instance receives both daemon and phone via the shared `pairing_token` — natural rendezvous.
- After pairing, daemon reconnects in relay mode keyed by `X-Daemon-Id` and is matched with phones that connect later with the same `X-Daemon-Id`.
- You can use the **Cloudflare Hibernation API** to avoid keeping the DO alive when idle. Implementation detail.
- **wrangler.toml** needs to declare the DO binding. See Cloudflare docs.

## What you still need to add

- CF Access setup on the Worker route (so `/v1/phone` requires SSO)
- Optional rate-limiting on `/v1/daemon` (Worker-side, beyond X-Daemon-Auth)
- Worker logging that excludes message bodies
- Phone web client (out of scope for the daemon repo; can live in a separate repo)
```

- [ ] **Step 4: Commit**

```bash
git add docs/protocols/
git commit -m "docs(protocols): relay + pairing + worker-skeleton specs for user's Worker"
```

---

## Self-Review Summary

**Spec coverage check** (every section of `2026-05-15-cc-hub-phase2-design.md`):

| Spec section | Implementing task(s) |
|---|---|
| 一句話定義 / 解決什麼 | Architecture across Tasks 6, 7, 8 |
| 工作分工 | Task 10 (Worker contract docs); Tasks 2-9 are everything daemon-side |
| 威脅模型 | Task 2 (crypto) enforces it; Task 10 (worker docs) documents it |
| 加密設計 (TweetNaCl, X25519, secretbox, nonce-window) | Task 2 (crypto.ts), Task 6 (nonce window in handleMessage) |
| 配對流程 (8 步驟) | Task 5 (PairingSession), Task 7 (CLI wiring), Task 10 (pairing doc) |
| Worker 合約 | Task 10 (relay-protocol.md, worker-skeleton.md) |
| Envelope | Task 4 (encodeEnvelope/decodeEnvelope) |
| 訊息類型 | Task 4 (Plaintext union type), Task 6 (dispatchPlaintext) |
| 元件 (7 files + protocols) | Tasks 2-7 (one file each), Task 10 (protocols) |
| 資料模型 (Config / PairedPeer) | Task 3 (config.ts) |
| 資料流 場景 A (首次配對) | Task 7 (cmdNew) + Task 5 + Task 10 (pairing doc) |
| 資料流 場景 B (一般使用) | Task 6 + Task 8 |
| 資料流 場景 C (斷線重連) | Task 6 (reconnect with exp backoff) |
| 資料流 場景 D (Revoke) | Task 7 (cmdRevoke) |
| 錯誤處理 (Worker 不通 / token 過期 / 解密失敗 / 未配對 peer / config 損毀 / 太多 peer) | Tasks 3, 5, 6, 7 collectively |
| 測試策略 (unit + integration + manual) | Tasks 2-6 (unit), Task 9 (integration); manual smoke deferred to user |
| 技術棧 (tweetnacl, qrcode-terminal) | Task 1 (deps) |
| YAGNI 清單 (FS, multi-daemon, offline queue, etc.) | Not implemented — confirmed by absence |
| Open Questions | OQ1 (bundle size) not relevant to daemon side; OQ2-4 will surface in real smoke test |

**Placeholder scan:** No "TODO", "TBD", "implement later", or "fill in details" in any task. Every code step has full code.

**Type consistency:**
- `Keypair`, `Encrypted` defined in Task 2 and used in Tasks 3, 4, 5, 6.
- `PairedPeer`, `Config`, `RemoteEndpoint` defined in Task 3 and used in Tasks 5, 6, 7, 8.
- `Envelope`, `Plaintext`, `encodeEnvelope`, `decodeEnvelope`, `PROTOCOL_VERSION` defined in Task 4 and used in Tasks 5, 6, 7, 9.
- `PairingSession`, `PAIRING_TOKEN_TTL_MS`, `pairingQrPayload`, `computePeerId` defined in Task 5 and used in Task 7.
- `RelayClient`, `RelayClientDeps` defined in Task 6 and used in Task 8, 9.
- All method signatures consistent across definition and call sites.

**Test counts:** Phase 1 baseline 30 → Task 2 adds 9 → 39 → Task 3 adds 8 → 47 → Task 4 adds 4 → 51 → Task 5 adds 6 → 57 → Task 6 adds 3 → 60 → Task 9 adds 1 → 61.

No unresolved gaps.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-cc-hub-phase2.md`.**
