# Miki-Moni

> *Miki the Monitor — watches your Claude Code sessions and pings you when one needs attention.*
> 把散落的 Claude session 收進一張儀表板，等你回應的時候會喊你。

Local dashboard that aggregates state across multiple VSCode Claude Code panel sessions, with an optional encrypted relay to a phone client.

> **Heads up on upgrade.** Pre-2026-05-17 installs used the directory `~/.cc-hub/`. The daemon migrates it to `~/.miki-moni/` automatically on first boot (preserves pairing keys, sessions DB). Re-run `pnpm install:hooks` once so `~/.claude/settings.json` points to the new `miki-emit.ps1` hook script. See [`docs/naming.md`](docs/naming.md) for the full rename map.

See `docs/superpowers/specs/` for design, `docs/superpowers/plans/` for the implementation plan.

## Quick start

```powershell
pnpm install
pnpm build:web
pnpm install:hooks
pnpm start
start http://localhost:8765
```

`pnpm install:hooks` merges 5 hook entries (SessionStart, Stop, UserPromptSubmit, PreToolUse, PostToolUse) into `~/.claude/settings.json` and backs the original up to `~/.claude/settings.json.miki-moni.bak`. Re-running is idempotent.

## Known Phase 1 limitations

- **Cross-window focus is approximate.** Clicking a project's title in the dashboard opens a Claude Code tab via `vscode://anthropic.claude-code/open?session=<uuid>`. Per Anthropic's docs, this URI handler opens in **whichever VSCode window is currently focused**, not the window that owns the project workspace. If the focused window's workspace doesn't match the session, a fresh Claude conversation is started in that window instead. Workaround: manually Alt+Tab to the right VSCode window first, then click. A native window-raiser (Win32 `FindWindow` + `SetForegroundWindow`) is planned for Phase 1.5. See `docs/superpowers/spikes/2026-05-15-hook-discovery.md` OQ3 for details.
- **Prompts are pre-filled, not sent.** The URI handler always pre-fills; you press Enter to submit. This is an Anthropic design choice, not a miki-moni limitation.
- **Stale sessions are not auto-detected** (Phase 1.5). If a VSCode window closes, the dashboard keeps showing the last status until you POST a new event for that cwd.
- **Mobile / remote** is out of Phase 1 entirely. The daemon binds 127.0.0.1 only.

## Architecture

Daemon (Node.js, express + ws, SQLite) listens on `127.0.0.1:8765`. PowerShell hook scripts in `~/.claude/settings.json` POST events to `/event`. A static Preact + Tailwind SPA at `/` subscribes to `/ws` for live updates.

```
┌──────────────────────────────────────────────────────┐
│  miki-moni (Node daemon, 127.0.0.1:8765)             │
│   POST /event   GET /sessions   POST /focus /send    │
│   WebSocket /ws        Web UI at /                   │
└────────────────────────┬─────────────────────────────┘
        ▲                │
   PS hooks         vscode:// URI launcher
        │                ▼
  ~/.claude/        VSCode panels (multiple)
  settings.json
```

## Development

```powershell
pnpm test          # vitest run
pnpm test:watch
pnpm typecheck
pnpm dev           # tsx watch src/index.ts
```

## Phase 1.5 backlog

Filed from the final code review (2026-05-15):

- Native cross-window focus via Win32 user32.dll (`FindWindowEx` + `SetForegroundWindow`)
- Stale-session heartbeat: mark sessions older than N minutes as `stale`
- WebSocket reconnection with exponential backoff in the web UI
- Skip `session_changed` emit when the upsert is a no-op (reduce broadcast volume)
- Manual end-to-end verification with live Claude hooks (deferred from Phase 1 smoke test)
