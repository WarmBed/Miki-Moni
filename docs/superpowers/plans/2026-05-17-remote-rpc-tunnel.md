# Remote RPC Tunnel — Implementation Plan

> **For agentic workers:** sub-skill: `superpowers:executing-plans` (inline) since work is small (~400 LOC).

**Goal:** Phone PWA + any remote web client renders the same dashboard as `127.0.0.1:8765` via E2E-encrypted tunnel through CF Worker relay.

**Architecture:** see `docs/superpowers/specs/2026-05-17-remote-rpc-tunnel-design.md`.

**Tech Stack:** TypeScript, Preact, vite, vitest, tweetnacl, CF Worker (already deployed).

---

### Task 1: Transport interface + LocalHttpTransport

**Files:**
- Create: `web/api.ts`
- Create: `web/transport-local.ts`
- Create: `web/__tests__/transport-local.test.ts`

- [ ] **Step 1: Failing test** — `transport-local.test.ts` verifies `LocalHttpTransport.fetch("/sessions")` calls native `fetch` against same-origin and returns the response. WebSocket variant similarly delegates to native `WebSocket`.
- [ ] **Step 2: Run test, expect fail (module missing).**
- [ ] **Step 3: Implement `web/transport-local.ts`** — thin wrapper, ~20 lines.
- [ ] **Step 4: Implement `web/api.ts`** with `Transport` interface, `WebSocketLike` type, `setTransport()`, `apiFetch()`, `apiWebSocket()`.
- [ ] **Step 5: Run tests, all green.**

### Task 2: TunnelTransport (client side)

**Files:**
- Create: `web/transport-tunnel.ts`
- Create: `web/__tests__/transport-tunnel.test.ts`

- [ ] **Step 1: Failing test** — fake relay WS, send `http_proxy_response` matching a `request_id`, verify `TunnelTransport.fetch("/sessions").json()` resolves with parsed body. Timeout test.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement `TunnelTransport`**:
  - Constructor takes existing `WebSocket` (the relay connection) + `sharedSecret` + `peerId` (for `to` field on outgoing — but daemon address is `"daemon"`).
  - `fetch(path, init)`: generate request_id (`crypto.randomUUID()`), encode envelope with `kind:"http_proxy"`, queue in `pending: Map<request_id, {resolve, reject, timer}>`, await, return synthesized `Response`.
  - `openWebSocket(path)`: return `WebSocketLike` shim backed by `tunnel_ws_id`.
  - Handler hooks into relay WS `onmessage`: decrypt envelope, dispatch on `kind`.
- [ ] **Step 4: Run tests, green.**

### Task 3: Daemon-side `http_proxy` handler

**Files:**
- Modify: `src/relay-client.ts` (add proxy handlers)
- Create: `tests/relay-client-proxy.test.ts`

- [ ] **Step 1: Failing test** — start mock localhost HTTP server, instantiate `RelayClient` with `http_local_port` = mock port, simulate inbound `http_proxy` envelope, verify outbound `http_proxy_response` matches mock response. Also test 404 / 500 passthrough.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** in `RelayClient`:
  - Add `private async handleHttpProxy(env, req): Promise<void>` that fetches localhost.
  - Hook into existing envelope receive loop (`handleEnvelope` or equiv).
  - Address response envelope `to: "phone:<peer_id>"` where peer_id is the sender's. (Per-peer encryption already in place.)
- [ ] **Step 4: Run, green.**

### Task 4: Daemon-side `ws_proxy_*` handlers

**Files:**
- Modify: `src/relay-client.ts`
- Modify: `tests/relay-client-proxy.test.ts`

- [ ] **Step 1: Failing test** — mock localhost WS server, simulate inbound `ws_proxy_open`, verify daemon opens local WS, simulate `ws_proxy_send`, verify mock receives. Server-pushed message → `ws_proxy_msg` outbound.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** — `tunnels: Map<peer_id, Map<tunnel_ws_id, LocalWS>>`. Open/send/close/msg forwarding. Cleanup on peer disconnect.
- [ ] **Step 4: Run, green.**

### Task 5: Wire api.ts into web/app.tsx call sites

**Files:**
- Modify: `web/app.tsx` (~30 mechanical replacements)
- Modify: `web/index.html` (loader picks transport)
- Modify: `web/main.tsx` if exists

- [ ] **Step 1: grep all `fetch(` and `new WebSocket(` in web/app.tsx.**
- [ ] **Step 2: Mechanical replace `fetch(` → `apiFetch(`, `new WebSocket(` → `apiWebSocket(`.**
- [ ] **Step 3: Bootstrap in `web/main.tsx`** — read `__MIKI_TRANSPORT__` build-define; if `"tunnel"`, instantiate TunnelTransport (needs PhoneState from existing store); if `"local"`, instantiate LocalHttpTransport. Call `setTransport()`.
- [ ] **Step 4: Run existing local tests, no regression.**

### Task 6: Vite phone build → web/ + retire web-phone/app.tsx

**Files:**
- Modify: `vite-phone.config.ts`
- Modify: `package.json` (build scripts unchanged if `build:phone` already runs vite-phone.config)
- Delete: `web-phone/app.tsx` (large simplified version — superseded)
- Keep: `web-phone/relay.ts`, `web-phone/store.ts` (auth/identity/pairing — still used by tunnel bootstrap)
- Move: `web-phone/index.html` content into `web/index.html` if needed (or keep separate entry)

- [ ] **Step 1:** `vite-phone.config.ts`: `root: "web"`, `define: { __MIKI_TRANSPORT__: '"tunnel"' }`.
- [ ] **Step 2:** Phone bootstrap in `web/main.tsx`: if `__MIKI_TRANSPORT__ === "tunnel"`, run pair flow (load state from `web-phone/store.ts`, do `performPairing` if needed via URL fragment, otherwise `connectAuthed`), THEN mount full `<App />` from `web/app.tsx`.
- [ ] **Step 3:** Delete `web-phone/app.tsx` and `web-phone/index.html` (superseded).
- [ ] **Step 4:** `pnpm build:phone` succeeds with same `dist/web-phone/` output shape.

### Task 7: `pairingQrPayload` reads `phone_pwa_url` from config

**Files:**
- Modify: `src/pairing.ts`
- Modify: `src/config.ts` (add `phone_pwa_url?` to `RemoteEndpoint`)
- Modify: `tests/pairing.test.ts`

- [ ] **Step 1: Failing test** — `pairingQrPayload` with `phone_pwa_url:"https://my-host.example.com/"` puts that origin in the URL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Default falls back to `PHONE_PWA_URL` constant if config field missing.**

### Task 8: Deploy + manual E2E

- [ ] Build phone, deploy `dist/web-phone` to Pages.
- [ ] Worker is already deployed (Phase A).
- [ ] On phone: open via QR, verify dashboard renders identical content to `127.0.0.1:8765`.
- [ ] On second laptop: open `miki-phone.pages.dev`, pair, verify same.
- [ ] Tap a session card → verify transcript fetches via tunnel; send a prompt; click focus.

---

## Commits

One commit per task. Conventional commit messages:

- `feat(web): Transport interface + LocalHttpTransport`
- `feat(web): TunnelTransport — HTTP + WS proxy over encrypted envelope`
- `feat(daemon): RelayClient http_proxy handler`
- `feat(daemon): RelayClient ws_proxy handler`
- `refactor(web): route fetch/WS through apiFetch/apiWebSocket`
- `feat(web): phone bundle = web/ with tunnel transport; retire web-phone/app.tsx`
- `feat(pairing): phone_pwa_url config field`
- `chore(deploy): rebuild phone + verify E2E parity`
