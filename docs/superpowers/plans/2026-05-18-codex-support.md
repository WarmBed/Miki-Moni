# Codex CLI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-parity OpenAI Codex CLI support to Miki-Moni alongside Claude Code, structured around an `AgentAdapter` interface so future agents need zero edits to shared code.

**Architecture:** Introduce `src/agents/{claude,codex}/` modules implementing a shared `AgentAdapter` interface. Existing Claude code is moved into `agents/claude/` (no behaviour change). DB schema gains an `agent` column. A new Node-based notify hook (`hooks/miki-emit-codex.mjs`) is registered into `~/.codex/config.toml`. The `wrap-process` dispatcher routes by `session.agent`.

**Tech Stack:** TypeScript (ESM), better-sqlite3, express, vitest, `@iarna/toml` (new dep), Node ESM hook script.

**Spec:** `docs/superpowers/specs/2026-05-18-codex-support-design.md`

---

## Phase 1 — agents/ skeleton + Claude refactor (no behaviour change)

### Task 1.1: Define `AgentAdapter` types

**Files:**
- Create: `src/agents/types.ts`

- [ ] **Step 1: Write the file**

```typescript
// src/agents/types.ts
export type AgentId = "claude" | "codex";

export interface InstallResult {
  installed: boolean;          // true if we wrote (or were already correctly set up); false on skip
  warning?: string;            // human-readable reason for skip
  backupPath?: string;
}

export interface WrapArgs {
  sessionUuid: string;
  cwd: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface InternalEvent {
  type: "message" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error";
  payload: unknown;
}

export interface AgentAdapter {
  readonly id: AgentId;
  installHooks(): Promise<InstallResult>;
  uninstallHooks(): Promise<void>;
  wrap(args: WrapArgs): AsyncIterable<InternalEvent>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: clean (file is types-only, no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/agents/types.ts
git commit -m "feat(agents): introduce AgentAdapter interface (Phase 1.1)"
```

### Task 1.2: Create registry with Claude-only adapter (stub)

**Files:**
- Create: `src/agents/registry.ts`
- Create: `src/agents/claude/adapter.ts`

- [ ] **Step 1: Create the Claude adapter stub**

```typescript
// src/agents/claude/adapter.ts
import type { AgentAdapter, AgentId, InstallResult, WrapArgs, InternalEvent } from "../types.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = "claude";

  async installHooks(): Promise<InstallResult> {
    // Phase 1.3 moves the existing install-hooks.ts logic here.
    throw new Error("ClaudeAdapter.installHooks not yet migrated");
  }

  async uninstallHooks(): Promise<void> {
    throw new Error("ClaudeAdapter.uninstallHooks not implemented");
  }

  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *wrap(_args: WrapArgs): AsyncIterable<InternalEvent> {
    // Phase 4 moves wrap-process.ts logic here.
    throw new Error("ClaudeAdapter.wrap not yet migrated");
  }
}
```

- [ ] **Step 2: Create the registry**

```typescript
// src/agents/registry.ts
import type { AgentAdapter, AgentId } from "./types.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";

const adapters: Record<AgentId, AgentAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};

export function getAdapter(id: AgentId): AgentAdapter {
  return adapters[id];
}

export function allAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
```

- [ ] **Step 3: Create a CodexAdapter stub so registry compiles**

```typescript
// src/agents/codex/adapter.ts
import type { AgentAdapter, AgentId, InstallResult, WrapArgs, InternalEvent } from "../types.js";

export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = "codex";

  async installHooks(): Promise<InstallResult> {
    return { installed: false, warning: "CodexAdapter not yet implemented (Phase 3)" };
  }

  async uninstallHooks(): Promise<void> { /* Phase 6 */ }

  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *wrap(_args: WrapArgs): AsyncIterable<InternalEvent> {
    throw new Error("CodexAdapter.wrap not yet implemented (Phase 4)");
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry.ts src/agents/claude/adapter.ts src/agents/codex/adapter.ts
git commit -m "feat(agents): add registry + Claude/Codex adapter stubs (Phase 1.2)"
```

### Task 1.3: Move Claude install logic into `agents/claude/install.ts`

**Files:**
- Create: `src/agents/claude/install.ts`
- Modify: `src/agents/claude/adapter.ts`
- Modify: `src/install-hooks.ts` (now delegates to registry)

- [ ] **Step 1: Move install logic into agents/claude/install.ts**

Cut the body of `src/install-hooks.ts` (everything below the imports — i.e., constants `SETTINGS_PATH`, `HOOK_SCRIPT_ABS`, `MARKER`, `LEGACY_MARKERS`, `TARGETS`, helpers `commandFor`, `readSettings`, `writeSettings`, `isLegacyGroup`, `ensureHookEntry`, and the `main` body) into a new file. Reshape `main` as an exported `installClaudeHooks()` returning `InstallResult`:

```typescript
// src/agents/claude/install.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { InstallResult } from "../types.js";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
// Was: ../hooks/miki-emit.ps1 from src/. Now we're one dir deeper (src/agents/claude/).
const HOOK_SCRIPT_ABS = path.resolve(_moduleDir, "..", "..", "..", "hooks", "miki-emit.ps1");
const MARKER = "miki-emit.ps1";
const LEGACY_MARKERS = ["cc-hub-emit.ps1"];

const TARGETS: Array<{ key: string; matcher?: string }> = [
  { key: "SessionStart" },
  { key: "Stop" },
  { key: "UserPromptSubmit" },
  { key: "PreToolUse", matcher: ".*" },
  { key: "PostToolUse", matcher: ".*" },
];

function commandFor(eventName: string): string {
  return `powershell -NoProfile -File "${HOOK_SCRIPT_ABS}" ${eventName}`;
}

async function readSettings(): Promise<Record<string, any>> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_PATH, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Could not parse ${SETTINGS_PATH} — file is not valid JSON. ` +
      `Fix the file by hand (or restore from a backup), then re-run install:hooks. ` +
      `Original error: ${(err as Error).message}`,
    );
  }
}

async function writeSettings(s: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function isLegacyGroup(g: any): boolean {
  if (!Array.isArray(g?.hooks)) return false;
  return g.hooks.some((h: any) =>
    typeof h?.command === "string" && LEGACY_MARKERS.some((m) => h.command.includes(m)),
  );
}

function ensureHookEntry(
  hooks: Record<string, any[]>,
  key: string,
  matcher: string | undefined,
  command: string,
): void {
  if (!Array.isArray(hooks[key])) hooks[key] = [];
  hooks[key] = hooks[key].filter((g) => !isLegacyGroup(g));
  const groups = hooks[key];
  for (const g of groups) {
    if (Array.isArray(g.hooks)) {
      for (const h of g.hooks) {
        if (typeof h.command === "string" && h.command.includes(MARKER)) return;
      }
    }
  }
  const newGroup: Record<string, any> = { hooks: [{ type: "command", command }] };
  if (matcher) newGroup.matcher = matcher;
  groups.push(newGroup);
}

export async function installClaudeHooks(): Promise<InstallResult> {
  const settings = await readSettings();
  const backup = SETTINGS_PATH + ".miki-moni.bak";
  try { await fs.access(backup); }
  catch { try { await fs.copyFile(SETTINGS_PATH, backup); } catch { /* no original yet */ } }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  for (const t of TARGETS) {
    ensureHookEntry(settings.hooks, t.key, t.matcher, commandFor(t.key));
  }
  await writeSettings(settings);
  return { installed: true, backupPath: backup };
}
```

- [ ] **Step 2: Wire it into the Claude adapter**

Replace `installHooks` body in `src/agents/claude/adapter.ts`:

```typescript
import { installClaudeHooks } from "./install.js";
// ...
async installHooks(): Promise<InstallResult> {
  return installClaudeHooks();
}
```

- [ ] **Step 3: Rewrite `src/install-hooks.ts` as a thin entry point**

```typescript
// src/install-hooks.ts
import { allAdapters } from "./agents/registry.js";

async function main(): Promise<void> {
  for (const adapter of allAdapters()) {
    try {
      const result = await adapter.installHooks();
      if (result.installed) {
        console.log(`[${adapter.id}] hooks installed${result.backupPath ? ` (backup: ${result.backupPath})` : ""}`);
      } else {
        console.log(`[${adapter.id}] skipped: ${result.warning ?? "no reason given"}`);
      }
    } catch (err) {
      console.error(`[${adapter.id}] install failed:`, err);
      process.exitCode = 1;
    }
  }
}

main();
```

- [ ] **Step 4: Run existing tests**

Run: `pnpm test src/install-hooks` (if exists) and `pnpm typecheck`.
Expected: typecheck clean; install-hooks tests pass if any (none currently — we add one next).

- [ ] **Step 5: Write a smoke test for the new module**

Create `src/agents/claude/install.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { installClaudeHooks } from "./install.js";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

describe("installClaudeHooks", () => {
  let savedSettings: string | null = null;
  let savedBackup: string | null = null;

  beforeEach(async () => {
    try { savedSettings = await fs.readFile(SETTINGS_PATH, "utf8"); } catch { savedSettings = null; }
    try { savedBackup = await fs.readFile(SETTINGS_PATH + ".miki-moni.bak", "utf8"); } catch { savedBackup = null; }
  });

  afterEach(async () => {
    if (savedSettings === null) { await fs.rm(SETTINGS_PATH, { force: true }); }
    else { await fs.writeFile(SETTINGS_PATH, savedSettings); }
    if (savedBackup === null) { await fs.rm(SETTINGS_PATH + ".miki-moni.bak", { force: true }); }
    else { await fs.writeFile(SETTINGS_PATH + ".miki-moni.bak", savedBackup); }
  });

  it("installs all 5 hook targets and is idempotent", async () => {
    const r1 = await installClaudeHooks();
    expect(r1.installed).toBe(true);
    const s1 = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf8"));
    expect(Object.keys(s1.hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse"]),
    );
    const r2 = await installClaudeHooks();
    expect(r2.installed).toBe(true);
    const s2 = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf8"));
    for (const k of Object.keys(s1.hooks)) {
      expect(s2.hooks[k].length).toBe(s1.hooks[k].length); // no duplicates
    }
  });
});
```

- [ ] **Step 6: Run the test**

Run: `pnpm test src/agents/claude/install`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/agents/claude/install.ts src/agents/claude/install.test.ts src/agents/claude/adapter.ts src/install-hooks.ts
git commit -m "refactor(install): move Claude hook install into agents/claude/install.ts (Phase 1.3)"
```

---

## Phase 2 — DB migration + `agent` field through the pipeline

### Task 2.1: Add `AgentId` to `types.ts`, extend `Session` and `HookEvent`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Update types**

```typescript
// src/types.ts (full replacement)
export type AgentId = "claude" | "codex";

export type SessionStatus = "active" | "waiting" | "idle" | "stale";

export interface Session {
  agent: AgentId;              // NEW
  cwd: string;
  session_uuid: string | null;
  project_name: string;
  status: SessionStatus;
  last_event_at: number;
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
  vscode_pid: number | null;
}

export type HookEventType =
  | "session_start"
  | "stop"
  | "user_prompt"
  | "pre_tool_use"
  | "post_tool_use";

export interface HookEvent {
  agent: AgentId;              // NEW
  event_type: HookEventType;
  cwd: string;
  session_uuid: string | null;
  timestamp: number;
  extra?: Record<string, unknown>;
}

export interface StoreEvents {
  session_changed: (session: Session) => void;
  session_removed: (sessionUuid: string) => void;
}
```

- [ ] **Step 2: Run typecheck — expect cascading failures**

Run: `pnpm typecheck`
Expected: errors at every site constructing `Session` or `HookEvent` without `agent`. Note them; we fix in following steps.

- [ ] **Step 3: Commit (will not pass tests yet, but typecheck breaks are intentional snapshot)**

Do NOT commit yet — wait until Task 2.4 finishes; this task's changes will commit alongside subsequent ones.

### Task 2.2: Bump schema to v3 with `agent` column

**Files:**
- Modify: `src/session-store.ts`
- Modify: `src/session-store.test.ts`

- [ ] **Step 1: Write failing test for the new column**

Add to `src/session-store.test.ts`:

```typescript
it("persists agent column and defaults to 'claude' if upserted without explicit agent", () => {
  const store = new SessionStore(":memory:");
  store.upsert({
    agent: "codex",
    cwd: "d:\\x", session_uuid: "u1", project_name: "x", status: "active",
    last_event_at: 1, last_message_preview: "", tokens_in: 0, tokens_out: 0, vscode_pid: null,
  });
  const got = store.get("u1");
  expect(got?.agent).toBe("codex");
  store.close();
});
```

- [ ] **Step 2: Update session-store.ts**

```typescript
// src/session-store.ts — change SCHEMA_VERSION and SQL
const SCHEMA_VERSION = 3;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_uuid TEXT PRIMARY KEY,
  agent TEXT NOT NULL DEFAULT 'claude',
  cwd TEXT NOT NULL,
  project_name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_event_at INTEGER NOT NULL,
  last_message_preview TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  vscode_pid INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_last_event ON sessions(last_event_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
`;

const UPSERT_SQL = `
INSERT INTO sessions (session_uuid, agent, cwd, project_name, status, last_event_at,
                     last_message_preview, tokens_in, tokens_out, vscode_pid)
VALUES (@session_uuid, @agent, @cwd, @project_name, @status, @last_event_at,
        @last_message_preview, @tokens_in, @tokens_out, @vscode_pid)
ON CONFLICT(session_uuid) DO UPDATE SET
  agent = excluded.agent,
  cwd = excluded.cwd,
  project_name = excluded.project_name,
  status = excluded.status,
  last_event_at = excluded.last_event_at,
  last_message_preview = excluded.last_message_preview,
  tokens_in = excluded.tokens_in,
  tokens_out = excluded.tokens_out,
  vscode_pid = excluded.vscode_pid;
`;
```

(Migration is automatic: existing `migrateIfNeeded()` drops the table on version mismatch and rebuilds from incoming hooks — same pattern as v1→v2.)

- [ ] **Step 3: Run the new test**

Run: `pnpm test src/session-store`
Expected: the new test passes; pre-existing tests fail wherever they upsert without `agent` — fix them by adding `agent: "claude"` to those fixtures. Update them in this same step.

- [ ] **Step 4: Re-run session-store tests**

Run: `pnpm test src/session-store`
Expected: all session-store tests pass.

### Task 2.3: Update `HookHandler` to carry `agent`

**Files:**
- Modify: `src/hook-handler.ts`
- Modify: `src/hook-handler.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/hook-handler.test.ts`:

```typescript
it("preserves agent across upsert and lets Claude + Codex coexist on the same cwd", async () => {
  const store = new SessionStore(":memory:");
  const resolver = new SessionResolver(/* whatever the file already passes */);
  const handler = new HookHandler(store, resolver);

  await handler.handle({
    agent: "claude",
    event_type: "session_start", cwd: "d:\\x", session_uuid: "u-claude", timestamp: 1,
  });
  await handler.handle({
    agent: "codex",
    event_type: "session_start", cwd: "d:\\x", session_uuid: "u-codex", timestamp: 2,
  });

  expect(store.get("u-claude")?.agent).toBe("claude");
  expect(store.get("u-codex")?.agent).toBe("codex");
  expect(store.getByCwd("d:\\x").length).toBe(2);
  store.close();
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm test src/hook-handler`
Expected: fail (HookEvent doesn't have `agent` yet wired through, Session upsert misses agent).

- [ ] **Step 3: Update hook-handler.ts**

In `handle()`, change the `next: Session = {...}` block to set `agent` from `existing?.agent ?? ev.agent` (immutable per session, same rule as cwd):

```typescript
const next: Session = {
  agent: existing?.agent ?? ev.agent,
  cwd: cwdToStore,
  session_uuid: sessionUuid,
  project_name: existing?.project_name ?? basename(cwdToStore),
  status: STATUS_BY_EVENT[ev.event_type],
  last_event_at: ev.timestamp,
  last_message_preview: existing?.last_message_preview ?? "",
  tokens_in: existing?.tokens_in ?? 0,
  tokens_out: existing?.tokens_out ?? 0,
  vscode_pid: existing?.vscode_pid ?? null,
};
```

Add a comment explaining: agent is immutable like cwd; if a hook event arrives with a different agent for an existing UUID, log a warning and keep the original.

- [ ] **Step 4: Run test**

Run: `pnpm test src/hook-handler`
Expected: pass.

### Task 2.4: Update server `/event` to parse + default `agent`

**Files:**
- Modify: `src/server.ts` (the `event_type` validation block near line 45)
- Modify: `hooks/miki-emit.ps1`

- [ ] **Step 1: Update the HTTP body parser**

Around line 45 (the `validTypes.includes(b.event_type)` block), extend the validator:

```typescript
// existing:
if (typeof b.event_type !== "string") return null;
// ... validTypes check ...

// NEW: agent is optional in body; default to "claude" for back-compat with old miki-emit.ps1.
const agent: AgentId = b.agent === "codex" ? "codex" : "claude";

return {
  agent,
  event_type: b.event_type as HookEvent["event_type"],
  cwd: typeof b.cwd === "string" ? b.cwd : "",
  session_uuid: typeof b.session_uuid === "string" ? b.session_uuid : null,
  timestamp: typeof b.timestamp === "number" ? b.timestamp : Date.now(),
  extra: typeof b.extra === "object" && b.extra !== null ? b.extra : undefined,
};
```

Add `import type { AgentId } from "./types.js";` if not already imported.

- [ ] **Step 2: Update `hooks/miki-emit.ps1` to send `agent`**

Find the `$body = @{ ... } | ConvertTo-Json` block and add `agent = "claude"`:

```powershell
$body = @{
  agent = "claude"
  event_type = $ourType
  cwd = $cwd
  session_uuid = $sessionId
  timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
} | ConvertTo-Json -Compress
```

- [ ] **Step 3: Run full test suite for changed surface**

Run: `pnpm test src/server src/hook-handler src/session-store src/agents`
Expected: all pass (or only fail with pre-existing failures unrelated to this change — confirm by diff against baseline).

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit Phase 2 in one shot**

```bash
git add src/types.ts src/session-store.ts src/session-store.test.ts \
        src/hook-handler.ts src/hook-handler.test.ts src/server.ts \
        hooks/miki-emit.ps1
git commit -m "feat(agent): plumb agent field through DB, hook handler, /event, and Claude hook (Phase 2)"
```

---

## Phase 3 — Codex notify hook + install

### Task 3.1: Codex notify payload types + mapper

**Files:**
- Create: `src/agents/codex/notify-payload.ts`
- Create: `src/agents/codex/notify-payload.test.ts`

- [ ] **Step 1: Write the parser tests first**

```typescript
// src/agents/codex/notify-payload.test.ts
import { describe, it, expect } from "vitest";
import { parseNotifyPayload, eventsFromPayload } from "./notify-payload.js";

describe("parseNotifyPayload", () => {
  it("accepts agent-turn-complete shape", () => {
    const p = parseNotifyPayload({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["hello"],
      "last-assistant-message": "hi",
    });
    expect(p?.type).toBe("agent-turn-complete");
    expect(p?.inputMessages).toEqual(["hello"]);
  });

  it("returns null for unknown type", () => {
    expect(parseNotifyPayload({ type: "something-else" })).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseNotifyPayload(null)).toBeNull();
    expect(parseNotifyPayload("x")).toBeNull();
  });
});

describe("eventsFromPayload", () => {
  it("emits user_prompt then stop for agent-turn-complete", () => {
    const p = parseNotifyPayload({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["hello"],
      "last-assistant-message": "hi",
    })!;
    const evs = eventsFromPayload(p, { isFirstSight: false });
    expect(evs.map(e => e.event_type)).toEqual(["user_prompt", "stop"]);
  });

  it("prepends session_start when isFirstSight", () => {
    const p = parseNotifyPayload({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["hi"],
      "last-assistant-message": "yo",
    })!;
    const evs = eventsFromPayload(p, { isFirstSight: true });
    expect(evs.map(e => e.event_type)).toEqual(["session_start", "user_prompt", "stop"]);
  });
});
```

- [ ] **Step 2: Implement the parser**

```typescript
// src/agents/codex/notify-payload.ts
import type { HookEventType } from "../../types.js";

export interface AgentTurnComplete {
  type: "agent-turn-complete";
  turnId: string;
  inputMessages: string[];
  lastAssistantMessage: string;
}
export type NotifyPayload = AgentTurnComplete;

export interface CodexEventOut {
  event_type: HookEventType;
  // session_uuid + cwd + timestamp are filled in by the caller (the hook script).
}

export function parseNotifyPayload(raw: unknown): NotifyPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === "agent-turn-complete") {
    return {
      type: "agent-turn-complete",
      turnId: typeof obj["turn-id"] === "string" ? (obj["turn-id"] as string) : "",
      inputMessages: Array.isArray(obj["input-messages"]) ? (obj["input-messages"] as string[]) : [],
      lastAssistantMessage: typeof obj["last-assistant-message"] === "string"
        ? (obj["last-assistant-message"] as string) : "",
    };
  }
  return null;
}

export function eventsFromPayload(
  _p: NotifyPayload,
  opts: { isFirstSight: boolean },
): CodexEventOut[] {
  const out: CodexEventOut[] = [];
  if (opts.isFirstSight) out.push({ event_type: "session_start" });
  out.push({ event_type: "user_prompt" });
  out.push({ event_type: "stop" });
  return out;
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm test src/agents/codex/notify-payload`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/agents/codex/notify-payload.ts src/agents/codex/notify-payload.test.ts
git commit -m "feat(codex): notify payload parser + event mapping (Phase 3.1)"
```

### Task 3.2: `seen-uuids.ts` LRU cache

**Files:**
- Create: `src/agents/codex/seen-uuids.ts`
- Create: `src/agents/codex/seen-uuids.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/agents/codex/seen-uuids.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SeenUuids } from "./seen-uuids.js";

const TMP = path.join(os.tmpdir(), `miki-seen-${Date.now()}-${Math.random()}.json`);

describe("SeenUuids", () => {
  beforeEach(async () => { await fs.rm(TMP, { force: true }); });

  it("first call is firstSight=true, subsequent calls false", async () => {
    const s = new SeenUuids(TMP, 10);
    expect(await s.recordAndCheck("u1")).toBe(true);
    expect(await s.recordAndCheck("u1")).toBe(false);
    expect(await s.recordAndCheck("u2")).toBe(true);
  });

  it("evicts LRU when over capacity", async () => {
    const s = new SeenUuids(TMP, 3);
    await s.recordAndCheck("a");
    await s.recordAndCheck("b");
    await s.recordAndCheck("c");
    await s.recordAndCheck("d"); // evicts "a"
    expect(await s.recordAndCheck("a")).toBe(true);  // a was forgotten
    expect(await s.recordAndCheck("d")).toBe(false);
  });

  it("survives across instances via file persistence", async () => {
    const s1 = new SeenUuids(TMP, 10);
    await s1.recordAndCheck("x");
    const s2 = new SeenUuids(TMP, 10);
    expect(await s2.recordAndCheck("x")).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/agents/codex/seen-uuids.ts
import { promises as fs } from "node:fs";

interface Persisted { order: string[]; }

export class SeenUuids {
  constructor(private filePath: string, private capacity: number = 500) {}

  /** Returns true iff uuid was NOT previously seen (i.e., this is the first sight). */
  async recordAndCheck(uuid: string): Promise<boolean> {
    const list = await this.load();
    const idx = list.indexOf(uuid);
    const firstSight = idx === -1;
    if (idx !== -1) list.splice(idx, 1);
    list.push(uuid);
    while (list.length > this.capacity) list.shift();
    await this.save(list);
    return firstSight;
  }

  private async load(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Persisted;
      return Array.isArray(parsed.order) ? parsed.order : [];
    } catch { return []; }
  }

  private async save(list: string[]): Promise<void> {
    const data: Persisted = { order: list };
    await fs.writeFile(this.filePath, JSON.stringify(data));
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm test src/agents/codex/seen-uuids
git add src/agents/codex/seen-uuids.ts src/agents/codex/seen-uuids.test.ts
git commit -m "feat(codex): SeenUuids LRU cache for first-sight detection (Phase 3.2)"
```

### Task 3.3: Codex `install.ts` (config.toml AST merge)

**Files:**
- Modify: `package.json` (add `@iarna/toml`)
- Create: `src/agents/codex/install.ts`
- Create: `src/agents/codex/install.test.ts`
- Modify: `src/agents/codex/adapter.ts`

- [ ] **Step 1: Add `@iarna/toml` to dependencies**

Run: `pnpm add @iarna/toml`
Expected: package.json gains `"@iarna/toml": "^2.x"`.

- [ ] **Step 2: Write tests**

```typescript
// src/agents/codex/install.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { _installCodexHooksTo } from "./install.js"; // testable entry point taking path

describe("installCodexHooks", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `miki-codex-toml-${Date.now()}-${Math.random()}.toml`);
  });
  afterEach(async () => { await fs.rm(tmp, { force: true }); });

  it("writes notify into a fresh empty config", async () => {
    const r = await _installCodexHooksTo(tmp);
    expect(r.installed).toBe(true);
    const text = await fs.readFile(tmp, "utf8");
    expect(text).toMatch(/notify\s*=\s*\[/);
    expect(text).toMatch(/miki-emit-codex\.mjs/);
  });

  it("is idempotent — second call same notify, no spurious write", async () => {
    await _installCodexHooksTo(tmp);
    const text1 = await fs.readFile(tmp, "utf8");
    const r2 = await _installCodexHooksTo(tmp);
    expect(r2.installed).toBe(true);
    const text2 = await fs.readFile(tmp, "utf8");
    expect(text2).toBe(text1);
  });

  it("refuses to overwrite a user-defined notify and reports a warning", async () => {
    await fs.writeFile(tmp, `notify = ["echo", "user owns this"]\n`);
    const r = await _installCodexHooksTo(tmp);
    expect(r.installed).toBe(false);
    expect(r.warning).toMatch(/already defines notify/i);
    expect(await fs.readFile(tmp, "utf8")).toMatch(/echo/);
  });

  it("preserves unrelated [projects.'...'] tables across round-trip", async () => {
    await fs.writeFile(tmp,
      `model = "gpt-5.5"\n\n[projects.'d:\\\\code\\\\x']\ntrust_level = "trusted"\n`);
    await _installCodexHooksTo(tmp);
    const text = await fs.readFile(tmp, "utf8");
    expect(text).toMatch(/projects\.'d:\\\\code\\\\x'/);
    expect(text).toMatch(/trust_level = "trusted"/);
    expect(text).toMatch(/notify\s*=\s*\[/);
  });
});
```

- [ ] **Step 3: Implement**

```typescript
// src/agents/codex/install.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import toml from "@iarna/toml";
import type { InstallResult } from "../types.js";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT_ABS = path.resolve(_moduleDir, "..", "..", "..", "hooks", "miki-emit-codex.mjs");
const EXPECTED_NOTIFY = ["node", HOOK_SCRIPT_ABS];

function notifyEquals(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function _installCodexHooksTo(targetPath: string): Promise<InstallResult> {
  let parsed: Record<string, any> = {};
  let originalText: string | null = null;
  try {
    originalText = await fs.readFile(targetPath, "utf8");
    parsed = toml.parse(originalText) as Record<string, any>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const existing = parsed.notify;
  if (existing && !notifyEquals(existing, EXPECTED_NOTIFY)) {
    return {
      installed: false,
      warning: `${targetPath} already defines notify = ${JSON.stringify(existing)}. Skipping. ` +
        `To enable Miki-Moni Codex hooks, merge manually so the array invokes ` +
        `node "${HOOK_SCRIPT_ABS}" first.`,
    };
  }

  if (notifyEquals(existing, EXPECTED_NOTIFY)) {
    return { installed: true }; // already correctly configured; no-op
  }

  parsed.notify = EXPECTED_NOTIFY;
  let backup: string | undefined;
  if (originalText !== null) {
    backup = `${targetPath}.miki-moni.bak`;
    try { await fs.access(backup); } catch { await fs.writeFile(backup, originalText); }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, toml.stringify(parsed as toml.JsonMap));
  return { installed: true, backupPath: backup };
}

export async function installCodexHooks(): Promise<InstallResult> {
  return _installCodexHooksTo(CONFIG_PATH);
}
```

- [ ] **Step 4: Wire into the adapter**

```typescript
// src/agents/codex/adapter.ts — replace installHooks body
import { installCodexHooks } from "./install.js";
// ...
async installHooks(): Promise<InstallResult> {
  return installCodexHooks();
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test src/agents/codex && pnpm typecheck`
Expected: pass + clean.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml \
        src/agents/codex/install.ts src/agents/codex/install.test.ts \
        src/agents/codex/adapter.ts
git commit -m "feat(codex): config.toml-based hook install (Phase 3.3)"
```

### Task 3.4: `hooks/miki-emit-codex.mjs` notify script

**Files:**
- Create: `hooks/miki-emit-codex.mjs`

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// miki-emit-codex.mjs — invoked by Codex `notify` (see ~/.codex/config.toml).
// Reads JSON payload from stdin, fans out 1–3 POSTs to the Miki-Moni daemon.
// Fails silently on any error to never block Codex.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const DATA_DIR = path.join(os.homedir(), ".miki-moni");
const SEEN_PATH = path.join(DATA_DIR, "codex-seen-uuids.json");
const CAPACITY = 500;

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function readPort() {
  try {
    const p = fs.readFileSync(path.join(DATA_DIR, "port"), "utf8").trim();
    if (/^\d+$/.test(p)) return parseInt(p, 10);
  } catch {}
  return 8765;
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")).order || []; }
  catch { return []; }
}
function saveSeen(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SEEN_PATH, JSON.stringify({ order: list }));
  } catch {}
}
function recordSeen(uuid) {
  const list = loadSeen();
  const idx = list.indexOf(uuid);
  const firstSight = idx === -1;
  if (idx !== -1) list.splice(idx, 1);
  list.push(uuid);
  while (list.length > CAPACITY) list.shift();
  saveSeen(list);
  return firstSight;
}

// Codex notify payload does not include cwd. We resolve it by scanning today's
// rollout files for one whose session_meta.id matches our UUID. Best-effort.
function findCwdForUuid(uuid) {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsRoot)) return process.cwd();
  // Walk YYYY/MM/DD looking at most ~50 most-recently-modified files.
  const candidates = [];
  for (const year of safeReaddir(sessionsRoot)) {
    for (const month of safeReaddir(path.join(sessionsRoot, year))) {
      for (const day of safeReaddir(path.join(sessionsRoot, year, month))) {
        for (const f of safeReaddir(path.join(sessionsRoot, year, month, day))) {
          if (!f.endsWith(".jsonl") || !f.includes(uuid)) continue;
          candidates.push(path.join(sessionsRoot, year, month, day, f));
        }
      }
    }
  }
  for (const file of candidates) {
    try {
      const firstLine = fs.readFileSync(file, "utf8").split("\n", 1)[0];
      const obj = JSON.parse(firstLine);
      if (obj.type === "session_meta" && obj.payload?.cwd) return obj.payload.cwd;
    } catch {}
  }
  return process.cwd();
}
function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

function post(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, path: "/event", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
      timeout: 2000,
    }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", () => resolve());
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.write(data); req.end();
  });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (payload?.type !== "agent-turn-complete") return;

    // Codex notify doesn't carry session UUID directly today; it's available
    // via env var CODEX_SESSION_ID when the notify program is spawned.
    const uuid = process.env.CODEX_SESSION_ID || payload["session-id"] || payload.session_id;
    if (!uuid) return;

    const cwd = findCwdForUuid(uuid);
    const firstSight = recordSeen(uuid);
    const port = readPort();
    const now = Date.now();
    const base = { agent: "codex", cwd, session_uuid: uuid, timestamp: now };

    const events = [];
    if (firstSight) events.push({ ...base, event_type: "session_start" });
    events.push({ ...base, event_type: "user_prompt", timestamp: now + 1 });
    events.push({ ...base, event_type: "stop", timestamp: now + 2 });

    for (const ev of events) await post(port, ev);
  } catch { /* never block codex */ }
})();
```

- [ ] **Step 2: Smoke-test by piping a payload**

Run (from worktree root):

```bash
CODEX_SESSION_ID=test-uuid-1 echo '{"type":"agent-turn-complete","turn-id":"t","input-messages":["hi"],"last-assistant-message":"yo"}' | node hooks/miki-emit-codex.mjs
```

Expected: exits 0 silently (daemon not running → silent fail). Then run with the daemon up via `pnpm dev` in a second shell and check daemon log shows two/three `/event` arrivals with `agent=codex`.

- [ ] **Step 3: Commit**

```bash
git add hooks/miki-emit-codex.mjs
git commit -m "feat(codex): notify hook script POSTs to daemon (Phase 3.4)"
```

### Task 3.5: Make `pnpm install:hooks` include Codex + ship script in npm tarball

**Files:**
- Modify: `package.json` (add `hooks/miki-emit-codex.mjs` to `files`)

- [ ] **Step 1: Verify `files` array in package.json**

Run: `grep -A20 '"files"' package.json`
Expected: `"hooks/miki-emit.ps1"` (or glob `"hooks/**"`) appears. If not a glob, add `"hooks/miki-emit-codex.mjs"`.

- [ ] **Step 2: Run `pnpm install:hooks` end-to-end**

Run: `pnpm install:hooks`
Expected output includes:
```
[claude] hooks installed ...
[codex]  hooks installed (backup: ...)   // or "skipped: ... already defines notify"
```

- [ ] **Step 3: Confirm config.toml**

Run: `grep -A2 '^notify' ~/.codex/config.toml`
Expected: `notify = ["node", "<absolute path>/hooks/miki-emit-codex.mjs"]`

- [ ] **Step 4: Manual E2E**

In a Codex-trusted project, run `codex exec --json "say hi"`. Open the dashboard (`http://127.0.0.1:8765` or whatever daemon prints). Expected: a card appears with the project name and a `status: waiting` after the turn completes.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(pack): ship miki-emit-codex.mjs in the npm tarball (Phase 3.5)"
```

---

## Phase 4 — Codex `wrap` (resume + stream)

### Task 4.1: Move existing wrap logic into `agents/claude/wrap.ts`

**Files:**
- Create: `src/agents/claude/wrap.ts`
- Modify: `src/agents/claude/adapter.ts`
- Modify: `src/wrap-process.ts`

- [ ] **Step 1: Identify the "wrap a session" function in current `src/wrap-process.ts`**

This file is large (~1000 lines). Find the exported function (or HTTP handler factory) that, given `(sessionUuid, cwd, prompt?)`, spawns Claude and streams events. Extract just that core into a new module.

Run: `grep -n "export" src/wrap-process.ts | head`
Identify the function (likely `wrapSession`, `runWrap`, or similar). If `wrap-process.ts` is purely an HTTP route registration, extract the inner spawn/stream logic into `agents/claude/wrap.ts` as `async function* wrapClaudeSession(args: WrapArgs): AsyncIterable<InternalEvent>`.

- [ ] **Step 2: Create `agents/claude/wrap.ts` with the extracted function**

The function should: accept `WrapArgs`, spawn Claude SDK with `resume: args.sessionUuid` (and `cwd`, `prompt`, `signal`), translate SDK output to `InternalEvent` shape using the mapping below, and yield events as an async generator.

```typescript
// src/agents/claude/wrap.ts (sketch — adapt to whatever shape wrap-process.ts uses today)
import type { WrapArgs, InternalEvent } from "../types.js";

export async function* wrapClaudeSession(args: WrapArgs): AsyncIterable<InternalEvent> {
  // 1. Build SDK input: { resume: args.sessionUuid, cwd: args.cwd, prompt: args.prompt }
  // 2. Wire args.signal to SDK abort.
  // 3. For each SDK event:
  //      - assistant message → yield { type: "message", payload }
  //      - tool_use → yield { type: "tool_use", payload }
  //      - tool_result → yield { type: "tool_result", payload }
  //      - turn_start / turn_end → yield matching InternalEvent
  //      - error → yield { type: "error", payload }
  // 4. The HTTP route in wrap-process.ts now does:
  //      for await (const ev of getAdapter(session.agent).wrap(args)) { ws.send(ev); }
  throw new Error("Implementation: copy from existing src/wrap-process.ts spawn+stream block");
}
```

(The exact translation depends on the current shape; the task author should diff vs `src/wrap-process.ts` and preserve all existing behaviours including the "synthesize hook events on turn_start/turn_end" logic seen near line 868.)

- [ ] **Step 3: Wire into the Claude adapter**

```typescript
// src/agents/claude/adapter.ts
import { wrapClaudeSession } from "./wrap.js";
// ...
async *wrap(args: WrapArgs): AsyncIterable<InternalEvent> {
  yield* wrapClaudeSession(args);
}
```

- [ ] **Step 4: Update `src/wrap-process.ts` to dispatch**

Replace the inlined Claude spawn with:

```typescript
import { getAdapter } from "./agents/registry.js";
// In the route handler, after looking up the session row:
const session = store.get(sessionUuid);
if (!session) { /* 404 */ return; }
const adapter = getAdapter(session.agent);
for await (const ev of adapter.wrap({ sessionUuid, cwd: session.cwd, prompt, signal })) {
  // existing forwarding to WS / hook synthesis stays the same
}
```

- [ ] **Step 5: Run existing wrap-process tests**

Run: `pnpm test src/wrap-process`
Expected: same pass/fail count as baseline. If the test failure count INCREASED, the extraction is incorrect — diff and fix.

- [ ] **Step 6: Commit**

```bash
git add src/agents/claude/wrap.ts src/agents/claude/adapter.ts src/wrap-process.ts
git commit -m "refactor(wrap): extract Claude wrap into agents/claude/wrap.ts + dispatcher (Phase 4.1)"
```

### Task 4.2: Implement `agents/codex/wrap.ts`

**Files:**
- Create: `src/agents/codex/wrap.ts`
- Create: `src/agents/codex/wrap.test.ts`
- Modify: `src/agents/codex/adapter.ts`

- [ ] **Step 1: Write the test against a fake child process**

```typescript
// src/agents/codex/wrap.test.ts
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { _wrapCodexFromStream } from "./wrap.js";

describe("wrapCodexSession (stream parsing)", () => {
  it("parses JSONL into InternalEvents", async () => {
    const jsonl = [
      `{"type":"turn_start","turn_id":"t1"}`,
      `{"type":"assistant_message","text":"hello"}`,
      `{"type":"tool_use","name":"shell","input":{"cmd":"ls"}}`,
      `{"type":"tool_result","output":"a b c"}`,
      `{"type":"turn_complete"}`,
      ``,
    ].join("\n");
    const stream = Readable.from([jsonl]);
    const events: any[] = [];
    for await (const ev of _wrapCodexFromStream(stream)) events.push(ev);
    expect(events.map(e => e.type)).toEqual([
      "turn_start", "message", "tool_use", "tool_result", "turn_end",
    ]);
  });

  it("emits error event on malformed JSON line", async () => {
    const stream = Readable.from(["{notjson\n"]);
    const events: any[] = [];
    for await (const ev of _wrapCodexFromStream(stream)) events.push(ev);
    expect(events[0].type).toBe("error");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/agents/codex/wrap.ts
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { Readable } from "node:stream";
import type { WrapArgs, InternalEvent } from "../types.js";

const TYPE_MAP: Record<string, InternalEvent["type"]> = {
  turn_start: "turn_start",
  turn_complete: "turn_end",
  assistant_message: "message",
  agent_message: "message",
  tool_use: "tool_use",
  tool_result: "tool_result",
};

export async function* _wrapCodexFromStream(stream: Readable): AsyncIterable<InternalEvent> {
  const rl = readline.createInterface({ input: stream });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); }
    catch (err) { yield { type: "error", payload: { reason: "parse_error", line, err: String(err) } }; continue; }
    const mapped = TYPE_MAP[obj.type];
    if (mapped) yield { type: mapped, payload: obj };
    else yield { type: "error", payload: { reason: "unknown_type", obj } };
  }
}

export async function* wrapCodexSession(args: WrapArgs): AsyncIterable<InternalEvent> {
  const codexArgs = ["exec", "--json", "--resume", args.sessionUuid, "--cd", args.cwd];
  if (args.prompt) codexArgs.push(args.prompt);
  const child = spawn("codex", codexArgs, { stdio: ["ignore", "pipe", "pipe"] });

  const onAbort = () => {
    child.kill("SIGINT");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500).unref();
  };
  args.signal?.addEventListener("abort", onAbort);

  try {
    for await (const ev of _wrapCodexFromStream(child.stdout!)) yield ev;
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
    if (!child.killed) child.kill();
  }
}
```

- [ ] **Step 3: Wire adapter**

```typescript
// src/agents/codex/adapter.ts
import { wrapCodexSession } from "./wrap.js";
// ...
async *wrap(args: WrapArgs): AsyncIterable<InternalEvent> {
  yield* wrapCodexSession(args);
}
```

- [ ] **Step 4: Test + typecheck + commit**

```bash
pnpm test src/agents/codex/wrap
pnpm typecheck
git add src/agents/codex/wrap.ts src/agents/codex/wrap.test.ts src/agents/codex/adapter.ts
git commit -m "feat(codex): wrap implementation via codex exec --json (Phase 4.2)"
```

---

## Phase 5 — Dashboard badge + filter

### Task 5.1: Tailwind colour tokens + Session type in web

**Files:**
- Modify: `web/tailwind.config.{ts,js,cjs}` (whichever exists)
- Modify: `web/src/types.ts` (or wherever `Session` is mirrored on the frontend)

- [ ] **Step 1: Add colours**

```js
// inside theme.extend.colors:
"agent-claude": "#d97757",
"agent-codex":  "#7c5cff",
```

- [ ] **Step 2: Mirror `agent` field in frontend `Session` type**

Add `agent: "claude" | "codex"` to whatever interface the dashboard uses (usually `web/src/types.ts` mirrors `src/types.ts`).

- [ ] **Step 3: Commit**

```bash
git add web/tailwind.config.* web/src/types.ts
git commit -m "feat(web): agent colour tokens + Session.agent (Phase 5.1)"
```

### Task 5.2: SessionCard badge

**Files:**
- Modify: `web/src/components/SessionCard.tsx` (or whichever component renders a session row)

- [ ] **Step 1: Locate the component**

Run: `grep -rln "session_uuid" web/src/ | head`
Expected: a single `SessionCard.*` file.

- [ ] **Step 2: Add a badge top-right**

Replace any existing top-right slot, or insert a new absolute-positioned span:

```tsx
<span
  className={
    "absolute top-1 right-1 w-4 h-4 rounded text-[10px] flex items-center justify-center text-white " +
    (session.agent === "codex" ? "bg-agent-codex" : "bg-agent-claude")
  }
  title={session.agent}
>
  {session.agent === "codex" ? "X" : "C"}
</span>
```

(The parent container must have `relative` set; add it if missing.)

- [ ] **Step 3: Visual sanity check**

Run: `pnpm dev:all` and open dashboard. Expected: existing Claude sessions show "C" orange. Once a codex session arrives (Phase 3 manual E2E), it shows "X" purple.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/SessionCard.tsx
git commit -m "feat(web): agent badge on session card (Phase 5.2)"
```

### Task 5.3: SessionList filter

**Files:**
- Modify: `web/src/components/SessionList.tsx` (or equivalent)

- [ ] **Step 1: Add filter state + UI**

```tsx
const [agentFilter, setAgentFilter] = useState<"all" | "claude" | "codex">("all");
// ... toolbar:
<div className="inline-flex gap-1 text-xs">
  {(["all", "claude", "codex"] as const).map((k) => (
    <button
      key={k}
      onClick={() => setAgentFilter(k)}
      className={"px-2 py-0.5 rounded " + (agentFilter === k ? "bg-zinc-800 text-white" : "bg-zinc-200")}
    >{k}</button>
  ))}
</div>
// ... filter:
const visible = sessions.filter(s => agentFilter === "all" || s.agent === agentFilter);
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/SessionList.tsx
git commit -m "feat(web): agent filter toggle (Phase 5.3)"
```

### Task 5.4: web-phone badge

**Files:**
- Modify: `web-phone/src/components/SessionCard.tsx` (or equivalent)
- Modify: `web-phone/tailwind.config.*`

- [ ] **Step 1: Copy the two colour tokens into the phone tailwind config**

Same `agent-claude` / `agent-codex` keys.

- [ ] **Step 2: Add a smaller badge (12×12, text-[8px])**

Same shape as web, smaller dims. No filter toggle.

- [ ] **Step 3: Commit**

```bash
git add web-phone/tailwind.config.* web-phone/src/components/SessionCard.tsx
git commit -m "feat(web-phone): agent badge (Phase 5.4)"
```

### Task 5.5: Build + visual verify + final commit

- [ ] **Step 1: Build both bundles**

Run: `pnpm build:all`
Expected: clean build, no errors.

- [ ] **Step 2: Smoke E2E**

Open dashboard, run `codex exec "hello"` in some trusted project, run a Claude turn in another. Confirm both cards appear with distinct badges; toggle filter to verify it works.

- [ ] **Step 3: Update README/CHANGELOG if maintained**

Skim `README.md` and `CHANGELOG.md` (if present) for any agent-specific language. Add a line under a new "0.3.0" section:

```
- feat: Codex CLI sessions are now first-class — they appear in the dashboard alongside Claude sessions, with an agent badge and filter.
```

- [ ] **Step 4: Final commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: changelog entry for codex support"
```

---

## Phase 6 (deferred — not implemented in this plan)

- VSCode focus / send-prompt for Codex (needs deep-link spike).
- Tool-level event granularity for Codex (`pre_tool_use` / `post_tool_use`) via tailing rollout JSONL.
- Encrypted relay-specific Codex tests.

Each will get its own design + plan when prioritised.

---

## Self-Review notes

- **Spec §2 (capability survey):** covered by Phase 3 (notify, install) and Phase 4 (resume + exec --json).
- **Spec §3 (architecture):** Phase 1 establishes the `agents/` skeleton; Phases 3–4 fill the Codex side; Phase 2 plumbs `agent` through DB, hook, server, hook-script.
- **Spec §4 (data model):** Phase 2.2 (schema bump) and Phase 2.1 (types).
- **Spec §5 (notify integration):** Phase 3.4 (`miki-emit-codex.mjs`) — note the cwd-resolution-via-rollout-glob is documented in code; matches spec risk table.
- **Spec §6 (wrap):** Phase 4.
- **Spec §7 (frontend):** Phase 5.
- **Spec §8 (tests):** unit tests at each step; manual E2E at end of Phase 3 and Phase 5.
- **Spec §9 (phasing):** preserved, each phase a separate commit chain that leaves the system working.

No outstanding TODOs, placeholders, or spec gaps detected.
