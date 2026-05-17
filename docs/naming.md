# Naming: Miki-Moni

**Date**: 2026-05-17
**Status**: Adopted (full rename — package, CLI, paths)

## TL;DR

- **Name**: **Miki-Moni**
- **CLI binary**: `miki`
- **Persona**: Miki — your personal sessions concierge
- **Worker name**: `miki-relay`
- **VSCode extension**: `miki-helper`
- **Hook script**: `hooks/miki-emit.ps1`
- **Data dir**: `~/.miki-moni/` (port file, config, sessions DB)

## Why Miki-Moni

Two halves:

- **Miki** — a short, friendly persona name. The dashboard *is* Miki: she
  watches your Claude Code sessions and pokes you when one needs attention.
- **Moni** — short for *monitor*. Pairs with Miki for a sticky, rhymed name.

Together: **Miki the Monitor**. Easy to say in Chinese and English; doesn't
sound like every other `claude-*` / `*-monitor` tool in the ecosystem.

## Why not Loom / 織機 (the previous working title)

`Loom` (2026-05-16 draft) leaned on the weaving metaphor — many threads into
one fabric. Accurate, but:

- The word "loom" is heavily owned by the video company in the npm namespace.
- The metaphor flattens — once you know it's a multi-session dashboard, the
  weaving angle adds nothing.
- It has no persona. **Miki** does, and the daemon's job ("watch many sessions,
  flag the ones that need you") fits a concierge character better than a
  textile machine.

The Loom draft is preserved in git history (`docs/naming.md` at the prior
revision) for context.

## Predecessors / what changed

| Surface | Old (cc-hub) | New (Miki-Moni) |
|---|---|---|
| npm package | `cc-hub` | `miki-moni` |
| CLI binary | `cch` | `miki` |
| Worker | `cch-relay` | `miki-relay` |
| VSCode extension | `cc-hub-helper` | `miki-helper` |
| Hook script | `hooks/cc-hub-emit.ps1` | `hooks/miki-emit.ps1` |
| Data directory | `~/.cc-hub/` | `~/.miki-moni/` |
| Settings backup marker | `~/.claude/settings.json.cc-hub.bak` | `~/.claude/settings.json.miki-moni.bak` |

## Migration for existing installs

The daemon detects an old `~/.cc-hub/` directory on startup and moves it to
`~/.miki-moni/` (preserving pairing keys, config, sessions DB). Hook script
re-install replaces the old `cc-hub-emit.ps1` entry in
`~/.claude/settings.json` with the new `miki-emit.ps1` entry.

Run `miki install:hooks` once after upgrading.

## Trademark / scope notes

- "Miki" is a common given name (Japanese 美希 / Hawaiian "quick, nimble"); no
  exclusive trademark claim in software. The compound `Miki-Moni` is
  distinctive enough to avoid collision.
- Anthropic's brand guidelines disallow naming that implies an official Claude
  product. **`Miki-Moni`** does not — it's framed as a third-party dashboard
  that Claude Code is a *user* of.
