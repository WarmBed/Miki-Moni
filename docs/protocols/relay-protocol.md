# miki-moni Relay Protocol (v1)

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

**Note for browser clients:** Browser-native `WebSocket` does not support custom request headers. Phone clients running in a browser MUST instead pass `daemon_id` and/or `pairing_token` as **URL query parameters** on the WS upgrade URL (e.g. `wss://worker/v1/phone?daemon_id=<id>`). Server implementations MUST accept either headers OR query parameters and prefer headers when both are present.

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
