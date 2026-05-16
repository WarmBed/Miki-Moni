# cc-hub-helper VSCode Extension — Design Spec

**Date:** 2026-05-16
**Status:** Design approved, ready for implementation plan.

## Problem

cc-hub daemon currently uses `vscode://anthropic.claude-code/open?session=X&prompt=Y` URI + Win32 P/Invoke (`AttachThreadInput` + ALT keypress + `SetForegroundWindow` + `SwitchToThisWindow`) + PowerShell `SendKeys {ENTER}` to auto-submit prompts from the dashboard to specific Claude panel sessions in VSCode.

The OS-level focus transfer works (`match=True`, verified end-to-end), but `SendKeys ENTER` does not actually submit the prompt to the target Claude panel session — prompts disappear ("不存在的維度"). Confirmed via end-to-end test: JSONL transcript gains no new user message even when `diag` shows successful focus + Enter dispatch.

Root cause: VSCode webview-hosted Claude panel does not expose a submit command; URI prefill goes to input box, but keyboard focus after URI handling isn't reliably on the input box; and the `claude-vscode.focus` command (which would put focus on the right control) can't be invoked from outside VSCode.

## Solution

Ship a companion VSCode extension `cc-hub-helper` (installed via Local VSIX into the user's daily VSCode windows) that runs inside the VSCode extension host, owns the entire submit flow, and uses internal VSCode APIs + commands that the cc-hub daemon cannot reach from outside.

## Architecture

```
┌─────────────────────┐
│  cc-hub Dashboard   │ (browser)
└──────────┬──────────┘
           │ POST /send
           ▼
┌─────────────────────┐                  ┌────────────────────────┐
│  cc-hub daemon      │  ◄─── WS ────►   │  VSCode #1 (code)      │
│  (Node, port 8765)  │       /ws_ext    │  + cc-hub-helper ext   │
│                     │                  ├────────────────────────┤
│  • session store    │  ◄─── WS ────►   │  VSCode #2 (email)     │
│  • extension reg    │                  │  + cc-hub-helper ext   │
│  • /send routes →   │                  ├────────────────────────┤
│    right extension  │  ◄─── WS ────►   │  VSCode #3 (router)    │
│                     │                  │  + cc-hub-helper ext   │
└─────────────────────┘                  └────────────────────────┘
```

**Direction of comms:** extension is the WS client, daemon is the WS server. Reuses cc-hub's existing `ws` dependency. No port collisions, no service-discovery file needed.

## Components

### cc-hub-helper extension (new)

Lives at `cc-hub/extension/` as a separate npm package with its own `package.json`, `tsconfig.json`, and build pipeline (`vsce package` produces `.vsix`).

**Activation:** on VSCode startup (`activationEvents: ["onStartupFinished"]`). No language/file activation triggers needed.

**Files:**
- `extension/package.json` — VSCode extension manifest. Declares `cc-hub-helper.showStatus` command (debug-only) and `onStartupFinished` activation.
- `extension/src/extension.ts` — main entry: `activate()` reads workspace root, instantiates `WsClient` + `Submitter`, registers `cc-hub-helper.showStatus`.
- `extension/src/ws-client.ts` — WS connection management. Connects to `ws://127.0.0.1:8765/ws_ext`, sends `register` on open, handles incoming `submit`/`ping`, exponential backoff reconnect on close (1s, 2s, 4s, max 30s).
- `extension/src/submitter.ts` — submit flow. Given `{session_uuid, prompt}`, fires URI internally → waits → focuses panel input → bring-to-foreground + SendKeys ENTER via spawned PowerShell.
- `extension/src/foreground-ps.ts` — small helper that emits a PowerShell script for "find VSCode window + force foreground + SendKeys ENTER". This is a **variant** of `cc-hub/src/vscode-bridge.ts:buildFocusAndEnterPS` with the leading `Start-Process URI` step **removed** (the extension already fired the URI in-process via `vscode.env.openExternal`). Rest of the script (EnumWindows + ALT-keypress + AttachThreadInput + SetForegroundWindow + SwitchToThisWindow + SendKeys ENTER) copied verbatim — that logic is already validated end-to-end.

**External deps:** only `ws` (and `@types/vscode`, `@types/node`, `typescript`, `vsce` as dev).

### cc-hub daemon (light change)

**Changes:**
- `src/server.ts`: add a second `WebSocketServer` mounted at path `/ws_ext` (keeps existing `/ws` for dashboard untouched).
- `src/ext-registry.ts` (new): `ExtRegistry` class. Tracks `Map<WebSocket, { workspace_root: string, version: string, registered_at: number }>`. Methods: `add(ws, info)`, `remove(ws)`, `findForCwd(cwd) → WebSocket | null` (longest-prefix-wins).
- `src/vscode-bridge.ts`: new method `submitViaHelper(sessionUuid, prompt, cwd) → Promise<{ok, error?, diag?}>` that picks the right WS via `ExtRegistry`, sends `{type:"submit", request_id, session_uuid, prompt}`, awaits matching `submit_ack` with 10s timeout. The existing `prefillAndSubmit` (current PowerShell-only path) is **kept unchanged** and **renamed to `prefillAndSubmitLegacy`** so callers explicitly opt in to it.
- `src/server.ts /send` handler — new behavior: when `submit:false, auto_enter:true` (the dashboard default):
  1. Look up registered extension via `ExtRegistry.findForCwd(session.cwd)`.
  2. If found → call `bridge.submitViaHelper(...)`. Use its result (ok/error/diag) for the response.
  3. If not found → return **503** with `error: "no cc-hub-helper extension registered for workspace covering <cwd>; install the VSIX into that VSCode window: npm run install-helper"`. **Do NOT silently fall back** to legacy PowerShell — it doesn't work and that was the whole reason for the helper. Legacy is opt-in only via explicit `?legacy=1` query param on /send, intended for debugging the OS-level focus mechanism in isolation.

**No new daemon deps.** Re-use existing `ws` package.

## Wire Protocol

WebSocket at `ws://127.0.0.1:8765/ws_ext`. Messages are JSON, one per WS frame.

### Extension → Daemon

```ts
{ type: "register", workspace_root: string, helper_version: string }
{ type: "submit_ack", request_id: string, ok: boolean, error?: string, diag?: string }
{ type: "pong", request_id: string }
```

Extension sends `register` immediately on socket open. `workspace_root` is the absolute path of the first folder in `vscode.workspace.workspaceFolders` (normalized lowercase on Windows). If no workspace folder is open, extension does NOT register (returns no-op submits).

### Daemon → Extension

```ts
{ type: "submit", request_id: string, session_uuid: string, prompt: string }
{ type: "ping", request_id: string }
```

Daemon pings every 30s. If no `pong` within 10s, daemon drops the connection (extension's reconnect logic re-establishes).

### request_id

UUID v4 generated by sender. Used to correlate ack/pong with the originating request. Required on every request/response pair.

## Submit Flow (inside extension)

On receiving `{type:"submit", request_id, session_uuid, prompt}`:

1. **Build URI:** `vscode://anthropic.claude-code/open?session=<encoded>&prompt=<encoded>`.
2. **Fire URI:** `await vscode.env.openExternal(vscode.Uri.parse(uri))`. This dispatches to Windows shell handler, which dispatches to the anthropic.claude-code extension. Returns `boolean` indicating whether the OS accepted the dispatch (not whether prefill worked).
3. **Wait for prefill:** `await sleep(500)`. This is empirically tuned — claude-code extension needs time to switch session tab and populate input box. (Configurable via `cc-hub-helper.prefillDelayMs` extension setting, default 500.)
4. **Focus input box:** `await vscode.commands.executeCommand('claude-vscode.focus')`. This is the command from the anthropic.claude-code extension's package.json, title "Claude Code: Focus input". Idempotent.
5. **Bring VSCode window to OS foreground + press ENTER:** spawn PowerShell running the proven `buildFocusAndEnterPS` script from `cc-hub/src/vscode-bridge.ts` (Win32 P/Invoke: EnumWindows → SetForegroundWindow + ALT keypress + SwitchToThisWindow → SendKeys ENTER). The script's `folderHint` is set to the workspace folder basename so it picks our own window deterministically. **Skip the URI dispatch step in the script** (we already did it in step 2); just do the focus + Enter.
6. **Reply ack:** send `{type:"submit_ack", request_id, ok: true, diag: "<PS stdout>"}` (or `ok:false, error: ...` on any failure).

Steps 1–4 happen inside extension's Node runtime (no spawn needed). Step 5 spawns PowerShell exactly the way the daemon does today. The whole flow takes ~700–900ms.

## Routing

Daemon receives `/send` with `session_uuid`. Resolves session record → gets `session.cwd`. Then `extRegistry.findForCwd(cwd)`:

- Iterate all registered extensions.
- Compute `isAncestor(extensionWorkspaceRoot, cwd)` — true if cwd starts with workspaceRoot (case-insensitive on Windows, with both paths normalized to forward slashes and trailing slash stripped).
- Among matches, pick longest workspaceRoot (= deepest workspace = most specific).
- Return its WS, or `null` if no match.

**Example:** session.cwd = `d:\code\xianyu-assistant\src`.
- If only one extension registered with workspace `d:\code` → routes there.
- If extensions registered with `d:\code` AND `d:\code\xianyu-assistant` → routes to `d:\code\xianyu-assistant` (longer prefix wins).
- If no extension covers `d:\code\xianyu-assistant\src` → 503 error.

## Error Handling

| Failure mode | Detection | Response |
|---|---|---|
| No extension registered for cwd | `extRegistry.findForCwd(cwd) → null` | 503 with helpful message to dashboard |
| Extension WS connection drops mid-submit | WS close before ack | Drop pending request; daemon `/send` returns 504 timeout |
| Submit ack timeout (10s) | Race between ack and timer | 504 timeout to dashboard |
| URI dispatch failed inside extension | `vscode.env.openExternal` returns false | `submit_ack {ok:false, error:"URI dispatch refused"}` |
| `claude-vscode.focus` command not found | `executeCommand` throws | `submit_ack {ok:false, error:"anthropic.claude-code extension not installed or focus command renamed"}` |
| PowerShell focus script fails | exit code ≠ 0 | `submit_ack {ok:false, error:"foreground/SendKeys: <stderr>"}` |
| Extension lost connection | WS `close` event | Backoff reconnect (1s → 2s → 4s → ... cap 30s). On reconnect, send `register` again. |
| Daemon restarts while extension is connected | Extension WS `error`/`close` | Same as above — reconnect loop handles it |
| Two extensions claim same workspace | Both `register` with same path | Both stay registered; routing picks whichever was added last (LIFO) — diagnostic warning logged |

## Multi-VSCode-Instance Coordination

No coordination needed beyond routing. Each extension instance is independent:
- Its `register` message identifies its workspace.
- Daemon's `ExtRegistry` is keyed by WS connection — natural per-instance.
- When one VSCode closes, the WS closes, daemon removes from registry.

## Repo Layout

```
cc-hub/
├── src/                              # daemon (existing)
│   ├── server.ts                     # MODIFY: add /ws_ext server
│   ├── ext-registry.ts               # NEW
│   ├── vscode-bridge.ts              # MODIFY: add submitViaHelper, keep legacy
│   └── ...
├── web/                              # dashboard (existing, unchanged)
├── extension/                        # NEW — separate npm package
│   ├── package.json                  # VSCode manifest + scripts
│   ├── tsconfig.json
│   ├── src/
│   │   ├── extension.ts              # activate/deactivate
│   │   ├── ws-client.ts              # WS connection management
│   │   ├── submitter.ts              # submit flow orchestration
│   │   └── foreground-ps.ts          # PowerShell script builder (copied from vscode-bridge.ts)
│   ├── tests/
│   │   ├── ws-client.test.ts
│   │   └── submitter.test.ts
│   └── README.md                     # install + usage
├── tests/
│   └── integration.test.ts           # MODIFY: add ext registry + routing tests
├── scripts/
│   └── install-helper.mjs            # NEW: builds VSIX + runs `code --install-extension`
└── package.json                      # MODIFY: add "install-helper" script
```

## Packaging & Install

**Build:** inside `cc-hub/extension/`, `npm run package` runs `vsce package` → produces `cc-hub-helper-0.1.0.vsix`.

**Install:** from `cc-hub/` root, `npm run install-helper` runs `scripts/install-helper.mjs` which:
1. Runs `npm run package` inside `extension/`
2. Globs for the produced `.vsix`
3. Spawns `code --install-extension <path-to-vsix> --force`
4. Prints next steps: "Restart VSCode to activate."

**Re-install on changes:** same command. The `--force` flag overwrites the existing install.

**Uninstall:** `code --uninstall-extension cc-hub.cc-hub-helper`.

## Testing Strategy

### Extension unit tests (`extension/tests/`)

- `ws-client.test.ts`: mock `WebSocket`. Verify: registers on connect, reconnects with backoff on close, handles `submit`/`ping`, sends `register` on every (re)connect.
- `submitter.test.ts`: mock `vscode` namespace + child_process. Verify: builds correct URI, calls `openExternal` then `executeCommand('claude-vscode.focus')` then spawns PowerShell, propagates errors as `submit_ack {ok:false, error}`.

### Daemon integration tests (`tests/integration.test.ts`)

- New `describe("ws_ext registry + routing")`:
  - WS client connects + registers → routes /send for matching cwd correctly
  - 2 extensions with overlapping workspaces → longest-prefix wins
  - No extension registered → /send returns 503
  - Extension drops connection → /send returns 504 next attempt
  - Submit ack with `ok:false` propagates error to /send response

### Manual E2E test (documented in `extension/README.md`)

1. `npm run install-helper` from cc-hub root
2. Restart one VSCode window (the one with d:\code workspace)
3. Open dashboard in browser, click 送出 with a distinctive prompt
4. Verify: prompt appears as new user message in that VSCode's Claude panel session
5. Repeat with all 3 VSCode windows installed
6. Verify: sending to xianyu-assistant session works regardless of which VSCode is foreground

### What we DON'T test automatically

- Actual claude-code extension behavior (URI prefill, focus command) — out of our control, will catch in manual E2E
- Win32 foreground transfer — already proven working in existing PowerShell tests, not re-tested

## YAGNI (explicitly out of scope)

- Linux/Mac support — Windows-only since the daemon's vscode-bridge is already Win32-specific. Re-evaluate post-MVP.
- Encryption/auth on `/ws_ext` — localhost-only listener, same trust model as `/ws` dashboard channel.
- Extension auto-update — manually re-run `npm run install-helper`.
- Visual status indicator in VSCode status bar showing connection state — could add later.
- Multiple Claude panels per session in same workspace — assume 1:1 mapping (current claude-code behavior).
- Bidirectional events from extension (e.g., notify daemon when user manually closes a session) — daemon doesn't need this; hooks fire `SessionEnd`.

## Open Questions (none — all resolved during brainstorming)

(Brainstorming pinned: WS direction = ext→daemon, distribution = Local VSIX, architecture = Approach 2 ext owns whole flow, routing = longest-prefix-wins.)
