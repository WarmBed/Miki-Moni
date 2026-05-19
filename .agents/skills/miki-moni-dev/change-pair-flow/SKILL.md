---
name: miki-moni-dev-change-pair-flow
description: Use when modifying any part of miki-moni's pairing / relay flow — daemon-side pair handling, worker DurableObjects, phone client bootstrap, QR generation, token registration. Triggers on "改 pair", "modify pairing", "relay change", "add pair token field", "pair URL format", "anti-MITM", "pair approval". This area has bitten us repeatedly (chicken-egg, silent-fallback, double-path, MITM); this skill is the regression-prevention checklist.
---

# Changing the Pair Flow Safely

The pairing handshake spans **6 files across 3 deployment targets** that all have to agree. Get one wrong and a clean upgrade ends with users staring at "ws_error". This skill is the do-not-repeat-history checklist.

## The 6 files

1. **`src/pairing.ts`** — pair token generation + QR payload format
2. **`src/relay-client.ts`** — daemon side: connect to worker, handle `pair_offer`, persist `paired_peers`
3. **`src/cli/pair.ts`** — CLI `--new` / `--rotate` / `--list` / `--show` / `--revoke`
4. **`worker/src/pairing-coordinator.ts`** — DurableObject token registry (register / claim / revoke)
5. **`worker/src/daemon-relay.ts`** — DurableObject per-daemon relay (acceptPhone, reconnect-sig verify, message routing)
6. **`web-phone/relay.ts` + `web-phone/main-tunnel.tsx`** — phone client: parse URL fragment, `performPairing`, bootstrap effect

If your change touches the *protocol* (message types, field names, URL fragment params), you almost certainly need to edit ≥3 of these. Also see `worker/src/handshake.ts` and `src/crypto.ts` for primitives.

## Mandatory pre-flight checklist

Before pressing edit on any of those files, ask:

1. **Is this gating something on existing state?** (e.g. "only do X if `paired_peers.length > 0`")
   - → That's chicken-and-egg. First-time users can't pair. See 0.3.7.
2. **Is this preferring cached state over explicit user input?** (URL hash, CLI flag, env var)
   - → Silent fallback = misleading. URL/explicit input wins. See 0.3.6.
3. **Am I writing data to disk AFTER ACKing?**
   - → Split-brain on disk failure. Persist first, ACK after. See 0.3.8 `handlePairOffer`.
4. **Am I appending a path to `worker_url`?** (`${worker_url}/v1/phone` etc)
   - → Some configs have `/v1/daemon` baked in. Strip before appending. See 0.3.9.
5. **Am I assuming the relay is honest?**
   - → It's only honest-but-curious. Anything the phone learns from `pair_init` (e.g. `daemon_pubkey`) needs out-of-band verification (QR `&k=`). See 0.3.8 SEC-1.
6. **Does this introduce a new bearer credential?** (token, sig, secret in URL)
   - → Persistent tokens = permanent access if leaked. At minimum, document it. Better: gate behind `MIKI_PAIR_REQUIRE_APPROVAL`.

## Protocol message types (cheatsheet)

| Direction | Type | Origin | Handled by |
|---|---|---|---|
| daemon → worker | `register_pairing` | `relay-client.ts` | `daemon-relay.ts:handleDaemonMessage` → forwards to coordinator |
| worker → daemon | `challenge` then `ready` | `daemon-relay.ts:acceptDaemon` | `relay-client.ts` challenge-response |
| daemon → worker | `challenge_response` (sig) | `relay-client.ts` | `daemon-relay.ts` verify |
| worker → phone | `pair_init` (with `daemon_pubkey`) | `daemon-relay.ts:acceptPhone` | `web-phone/relay.ts:performPairing` — verifies against QR `&k=` |
| phone → daemon (via worker) | `pair_offer` | `web-phone/relay.ts` | `relay-client.ts:handlePairOffer` |
| daemon → phone | `pair_ack` / `pair_nack` | `relay-client.ts` | phone `performPairing` resolves/rejects |
| both ↔ | `envelope` (encrypted Plaintext) | various | `relay-protocol.ts:encodeEnvelope` / `decodeEnvelope` |
| daemon → worker | `keepalive` (every 50s) | `relay-client.ts` | `daemon-relay.ts` no-op ack (defeats CF 100s idle timeout) |

## URL fragment format (current)

```
https://miki-moni.pages.dev/#t=<TOKEN>&r=<WORKER_URL_ENCODED>&k=<DAEMON_PUBKEY_B64_ENCODED>
   t = 16-char pair token (Crockford-base32-ish alphabet, rejection-sampled)
   r = worker_url (NOT including /v1/daemon path — strip if present)
   k = daemon X25519 encryption pubkey, base64 (anti-MITM, optional for legacy QRs)
```

Anything new you add → `parsePairFragment` in `web-phone/main-tunnel.tsx` must also parse it, AND `pairingQrPayload` in `src/pairing.ts` must emit it.

## Required test cycle for any pair-flow change

```
1. pnpm typecheck       (touch all 3 deploy targets — daemon, worker, phone — typescript must agree)
2. pnpm vitest run tests/integration-relay.test.ts   (full E2E daemon ↔ mock-worker ↔ phone)
3. pnpm verify          (heavier: starts a mock worker + runs the verify script)
4. Manual Playwright smoke (tools/dev/smoke-pair-038.py as template):
   - new format URL works
   - old format URL (no &k=) still works (back-compat)
   - bad URL (token doesn't exist on worker) fails cleanly
```

## Deploy order matters

If your change is **protocol-breaking** (e.g. new required field, removed message type):

1. **Worker first** (must accept BOTH old and new formats for transition)
2. **Daemon second** (sends new format, but worker still tolerates old phones)
3. **Pages last** (phone PWA — once deployed, all users start using new format)

Reverse order = old daemons can't talk to new worker, or new phones can't talk to old daemons.

If your change is **protocol-compatible** (e.g. add optional field, tighten validation): deploy order doesn't matter, but `worker_url`-shape changes are protocol-breaking even if they look compatible — be careful.

## Back-compat rules

We support **old QRs without `&k=`** (pre-0.3.8 generation) — phone falls back to trust-on-first-use with console warning. Don't remove this until we're confident no one's still using old QRs.

Same for any future protocol field: assume some phone is running 6-month-old bundle.

## Known regression traps (canonical bug list)

| Bug | What broke | Fix file | Version |
|---|---|---|---|
| Chicken-egg relay startup | First pair impossible | `src/index.ts:157` removed `paired_peers > 0` gate | 0.3.7 |
| localStorage > URL hash | New pair URL silently ignored | `web-phone/main-tunnel.tsx` reorder | 0.3.6 |
| AskQ Submit shown on Q1/N | Premature submit | `web/app.tsx:533` Next/Submit conditional | 0.3.4 |
| Image content blocks dropped | Bubble shows text only | `src/session-resolver.ts` `block.type==="image"` handler + `web/app.tsx:TurnView` | 0.3.4 |
| Permission mode menu cut off | Dropdown off-screen at right edge | `web/app.tsx:PermissionModeChip` viewport-clamp | 0.3.5 |
| Pair token modulo bias | Skewed entropy | `src/pairing.ts` + `worker/src/pairing-code.ts` rejection sampling | 0.3.8 |
| Reconnect-sig 2-min window | Replay possible | `worker/src/daemon-relay.ts:verifyReconnectSig` current minute only | 0.3.8 |
| Pair-offer ACK before save | Disk failure → silent peer loss | `src/relay-client.ts:handlePairOffer` persist-first | 0.3.8 |
| `cmdNew` replaces remote whole | Persistent token wiped | `src/cli/pair.ts:cmdNew` use `{...remote, worker_url}` | 0.3.8 |
| `cmdRotate` dueling daemons | Two daemons race for 8765 | `src/cli/pair.ts:cmdRotate` skip spawn if `/admin/restart` acked | 0.3.8 |
| Rotate to new relay leaves old token | Old QR usable forever | `cmdRotate` revokeOldRelayToken | 0.3.8 |
| `paired_peers` unbounded growth | Config bloat (29 entries seen) | `src/config.ts:addPairedPeer` LRU + stale prune | 0.3.8 |
| `last_seen_at` never written | Can't prune dead peers | `src/relay-client.ts:touchPeerSeen` | 0.3.8 |
| DNS rebinding | evil.com can POST `/admin/*` | `src/server.ts` middleware | 0.3.8 |
| Relay can MITM ECDH | Worker swaps daemon pubkey | QR `&k=` + phone verify | 0.3.8 |
| `worker_url` w/ `/v1/daemon` baked in | Phone tries `/v1/daemon/v1/phone` | Strip in `pairingQrPayload` + `performPairing` | 0.3.9 |

If you cause a 13th entry, this skill needs updating.

## Related skills

- `miki-moni-dev:locate-code` — finds files quickly
- `miki-moni-dev:release-flow` — pair flow change usually needs worker + Pages + npm all 3 deployed; this skill covers ordering
