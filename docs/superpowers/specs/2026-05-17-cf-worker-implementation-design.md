# Phase 2 CF Worker Implementation — Design Spec

**Date:** 2026-05-17
**Status:** Design approved, ready for implementation plan.
**Supersedes:** "Worker 合約" + "Open Questions" sections of `2026-05-15-cc-hub-phase2-design.md`.

## Problem

Phase 2 spec defines an E2E encrypted relay between daemon (user's laptop) and phone (user's mobile/browser). The relay should run on Cloudflare Workers + Durable Objects, deployed to `relay.f1telemetrystationpro.org`. That spec left the CF-specific implementation details vague ("Worker 端會處理") and assumed Cloudflare Access SSO for phone auth, which we've since decided against (no-login MVP).

This spec fills the gaps: Durable Objects sharding, Hibernating WebSocket pattern, pairing flow without SSO, anti-abuse without pre-shared tokens, offline behavior, and `wrangler.toml` configuration. The end-user UX target: scan a QR code OR type a 16-char pairing code → remote control your Claude sessions from anywhere.

## Goals

- **Zero-knowledge relay** — Worker sees only encrypted blobs + minimal routing metadata. No content, no transcripts, no user identity.
- **No login** — Pairing is the only auth ceremony. No Google OAuth, no CF Access, no accounts.
- **Self-hostable trivially** — One `wrangler deploy` to user's own Cloudflare account. Same code, different account.
- **Free-tier viable** — Designed to fit Cloudflare Workers free tier (100k req/day, DO standard).
- **Daemon-side compatible** — Minimal changes to existing `src/relay-client.ts`. Drop `X-Daemon-Auth` pre-shared token, gain challenge-response handshake.

## Non-Goals (YAGNI)

- ❌ Offline message queue — phone offline = messages dropped. Phone reload-syncs from daemon state on reconnect.
- ❌ Push notifications (APNs/FCM) — Phase 3.
- ❌ Message history persistence in Worker — daemon JSONL is the only source of truth.
- ❌ Multi-daemon-per-user accounts — one daemon = one pairing namespace.
- ❌ Forward secrecy / Double Ratchet — Phase 3.
- ❌ File / image attachments through relay — Phase 3 (would need R2).
- ❌ Web Push API in browser PWA — Phase 3.

## Architecture

```
┌─────────────────────┐                                         ┌──────────────────────┐
│ User Laptop         │                                         │ User Phone / Browser │
│                     │                                         │                      │
│  cc-hub daemon      │                                         │  cc-hub web-phone    │
│  + relay-client     │                                         │  (PWA)               │
│  (Node.js, SQLite,  │                                         │                      │
│   keypair on disk)  │                                         │  (keypair in         │
│      │              │                                         │   IndexedDB)         │
└──────┼──────────────┘                                         └──────────┼───────────┘
       │                                                                   │
       │ wss://relay.f1telemetrystationpro.org/v1/daemon                                 │ wss://relay.f1telemetrystationpro.org/v1/phone
       │ + challenge-response handshake                                    │ + pairing-token OR daemon_id+sig
       │                                                                   │
       ▼                                                                   ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Worker (relay.f1telemetrystationpro.org)                      │
│                                                                                    │
│   Worker fetch handler                                                            │
│   - GET  /v1/health        → 200 OK                                              │
│   - WSS  /v1/daemon        → route to per-daemon DO                              │
│   - WSS  /v1/phone         → route to per-daemon DO (via coordinator lookup)     │
│   - POST /v1/coordinator/* → internal coordinator RPC                            │
│                                                                                    │
│   ┌────────────────────────────────────┐  ┌────────────────────────────────────┐ │
│   │   PairingCoordinator (1 DO)        │  │   DaemonRelay (N DOs)              │ │
│   │   name = "coordinator"             │  │   name = daemon_id (pubkey hash)   │ │
│   │                                    │  │                                    │ │
│   │   pending_pairings: Map<token,     │  │   daemon_ws: WebSocket | null      │ │
│   │     { daemon_id, expires_at }>     │  │   phone_wss: Set<WebSocket>        │ │
│   │                                    │  │   daemon_pubkey: Uint8Array        │ │
│   │   - claim(token, daemonId)         │  │   - relay envelope                 │ │
│   │   - lookup(token) → daemonId       │  │   - verify daemon challenge        │ │
│   │   - expire on alarm (10 min TTL)   │  │   - hibernating WS callbacks       │ │
│   └────────────────────────────────────┘  └────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Two DO classes:**

1. **`PairingCoordinator`** — single instance (`name="coordinator"`). Holds pending pairing tokens. Low traffic (only during the brief pairing window). Stores Map of token → daemon_id with TTL.

2. **`DaemonRelay`** — one instance per daemon (`name=daemon_id`). Holds the daemon's WS + connected phone WSes. Self-routes envelopes between them.

## Pairing Code Format

Both QR and manual entry use the **same** 16-character pairing token:

```
K7H2-X9PN-RT4B-MWQ8
```

- 16 chars Crockford base32 (excludes `0`, `O`, `1`, `I`, `L` for unambiguous reading)
- ~80 bits entropy → brute-force infeasible even without rate limit
- Display format: `XXXX-XXXX-XXXX-XXXX` (4-4-4-4 grouping for readability)
- Hyphens stripped before validation; case-insensitive
- TTL 10 minutes (enough time to type on a phone)
- Single-use: claimed token deleted from coordinator immediately on successful pairing

QR payload (string content):
```
cch://pair?token=K7H2X9PNRT4BMWQ8&relay=https%3A%2F%2Frelay.f1telemetrystationpro.org
```

Manual entry: user opens web-phone, types/pastes `K7H2-X9PN-RT4B-MWQ8` into a single input field. Frontend strips hyphens, uppercases, sends to coordinator.

## Wire Protocol

WebSocket frames are JSON. One message per frame.

### Endpoints

```
WSS  wss://relay.f1telemetrystationpro.org/v1/daemon            # daemon connects here
WSS  wss://relay.f1telemetrystationpro.org/v1/phone             # phone (paired or pairing) connects here
GET  https://relay.f1telemetrystationpro.org/v1/health          # plain HTTP, returns "ok"
```

### Daemon-side handshake (challenge-response)

Replaces the old `X-Daemon-Auth` pre-shared token.

```
1. Daemon opens WSS /v1/daemon with header `X-Daemon-Pubkey: <base32(pubkey)>`
2. Worker derives daemon_id = SHA-256(pubkey) and routes to DaemonRelay DO by that name
3. DO sends:    { type: "challenge", nonce: <base64(32B random)> }
4. Daemon signs nonce + worker-supplied timestamp with its X25519-derived Ed25519 keypair
   (or uses a separate sign keypair generated alongside the encryption pair; see Crypto section)
5. Daemon replies: { type: "challenge_response", sig: <base64>, pubkey: <base64> }
6. DO verifies sig against pubkey, confirms SHA-256(pubkey) == daemon_id, accepts the connection
7. DO emits { type: "ready" }; daemon is now in relay mode
8. If `X-Pairing-Init: 1` header was set, daemon also registers a pairing token with the coordinator (see Pairing Flow)
```

On failure: close with code 4001 (`auth_failed`) and message.

### Phone-side handshake (two modes)

#### A. New pairing (phone has no prior daemon_id)

```
1. Phone opens WSS /v1/phone with header `X-Pairing-Token: K7H2X9PNRT4BMWQ8` (no hyphens)
2. Worker forwards to PairingCoordinator DO
3. Coordinator looks up token → finds daemon_id, marks token "claiming"
4. Worker (with that daemon_id) routes phone WS to the DaemonRelay DO
5. DaemonRelay sends:    { type: "pair_init", daemon_pubkey: <base64> }
6. Phone:
   a. Generates its own X25519 keypair (in IndexedDB)
   b. Derives shared_secret = X25519(phone_priv, daemon_pub)
   c. Sends: { type: "pair_offer", phone_pubkey: <base64> }
7. DaemonRelay forwards pair_offer to daemon over its WS
8. Daemon derives matching shared_secret = X25519(daemon_priv, phone_pub), stores in config.paired_peers
9. Daemon sends { type: "pair_ack", session_uuid?: string } via its WS → DO forwards to phone
10. Coordinator deletes the token
11. Phone stores: { relay_url, daemon_id, daemon_pubkey, phone_keypair, shared_secret } in IndexedDB
12. Both sides are now in relay mode
```

#### B. Re-connect (phone already paired)

```
1. Phone opens WSS /v1/phone with headers:
   - X-Daemon-Id: <daemon_id>
   - X-Phone-Pubkey: <base64(phone_pubkey)>
   - X-Sig: <base64(sign(daemon_id + nonce_minute, phone_priv))>
   where nonce_minute = floor(currentEpochMinute / 1) — a UTC minute bucket, mitigates replay
2. Worker routes to DaemonRelay DO by daemon_id
3. DO verifies sig (phone_pubkey was stored at pairing time, looked up in DO storage)
4. On verify pass: accept WS, emit "ready"
5. On fail: close with code 4001
```

### Envelope (post-handshake)

All post-handshake messages are opaque to the Worker — see `src/relay-protocol.ts:Envelope`. The Worker only sees:

```ts
{
  type: "envelope",
  from: string,        // sender id (for fan-out routing only)
  to?: string,         // optional target (broadcast if absent)
  ciphertext: string,  // base64 encrypted payload
  nonce: string        // base64
}
```

The DO does NOT inspect `ciphertext`. It forwards to the other side(s) of the pairing.

### Close codes

| Code | Name | When |
|---|---|---|
| 1000 | normal | clean close from either side |
| 1008 | policy_violation | bad headers, malformed JSON, sig fail |
| 4001 | auth_failed | challenge-response failed |
| 4002 | pairing_token_invalid | token expired or unknown |
| 4003 | rate_limited | per-IP rate limit hit |
| 4011 | server_drained | DO recycling (rare; client should reconnect with backoff) |

## Durable Object Internals

### `PairingCoordinator`

Single instance, `name="coordinator"`. Storage:

```ts
{
  // token (no hyphens, uppercase) → { daemon_id, expires_at_ms }
  pending: Map<string, { daemon_id: string; expires_at_ms: number }>;
}
```

API (called by Worker fetch handler via DO RPC):

```ts
// Daemon registers a new pairing offer.
register(token: string, daemon_id: string): { ok: true } | { ok: false; reason: string }

// Phone redeems a token. Returns daemon_id if valid; marks token as in-flight (1-shot).
claim(token: string): { ok: true; daemon_id: string } | { ok: false; reason: "expired" | "unknown" | "already_claimed" }

// Daemon may revoke a token early.
revoke(token: string): void
```

TTL enforcement: DO Alarm fires every 60s, deletes any entry with `expires_at_ms < now`.

### `DaemonRelay`

One instance per daemon, `name=daemon_id`. Uses **Hibernating WebSocket** — the DO can release memory between messages, woken automatically by incoming frames.

Storage:

```ts
{
  daemon_pubkey: Uint8Array;       // public key bytes (set after first daemon connects)
  paired_phones: Map<string, {     // phone_id (hash of pubkey) → meta
    pubkey: Uint8Array;
    paired_at_ms: number;
  }>;
  pending_pair_init?: {            // present only during a pairing window
    pairing_token: string;
    expires_at_ms: number;
  };
}
```

In-memory (rebuilt from `state.getWebSockets()` after hibernation):

```ts
{
  daemon_ws: WebSocket | null;     // exactly one
  phone_wss: Set<WebSocket>;
}
```

Each accepted WS is tagged via `state.acceptWebSocket(ws, [tag])` so post-hibernation we can re-classify:

```ts
state.acceptWebSocket(ws, ["daemon"]);
state.acceptWebSocket(ws, ["phone", phone_id]);
```

Handler methods (CF Workers Hibernating WS API):

```ts
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>
async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>
async webSocketError(ws: WebSocket, error: unknown): Promise<void>
```

Routing inside DO:

```ts
async webSocketMessage(ws, message) {
  const tags = this.state.getTags(ws);  // ["daemon"] or ["phone", phone_id]
  const env = JSON.parse(message);

  if (tags[0] === "daemon") {
    // daemon → all phones (or targeted phone if env.to is a phone_id)
    for (const phone of this.state.getWebSockets("phone")) {
      if (!env.to || env.to === this.tagOf(phone)[1]) phone.send(message);
    }
  } else {
    // phone → daemon
    const daemon = this.state.getWebSockets("daemon")[0];
    if (daemon) daemon.send(message);
    else ws.close(4011, "daemon_offline");  // phone notified daemon is gone
  }
}
```

## Anti-abuse

**No pre-shared secrets. No accounts. Just crypto + CF infrastructure.**

1. **Daemon connection** requires valid challenge-response with the pubkey whose hash matches the requested daemon_id. Attackers without the private key can't impersonate.

2. **Phone connection** requires either:
   - Valid pairing token (single-use, 10 min TTL, ~80 bits entropy)
   - OR (paired phone) valid Ed25519 sig over `daemon_id + UTC_minute` using a pubkey known to the DaemonRelay DO

3. **Per-IP rate limit** via Cloudflare's [rate limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):
   - `/v1/daemon` and `/v1/phone` paths: 30 new connection attempts per minute per IP
   - Exceeded → 429 / WS close 4003

4. **CF DDoS protection** at network layer (free, automatic).

5. **No reflection attacks**: Worker never echoes user-controlled data back without crypto validation.

6. **Pairing token rate limit** within coordinator: max 10 pairing registrations per daemon per hour (prevents one daemon from filling the coordinator with junk).

7. **Coordinator overflow protection**: if `pending.size > 10000`, refuse new registrations until alarm cleanup.

## Crypto Mapping (clarification with existing code)

`src/crypto.ts` uses TweetNaCl `nacl.box` (X25519 + XSalsa20-Poly1305) for the encryption keypair. For the daemon challenge-response signature, we'll use the same X25519 keypair but with `nacl.sign` — actually, NaCl's box and sign use different curves, so we need to be careful.

**Decision:** Add a separate Ed25519 sign keypair to the daemon. Stored alongside the existing X25519 keypair in `config.json`:

```ts
{
  daemon_keypair: {
    encryption: { pub: <base64>, priv: <base64> },   // X25519 (nacl.box, existing)
    signing: { pub: <base64>, priv: <base64> },       // Ed25519 (nacl.sign, NEW)
  },
  ...
}
```

The `daemon_id` is derived from the **signing pubkey** (Ed25519): `SHA-256(signing.pub)`. This is what the DaemonRelay DO matches against.

For phones: same dual-keypair structure in IndexedDB (encryption + signing keys).

The existing `src/crypto.ts` only has `nacl.box` helpers. Add `nacl.sign` helpers as part of the implementation.

## Daemon-Side Changes

`src/relay-client.ts` currently:
- Reads `remote.x_daemon_auth_token` from config — **REMOVE** (no more pre-shared token)
- Sends `X-Daemon-Auth` header — **REMOVE**
- Sends `X-Daemon-Id` header — **KEEP** but now derived from signing pubkey
- Sends `X-Daemon-Pubkey: <base32(signing.pub)>` header — **NEW**
- Implements challenge-response after WS open — **NEW** (~30 LOC)
- On `X-Pairing-Init: 1` mode: after handshake, registers pairing token via the WS (sent as a special `register_pairing` message that the DaemonRelay forwards to coordinator)

`src/config.ts`: add `signing` sub-keypair to `daemon_keypair`. Migration: on daemon start, if `signing` missing, generate + persist. Existing X25519 `encryption` keypair untouched.

`src/pairing.ts`: minor — `pairingQrPayload()` now emits `cch://pair?token=XXXX&relay=...` format.

## Web-Phone Changes

`web-phone/relay.ts` needs the same dual-keypair handling + signature on reconnect. Currently mostly handles the pairing flow; add re-connect path with Ed25519 sig.

`web-phone/app.tsx`: new manual-entry input UI for pairing code (4×4 char boxes or single field with auto-format).

## `wrangler.toml`

Lives at `cc-hub/worker/wrangler.toml`. Single-Worker, two DO bindings, custom domain route:

```toml
name = "cch-relay"
main = "src/index.ts"
compatibility_date = "2026-05-17"
compatibility_flags = ["nodejs_compat"]

# Custom domain (DNS must already exist in Cloudflare for f1telemetrystationpro.org zone)
routes = [
  { pattern = "relay.f1telemetrystationpro.org/*", custom_domain = true }
]

# Durable Object bindings
[[durable_objects.bindings]]
name = "PAIRING"
class_name = "PairingCoordinator"

[[durable_objects.bindings]]
name = "RELAY"
class_name = "DaemonRelay"

# DO migrations (one per release that adds/removes a DO class)
[[migrations]]
tag = "v1"
new_classes = ["PairingCoordinator", "DaemonRelay"]

# Rate-limit binding
[[unsafe.bindings]]
name = "RATE_LIMITER"
type = "ratelimit"
namespace_id = "1"
simple = { limit = 30, period = 60 }
```

No `[vars]` (no secrets needed — pre-shared token removed).

## Repo Layout

```
cc-hub/
├── worker/                               # NEW — CF Worker package
│   ├── package.json                      # name: cc-hub-worker, dep on @cloudflare/workers-types
│   ├── tsconfig.json
│   ├── wrangler.toml
│   ├── src/
│   │   ├── index.ts                      # fetch handler + DO export
│   │   ├── pairing-coordinator.ts        # PairingCoordinator DO
│   │   ├── daemon-relay.ts               # DaemonRelay DO
│   │   ├── handshake.ts                  # challenge-response + sig verify (pure fn)
│   │   ├── pairing-code.ts               # base32 encode/decode/normalize
│   │   └── env.ts                        # Env type definitions
│   └── tests/                            # vitest with @cloudflare/vitest-pool-workers
│       ├── handshake.test.ts             # unit
│       ├── pairing-code.test.ts          # unit
│       ├── coordinator.test.ts           # DO test
│       └── relay.test.ts                 # DO test (full pairing + relay E2E)
├── src/
│   ├── relay-client.ts                   # MODIFY: challenge-response, drop X-Daemon-Auth
│   ├── crypto.ts                         # ADD: sign / verify helpers (nacl.sign)
│   ├── config.ts                         # ADD: signing keypair, migration
│   └── pairing.ts                        # MODIFY: cch:// URL format
├── web-phone/
│   ├── relay.ts                          # MODIFY: dual-keypair + reconnect sig
│   ├── app.tsx                           # ADD: manual code-entry UI
│   └── store.ts                          # ADD: persist signing keypair to IndexedDB
└── docs/
    └── deploy.md                          # NEW: hosted vs self-host guide
```

## Testing Strategy

### Worker unit tests (`worker/tests/`)

Use `@cloudflare/vitest-pool-workers` — runs tests inside actual workerd, real DO behavior.

- `handshake.test.ts`: challenge-response sign + verify (Ed25519); reject wrong pubkey; reject expired nonce; reject sig over wrong message.
- `pairing-code.test.ts`: 16-char base32 encode/decode; normalize hyphens; reject ambiguous chars; entropy check (no all-same).
- `coordinator.test.ts`: register → claim happy path; expire after TTL; reject claim of unknown token; reject double-claim; alarm cleans up stale.
- `relay.test.ts`: full pairing flow (mock daemon WS + mock phone WS); envelope routing (daemon→phone, phone→daemon, broadcast); phone disconnect doesn't drop others; daemon disconnect closes phones with 4011.

### Daemon integration tests (`tests/`)

- `relay-client.test.ts`: ADD tests for new challenge-response flow (mock Worker speaks the protocol).
- Existing `mock-worker` updated to match new protocol (sign challenges, no auth token).

### E2E smoke (manual, documented)

- `pnpm mock-worker` + `pnpm pair` locally → scan QR → web-phone shows session list → send prompt round-trip works.
- Deploy to `relay.f1telemetrystationpro.org` → same flow with real Worker → confirm `daemon_id` routes to correct DO.

## Deployment

### Hosted (your infra)

```bash
cd cc-hub/worker
wrangler login          # one-time, OAuth to f1telemetrystationpro.org's CF account
wrangler deploy
# → live at https://relay.f1telemetrystationpro.org
```

### Self-host (user's own CF account)

```bash
git clone https://github.com/<repo>/cc-hub
cd cc-hub/worker

# 1. Edit wrangler.toml — replace the routes block with YOUR domain
#    OR delete it to use the auto-assigned <worker>.<account>.workers.dev URL
sed -i 's|relay.f1telemetrystationpro.org|cch.your-name.workers.dev|' wrangler.toml

# 2. Deploy
wrangler login
wrangler deploy

# 3. Tell your daemon to use it
cch config set remote.worker_url https://cch.your-name.workers.dev
```

`docs/deploy.md` documents both paths in detail.

## Error Handling

| Failure | Response |
|---|---|
| Daemon connects with malformed `X-Daemon-Pubkey` | WS close 1008 + log warn |
| Daemon fails challenge-response in 10s | WS close 4001 + log warn |
| Phone hits `/v1/phone` without `X-Pairing-Token` AND without `X-Daemon-Id`+sig | WS close 1008 immediately |
| Phone presents expired or already-claimed token | WS close 4002 |
| Phone fails reconnect sig (paired but wrong key) | WS close 4001 |
| Daemon disconnects mid-session | All phone WSes get close 4011, phone reconnects with backoff |
| Per-IP rate limit hit | WS close 4003 |
| DO storage transient failure | Retry once, then close 1011 (server error); client reconnects |

## Open Questions (none — all resolved during brainstorming)

- ✅ DO sharding: per-daemon + coordinator (decided)
- ✅ Pairing storage: coordinator DO with 10-min TTL (decided)
- ✅ Anti-abuse: crypto handshake + CF rate-limit (decided)
- ✅ Offline queue: drop, no persistence (decided)
- ✅ Drop pre-shared X-Daemon-Auth: yes, challenge-response replaces it (decided)
- ✅ Pairing code format: 16-char Crockford base32 (decided after spec draft)
