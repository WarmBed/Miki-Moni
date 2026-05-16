# Mock Worker (local dev)

This is a Node.js stand-in for the user's Cloudflare Worker, used during local
development of cc-hub so the whole daemon ↔ relay ↔ phone pipeline can be
exercised on one machine without a Cloudflare account.

**This is NOT production code.** Differences from the real Worker:

| Real Worker | Mock Worker |
|---|---|
| CF Access SSO enforced on `/v1/phone` | No SSO; accepts any phone connection |
| Durable Objects per daemon_id | In-process Maps (lost on restart) |
| Cloudflare TLS / edge | Plain HTTP/WS on 127.0.0.1 |
| Globally distributed | Single localhost process |
| Runs on Cloudflare Workers runtime | Runs on Node.js via tsx |

## Run

```powershell
pnpm mock-worker
```

With a custom port:

```powershell
$env:MOCK_WORKER_PORT = "8788"; pnpm mock-worker
```

With a custom auth token:

```powershell
$env:MOCK_WORKER_TOKEN = "my-secret"; pnpm mock-worker
```

Defaults:
- Port: `8787`
- `X-Daemon-Auth` token: `local-dev-token`

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/health
```

Should return:

```json
{ "ok": true, "mode": "mock-worker", "daemons": 0, "phones": 0, "pairings": 0 }
```

## Use with daemon (pairing flow)

In a separate terminal, start the daemon and point it at the mock worker:

```powershell
pnpm pair --new --worker-url=ws://127.0.0.1:8787/v1/daemon --token=local-dev-token
```

Then open `http://127.0.0.1:8787/` in a browser to load the phone web client
(available after running `pnpm build:phone`).

## Endpoints

| Endpoint | Protocol | Notes |
|---|---|---|
| `GET /v1/health` | HTTP | JSON health + peer counts |
| `WS /v1/daemon` | WebSocket | Requires `X-Daemon-Auth`; use `X-Daemon-Id` or `X-Pairing-Token` |
| `WS /v1/phone` | WebSocket | No auth (dev only); use `X-Daemon-Id` or `X-Pairing-Token` |
| `GET /` | HTTP | Serves `dist/web-phone/` static files |

## Logging

The mock worker prints one log line per event to stdout:

```
[2025-01-15 12:34:56] daemon connected {"id":"abc123"}
[2025-01-15 12:34:57] phone connected {"daemonId":"abc123","total":1}
[2025-01-15 12:34:58] daemon->phone(1) 128 bytes {"id":"abc123"}
[2025-01-15 12:34:59] phone->daemon 64 bytes {"daemonId":"abc123"}
[2025-01-15 12:35:00] phone disconnected {"daemonId":"abc123","remaining":0}
```

Note: only message size and direction are logged — never the ciphertext content.
