# Spike: Hook Discovery (2026-05-15)

> Status: **RESOLVED via documentation + on-machine verification**. The original plan called for an empirical probe of a real Claude session. The user requested autonomous execution instead. OQ1/OQ2/OQ3/OQ5 are now answered authoritatively from Claude Code official documentation (https://code.claude.com/docs/en/hooks and /vs-code and /deep-links — Anthropic-published, current as of 2026-05). OQ4 was verified on this machine. The downstream tasks have been updated to match.

## OQ1: Does the hook process get `CLAUDE_SESSION_ID` env var?

**Answer:** **NO.**

**Evidence (direct doc quote):**
> "There is no `CLAUDE_SESSION_ID`, `CLAUDE_TOOL_NAME`, or similar environment variables. Pass these values to your hook via stdin JSON."

What hooks DO get as env vars:
- `CLAUDE_PROJECT_DIR` — project root path (on all hooks)
- `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` — plugin hooks only
- `CLAUDE_ENV_FILE` — SessionStart, Setup, CwdChanged, FileChanged
- `CLAUDE_EFFORT` — PreToolUse, PostToolUse, Stop, SubagentStop
- `CLAUDE_CODE_REMOTE=true` — only in remote web envs

**Implication for Task 14 (PowerShell emitter):** Must parse `session_id` from stdin JSON, not env. Fallback to `CLAUDE_PROJECT_DIR` for cwd. `cwd` is also in the stdin JSON, so that's the primary source.

---

## OQ2: What is the `Stop` hook stdin payload schema?

**Answer:** Documented schema below.

**Stop event stdin:**
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "permission_mode": "string",
  "effort": { "level": "string" },
  "hook_event_name": "Stop"
}
```

**Common fields across all events** (`SessionStart`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`):
- `session_id` — string, unique session UUID
- `transcript_path` — string, absolute path to the conversation .jsonl
- `cwd` — string, working directory
- `hook_event_name` — string, the event name (PascalCase, e.g. `"Stop"`)

**Event-specific additions:**
- `SessionStart` adds: `source` ("startup"/"resume"/"clear"/"compact"), `model`
- `UserPromptSubmit` adds: `prompt`, `permission_mode`
- `PreToolUse` adds: `tool_name`, `tool_use_id`, `tool_input` (varies by tool), `permission_mode`, `effort`
- `PostToolUse` adds: `tool_name`, `tool_use_id`, `tool_input`, `tool_result`, `permission_mode`, `effort`

**Implication for Task 14 (PowerShell emitter):** Map `hook_event_name` (PascalCase) → our `event_type` (snake_case). Take `cwd` and `session_id` from stdin JSON.

**Implication for Task 6 (HookHandler):** No change — our internal `HookEvent` is the post-emitter normalized shape, so HookHandler keeps its current interface.

---

## OQ3: Does `vscode://anthropic.claude-code/open?session=<uuid>` raise the correct workspace's window on Windows?

**Answer: PARTIAL — known limitation.**

**Evidence (direct doc quote from /vs-code):**
> "If VS Code isn't already running, opening the URL launches it first. **If VS Code is already running, the URL opens in whichever window is currently focused.**"

And on the `session` parameter:
> "A session ID to resume instead of starting a new conversation. **The session must belong to the workspace currently open in VS Code. If the session isn't found, a fresh conversation starts instead.**"

**Combined behavior:**
1. URI opens a Claude Code tab in **whichever VSCode window is currently focused** (not the workspace-matching one).
2. If the focused window's workspace contains the session — works as intended.
3. If the focused window is a different workspace — a **fresh** Claude conversation opens there. The prompt prefill still goes through, but in the wrong project.

**Implication for Task 7 (VscodeBridge) and Task 17 (Web UI):**
- The pure URI-handler approach can NOT reliably "focus the dragonfly VSCode window from the dashboard". It can only open a new tab in the currently-focused VSCode.
- **YAGNI-acceptable Phase 1 fallback:** treat `focus` as "user manually Alt+Tab to the right VSCode, then click dashboard's focus button". The button still serves a purpose: it opens / refocuses the existing session tab inside whatever VSCode is focused. The notification also tells user *which* project needs attention so they know which window to switch to.
- **For Phase 2** (or 1.5): add an OS-level window-focus mechanism (Windows: PowerShell `Add-Type` + `user32.dll`'s `FindWindow` + `SetForegroundWindow`, or `AppActivate`). Out of Phase 1 scope.

**Update applied:** Task 18 smoke test step "Cross-window focus works" downgraded — passing now means "the Claude tab opens with the right session loaded *if the target VSCode is focused*". A real cross-window focus is documented as a Phase 1 limitation in README.

---

## OQ4: Does `node-notifier` send a Windows toast notification from this daemon?

**Answer: YES.**

**Verification (run on this machine, 2026-05-15):**
```
node -e "import('node-notifier').then(n => n.default.notify({ title: 'cc-hub probe', message: 'OQ4 verification — node-notifier on Windows' }, (err) => { ... }))"
→ OK: notification dispatched
```

**Implication:** Task 8 (Notifier) proceeds with `node-notifier` as planned.

---

## OQ5: Multi-VSCode-windows same workspace — which one does the URI handler hit?

**Answer:** Whichever is currently focused (same as OQ3). Document doesn't specifically address two windows on the same workspace, but the rule "URL opens in whichever window is currently focused" implies the focused one wins regardless of workspace match.

**Implication:** Same as OQ3 — Phase 1 accepts the limitation. Dashboard `focus` button works on the focused window, not the workspace-owning window.

---

## Updated Branch Decisions

| OQ | Answer | Action |
|---|---|---|
| OQ1 | No env var; session_id is in stdin JSON | Task 14 PS emitter reads from stdin |
| OQ2 | Documented schema | Task 14 mapping + Task 6 unchanged |
| OQ3 | URI hits focused window, not workspace-owning | Task 7 documented limitation; no spec change. Phase 1 ships with caveat; Phase 1.5/2 adds OS-level window focus |
| OQ4 | node-notifier works | Task 8 proceeds as planned |
| OQ5 | Same as OQ3 | Documented as known limitation |

**No Phase 1 spec rewrite needed.** The "cross-window focus" use case is partially served (notification tells you *which* project needs attention; clicking the URI loads the right session if the right window is focused). A true window-raiser is logged as Phase 1.5 follow-up.

---

## Fixtures Created (based on doc schemas, not real captures)

Synthetic fixtures live at `d:/code/cc-hub/tests/fixtures/`:

- `hook-payloads/session_start.json`
- `hook-payloads/stop.json`
- `hook-payloads/user_prompt_submit.json`
- `hook-payloads/pre_tool_use.json`
- `hook-payloads/post_tool_use.json`
- `projects/d--code-cc-hub/<uuid>.jsonl` — fake conversation log
- `projects/d--code-empty-project/.gitkeep` — empty project dir for null-case tests

These are synthesized to match the documented schemas. Tasks 5, 6, 9-13 use them in tests. When real spike data becomes available (e.g. on the first real smoke test in Task 18), the fixtures can be regenerated.
