# Remote RPC Tunnel — Design Spec

**Date:** 2026-05-17
**Status:** Approved (Phase B)
**Goal:** Any non-localhost client (phone, second laptop, tablet) opens the *same* dashboard UI as `http://127.0.0.1:8765` and gets feature parity, routed through the existing E2E-encrypted CF Worker relay.

## Non-Goals

- Modifying `src/server.ts` or any backend logic (user WIP in parallel).
- Adding new daemon HTTP endpoints. The tunnel exposes exactly what `localhost:8765` already exposes.
- Auth / authz changes. Pairing + Ed25519 reconnect + per-peer ECDH shared secret already do the job.
- npm publish / installation UX (handled in another WIP branch).

## Design Principles

1. **Same JS bundle, two transports.** `web/` is built once and served from two origins; runtime decides whether to call backend directly (localhost) or via tunnel (remote).
2. **Server.ts is the only source of truth for backend behavior.** Tunnel side just forwards request/response bytes; daemon-side proxy re-issues the call against its own `localhost:8765` so server logic doesn't fork.
3. **Pluggable Transport.** A single `Transport` interface; current implementations: `LocalHttpTransport`, `TunnelTransport`. Future (e.g. WebRTC P2P, local LAN) just add another impl.
4. **Self-host friendly.** No URLs hardcoded in `web/`. PWA URL + relay URL flow in via build-time env + per-pairing URL fragment. Defaults are *hosted-convenience defaults*, not architectural.

## Architecture

```
                       ┌─────────────────────────────────────────────┐
                       │   web/ JS bundle (built once)               │
                       │   ┌──────────────────────────────────────┐  │
                       │   │ React components (unchanged)         │  │
                       │   │ — call apiFetch / apiWebSocket       │  │
                       │   └────────────┬─────────────────────────┘  │
                       │   ┌────────────▼─────────────────────────┐  │
                       │   │ web/api.ts                           │  │
                       │   │  pickTransport() → Transport         │  │
                       │   │  apiFetch / apiWebSocket             │  │
                       │   └────────────┬─────────────────────────┘  │
                       │                │ (Transport interface)      │
                       │   ┌────────────┴──────┐  ┌──────────────┐  │
                       │   │ LocalHttpTransport│  │TunnelTransport│ │
                       │   └───────────────────┘  └───────┬──────┘  │
                       └──────────────────────────────────┼──────────┘
                                                          │  envelope
                                       ┌──────────────────▼────────┐
                                       │ CF Worker relay (Phase A) │
                                       │  routes by peer_id        │
                                       └──────────────────┬────────┘
                                                          │  envelope
                            ┌─────────────────────────────▼────────────────┐
                            │ Daemon: RelayClient                          │
                            │  + http_proxy handler                        │
                            │  + ws_proxy handler                          │
                            │     → fetch http://127.0.0.1:8765/{path}     │
                            │     → encrypt response → relay → phone       │
                            └─────────────────────────────┬────────────────┘
                                                          │ localhost HTTP/WS
                                                          ▼
                            ┌──────────────────────────────────────────────┐
                            │ server.ts (UNCHANGED)                        │
                            │ /sessions, /transcript, /send, /focus, /ws,…│
                            └──────────────────────────────────────────────┘
```

## Module Boundaries

### `web/api.ts` (new, ~80 LOC)

Single export surface. UI components import only this.

```ts
export interface Transport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openWebSocket(path: string): WebSocketLike;
  readonly mode: "local" | "tunnel";
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(t: "open" | "message" | "close" | "error", cb: (ev: any) => void): void;
}

export const apiFetch: Transport["fetch"];
export const apiWebSocket: Transport["openWebSocket"];
```

Bootstrap (in `web/index.html` or `web/main.tsx`) selects the transport once, then all UI code uses `apiFetch` / `apiWebSocket` exclusively.

### `web/transport-local.ts` (new, ~20 LOC)

Wraps native `fetch` + `WebSocket` against same-origin. Identity-shaped.

### `web/transport-tunnel.ts` (new, ~150 LOC)

- Holds the relay WS connection (created via `connectAuthed` from existing `relay.ts`)
- `fetch(path, init)`:
  - Generates `request_id`
  - Sends `{kind:"http_proxy", request_id, method, path, headers?, body?}` envelope
  - Awaits matching `{kind:"http_proxy_response", request_id, status, headers, body}` envelope (timeout 30s)
  - Returns a synthesized `Response` object
- `openWebSocket(path)`:
  - Generates `tunnel_ws_id`
  - Sends `{kind:"ws_proxy_open", tunnel_ws_id, path}`
  - Returns a `WebSocketLike` shim that:
    - `send(data)` → `{kind:"ws_proxy_send", tunnel_ws_id, data}`
    - dispatches `message` events from `{kind:"ws_proxy_msg", tunnel_ws_id, data}`
    - dispatches `close` events from `{kind:"ws_proxy_close", tunnel_ws_id, code, reason}`
    - `close()` → `{kind:"ws_proxy_close", tunnel_ws_id, code, reason}`

### `src/relay-client.ts` (extended, ~+120 LOC)

Adds two message handlers to the existing receive loop:

- `http_proxy` → `fetch("http://127.0.0.1:" + daemonPort + path, …)` → wrap response into `http_proxy_response` envelope addressed `to: phone:<from_peer_id>`.
- `ws_proxy_open` → opens a local `ws://127.0.0.1:port/<path>` WebSocket, stores it in `tunnels: Map<tunnel_ws_id, LocalWS>`. Forwards subsequent `ws_proxy_send` to the local WS, and forwards local WS messages back as `ws_proxy_msg` envelopes (addressed to the originating peer).
- `ws_proxy_close` → closes and removes from `tunnels`.

Tunnel state is per-peer. Cleanup on peer disconnect.

### Configuration surface

`Config.remote` (existing):

```ts
remote?: {
  worker_url: string;          // CF Worker URL (defaults: hosted)
  phone_pwa_url?: string;      // CF Pages URL for QR target (defaults: hosted)
  daemon_local_port?: number;  // Default 8765
}
```

`pairing.ts:pairingQrPayload` reads `phone_pwa_url` from config rather than hardcoding. Defaults to hosted convenience URL.

## Protocol — Envelope Payloads

All inside the existing encrypted `Envelope { v, to, ct, nonce, ts }`. Decrypted JSON has `kind` plus payload.

### Request/response (HTTP proxy)

```jsonc
// phone → daemon
{ "kind": "http_proxy",
  "request_id": "uuid",
  "method": "GET",
  "path": "/sessions/abc-123/transcript?limit=200",
  "headers": { "content-type": "application/json" },  // optional
  "body": "..."                                        // optional, string for JSON bodies
}

// daemon → phone
{ "kind": "http_proxy_response",
  "request_id": "uuid",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "..."                                        // string
}
```

Bodies stay as strings; the `Response` shim's `.json()` etc. parse on the phone side.

### WS proxy (subscribe)

```jsonc
// phone → daemon: open
{ "kind": "ws_proxy_open",  "tunnel_ws_id": "uuid", "path": "/ws" }
// daemon → phone: ack
{ "kind": "ws_proxy_opened", "tunnel_ws_id": "uuid" }
// daemon → phone: message arrived on local WS
{ "kind": "ws_proxy_msg",    "tunnel_ws_id": "uuid", "data": "<original ws frame>" }
// either direction: close
{ "kind": "ws_proxy_close",  "tunnel_ws_id": "uuid", "code": 1000, "reason": "" }
// phone → daemon: client-side send
{ "kind": "ws_proxy_send",   "tunnel_ws_id": "uuid", "data": "..." }
```

## Build / Deploy

- `vite-phone.config.ts`: change `root: "web-phone"` → `root: "web"`, set `define: { __MIKI_TRANSPORT__: JSON.stringify("tunnel") }`.
- `vite-web.config.ts` (or default): same `root: "web"`, `define: { __MIKI_TRANSPORT__: JSON.stringify("local") }`.
- `web/api.ts` picks transport from `__MIKI_TRANSPORT__` at build time AND can be overridden at runtime via URL flag (helps tests).
- `web-phone/app.tsx`, `web-phone/relay.ts`, `web-phone/store.ts` shrinks to a thin Pages bootstrap; the relay/store stay (auth, identity, pairing).

## Error Handling

| Scenario | Phone-side behavior |
|---|---|
| Daemon offline (relay returns nothing) | Each `apiFetch` rejects with `TunnelTimeoutError` after 30s; UI shows offline banner; auto-retry on next user action |
| Relay WS dropped | `connectAuthed` exponential reconnect (already exists); tunnel WS proxies all close with code 1006; UI re-subscribes on reconnect |
| daemon HTTP returns 5xx | Transparent passthrough; UI sees the same error as on localhost |
| Multi-phone race | Phase A routing ensures only the requesting phone gets its `http_proxy_response`; subscribe events still broadcast |

## Testing Strategy

Three test layers:

1. **Transport contract** (`web/__tests__/transport.test.ts`): use a fake relay WS, send `http_proxy` envelope, verify `apiFetch()` resolves with synthesized Response matching `http_proxy_response`. Same for WS proxy.
2. **Daemon-side proxy unit** (`tests/relay-client-proxy.test.ts`): inject mock localhost HTTP server, send fake `http_proxy` envelope, verify outgoing `http_proxy_response`.
3. **End-to-end smoke** (manual): start daemon, open `miki-phone.pages.dev` on phone, verify dashboard renders identical content to `127.0.0.1:8765`.

## Extensibility Hooks

| Future change | Where it plugs in |
|---|---|
| Add WebRTC P2P transport (skip relay for LAN) | New `web/transport-webrtc.ts` impl of `Transport` |
| Compress large transcript responses | Transport-level: `http_proxy_response` body → gzip; transport decompresses |
| Self-host with custom relay/PWA URL | `Config.remote` fields; no code change |
| Add new daemon endpoint | No client change — `apiFetch("/new-endpoint")` just works |
| Permission scoping (read-only phone vs full control) | New `kind:"http_proxy"` field `acl: "read" | "write"` checked daemon-side |

## Out of Scope (deferred)

- Streaming responses (SSE / chunked) — current model buffers full response. OK because largest is `transcript` (~MBs), well within an envelope.
- Request cancellation across tunnel — phone-side aborts can't propagate to localhost fetch. Daemon completes the request anyway; phone discards. Fine for v1.
- Native mobile app — web PWA is the v1 client.
