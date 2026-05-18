---
name: miki-moni-dev-locate-code
description: Use when working in the miki-moni / cc-hub repo and need to find which file handles a feature (pairing, image rendering, permission mode, transcript bubbles, dashboard UI, phone client, worker relay, etc.) without re-scanning the codebase. Trigger phrases include "miki where is X", "需要修 X 在哪", "找 pair flow", "image bubble code", "permission mode chip 在哪".
---

# Miki-Moni Code Map

Navigation reference for the miki-moni codebase (a.k.a. cc-hub). Each row points at the file + function where a feature lives, so future Claude can jump straight in instead of grepping from zero.

## Architecture in one glance

```
PS hooks ──POST /event──▶  daemon (src/, 127.0.0.1:8765)  ──WS /ws──▶  web (web/ dashboard SPA)
                                │                          ──WS /ws_ext──▶  miki-helper VSCode extension
                                └─encrypted envelope──▶ worker (Cloudflare DurableObject) ──▶ web-phone (Pages-hosted PWA)
```

| Layer | Path | Entry |
|---|---|---|
| Daemon | `src/` | `src/index.ts` (bootstraps express on 8765) |
| Wrapped CLI | `src/cli/wrap.ts` | spawned per session by `miki claude` |
| Dashboard SPA | `web/app.tsx` | single big file, mounted by `web/main.tsx` |
| Phone PWA | `web-phone/main-tunnel.tsx` | bootstraps tunnel + dynamic-imports `web/app.tsx` |
| Cloudflare Worker | `worker/src/` | `index.ts` routes, DOs in `daemon-relay.ts` + `pairing-coordinator.ts` |
| CLI | `bin/miki.mjs` → `src/cli/miki.ts` | subcommands: `start setup pair claude install-hooks` |

## Where things live

### Pairing & relay
| Task | File:Function | Notes |
|---|---|---|
| Generate pair QR / token | `src/pairing.ts:generateNewPairingToken` + `pairingQrPayload` | rejection sampling for entropy; strips `/v1/daemon` suffix |
| Daemon-side relay client | `src/relay-client.ts:RelayClient` | `handlePairOffer` (line ~190), `handleEnvelope` (line ~296), `promptForPairApproval` |
| `pnpm pair --new/--rotate/--list/--show` | `src/cli/pair.ts` | `cmdNew` `cmdRotate` `cmdRevoke` `printQrAndCode` |
| Worker entry routes | `worker/src/index.ts` | `/v1/daemon` `/v1/phone` `/v1/pairing/revoke` `/v1/health` |
| Worker DO: token registry | `worker/src/pairing-coordinator.ts` | `register` `claim` `revoke` + alarm sweep |
| Worker DO: per-daemon relay | `worker/src/daemon-relay.ts` | `acceptPhone` `acceptDaemon` `handlePhoneMessage` `verifyReconnectSig` |
| Phone-side pair handshake | `web-phone/relay.ts:performPairing` | verifies daemon pubkey from QR `&k=` |
| Phone bootstrap (URL hash vs cached state) | `web-phone/main-tunnel.tsx:Bootstrap` | URL hash always wins; `initialStateRef` avoids stale closure |

### Dashboard UI (web/app.tsx is one big file — search by function name)
| Task | Function in `web/app.tsx` |
|---|---|
| Session card list (small cards) | `Card`, `SessionGrid` |
| Big "modal" card opened by clicking session | `CellModal` |
| Transcript turn rendering (text + image bubble) | `TurnView` (~line 666) |
| Image attachment strip in composer | `AttachedImageStrip` (~line 556) |
| Composer input box (Ctrl+V paste) | `composer` inside `Card` (~line 1170) + modal version (~line 2711) |
| Permission mode chip + dropdown | `PermissionModeChip` (~line 1627) |
| Model chip + dropdown | `ModelChip` (~line 1751) |
| AskUserQuestion modal (multi-question) | `AskQuestionModal` (~line 427) |
| WS connection / event handlers | search `connectWs` (~line 3641) |

### Daemon HTTP/WS
| Route | File:Handler |
|---|---|
| `/event` (hook intake) | `src/server.ts` |
| `/send` (push prompt to wrapped Claude) | `src/server.ts:558` — wrap-push fast path + VSCode prefill fallback |
| `/sessions/previews` `/sessions/:uuid/transcript` | `src/server.ts`, reads via `src/session-resolver.ts:readTranscriptTail` |
| `/admin/restart` `/admin/quit` `/admin/pid` | `src/server.ts` |
| `/wrap/start` `/wrap/permission-mode` `/wrap/model` | `src/server.ts` |
| `/ws` (dashboard WS) `/ws_ext` (helper ext WS) | `src/server.ts:createApp` |
| DNS-rebind guard | `src/server.ts` middleware right after `express.json` (line ~64) |

### Hooks (Claude Code → daemon)
| Hook | File |
|---|---|
| SessionStart / Stop / UserPromptSubmit / PreToolUse / PostToolUse | `hooks/miki-emit.ps1` (Windows PowerShell) |
| Install hooks into `~/.claude/settings.json` | `pnpm install:hooks` → `src/cli/install-hooks.ts` |

### Storage
| What | Where |
|---|---|
| `~/.miki-moni/config.json` | `src/config.ts` (loadOrInitConfig, addPairedPeer, touchPeerLastSeen) |
| `~/.miki-moni/miki-moni.log` | pino logs |
| `~/.miki-moni/wizard-local-only` (sentinel) | written by `src/cli/setup-wizard.ts:markLocalOnly` |
| Per-session JSONL transcripts | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (Claude Agent SDK manages) |
| `PORT_FILE` | `~/.miki-moni/port` — singleton guard reads it before bind |

### i18n
| Layer | File |
|---|---|
| Master strings (en/zh-TW/zh-CN) | `shared/i18n.ts` |
| CLI banner strings | `src/cli/i18n-cli.ts` |
| Calls `t("namespace.key")` everywhere | grep `t\(` |

## Build / dev commands

| Goal | Command |
|---|---|
| Daemon only | `pnpm start` (no watch) or `pnpm dev` (tsx watch) |
| Build dashboard SPA | `pnpm build:web` → `dist/web/` |
| Build phone PWA | `pnpm build:phone` → `dist/web-phone/` |
| Build both | `pnpm build:all` (uses `&&` — PowerShell 5.1 will break it, run each separately on Windows) |
| Tests | `pnpm test` (vitest); `pnpm vitest run tests/<one>.test.ts` for single |
| Typecheck | `pnpm typecheck` |
| Full E2E with mock relay | `pnpm verify` |
| Daemon + mock-worker + web + phone all dev | `pnpm dev:all` |
| Pair tools | `pnpm pair --new --worker-url=...` / `--rotate` / `--list` / `--show` |

## Critical pitfalls (don't repeat history)

1. **`paired_peers.length > 0` gate on relay startup** — chicken-and-egg, fixed in 0.3.7 (`src/index.ts:157`). If you ever re-gate this, first-pair breaks.
2. **`localStorage > URL hash` in phone bootstrap** — silent fallback, fixed in 0.3.6 (`web-phone/main-tunnel.tsx`). URL hash MUST win.
3. **`worker_url` with `/v1/daemon` baked in** — phone naively appends `/v1/phone` → broken path. QR generator + phone client both strip; never embed verbatim.
4. **Express `app.use` middleware before routes** — DNS-rebind guard MUST sit before any route registration in `createApp`.
5. **`/admin/restart` already respawns** — don't ALSO `spawnDetachedDaemon` in `cmdRotate`. Two daemons race for 8765.
6. **`config.json` `last_seen_at` was historically never written** — keep `touchPeerLastSeen` wired into `RelayClient.handleEnvelope` or pruning logic breaks.
7. **PowerShell 5.1 doesn't support `&&`** — chain with `;` or `if ($?) { ... }`. Affects `pnpm build:all` and any pasted multi-cmd.
8. **Don't pollute test config into `~/.miki-moni/config.json`** — `pnpm verify` writes `device.name: test`. Check before pushing if you ran tests.

## Related skills

- `miki-moni-dev:release-flow` — full bump + build + push + worker deploy + pages deploy + npm publish sequence
- `miki-moni-dev:change-pair-flow` — when modifying pairing / relay code; checklist of regression traps
- `miki-moni-dev:add-daemon-endpoint` — adding new routes to src/server.ts (with auth + DNS-rebind considerations)
