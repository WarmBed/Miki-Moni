# Miki-Moni

> 巫女 (Miki the Monitor) — watches your Claude Code sessions and pings you when one needs attention.

Aggregate the state of every VSCode Claude Code panel into a single local dashboard. Connect to it from your phone or another laptop through an end-to-end encrypted relay.

<p align="center">
  <img src="docs/images/dashboard-desktop.png" width="720" alt="Desktop dashboard — session cards with live transcript">
  <br />
  <em>Local dashboard at <code>http://127.0.0.1:8765</code> · same UI served to phones via tunnel</em>
</p>

<p align="center">
  <img src="docs/images/phone-pair-screen.png" width="320" alt="Phone pairing screen with QR scan + 16-char code entry">
  <br />
  <em>Phone pairing — scan QR, paste URL, or type the 16-char code</em>
</p>

---

## Why

- Three Claude Code panels open across two VSCode windows. One finishes; you don't notice for 20 minutes.
- You walk away from your desk; you want to peek at "did it finish yet?" from your phone without VPN-ing in.
- A teammate's machine has the project loaded; you want a read-only view from yours.

Miki-Moni gives you **one dashboard** that aggregates every Claude Code session (across windows, projects, machines) and lets you respond from anywhere.

## Install

```bash
npm install -g miki-moni
miki start
```

On first run, a setup wizard asks:

1. **Language** — English / 繁體中文 / 简体中文
2. **Relay mode** — pick one:
   - **Hosted** (default) — uses the author's free `relay.f1telemetrystationpro.org`. Zero setup.
   - **Self-host** — auto-deploys a Cloudflare Worker + Pages site to *your* CF account (needs `wrangler`).
   - **Local-only** — no phone access; dashboard at `127.0.0.1:8765` only.

Then it prints a permanent pairing QR + 16-char code:

```
📱 Phone pairing — scan QR, open URL, or type the 16-char code:

  [QR code]

   URL:    https://miki-moni.pages.dev/#t=XXXX...&r=wss://...
   Code:   XXXX-XXXX-XXXX-XXXX
   Local:  http://127.0.0.1:8765
   (QR / URL / Code are permanent — rotate with `miki pair --rotate`)
```

That QR works permanently — scan once on each device you want to pair. Rotate when leaked.

## Three deployment modes

|  | Hosted | Self-host | Local-only |
|---|---|---|---|
| **Setup** | 0 sec | ~5 min wizard | 0 sec |
| **Needs CF account** | No | Yes | No |
| **Phone access** | Yes | Yes | No |
| **Trust author's infra** | Yes ([§ Security](#security)) | No | N/A |
| **Bandwidth limits** | Author's CF free tier (100k req/day) | Your CF free tier | N/A |
| **Rotate later** | `miki setup` | `miki setup` | `miki setup` |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  ╭─ Your machine ────────────────────────────────────────────────────╮   │
│  │                                                                   │   │
│  │  miki-moni daemon (Node, 127.0.0.1:8765)                          │   │
│  │    POST /event   GET /sessions   POST /focus /send  WS /ws        │   │
│  │                                                                   │   │
│  │     ▲                       ▲                            ▲       │   │
│  │ PS hooks            web dashboard               RelayClient       │   │
│  │ (~/.claude/         (browser at 127.0.0.1)                        │   │
│  │  settings.json)                                                   │   │
│  ╰────────────────────────────────────────────────────┬──────────────╯   │
│                                                       │ E2E encrypted    │
│                                                       │ envelope         │
│                                          ╭────────────▼─────────────╮   │
│                                          │ Cloudflare Worker relay  │   │
│                                          │ (zero-knowledge: routes  │   │
│                                          │  encrypted blobs only)   │   │
│                                          ╰────────────┬─────────────╯   │
│                                                       │ E2E encrypted    │
│                                                       ▼                  │
│                                          ╭──────────────────────────╮   │
│                                          │ Phone / 2nd laptop /     │   │
│                                          │ tablet (web PWA)         │   │
│                                          │  · scans QR → auto-pair  │   │
│                                          │  · sees same dashboard   │   │
│                                          ╰──────────────────────────╯   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Encryption**: X25519 ECDH at pair time → per-peer shared secret → NaCl `secretbox` on every envelope. The relay never holds keys; only the daemon and the paired phone can read content.

**Auth**: each phone holds an Ed25519 signing keypair (in IndexedDB). On reconnect, it signs `daemon_id || utc_minute` — relay verifies before routing. Revoke per-device with `miki pair --revoke <peer_id>`.

## CLI reference

| Command | What it does |
|---|---|
| `miki start` | Run daemon + print pairing banner. First run launches the setup wizard. |
| `miki setup` | Re-run the wizard (change language, switch relay mode, etc.) |
| `miki pair` | Show the current permanent QR + paired-phones list. |
| `miki pair --rotate` | Generate a new pair token (invalidates the old QR; paired phones keep working). |
| `miki pair --list` | List paired phones with their IDs + paired timestamps. |
| `miki pair --revoke <peer_id>` | Remove a phone from local config AND tell the relay to drop it. |
| `miki pair --new` | One-shot ephemeral token (10 min TTL) — legacy / debugging. |
| `miki claude [...args]` | Wrap a Claude Code session and auto-spawn the daemon if down. |
| `miki install-hooks` | Merge Claude Code hooks into `~/.claude/settings.json` so non-wrapped panels show up too. |

Verbose daemon logs: `MIKI_LOG_LEVEL=info miki start`. Full trace always in `~/.miki-moni/miki-moni.log`.

## Security

Risks ordered by realism:

| Risk | Mitigation |
|---|---|
| 🔴 **Pairing QR leaks** (screenshot in chat, photo of screen, posted publicly) | Permanent QR means anyone with it can pair. Treat the QR like an SSH key. Rotate immediately if leaked: `miki pair --rotate`. |
| 🟡 **Paired phone stolen** | Phone holds an Ed25519 signing key that grants relay access. Revoke from the daemon: `miki pair --revoke <peer_id>`. |
| 🟢 Brute-force pair token | 16 Crockford base32 chars ≈ 80 bits of entropy. Computationally infeasible. |
| 🟢 Relay sees content | Zero-knowledge by design — relay only routes opaque ciphertext, never holds shared secrets. |
| 🟡 You trust the hosted relay operator | Self-host avoids this entirely. The author can see metadata (peer IDs, timing, sizes) and theoretically swap the PWA bundle. Source is open; verify or self-host. |
| 🟢 DDoS on hosted relay | Cloudflare rate-limit binding caps at 30 req/60s per IP. Worst case: your daily quota burns. |

## Self-host (manual)

The `miki setup` wizard automates this end-to-end, but if you prefer manual:

```bash
# In a cloned cc-hub source tree:
cd worker
wrangler login
wrangler deploy --config wrangler-selfhost.toml --name my-relay
wrangler pages project create my-phone --production-branch=main
wrangler pages deploy ../dist/web-phone --project-name my-phone --branch=main
```

Then edit `~/.miki-moni/config.json`:

```json
{
  "remote": {
    "worker_url": "wss://my-relay.<your-cf-username>.workers.dev",
    "phone_pwa_url": "https://my-phone.pages.dev/"
  }
}
```

`miki start` will pick up the new endpoints on next run.

## Development

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm typecheck
pnpm test         # daemon + worker test suites
pnpm dev          # tsx watch src/index.ts
```

Source tree:

| Path | Purpose |
|---|---|
| `src/` | Node daemon (express + ws + better-sqlite3) — hooks, pairing, RelayClient |
| `web/` | Desktop / phone full dashboard (Preact + Tailwind + Vite) |
| `web-phone/` | Phone bootstrap shell (QR scanner + tunnel setup) — mounts web/ |
| `worker/` | Cloudflare Worker relay (DaemonRelay + PairingCoordinator DOs) |
| `extension/` | VSCode helper extension — handles `claude-vscode.send` |
| `hooks/` | Claude Code hook scripts (PowerShell) — POST events to daemon |
| `bin/miki.mjs` | npm-published CLI entry |

## Branches

- `main` — versioned releases (current: v0.0.0)
- `dev` — active development; every change gets a `package.json` version bump

## License

TBD.

## Credits

Built with [Anthropic Claude](https://claude.ai/code) via [Claude Code](https://github.com/anthropics/claude-code).
