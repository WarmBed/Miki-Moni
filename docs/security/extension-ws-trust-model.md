# Trust model: `miki-helper` VSCode extension ↔ daemon `/ws_ext`

**Status:** documented, no change to behavior yet. Decision pending.

This is the higher-risk of the two local-trust analyses (sibling:
[`hooks-trust-model.md`](hooks-trust-model.md)). The `/ws_ext` route is the
return path that turns daemon-side `/send` requests into a VSCode
keystroke — so impersonating it equals **intercepting user prompts**.

## Current behavior

`extension/` (npm package `miki-helper`) opens a WebSocket to
`ws://127.0.0.1:8765/ws_ext` and sends:

```json
{ "type": "register", "workspace_root": "d:/code/cc-hub", "helper_version": "0.0.1" }
```

The daemon (`src/server.ts`, `wss.on("connection")` branch for
`/ws_ext`):

1. Accepts the WS upgrade — no Origin / token / PID check.
2. On `register`, calls `ExtRegistry.add(ws, { workspace_root, version, ... })`.
3. Stores the connection keyed by the **client-supplied** `workspace_root`.

When the daemon's `/send` route routes a prompt to the helper path
(`src/server.ts:558+`):

1. Resolves the target `session_uuid` → its `cwd`.
2. `ExtRegistry.findForCwd(cwd)` picks the registered extension whose
   `workspace_root` is the closest ancestor of `cwd` (`src/ext-registry.ts:30`).
3. Sends a `submit` message containing the prompt and `request_id` over
   that WebSocket.
4. The real extension calls `claude-vscode.focus` and types the prompt
   into the VSCode panel via the official VSCode command API.

## Threat

A malicious local process opens `ws://127.0.0.1:8765/ws_ext` and registers
a `workspace_root` that:

- **Equals an existing legit workspace** → `ExtRegistry.add` replaces by
  `ws` identity but multiple entries with the same `workspace_root` coexist.
  The newest wins on lookup ordering (sort by `workspace_root.length` is a
  tie). Race condition: whichever connected most recently could be picked.
- **Is a deeper subfolder of the user's project** (e.g. legit registered
  `d:/code/cc-hub`, attacker registers `d:/code/cc-hub/src`). `findForCwd`
  picks the longest match → the attacker wins for any session whose `cwd`
  is at or below that subfolder.

What the attacker gets:

- **Read every prompt** the dashboard sends via `/send` for a matching
  workspace. This includes prompts pushed from the **paired phone** — i.e.
  the phone → relay → daemon → `/ws_ext` path.
- **Reply with fake `submit_ack`** to confuse retry logic.
- **Hold the daemon's expectation hostage** by not replying to `ping`, so
  the daemon evicts only after pong-timeout.

Also reachable from a browser? The browser WebSocket API sends an `Origin`
header on `ws://` upgrades; current daemon code does not check it. So:

- A phishing-style page that the user visits while the daemon runs could
  silently connect to `/ws_ext`, register a workspace_root that matches the
  user's repo, and exfiltrate prompts to an attacker-controlled server.
- This is the single most embarrassing failure mode.

What the attacker **cannot** do via `/ws_ext` alone:

- Inject prompts *toward* Claude. `MsgSubmit` flows daemon → extension; the
  extension is sender of `submit_ack` only. (Confirmed at
  `src/protocol-ext.ts:7-40`.) So even a fully impersonated extension
  cannot trigger a Claude prompt — it can only *observe* what the dashboard
  sends.
- Read existing session transcripts (those come from `/sessions` REST, not
  `/ws_ext`).

## Risk rating

🔴 **High.** Cross-origin browser exfiltration of user prompts is the worst
realistic outcome and requires only a visited webpage. The longest-prefix
match in `ExtRegistry.findForCwd` makes it easy to win the routing race by
registering a deeper subfolder.

## Options (no decision yet)

### Option A — Origin allow-list on `/ws_ext` upgrade

Reject the WS upgrade unless `Origin` is `null`, absent, or matches
`http://127.0.0.1:*` / `http://localhost:*`. The official extension is a
Node process and sends no `Origin`; browsers always send one.

- ✅ Kills the visited-webpage attack entirely.
- ✅ Five lines of code in the WS upgrade handler.
- ❌ Doesn't stop a local malicious binary that omits `Origin`.

### Option B — Per-install handshake token

At `pnpm install:hooks` / extension install time, drop a token in
`~/.miki-moni/ext-token`. The extension reads it and sends as a
`?token=...` query param or first WS frame. The daemon rejects connections
without a matching token.

- ✅ Defeats both browser and local impersonators that can't read the
  user's home directory.
- ❌ Any process running as your user can read the file → same trust
  ceiling as the hooks case.
- ❌ Token rotation needs an extension-side mechanism (currently nothing).

### Option C — PID + executable-path attestation

On WS connect, the daemon reads the remote socket's PID from the OS
(`SO_PEERCRED` on Linux/macOS; named-pipe lookup on Windows). Verify the
executable path is the installed `miki-helper` extension host.

- ✅ Strongest local guarantee.
- ❌ Loopback TCP sockets do not expose PEERCRED reliably on Windows.
  Would require switching `/ws_ext` from TCP to a named pipe.
- ❌ Significant refactor; loses the "any WS client can dev against the
  protocol" property that makes hacking on it easy.

### Option D — `workspace_root` ownership challenge

Refuse to honor a `register` for `workspace_root` X unless the extension
proves it can touch a file inside X. E.g. daemon writes a nonce to
`<X>/.miki-helper-nonce`, asks extension to read and echo it. A browser
attacker cannot read arbitrary files, so it fails.

- ✅ Defeats browser impersonation without an Origin check.
- ✅ Stops local impersonators that lack filesystem access to the project
  (rare but possible: sandboxed processes).
- ❌ Writes a file inside every registered workspace (noise / gitignore).
- ❌ Doesn't defeat local processes that have read access to the project
  dir (which is most of them).

### Option E — Combine A + B (recommended seed)

Origin check (defense against browsers) + token (defense against local
processes without home-dir read access). Same shape as the hooks-trust
recommendation, so install-time tooling can write a single combined
token.

## Concrete near-term action (independent of A–E)

Even without any auth change, two cheap fixes already reduce blast radius:

1. **Allow only one registration per `workspace_root` and reject
   duplicates.** Today `ExtRegistry.add` filters by `ws` identity, not by
   `workspace_root`. Reject a `register` whose `workspace_root` equals (or
   is a descendant of) an existing registration with a different
   `ws`. Closes the deeper-subfolder hijack.

2. **Log all `/ws_ext` registrations** with peer-IP + PID where available
   so a user inspecting `~/.miki-moni/miki-moni.log` can audit who has
   registered.

These two changes don't require an auth design decision and we can land
them before settling on Options A–E.

## Open questions

- Are we willing to require `pnpm install:hooks` after upgrading from a
  pre-token version? (Same answer should apply to the hooks doc.)
- Should the extension marketplace listing carry a publisher-verified
  signature so users can distinguish the real `miki-helper` from a
  squatter? (Out of scope for the daemon-side trust model but relevant.)
