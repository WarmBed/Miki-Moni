# cc-hub Quick Start (local dev)

End-to-end local verification of Phase 2's encrypted remote relay,
without a Cloudflare account.

## One-time setup

```powershell
pnpm install
pnpm build:all      # builds dist/web and dist/web-phone
```

## Verify the whole pipeline (zero clicks)

```powershell
pnpm verify
```

This spawns a temp daemon + mock-worker, simulates a paired phone, and
asserts the full E2E flow (session event → encrypted envelope → decrypted
on phone → request_snapshot → ping/pong). Exits 0 on success.

## Run it for real and click around

```powershell
pnpm dev:all
```

Then in a browser:

| URL | What |
|---|---|
| http://127.0.0.1:8765 | Phase 1 desktop dashboard (already works without remote) |
| http://127.0.0.1:8787 | Phone web client (Phase 2) |

To pair the phone web client with the daemon:

1. In a third terminal: `pnpm pair --new --worker-url=ws://127.0.0.1:8787/v1/daemon --token=local-dev-token`
2. Copy the JSON printed below the QR
3. Open http://127.0.0.1:8787 in your browser
4. Paste the JSON into the "Pairing JSON" box, click Pair
5. The dashboard loads — open a Claude Code panel anywhere and watch sessions appear

## When you're ready to go beyond local

The mock-worker simulates the contract documented in `docs/protocols/relay-protocol.md`. Replace it with a real Cloudflare Worker (`docs/protocols/worker-skeleton.md` has a starter). The daemon code does not change.
