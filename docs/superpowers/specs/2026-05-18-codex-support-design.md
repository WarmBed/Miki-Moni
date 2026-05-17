# Codex CLI Support — Design Spec

**Date:** 2026-05-18
**Status:** Draft, awaiting user review
**Branch:** `feat/codex-support` (worktree: `../cc-hub-codex-support`)
**Scope:** Full parity for OpenAI Codex CLI alongside Claude Code in Miki-Moni, CLI-focused. VSCode focus / send-prompt is explicitly Phase 6 (later).

## 1. Goals & Non-Goals

### Goals
- Codex CLI sessions appear in the Miki-Moni dashboard side-by-side with Claude Code sessions.
- `waiting` notifications fire when a Codex turn completes (same UX as Claude `Stop`).
- `pnpm wrap` can resume a Codex session by UUID and stream its output through the same internal event pipeline as Claude.
- Adding a third agent (cursor, aider, etc.) in the future requires only a new folder under `src/agents/`, no edits to shared code.

### Non-Goals (Phase 1–5)
- Tool-level granularity (`pre_tool_use` / `post_tool_use`) for Codex. Codex's `notify` mechanism only fires on turn completion; we do **not** tail `~/.codex/sessions/**/rollout-*.jsonl` to fake it. Deferred to Phase 6.
- VSCode panel focus / send-prompt for Codex. Codex Desktop deep-link scheme not yet spiked. Deferred to Phase 6.
- Encrypted relay parity for Codex. The existing relay protocol is agent-agnostic, so this comes for free once Phase 1–5 land, but we will not write explicit tests for Codex-over-relay until then.

## 2. Codex CLI Capability Survey (verified 2026-05-18)

| Need | Codex CLI surface | Verified |
|---|---|---|
| Hook callbacks | `notify = ["node", "<path>"]` in `~/.codex/config.toml`. Codex spawns the program on each `agent-turn-complete` and pipes a JSON payload on stdin. | Yes — present in `~/.codex/.tmp` distribution; payload shape matches Codex upstream docs. |
| Session UUID | `session_meta.id` (UUID v7), persisted in `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. | Yes — confirmed against live session `019e3722-8268-7151-883f-65afed2bbbdb`. |
| Resume by UUID | `codex resume <UUID>` (interactive) and `codex exec --json --resume <UUID> "<prompt>"` (non-interactive, JSONL on stdout). | Yes — `codex resume --help` and `codex exec --help`. |
| Immutable cwd | `session_meta` records `cwd` once; later events don't carry cwd. | Yes — matches our existing immutable-cwd invariant. |
| VSCode deep link | Codex Desktop is the originator but the `vscode://` scheme is not documented. | **No — Phase 6 spike required.** |

### 2.1 Codex notify payload shape

```json
{
  "type": "agent-turn-complete",
  "turn-id": "...",
  "input-messages": ["...user prompt..."],
  "last-assistant-message": "..."
}
```

Codex does not emit `session_start`, `pre_tool_use`, or `post_tool_use` via notify. The full set of notify event types in the current Codex release is `agent-turn-complete` only (other types reserved for future use).

### 2.2 Event mapping decision

| Codex notify | Miki event_type | Behaviour |
|---|---|---|
| First time we see a `session_uuid` | `session_start` | Synthesised by the hook script when the local "seen-uuids" cache misses. Cache lives at `~/.miki-moni/codex-seen-uuids.json`. |
| `agent-turn-complete` (carries `input-messages`) | Emit two events in order: `user_prompt` then `stop` | Same callback emits both; daemon's last-write-wins still applies. |
| (no equivalent) | `pre_tool_use` / `post_tool_use` | Not produced for Codex sessions. Dashboard shows session as either `active` (briefly, during user_prompt) or `waiting` (after stop). |

## 3. Architecture

```
+-------------------+        +---------------------+        +-----------------+
| Claude Code hooks |        | Codex notify program |        | wrap-process    |
| (miki-emit.ps1)   |        | (miki-emit-codex.mjs)|        | (CLI / web)     |
+--------+----------+        +----------+----------+        +--------+--------+
         |  agent='claude'              |  agent='codex'             |
         |    POST /event               |    POST /event             |
         +-------+----------------------+                            |
                 v                                                   v
         +-------+--------+                                  +-------+--------+
         | server.ts      |                                  | wrap-process.ts|
         | (/event route) |                                  | dispatch by    |
         +-------+--------+                                  | session.agent  |
                 |                                            +-------+--------+
                 v                                                    |
         +-------+--------+                                            |
         | hook-handler.ts|<--------- AgentAdapter -------------------+
         | (agent-agnostic)|         registry.get(agent).wrap(...)
         +-------+--------+
                 v
         +-------+--------+        +-----------+
         | session-store  | -----> | WS broadcast | --> web dashboard (badge by agent)
         | (sqlite + agent)        +-----------+
         +----------------+
```

### 3.1 New module: `src/agents/`

```
src/agents/
  types.ts          # AgentAdapter, InternalEvent, WrapArgs, AgentId
  registry.ts       # getAdapter(id), allAdapters()
  claude/
    adapter.ts      # implements AgentAdapter for Claude Code
    install.ts      # extracted from src/install-hooks.ts (Claude portion)
    wrap.ts         # extracted from src/wrap-process.ts (Claude portion)
  codex/
    adapter.ts      # implements AgentAdapter for Codex
    install.ts      # config.toml merge (idempotent, AST-based)
    wrap.ts         # spawns `codex exec --json --resume <uuid>`, parses JSONL
    notify-payload.ts # codex notify payload type + parsers
    seen-uuids.ts   # tracks which UUIDs we've already seen, to synthesise session_start
```

### 3.2 `AgentAdapter` interface

```typescript
export type AgentId = 'claude' | 'codex';

export interface InternalEvent {
  // existing shape used by wrap-process consumers; unchanged
  type: 'message' | 'tool_use' | 'tool_result' | 'turn_end' | 'error';
  payload: unknown;
}

export interface WrapArgs {
  sessionUuid: string;
  cwd: string;
  prompt?: string;       // optional initial prompt
  signal?: AbortSignal;
}

export interface AgentAdapter {
  readonly id: AgentId;
  installHooks(): Promise<void>;   // idempotent
  uninstallHooks(): Promise<void>; // idempotent
  wrap(args: WrapArgs): AsyncIterable<InternalEvent>;
  // Phase 6:
  focusSession?(uuid: string, cwd: string): Promise<void>;
  sendPrompt?(uuid: string, cwd: string, text: string): Promise<void>;
}
```

### 3.3 Registry pattern

```typescript
// src/agents/registry.ts
const adapters: Record<AgentId, AgentAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};
export const getAdapter = (id: AgentId) => adapters[id];
export const allAdapters = () => Object.values(adapters);
```

`hook-handler`, `wrap-process`, and `install-hooks` consume only the registry. There is **no** `if (agent === 'codex')` branch anywhere outside `src/agents/codex/`.

## 4. Data Model Changes

### 4.1 `sessions` table migration

```sql
ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
```

Applied on daemon start by `session-store.ts`:
1. `PRAGMA table_info(sessions)` to detect missing column.
2. Run the `ALTER TABLE` once if missing. Idempotent on subsequent starts.
3. No migration framework introduced (single column, single statement).

### 4.2 `Session` type

```typescript
interface Session {
  agent: AgentId;          // NEW
  cwd: string;
  session_uuid: string;
  project_name: string;
  status: SessionStatus;
  last_event_at: number;
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
  vscode_pid: number | null;
}
```

Primary key remains `session_uuid` alone (UUID namespaces are disjoint in practice; adding a composite key would force every consumer to carry two fields for zero gain).

### 4.3 `HookEvent` type

```typescript
interface HookEvent {
  agent: AgentId;          // NEW; defaults to 'claude' if missing for backward compat
  event_type: 'session_start' | 'user_prompt' | 'pre_tool_use' | 'post_tool_use' | 'stop';
  cwd: string;
  session_uuid: string;
  timestamp: number;
}
```

Server `/event` handler treats missing `agent` as `'claude'` so users with an un-updated `miki-emit.ps1` don't break. We log a one-shot warning recommending `pnpm install:hooks`.

## 5. Codex notify integration

### 5.1 `hooks/miki-emit-codex.mjs`

- Node ESM script, no external deps (uses `node:fs`, `node:http`, `node:os`, `node:path`).
- Reads JSON from stdin.
- Loads/updates `~/.miki-moni/codex-seen-uuids.json` (max 500 entries, LRU).
- If UUID is new → POST `{event_type: 'session_start', agent: 'codex', ...}` first.
- Always POST `{event_type: 'user_prompt'}` then `{event_type: 'stop'}`.
- Port discovery: read `~/.miki-moni/port`, fall back to 8765.
- Resolves `cwd`: notify payload doesn't include cwd reliably; we read the session's `session_meta.cwd` by glob-finding the matching rollout JSONL under `~/.codex/sessions/`. This is the one place we touch private state, and only to bootstrap cwd on first sight. Documented in code with a TODO referencing Phase 6.
- Fails silently on any error (never blocks Codex).

### 5.2 Installation: `~/.codex/config.toml` merge

`src/agents/codex/install.ts` uses `@iarna/toml` (already in repo for unrelated reasons; if not, add it — it is permissively licensed and zero-dep).

Algorithm:
1. Read `~/.codex/config.toml` (create empty if missing).
2. Parse to AST/object.
3. If `notify` key missing → set to `["node", "<absolute path to miki-emit-codex.mjs>"]`.
4. If `notify` exists and equals our value → no-op.
5. If `notify` exists and differs → write to stderr:
   `[miki-moni] WARNING: ~/.codex/config.toml already defines notify = [...]. Skipping. To enable Miki-Moni Codex hooks, merge manually or chain.`
   Return success without modifying (consistent with our "never break user config" rule for `~/.claude/settings.json`).
6. Backup original to `~/.codex/config.toml.bak.<timestamp>` before any write.
7. Re-serialize with `@iarna/toml` (preserves table order; comments are dropped — documented limitation, mitigated by the backup).

`pnpm install:hooks` calls `allAdapters().map(a => a.installHooks())` in parallel.

## 6. `wrap-process` dispatch

`src/wrap-process.ts` becomes a thin dispatcher:

```typescript
export async function* wrapSession(args: WrapArgs & { agent: AgentId }) {
  const adapter = getAdapter(args.agent);
  yield* adapter.wrap(args);
}
```

`src/agents/claude/wrap.ts` keeps the current implementation (Claude SDK, `resume: uuid`).

`src/agents/codex/wrap.ts`:
- Spawns `codex exec --json --resume <uuid> --cd <cwd> <prompt>`.
- Parses stdout line-by-line as JSONL.
- Maps Codex JSON event types → our `InternalEvent` shape. Mapping table lives in `notify-payload.ts` for symmetry with notify mapping. The minimum we map:
  - `agent_message` / `assistant_message` → `{ type: 'message', payload }`
  - `tool_use` (any flavour) → `{ type: 'tool_use', payload }`
  - `tool_result` → `{ type: 'tool_result', payload }`
  - `turn_complete` → `{ type: 'turn_end', payload }`
  - parse errors / stderr → `{ type: 'error', payload }`
- On `signal.abort()`, sends SIGINT then SIGKILL after 500ms.

## 7. Frontend Changes

### 7.1 `web/` (dashboard)

- `SessionCard.tsx`: small badge top-right. `C` (Claude orange `#d97757`) or `X` (Codex purple `#7c5cff`). 16×16, rounded.
- `SessionList.tsx`: filter toggles — `All / Claude / Codex`. Default `All`.
- Both colours added to `tailwind.config` as `agent-claude` / `agent-codex` for single source of truth.
- WS message shape adds `agent` automatically (Session type change); no protocol version bump needed because consumers ignore unknown fields.

### 7.2 `web-phone/`

Same badge treatment, smaller (12×12). No filter (mobile is single-session focused).

## 8. Testing Strategy

### 8.1 Unit

- `src/agents/codex/install.test.ts`
  - Empty config.toml → notify gets written.
  - Existing matching notify → no-op (no backup created).
  - Existing different notify → warning logged, no write.
  - Existing `[projects.'d:\code\x']` tables preserved across round-trip.
- `src/agents/codex/notify-payload.test.ts`
  - Fixture: real `agent-turn-complete` payload → emits 2 (or 3 if first sight) HTTP POSTs in correct order with correct shape.
  - Missing optional fields → graceful.
- `src/agents/codex/wrap.test.ts`
  - Mock `codex` child process emitting JSONL fixture → adapter yields expected `InternalEvent` sequence.
  - SIGINT on abort.
- `src/hook-handler.test.ts` (extend existing)
  - Same cwd with `agent='claude'` and `agent='codex'` UUIDs coexist as distinct rows.
  - `agent` missing in HookEvent → row gets `agent='claude'`.
- `src/session-store.test.ts` (extend)
  - Open DB with pre-migration schema (no `agent` column) → ALTER applied, default `'claude'`, existing rows preserved.

### 8.2 Integration

- `pnpm verify` gains a codex track: synthetic `miki-emit-codex.mjs` invocation against running daemon, asserts WS sees a session with `agent='codex'`.
- Manual smoke before each Phase merge: real `codex exec --json "say hi"` in `d:\code\cc-hub` → dashboard shows the card.

### 8.3 Out of scope this spec

- VSCode focus, send-prompt, jsonl-tail granularity, encrypted relay E2E for Codex.

## 9. Phasing

| Phase | Deliverable | Done when |
|---|---|---|
| 1 | `src/agents/` skeleton, types, registry; refactor existing Claude code into `agents/claude/`; **no behaviour change**. | All existing tests pass; typecheck clean. |
| 2 | DB migration + `agent` in `HookEvent` and `Session`; server `/event` accepts/back-compats `agent`. | Unit tests pass; `miki-emit.ps1` updated to send `agent='claude'`. |
| 3 | `hooks/miki-emit-codex.mjs` + `src/agents/codex/install.ts` + wired into `pnpm install:hooks`. | Manual: `codex exec "hi"` in a project surfaces a card in the dashboard. |
| 4 | `src/agents/codex/wrap.ts` + dispatcher in `wrap-process.ts`. | `pnpm verify` extended track passes. |
| 5 | Dashboard badge + filter (web + web-phone). | UI review. |
| 6 (later) | VSCode focus / send-prompt for Codex; optional jsonl-tail for tool granularity. | Out of scope this spec; will get its own design doc. |

Each phase is shippable on its own and leaves the system in a working state.

## 10. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Codex notify payload shape changes upstream. | Parser is isolated in `notify-payload.ts`; fixture-driven tests catch drift; payload version (if present) gets logged. |
| `@iarna/toml` drops comments on round-trip. | Document in install warning; backup file always written before modification. |
| User has custom `notify` in `~/.codex/config.toml`. | We refuse to overwrite, log a clear message with manual-merge instructions, exit 0. |
| cwd resolution via session jsonl glob is fragile. | Phase 6 will replace this once Codex exposes cwd in notify payload (open upstream request). For now, fallback is "use the cwd from the first event after session_start" — but session_start synthesis itself needs cwd, so glob-then-fallback-to-process-cwd. |
| Two adapters both POST to `/event` for the same UUID (impossible in practice but worth guarding). | `agent` is part of upsert; mismatched-agent updates for the same UUID are logged and dropped (last-write-wins is per-agent). |

## 11. File Manifest (estimated diff)

- New: `src/agents/types.ts`, `src/agents/registry.ts`
- New: `src/agents/claude/{adapter,install,wrap}.ts` (moved from existing files)
- New: `src/agents/codex/{adapter,install,wrap,notify-payload,seen-uuids}.ts`
- New: `hooks/miki-emit-codex.mjs`
- New: tests as listed in §8.1
- Modified: `src/types.ts` (add `AgentId`, extend `Session` and `HookEvent`)
- Modified: `src/session-store.ts` (migration + agent in upsert/get)
- Modified: `src/hook-handler.ts` (pass through agent; remove any Claude-specific logic if found)
- Modified: `src/wrap-process.ts` (becomes dispatcher)
- Modified: `src/install-hooks.ts` (delegate to adapters)
- Modified: `src/server.ts` (`/event` accepts `agent`, back-compat fallback)
- Modified: `hooks/miki-emit.ps1` (POST body adds `"agent": "claude"`)
- Modified: `web/src/components/SessionCard.tsx`, `SessionList.tsx`
- Modified: `web-phone/src/...` (badge only)
- Modified: `tailwind.config.*` (two colour tokens)
- Modified: `docs/protocols/hook-protocol.md` (or new file if absent)
- Modified: `package.json` (add `@iarna/toml` if not present)

## 12. Out of Scope (reiterated for the reader)

- Tool-level event granularity for Codex.
- VSCode panel focus / send-prompt for Codex.
- Encrypted relay-specific tests for Codex sessions.
- A migration framework. One ALTER does not justify one.
- Renaming the `cc-hub` repo (still tracked separately).
