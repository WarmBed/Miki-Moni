# Trust model: Claude Code hooks → daemon `/event`

**Status:** documented, no change to behavior yet. Decision pending.

## Current behavior

Claude Code's hook system invokes `hooks/miki-emit.ps1` for five event types
(`SessionStart`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`). The
script reads the hook payload from stdin and POSTs a JSON body to
`http://127.0.0.1:<port>/event`:

```json
{
  "event_type": "session_start",
  "cwd": "d:\\code\\cc-hub",
  "session_uuid": "5fbb...",
  "timestamp": 1729...
}
```

The daemon (`src/server.ts`, route `/event`):

1. Validates the JSON shape (`parseHookEvent`).
2. Normalizes `cwd` and looks up / inserts a row in the SQLite session store.
3. Optionally fires a desktop notification when status flips to `waiting`.

No authentication, no shared secret, no PID check. The only access control is
that the daemon binds `127.0.0.1` exclusively (`src/index.ts:166`).

## Threat

Anything running on the same machine as your user account can POST to
`/event`:

- A random browser tab on `http://malicious.example/` can issue
  `fetch("http://127.0.0.1:8765/event", { method: "POST", ... })`.
- A malicious npm postinstall, a compromised VSCode extension, a renamed
  `.ps1` dropped in `%TEMP%` — any of these can spam events.

What they get:

- **Pollute the dashboard.** Insert fake sessions with attacker-controlled
  `project_name` / `cwd`. Cosmetic but confusing.
- **Trigger spurious notifications.** Toast spam, audio chime spam.
- **Hide real sessions in noise.** A flood of `stop`/`waiting` events buries
  legitimate notifications.
- **Pre-position cwd entries** so later `/send` or `/focus` calls operate on
  attacker-chosen rows.

What they **cannot** do via `/event` alone:

- Execute shell / read files. The handler treats the payload as data, stores
  it in prepared statements (better-sqlite3 binds), never `exec`s anything.
- Affect the wrapped CLI's running Claude process.
- Leak prompts back to themselves (this endpoint is write-only from their
  side; the `/ws_ext` route is the prompt-exfiltration vector — see the
  sibling doc).

## Risk rating

🟡 **Medium.** Real but bounded. No RCE, no prompt leak, but reputational
("anyone can spoof events into Miki-Moni") and a denial-of-service nuisance.

## Options (no decision yet)

### Option A — Keep as-is, document loudly

Loopback is the entire trust boundary. Add a security note to README and
release notes that says "any process running as your user can write hook
events." Ship as v0.x and let the threat model evolve.

- ✅ Zero implementation cost.
- ✅ Matches how `~/.claude/settings.json` already works (hooks themselves
  are trust-on-local).
- ❌ A PoC blog post ("I spoofed Miki-Moni dashboards from a webpage") is
  cheap to write.

### Option B — Per-install shared secret in a token file

Generate a random token at first run, write it to
`~/.miki-moni/hook-token` with restrictive perms, and have:

- `hooks/miki-emit.ps1` read it and add an `X-Miki-Token` header.
- `/event` reject requests without a matching header.

- ✅ Stops cross-origin browser fetches (they can't read arbitrary files).
- ✅ Defeats casual local impersonation (attacker must read the file).
- ❌ Any process running as your user can still read the token file. Same
  attacker class that compromises hooks can read it.
- ❌ Tiny extra surface on `pnpm install:hooks` (must inject token).

### Option C — Cookie-style + Origin / null-Origin check

Reject `POST /event` when the request has an `Origin` header that isn't
empty / `null` / local. PowerShell `Invoke-RestMethod` sends no `Origin`;
browsers always do.

- ✅ Blocks the cross-origin browser-tab attack (the most embarrassing one).
- ✅ Zero file-system state.
- ❌ Doesn't stop a local malicious binary that omits `Origin`.
- ❌ Same approach must be repeated on every loopback route.

### Option D — Combine B + C

Token file + Origin check. Closes both browser-tab and local-binary spoofing
in the common case.

- ✅ Strongest local protection without OS keychain.
- ❌ Most code to write and test; needs careful rollout for users who
  installed hooks before the token existed (`miki install-hooks --force`).

## Recommendation seed (for later discussion)

If we ship as `v0.x` openly experimental → Option A is fine *if* the README
and release notes are explicit. If we want to avoid a "trivial spoofing"
issue thread → Option D is the right shape: token file for in-process auth,
Origin check as defense-in-depth against browser tabs.

Open questions:

- Do we accept the migration friction of re-running `miki install-hooks`?
- Should the token live in OS keychain (`wincred` / Keychain Access)
  instead of `~/.miki-moni/hook-token`? Adds a native dep but matches how
  GitHub CLI / 1Password CLI store secrets.
