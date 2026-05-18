# Miki-Moni

**[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md)**

> 巫女 (Miki the Monitor) — one dashboard for every Claude Code session you have open, with end-to-end encrypted remote control from your phone.

<p align="center">
  <img src="docs/images/dashboard-desktop.png" width="820" alt="Desktop dashboard — session grid with live transcripts">
</p>

<p align="center">
  <a href="#quick-start">Install</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#self-host">Self-host</a> ·
  <a href="#security">Security</a>
</p>

---

## What it is

You run several Claude Code panels at once. One finishes; you don't notice. You walk away from your desk and can't peek. A teammate's machine has the context; you can't see it.

Miki-Moni hooks into every Claude Code panel on your machine and aggregates them into a single dashboard at `http://127.0.0.1:8765`. An optional encrypted relay lets a phone or second laptop see the same view and push prompts back.

- **Aggregates, doesn't replace.** Hooks sit alongside `claude` — you keep starting sessions the way you already do.
- **Sessions are durable.** Every session can be resumed from any terminal by UUID — `miki claude -r <uuid>` brings back full context, even if the original window crashed.
- **Local by default, remote when you opt in.** The daemon binds `127.0.0.1` only. Phone access flows through E2E-encrypted envelopes via a Cloudflare Worker that never holds keys.

## Quick start

```bash
npm install -g miki-moni
miki start
```

First run launches a wizard that asks for language, relay mode (hosted / self-host / local-only), and prints a permanent pairing QR:

<p align="center">
  <img src="docs/images/cli-banner.png" width="520" alt="miki start prints QR + URL + 16-char code">
</p>

Scan the QR once on each device. The token is permanent until you `miki pair --rotate`. Dashboard is live at [http://127.0.0.1:8765](http://127.0.0.1:8765).

## Architecture

```
┌─ your machine ─────────────────────────────────────────────────────────┐
│                                                                        │
│  Claude Code (any panel)                                               │
│   │                                                                    │
│   │ PS hooks (SessionStart / Stop / UserPromptSubmit / PreToolUse /    │
│   │            PostToolUse)                                            │
│   │  ── POST /event ──▶                                                │
│   │                                                                    │
│   │   ┌──────────────────────────────────────────────────────────┐    │
│   │   │  miki-moni daemon  (Node, 127.0.0.1:8765)                │    │
│   │   │  ─ session store (better-sqlite3)                        │    │
│   │   │  ─ HTTP:  /event /sessions /focus /send /wrap/*          │    │
│   │   │  ─ WS:    /ws (dashboard)   /wrap (CLI)   /ws_ext (ext)  │    │
│   │   │  ─ RelayClient (X25519 + NaCl secretbox)                 │    │
│   │   └─────┬──────────────┬────────────────┬───────────┬───────┘    │
│   │         │ WS /ws       │ WS /ws_ext     │ WS /wrap  │ relay      │
│   ▼         ▼              ▼                ▼           │ envelope   │
│  hooks    web dashboard   VSCode helper   miki claude   │            │
│           (Preact SPA)    extension       (wrap CLI)    │            │
│                                                          │            │
└──────────────────────────────────────────────────────────┼────────────┘
                                                           │
                                       ╭───────────────────▼──────────╮
                                       │ Cloudflare Worker relay      │
                                       │ (zero-knowledge: opaque blobs│
                                       │  only, never holds keys)     │
                                       ╰───────────────────┬──────────╯
                                                           │ E2E encrypted
                                                           ▼
                                       ╭──────────────────────────────╮
                                       │ Phone PWA / 2nd laptop       │
                                       │ Ed25519 keypair in IndexedDB │
                                       ╰──────────────────────────────╯
```

| Component | Role |
|---|---|
| **PS hooks** | Posted by Claude Code to `/event` on every session/tool boundary so non-wrapped panels show up in the dashboard. |
| **daemon** | Node + express + ws + better-sqlite3. Holds session state and routes the four WS planes. |
| **web dashboard** | Preact + Tailwind SPA mounted at `/`. Reads `/ws`, posts `/send` and `/focus`. |
| **wrap CLI** (`miki claude`) | Wraps a Claude Code session so the daemon can push prompts (`/send`), switch model (`/wrap/model`), and resume by UUID. |
| **VSCode helper extension** | Connects to `/ws_ext`; receives `claude-vscode.focus` and pre-fills prompts into the active panel. |
| **RelayClient** | E2E-encrypts envelopes (X25519 ECDH per peer → NaCl secretbox) and ships them to the Worker. |
| **Cloudflare Worker** | Stateless relay. Routes opaque ciphertext between daemon and paired peers. Verifies Ed25519 signatures on `daemon_id ‖ utc_minute`. |
| **Phone PWA** | Web client served from Pages. Scans QR, holds an Ed25519 signing key in IndexedDB, talks to the relay. |

Full protocol details in [`docs/protocols/relay-protocol.md`](docs/protocols/relay-protocol.md).

## Features

### Dashboard

- **Multi-session grid** — every Claude Code panel on the machine, regardless of which VSCode window or terminal started it.
- **Status counters** that filter — click `5 active` to scope the grid; click again to clear.
- **New CLI popover** — kick off a fresh `miki claude --fresh` in any folder; remembers recent cwds via a native picker so jumping into a new project is one click.
- **Live transcript** in chat-bubble layout (user right, assistant/system/tool left). Toggle tool calls, limit slider (10 / 50 / 200 / all).
- **WS status dot** — green when receiving live updates, amber while reconnecting.

<p align="center">
  <img src="docs/images/new-cli-popover.png" width="320" alt="New CLI popover — folder path + recent cwds dropdown">
</p>

### Session control

- **Model chip** — pop open to switch model live: default / Sonnet / Opus / Haiku / custom id. Broadcasts to every connected dashboard via `POST /wrap/model`.
- **Mode chip with color** — `acceptEdits` blue, `bypass` red, plain ask grey. Locked for the session's lifetime.
- **Open CLI** — spawn `wt.exe` running `miki claude -r <session-uuid>` to take over a session from a terminal with full context. Works even if the original panel has been closed or crashed.
- **Send composer** — multi-line input with auto-grow. Enter or Ctrl/⌘+Enter to send (your choice). Paste, drop, or pick image attachments.

<p align="center">
  <img src="docs/images/model-picker.png" width="240" alt="Model picker popover">
  <img src="docs/images/mode-picker.jpg" width="240" alt="Mode picker popover">
</p>

### Mobile

- **Phone dashboard** — same grid, single-column layout, scoped tap targets.
- **Chat-bubble transcript** matches the desktop, fits a phone viewport.
- **Swipe-right-to-close** session modals — document-level gesture with translateX preview.
- **Composer** with image-upload button (mobile file picker), textarea auto-grow, and iOS focus-zoom + keyboard-resize fixes.
- **Collapsible transcript controls** (show-tool / limit / load-all / reload) tucked behind one sliders popover.

<p align="center">
  <img src="docs/images/dashboard-phone.png" width="240" alt="Phone dashboard">
  <img src="docs/images/phone-session-modal.png" width="240" alt="Phone session modal">
</p>

## Deployment modes

|  | Hosted | Self-host | Local-only |
|---|---|---|---|
| Setup | 0 sec | ~5 min wizard | 0 sec |
| Needs CF account | No | Yes | No |
| Phone access | Yes | Yes | No |
| Trust author's infra | Yes | No | N/A |
| Bandwidth ceiling | Author's CF free tier (~100k req/day) | Your CF free tier | N/A |
| Switch later | `miki setup` | `miki setup` | `miki setup` |

Default is **Hosted**, pointing at `relay.f1telemetrystationpro.org`. The wizard will deploy a Worker + Pages site to your own CF account if you pick Self-host.

## Security

The daemon binds **`127.0.0.1` only** — nothing on the public network can reach it. Phone access is end-to-end encrypted (X25519 ECDH at pair time → NaCl `secretbox` per envelope). The relay only routes opaque ciphertext and never holds shared secrets.

The daemon trusts any process running as your user to call `/event`, `/send`, `/focus`, and connect to `/ws_ext`. This keeps hooks and the helper extension token-free but means: anything that runs as your user can talk to the daemon. Treat `~/.miki-moni/` like `~/.ssh/`.

| The phone **can** | The phone **cannot** |
|---|---|
| See live session state + transcript | Run arbitrary shell commands |
| Push prompts (pre-fill in VSCode; direct send to wrap CLI) | Auto-submit a prompt into VSCode without your keystroke |
| Focus an existing panel | Bypass Claude Code's per-tool permission prompts |

Risk table, hardening options, and the full hooks / extension trust analysis: [`docs/security/`](docs/security/).

## CLI reference

| Command | What it does |
|---|---|
| `miki start` | Run the daemon; first run launches the setup wizard. |
| `miki setup` | Re-run the wizard (change language, switch relay mode). |
| `miki pair` | Show the permanent QR + paired-phones list. |
| `miki pair --rotate` | Invalidate the current QR; already-paired phones keep working. |
| `miki claude [...args]` | Wrap a Claude Code session; auto-spawns the daemon if down. |
| `miki install-hooks` | Merge Claude Code hooks into `~/.claude/settings.json`. |

`miki --help` for the full list. Verbose logs: `MIKI_LOG_LEVEL=info miki start`. Full trace always in `~/.miki-moni/miki-moni.log`.

## Self-host

The setup wizard does this end-to-end; for manual deployment:

```bash
cd worker
wrangler login
wrangler deploy --config wrangler-selfhost.toml --name my-relay
wrangler pages project create my-phone --production-branch=main
wrangler pages deploy ../dist/web-phone --project-name my-phone --branch=main
```

Then point `~/.miki-moni/config.json` at your endpoints:

```json
{
  "remote": {
    "worker_url": "wss://my-relay.<your-cf-username>.workers.dev",
    "phone_pwa_url": "https://my-phone.pages.dev/"
  }
}
```

## Development

```bash
git clone https://github.com/WarmBed/Miki-Moni
cd Miki-Moni
pnpm install
pnpm dev          # tsx watch src/index.ts
pnpm test         # daemon + worker test suites
pnpm typecheck
```

Source tree: `src/` daemon · `web/` dashboard SPA · `web-phone/` phone bootstrap · `worker/` Cloudflare Worker · `extension/` VSCode helper · `hooks/` PS hook scripts · `bin/miki.mjs` CLI entry.

Branch model: `main` ships releases (current **v0.3.3**), `dev` carries active work with a `package.json` version bump on every change.

## Related

**[Happy](https://happy.engineering)** (`slopus/happy-cli`) solves an overlapping itch from a different angle. Both can coexist on the same machine.

| | Miki-Moni | Happy |
|---|---|---|
| Entry point | Hooks into existing panels | Replaces `claude` |
| Phone client | Web PWA (no install) | Native iOS / Android |
| Multi-session dashboard | Yes — aggregated grid | Per-session |
| Supported agents | Claude Code | Claude Code, Codex, Gemini, ACP |

Use Happy for a polished mobile-first multi-agent experience. Use Miki-Moni if you live in VSCode and want a single dashboard for every parallel panel, with a relay you can self-host in minutes.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built with [Anthropic Claude](https://claude.ai/code) via [Claude Code](https://github.com/anthropics/claude-code).
