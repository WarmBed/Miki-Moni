# cc-hub Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node.js daemon that aggregates state across multiple VSCode Claude Code panel sessions, exposes a localhost dashboard for cross-window awareness, and uses the `vscode://anthropic.claude-code/open` URI handler for one-click focus and prompt prefill.

**Architecture:** Single Node.js process (`cc-hub`) listens on `127.0.0.1:8765` for HTTP + WebSocket. PowerShell hook scripts in `~/.claude/settings.json` POST events to it. A static SPA served at `/` connects via WebSocket for live updates. SQLite persists session state across daemon restarts.

**Tech Stack:** Node.js 20+, TypeScript strict, express, ws, better-sqlite3, preact + tailwind, vitest, pino, node-notifier, vite, tsx.

**Spec reference:** [d:/code/cc-hub/docs/superpowers/specs/2026-05-15-cc-hub-phase1-design.md](../specs/2026-05-15-cc-hub-phase1-design.md)

**Deviation from spec:** Spec section "元件" lists `notifier.ts` as wrapping `PushNotification` tool. After analysis, `PushNotification` is only invokable from inside an active Claude Code session, not from an external Node daemon. Phase 1 uses `node-notifier` (OS-native toast notifications) instead. Phone push is deferred to Phase 2.

---

## File Structure (lock-in)

```
d:/code/cc-hub/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── vite.config.ts             (web UI build only)
├── .gitignore
├── .editorconfig
├── README.md
├── docs/superpowers/
│   ├── specs/2026-05-15-cc-hub-phase1-design.md
│   ├── plans/2026-05-15-cc-hub-phase1.md   (this file)
│   └── spikes/2026-05-15-hook-discovery.md  (created in Task 3)
├── src/
│   ├── types.ts                (shared types: Session, HookEvent, ...)
│   ├── session-store.ts        (SQLite-backed, EventEmitter)
│   ├── session-resolver.ts     (cwd → sessionUuid via log files)
│   ├── hook-handler.ts         (HookEvent → store mutation)
│   ├── vscode-bridge.ts        (vscode:// URI launcher)
│   ├── notifier.ts             (node-notifier wrapper)
│   ├── server.ts               (express + ws routes)
│   ├── install-hooks.ts        (CLI: adds entries to ~/.claude/settings.json)
│   └── index.ts                (entry point: wires everything, calls server.start)
├── tests/
│   ├── fixtures/
│   │   ├── projects/           (sample ~/.claude/projects dir layout)
│   │   └── hook-payloads/      (captured during Task 3 spike)
│   ├── session-store.test.ts
│   ├── session-resolver.test.ts
│   ├── hook-handler.test.ts
│   ├── vscode-bridge.test.ts
│   ├── notifier.test.ts
│   └── integration.test.ts     (daemon up → POST events → assert state + WS)
├── web/
│   ├── index.html
│   ├── app.tsx
│   ├── style.css               (tailwind directives)
│   └── tailwind.config.js
└── hooks/
    └── cc-hub-emit.ps1
```

Each `src/*.ts` has one responsibility and can be unit-tested in isolation. The web UI compiles to `dist/web/` which `server.ts` serves as static files.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `d:/code/cc-hub/package.json`
- Create: `d:/code/cc-hub/tsconfig.json`
- Create: `d:/code/cc-hub/vitest.config.ts`
- Create: `d:/code/cc-hub/.gitignore`
- Create: `d:/code/cc-hub/.editorconfig`
- Create: `d:/code/cc-hub/README.md`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "cc-hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build:web": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "install:hooks": "tsx src/install-hooks.ts"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^4.21.0",
    "node-notifier": "^10.0.1",
    "pino": "^9.4.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^5.0.0",
    "@types/node": "^20.16.0",
    "@types/node-notifier": "^8.0.5",
    "@types/ws": "^8.5.12",
    "preact": "^10.24.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "tailwindcss": "^3.4.13",
    "tsx": "^4.19.1",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.1"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "jsxImportSource": "preact"
  },
  "include": ["src/**/*", "tests/**/*", "web/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.log
~/
.cc-hub/
```

- [ ] **Step 5: Create .editorconfig**

```
root = true

[*]
end_of_line = lf
insert_final_newline = true
charset = utf-8
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 6: Create minimal README.md**

```markdown
# cc-hub

Local dashboard that aggregates state across multiple VSCode Claude Code panel sessions.

See `docs/superpowers/specs/` for design, `docs/superpowers/plans/` for the implementation plan.

## Quick start

```powershell
pnpm install
pnpm install:hooks
pnpm start
start http://localhost:8765
```
```

- [ ] **Step 7: Install dependencies**

Run: `pnpm install` (in `d:/code/cc-hub`)
Expected: All packages install, `node_modules/` created. If `better-sqlite3` fails to compile, install Visual Studio Build Tools + Python 3 and retry.

- [ ] **Step 8: Verify typecheck baseline**

Run: `pnpm typecheck`
Expected: Exit 0 (no source files yet, so nothing to typecheck — empty success).

- [ ] **Step 9: Commit**

```bash
cd d:/code/cc-hub
git add package.json tsconfig.json vitest.config.ts .gitignore .editorconfig README.md
git commit -m "chore: scaffold cc-hub project (package.json, tsconfig, vitest, gitignore)"
```

---

## Task 2: Shared Types

**Files:**
- Create: `d:/code/cc-hub/src/types.ts`

These types are imported by every other module. Define them once, here.

- [ ] **Step 1: Create src/types.ts with the full type surface**

```ts
export type SessionStatus = "active" | "waiting" | "idle" | "stale";

export interface Session {
  cwd: string;                  // primary key, e.g. "d:\\code\\dragonfly"
  session_uuid: string | null;
  project_name: string;
  status: SessionStatus;
  last_event_at: number;        // unix ms
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
  event_type: HookEventType;
  cwd: string;
  session_uuid: string | null;
  timestamp: number;
  extra?: Record<string, unknown>;
}

export interface StoreEvents {
  session_changed: (session: Session) => void;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: Exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add Session, HookEvent, StoreEvents types"
```

---

## Task 3: Hook Discovery Spike

**Goal:** Empirically resolve the 5 open questions from the spec by running a temporary instrumented hook against a real Claude Code panel session. Document findings before writing code that depends on them.

**Files:**
- Create: `d:/code/cc-hub/docs/superpowers/spikes/2026-05-15-hook-discovery.md`
- Create temporary: `d:/code/cc-hub/spike/probe.ps1` (delete after task)
- Create: `d:/code/cc-hub/tests/fixtures/hook-payloads/*.json` (captured payloads)
- Create: `d:/code/cc-hub/tests/fixtures/projects/` (snapshot of relevant `~/.claude/projects/` layout)

- [ ] **Step 1: Write the probe script**

Create `d:/code/cc-hub/spike/probe.ps1`:

```powershell
$ErrorActionPreference = "Continue"
$stdin = [Console]::In.ReadToEnd()
$logPath = "d:\code\cc-hub\spike\captured.jsonl"

$record = @{
  ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  argv = $args
  env_subset = @{
    CLAUDE_SESSION_ID = $env:CLAUDE_SESSION_ID
    CLAUDE_PROJECT_DIR = $env:CLAUDE_PROJECT_DIR
    CLAUDE_TOOL_NAME = $env:CLAUDE_TOOL_NAME
    PWD = $PWD.Path
  }
  stdin_raw = $stdin
}

$json = $record | ConvertTo-Json -Depth 10 -Compress
Add-Content -Path $logPath -Value $json -Encoding utf8
```

- [ ] **Step 2: Register the probe in ~/.claude/settings.json temporarily**

Add (or merge) this `hooks` block to `C:/Users/mike2/.claude/settings.json`. Back up the file first.

```bash
cp C:/Users/mike2/.claude/settings.json C:/Users/mike2/.claude/settings.json.bak
```

Add:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -File d:/code/cc-hub/spike/probe.ps1 SessionStart" }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -File d:/code/cc-hub/spike/probe.ps1 Stop" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "powershell -NoProfile -File d:/code/cc-hub/spike/probe.ps1 UserPromptSubmit" }] }],
    "PreToolUse":    [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "powershell -NoProfile -File d:/code/cc-hub/spike/probe.ps1 PreToolUse" }] }],
    "PostToolUse":   [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "powershell -NoProfile -File d:/code/cc-hub/spike/probe.ps1 PostToolUse" }] }]
  }
}
```

(If a `hooks` block already exists, merge — don't overwrite.)

- [ ] **Step 3: Run a real Claude session and trigger each event**

1. Open VSCode in some workspace (e.g. `d:/code/cc-hub`)
2. Open Claude Code panel
3. Send a prompt that triggers a tool (e.g. "list files in this folder")
4. Wait for Claude to finish (triggers Stop)
5. Close the panel/session

- [ ] **Step 4: Inspect captured.jsonl and document findings**

Read `d:/code/cc-hub/spike/captured.jsonl` and answer each open question. Create `docs/superpowers/spikes/2026-05-15-hook-discovery.md`:

```markdown
# Spike: Hook Discovery (2026-05-15)

## OQ1: Does the hook process get CLAUDE_SESSION_ID env var?
**Answer:** YES / NO / PARTIAL (one of)
**Evidence:** [paste env_subset line from captured.jsonl]

## OQ2: What is the Stop hook stdin payload schema?
**Answer:** [paste a real stdin_raw, formatted]
**Field map:**
- `session_id` → ...
- `cwd` → ...
- (etc.)

## OQ3: Does `vscode://anthropic.claude-code/open?session=<uuid>` raise the correct window on Windows?
**Test:** Open 2 VSCode windows in different folders. From PowerShell:
  `Start-Process "vscode://anthropic.claude-code/open?session=<real-uuid>"`
**Answer:** YES / NO / PARTIAL — describe exactly what happens (which window? does it create new tab?)

## OQ4: How does cc-hub daemon send a notification?
**Decision:** Use `node-notifier` (deviation from spec — PushNotification is internal-only).
**Verification:** `node -e "import('node-notifier').then(n => n.default.notify('hello'))"` shows a Windows toast.

## OQ5: Multi-VSCode-windows same workspace — which one does URI handler hit?
**Test:** Open 2 VSCode windows in d:/code/cc-hub. Trigger URI handler.
**Answer:** [observed behavior]

## Confirmed payload schemas (saved as fixtures)
- SessionStart → tests/fixtures/hook-payloads/session_start.json
- Stop → tests/fixtures/hook-payloads/stop.json
- UserPromptSubmit → tests/fixtures/hook-payloads/user_prompt_submit.json
- PreToolUse → tests/fixtures/hook-payloads/pre_tool_use.json
- PostToolUse → tests/fixtures/hook-payloads/post_tool_use.json
```

- [ ] **Step 5: Copy real payloads into fixtures**

Pick one representative `stdin_raw` for each event type from `captured.jsonl` and save them as pretty-printed JSON files under `tests/fixtures/hook-payloads/`. These are the source of truth for Task 6's parsing tests.

- [ ] **Step 6: Capture sample log file structure**

Copy a slice of `C:/Users/mike2/.claude/projects/d--code-cc-hub/` (or whichever path the spike ran in) into `tests/fixtures/projects/d--code-cc-hub/`. Keep 1-2 real `*.jsonl` files (these are big — trim each to first 50 lines if oversized) to use as fixtures for `session-resolver` tests.

- [ ] **Step 7: Remove the probe hooks from settings.json**

Restore the backup: `cp C:/Users/mike2/.claude/settings.json.bak C:/Users/mike2/.claude/settings.json` (or manually delete the hook entries added in step 2).

- [ ] **Step 8: Delete spike/ directory (no longer needed; findings are in docs)**

```powershell
Remove-Item -Recurse -Force d:/code/cc-hub/spike
```

- [ ] **Step 9: Commit findings + fixtures**

```bash
git add docs/superpowers/spikes/2026-05-15-hook-discovery.md tests/fixtures/
git commit -m "docs(spike): hook discovery findings + payload fixtures"
```

> ⚠️ **Branch point:** If OQ3 (URI handler raises correct window) answered NO, the spec's Scenario A step 6 needs revisiting before continuing. Stop and report back. If OQ1 (CLAUDE_SESSION_ID) answered NO, the hook-handler must always go through session-resolver — note this in the spike doc and proceed.

---

## Task 4: SessionStore

**Files:**
- Create: `d:/code/cc-hub/src/session-store.ts`
- Test: `d:/code/cc-hub/tests/session-store.test.ts`

Pure data layer. Wraps better-sqlite3, emits `session_changed` events. No HTTP, no hooks, no IO besides the DB.

- [ ] **Step 1: Write failing tests**

Create `tests/session-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../src/session-store.js";
import type { Session } from "../src/types.js";

const sample: Session = {
  cwd: "d:\\code\\dragonfly",
  session_uuid: null,
  project_name: "dragonfly",
  status: "active",
  last_event_at: 1715760000000,
  last_message_preview: "",
  tokens_in: 0,
  tokens_out: 0,
  vscode_pid: null,
};

describe("SessionStore", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(":memory:"); });

  it("upserts a session by cwd", () => {
    store.upsert(sample);
    expect(store.get(sample.cwd)).toEqual(sample);
  });

  it("overwrites existing session on second upsert with same cwd", () => {
    store.upsert(sample);
    store.upsert({ ...sample, status: "waiting", last_event_at: 1715760001000 });
    expect(store.get(sample.cwd)?.status).toBe("waiting");
  });

  it("lists all sessions", () => {
    store.upsert(sample);
    store.upsert({ ...sample, cwd: "d:\\code\\openruterati", project_name: "openruterati" });
    expect(store.list()).toHaveLength(2);
  });

  it("emits session_changed on upsert", () => {
    const seen: Session[] = [];
    store.on("session_changed", (s) => seen.push(s));
    store.upsert(sample);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe(sample.cwd);
  });

  it("returns undefined for unknown cwd", () => {
    expect(store.get("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test session-store`
Expected: FAIL — "Cannot find module '../src/session-store.js'"

- [ ] **Step 3: Implement SessionStore**

Create `src/session-store.ts`:

```ts
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import type { Session, StoreEvents } from "./types.js";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  cwd TEXT PRIMARY KEY,
  session_uuid TEXT,
  project_name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_event_at INTEGER NOT NULL,
  last_message_preview TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  vscode_pid INTEGER
);
`;

const UPSERT_SQL = `
INSERT INTO sessions (cwd, session_uuid, project_name, status, last_event_at,
                     last_message_preview, tokens_in, tokens_out, vscode_pid)
VALUES (@cwd, @session_uuid, @project_name, @status, @last_event_at,
        @last_message_preview, @tokens_in, @tokens_out, @vscode_pid)
ON CONFLICT(cwd) DO UPDATE SET
  session_uuid = excluded.session_uuid,
  project_name = excluded.project_name,
  status = excluded.status,
  last_event_at = excluded.last_event_at,
  last_message_preview = excluded.last_message_preview,
  tokens_in = excluded.tokens_in,
  tokens_out = excluded.tokens_out,
  vscode_pid = excluded.vscode_pid;
`;

export interface SessionStore extends EventEmitter {
  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this;
  emit<K extends keyof StoreEvents>(event: K, ...args: Parameters<StoreEvents[K]>): boolean;
}

export class SessionStore extends EventEmitter {
  private db: Database.Database;

  constructor(path: string) {
    super();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_SQL);
  }

  upsert(session: Session): void {
    this.db.prepare(UPSERT_SQL).run(session);
    this.emit("session_changed", session);
  }

  get(cwd: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE cwd = ?").get(cwd) as Session | undefined;
    return row;
  }

  list(): Session[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY last_event_at DESC").all() as Session[];
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test session-store`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/session-store.ts tests/session-store.test.ts
git commit -m "feat(store): SQLite-backed SessionStore with upsert/get/list + change events"
```

---

## Task 5: SessionResolver

**Files:**
- Create: `d:/code/cc-hub/src/session-resolver.ts`
- Test: `d:/code/cc-hub/tests/session-resolver.test.ts`

Given a cwd, find the most recent active session UUID by scanning `~/.claude/projects/<encoded-cwd>/*.jsonl`. Encoding rule (per Claude Code convention): replace each `/`, `\`, `:` with `-`. Use fixtures captured in Task 3.

- [ ] **Step 1: Write failing tests**

Create `tests/session-resolver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { SessionResolver, encodeCwd } from "../src/session-resolver.js";

const FIXTURES_ROOT = path.join(__dirname, "fixtures", "projects");

describe("encodeCwd", () => {
  it("replaces slashes and colons with dashes", () => {
    expect(encodeCwd("d:\\code\\dragonfly")).toBe("d--code-dragonfly");
    expect(encodeCwd("/home/user/proj")).toBe("-home-user-proj");
  });
});

describe("SessionResolver", () => {
  it("returns the most recently modified session UUID for a cwd", async () => {
    const r = new SessionResolver(FIXTURES_ROOT);
    // Assumes fixture dir contains at least one .jsonl named like <uuid>.jsonl
    const uuid = await r.resolveLatest("d:\\code\\cc-hub");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("returns null when no project directory exists for cwd", async () => {
    const r = new SessionResolver(FIXTURES_ROOT);
    expect(await r.resolveLatest("d:\\code\\nonexistent")).toBeNull();
  });

  it("returns null when project directory is empty", async () => {
    // Use a fixture dir with no .jsonl files; create one in fixtures if needed.
    const r = new SessionResolver(FIXTURES_ROOT);
    expect(await r.resolveLatest("d:\\code\\empty-project")).toBeNull();
  });
});
```

If your fixture directory layout doesn't have `d--code-cc-hub` and `d--code-empty-project`, create them under `tests/fixtures/projects/` to match. For `d--code-empty-project/`, just create an empty directory (commit a `.gitkeep`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test session-resolver`
Expected: FAIL — "Cannot find module '../src/session-resolver.js'"

- [ ] **Step 3: Implement SessionResolver**

Create `src/session-resolver.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\/\\:]/g, "-");
}

export class SessionResolver {
  constructor(private projectsRoot: string) {}

  async resolveLatest(cwd: string): Promise<string | null> {
    const dir = path.join(this.projectsRoot, encodeCwd(cwd));
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return null;

    const withMtime = await Promise.all(
      jsonlFiles.map(async (f) => ({
        file: f,
        mtime: (await fs.stat(path.join(dir, f))).mtimeMs,
      }))
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const latest = withMtime[0]!.file;
    return latest.replace(/\.jsonl$/, "");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test session-resolver`
Expected: 4 passed (1 for encodeCwd, 3 for SessionResolver).

- [ ] **Step 5: Commit**

```bash
git add src/session-resolver.ts tests/session-resolver.test.ts tests/fixtures/projects/
git commit -m "feat(resolver): cwd→sessionUuid via ~/.claude/projects/<encoded>/*.jsonl"
```

---

## Task 6: HookHandler

**Files:**
- Create: `d:/code/cc-hub/src/hook-handler.ts`
- Test: `d:/code/cc-hub/tests/hook-handler.test.ts`

Pure function-ish class: takes a `HookEvent`, derives the new `Session` state, calls `store.upsert`. If `session_uuid` is null in the event, fire-and-forget `resolver.resolveLatest(cwd)` in the background to backfill it.

- [ ] **Step 1: Write failing tests**

Create `tests/hook-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import type { HookEvent } from "../src/types.js";

class StubResolver {
  resolveLatest = vi.fn(async (_cwd: string) => "stub-uuid-1234");
}

describe("HookHandler", () => {
  let store: SessionStore;
  let resolver: StubResolver;
  let handler: HookHandler;

  beforeEach(() => {
    store = new SessionStore(":memory:");
    resolver = new StubResolver();
    handler = new HookHandler(store, resolver as any);
  });

  it("session_start → status=active, project_name from path basename", async () => {
    const ev: HookEvent = {
      event_type: "session_start",
      cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123",
      timestamp: 1715760000000,
    };
    await handler.handle(ev);
    const s = store.get("d:\\code\\dragonfly");
    expect(s?.status).toBe("active");
    expect(s?.project_name).toBe("dragonfly");
    expect(s?.session_uuid).toBe("abc-123");
  });

  it("stop → status=waiting", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123", timestamp: 1000,
    });
    await handler.handle({
      event_type: "stop", cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123", timestamp: 2000,
    });
    expect(store.get("d:\\code\\dragonfly")?.status).toBe("waiting");
  });

  it("user_prompt → status=active (user came back)", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 1,
    });
    await handler.handle({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 2,
    });
    await handler.handle({
      event_type: "user_prompt", cwd: "x", session_uuid: "u1", timestamp: 3,
    });
    expect(store.get("x")?.status).toBe("active");
  });

  it("backfills session_uuid via resolver when event omits it", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x",
      session_uuid: null, timestamp: 1,
    });
    // resolver is async fire-and-forget; await microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(resolver.resolveLatest).toHaveBeenCalledWith("x");
    expect(store.get("x")?.session_uuid).toBe("stub-uuid-1234");
  });

  it("last-write-wins by timestamp (older event ignored)", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 100,
    });
    await handler.handle({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 50,  // older
    });
    expect(store.get("x")?.status).toBe("active");
  });

  it("project_name uses basename of cwd (handles Windows backslash)", async () => {
    await handler.handle({
      event_type: "session_start",
      cwd: "C:\\Users\\mike\\proj-x",
      session_uuid: "u1", timestamp: 1,
    });
    expect(store.get("C:\\Users\\mike\\proj-x")?.project_name).toBe("proj-x");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test hook-handler`
Expected: FAIL — "Cannot find module '../src/hook-handler.js'"

- [ ] **Step 3: Implement HookHandler**

Create `src/hook-handler.ts`:

```ts
import path from "node:path";
import type { HookEvent, Session, SessionStatus } from "./types.js";
import type { SessionStore } from "./session-store.js";
import type { SessionResolver } from "./session-resolver.js";

const STATUS_BY_EVENT: Record<HookEvent["event_type"], SessionStatus> = {
  session_start: "active",
  user_prompt: "active",
  pre_tool_use: "active",
  post_tool_use: "active",
  stop: "waiting",
};

function basename(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  return path.posix.basename(normalized);
}

export class HookHandler {
  constructor(private store: SessionStore, private resolver: SessionResolver) {}

  async handle(ev: HookEvent): Promise<void> {
    const existing = this.store.get(ev.cwd);
    if (existing && existing.last_event_at > ev.timestamp) return;  // last-write-wins

    const next: Session = {
      cwd: ev.cwd,
      session_uuid: ev.session_uuid ?? existing?.session_uuid ?? null,
      project_name: basename(ev.cwd),
      status: STATUS_BY_EVENT[ev.event_type],
      last_event_at: ev.timestamp,
      last_message_preview: existing?.last_message_preview ?? "",
      tokens_in: existing?.tokens_in ?? 0,
      tokens_out: existing?.tokens_out ?? 0,
      vscode_pid: existing?.vscode_pid ?? null,
    };
    this.store.upsert(next);

    if (!next.session_uuid) {
      // Fire-and-forget backfill
      void this.backfillUuid(ev.cwd);
    }
  }

  private async backfillUuid(cwd: string): Promise<void> {
    const uuid = await this.resolver.resolveLatest(cwd);
    if (!uuid) return;
    const current = this.store.get(cwd);
    if (!current || current.session_uuid) return;
    this.store.upsert({ ...current, session_uuid: uuid });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test hook-handler`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/hook-handler.ts tests/hook-handler.test.ts
git commit -m "feat(hook-handler): map HookEvent → Session state with uuid backfill"
```

---

## Task 7: VscodeBridge

**Files:**
- Create: `d:/code/cc-hub/src/vscode-bridge.ts`
- Test: `d:/code/cc-hub/tests/vscode-bridge.test.ts`

Wraps the `vscode://anthropic.claude-code/open` URI handler call. On Windows, uses `PowerShell Start-Process` (which won't block and which correctly raises the URL-handling app). Inject a `launch` function for testing.

- [ ] **Step 1: Write failing tests**

Create `tests/vscode-bridge.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { VscodeBridge } from "../src/vscode-bridge.js";

describe("VscodeBridge", () => {
  it("focuses by sessionUuid only — no prompt encoded", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.focus("uuid-1234");
    expect(launch).toHaveBeenCalledWith("vscode://anthropic.claude-code/open?session=uuid-1234");
  });

  it("falls back to plain open when sessionUuid is null", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.focus(null);
    expect(launch).toHaveBeenCalledWith("vscode://anthropic.claude-code/open");
  });

  it("send encodes the prompt", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.send("uuid-1234", "跑 npm test");
    const expectedPrompt = encodeURIComponent("跑 npm test");
    expect(launch).toHaveBeenCalledWith(
      `vscode://anthropic.claude-code/open?session=uuid-1234&prompt=${expectedPrompt}`
    );
  });

  it("send works without sessionUuid (no session param)", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.send(null, "hello");
    expect(launch).toHaveBeenCalledWith(
      `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent("hello")}`
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test vscode-bridge`
Expected: FAIL — "Cannot find module '../src/vscode-bridge.js'"

- [ ] **Step 3: Implement VscodeBridge**

Create `src/vscode-bridge.ts`:

```ts
import { spawn } from "node:child_process";

export type LaunchFn = (url: string) => Promise<void>;

export const defaultLaunch: LaunchFn = (url) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process -FilePath '${url.replace(/'/g, "''")}'`],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.on("error", reject);
  });

export class VscodeBridge {
  constructor(private launch: LaunchFn = defaultLaunch) {}

  async focus(sessionUuid: string | null): Promise<void> {
    const base = "vscode://anthropic.claude-code/open";
    const url = sessionUuid ? `${base}?session=${sessionUuid}` : base;
    await this.launch(url);
  }

  async send(sessionUuid: string | null, prompt: string): Promise<void> {
    const params = new URLSearchParams();
    if (sessionUuid) params.set("session", sessionUuid);
    params.set("prompt", prompt);
    const url = `vscode://anthropic.claude-code/open?${params.toString()}`;
    await this.launch(url);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test vscode-bridge`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/vscode-bridge.ts tests/vscode-bridge.test.ts
git commit -m "feat(bridge): vscode:// URI launcher with focus/send + injectable launch fn"
```

---

## Task 8: Notifier

**Files:**
- Create: `d:/code/cc-hub/src/notifier.ts`
- Test: `d:/code/cc-hub/tests/notifier.test.ts`

Thin wrapper around `node-notifier`. Injectable for testing.

- [ ] **Step 1: Write failing tests**

Create `tests/notifier.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Notifier } from "../src/notifier.js";

describe("Notifier", () => {
  it("calls the underlying notify with composed title", async () => {
    const sendImpl = vi.fn();
    const n = new Notifier(sendImpl);
    await n.notify({ project: "dragonfly", message: "Claude is waiting" });
    expect(sendImpl).toHaveBeenCalledWith({
      title: "cc-hub · dragonfly",
      message: "Claude is waiting",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test notifier`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Notifier**

Create `src/notifier.ts`:

```ts
import notifier from "node-notifier";

export interface NotifyArgs {
  project: string;
  message: string;
}

export type SendFn = (opts: { title: string; message: string }) => void;

export const defaultSend: SendFn = (opts) => notifier.notify(opts);

export class Notifier {
  constructor(private send: SendFn = defaultSend) {}

  async notify(args: NotifyArgs): Promise<void> {
    this.send({
      title: `cc-hub · ${args.project}`,
      message: args.message,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test notifier`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/notifier.ts tests/notifier.test.ts
git commit -m "feat(notifier): node-notifier wrapper with composable send fn"
```

---

## Task 9: Server Skeleton + POST /event

**Files:**
- Create: `d:/code/cc-hub/src/server.ts`
- Test: `d:/code/cc-hub/tests/integration.test.ts` (start it now, grow it across later tasks)

Express server. POST /event accepts a JSON `HookEvent`, hands to `HookHandler`, returns 204.

- [ ] **Step 1: Write failing integration test**

Create `tests/integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import path from "node:path";

const fixturesRoot = path.join(__dirname, "fixtures", "projects");

describe("server POST /event", () => {
  let store: SessionStore;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({ store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none" }));
  });
  afterEach(() => store.close());

  it("ingests a session_start event", async () => {
    const res = await request(app).post("/event").send({
      event_type: "session_start",
      cwd: "d:\\code\\dragonfly",
      session_uuid: "u-1",
      timestamp: Date.now(),
    });
    expect(res.status).toBe(204);
    expect(store.get("d:\\code\\dragonfly")?.status).toBe("active");
  });

  it("rejects malformed payload with 400", async () => {
    const res = await request(app).post("/event").send({ garbage: true });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test integration`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement server.ts (only POST /event + factory for now)**

Create `src/server.ts`:

```ts
import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
import type { SessionStore } from "./session-store.js";
import type { HookHandler } from "./hook-handler.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Notifier } from "./notifier.js";
import type { HookEvent } from "./types.js";

export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
}

function parseHookEvent(body: unknown): HookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.event_type !== "string") return null;
  if (typeof b.cwd !== "string") return null;
  if (typeof b.timestamp !== "number") return null;
  const validTypes = ["session_start", "stop", "user_prompt", "pre_tool_use", "post_tool_use"];
  if (!validTypes.includes(b.event_type)) return null;
  return {
    event_type: b.event_type as HookEvent["event_type"],
    cwd: b.cwd,
    session_uuid: typeof b.session_uuid === "string" ? b.session_uuid : null,
    timestamp: b.timestamp,
    extra: (b.extra as Record<string, unknown>) ?? undefined,
  };
}

export function createApp(deps: ServerDeps): { app: Express; server: http.Server } {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/event", async (req: Request, res: Response) => {
    const ev = parseHookEvent(req.body);
    if (!ev) { res.status(400).json({ error: "invalid hook event" }); return; }
    await deps.handler.handle(ev);
    res.status(204).end();
  });

  const server = http.createServer(app);
  return { app, server };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test integration`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/integration.test.ts
git commit -m "feat(server): express skeleton with POST /event + integration test harness"
```

---

## Task 10: GET /sessions

**Files:**
- Modify: `d:/code/cc-hub/src/server.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/integration.test.ts`:

```ts
describe("server GET /sessions", () => {
  let store: SessionStore;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({ store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none" }));
  });
  afterEach(() => store.close());

  it("returns empty array initially", async () => {
    const res = await request(app).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns all sessions after events", async () => {
    await request(app).post("/event").send({
      event_type: "session_start", cwd: "d:\\code\\a", session_uuid: "u1", timestamp: 1,
    });
    await request(app).post("/event").send({
      event_type: "session_start", cwd: "d:\\code\\b", session_uuid: "u2", timestamp: 2,
    });
    const res = await request(app).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test integration`
Expected: FAIL — 404 from GET /sessions.

- [ ] **Step 3: Add the route in src/server.ts**

Inside `createApp`, before `const server = ...`:

```ts
  app.get("/sessions", (_req, res) => {
    res.json(deps.store.list());
  });

  app.get("/sessions/:cwd", (req, res) => {
    const session = deps.store.get(decodeURIComponent(req.params.cwd!));
    if (!session) { res.status(404).end(); return; }
    res.json(session);
  });
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test integration`
Expected: 4 passed (2 from Task 9 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/integration.test.ts
git commit -m "feat(server): GET /sessions and GET /sessions/:cwd"
```

---

## Task 11: WebSocket Broadcast

**Files:**
- Modify: `d:/code/cc-hub/src/server.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

Subscribe to `store.on("session_changed", ...)` and broadcast JSON `{type:"session_changed", session}` to all `/ws` clients.

- [ ] **Step 1: Add failing test**

Append to `tests/integration.test.ts`:

```ts
import WebSocket from "ws";

describe("server WS /ws", () => {
  it("broadcasts session_changed to connected clients", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app, server } = createApp({ store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: any[] = [];
    ws.on("message", (m) => received.push(JSON.parse(m.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));

    await request(app).post("/event").send({
      event_type: "session_start", cwd: "d:\\code\\x", session_uuid: "u", timestamp: 1,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received.some((m) => m.type === "session_changed" && m.session?.cwd === "d:\\code\\x")).toBe(true);

    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test integration`
Expected: WebSocket connection fails (no /ws handler yet).

- [ ] **Step 3: Wire WebSocket in src/server.ts**

Add imports at top:

```ts
import { WebSocketServer } from "ws";
```

Modify the `createApp` return to install the WS server and subscribe:

```ts
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  deps.store.on("session_changed", (session) => {
    const msg = JSON.stringify({ type: "session_changed", session });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg);
    }
  });

  return { app, server };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test integration`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/integration.test.ts
git commit -m "feat(server): /ws WebSocket broadcasts session_changed events"
```

---

## Task 12: POST /focus and POST /send

**Files:**
- Modify: `d:/code/cc-hub/src/server.ts`
- Modify: `d:/code/cc-hub/tests/integration.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/integration.test.ts`:

```ts
import { VscodeBridge } from "../src/vscode-bridge.js";

describe("server POST /focus + /send", () => {
  it("focus calls bridge.focus with session_uuid from store", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\x", session_uuid: "uuid-xyz", project_name: "x",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/focus").send({ cwd: "d:\\code\\x" });
    expect(res.status).toBe(204);
    expect(launches).toContain("vscode://anthropic.claude-code/open?session=uuid-xyz");
    store.close();
  });

  it("send calls bridge.send with encoded prompt", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\x", session_uuid: "uuid-xyz", project_name: "x",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/send").send({ cwd: "d:\\code\\x", prompt: "run tests" });
    expect(res.status).toBe(204);
    expect(launches[0]).toMatch(/session=uuid-xyz/);
    expect(launches[0]).toMatch(/prompt=run\+tests|prompt=run%20tests/);
    store.close();
  });

  it("focus returns 404 for unknown cwd", async () => {
    const store = new SessionStore(":memory:");
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/focus").send({ cwd: "d:\\code\\nope" });
    expect(res.status).toBe(404);
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test integration`
Expected: FAIL — 404 from /focus and /send.

- [ ] **Step 3: Add routes in src/server.ts**

Inside `createApp`, add before WS setup:

```ts
  app.post("/focus", async (req, res) => {
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
    if (!cwd) { res.status(400).json({ error: "missing cwd" }); return; }
    const session = deps.store.get(cwd);
    if (!session) { res.status(404).end(); return; }
    await deps.bridge.focus(session.session_uuid);
    res.status(204).end();
  });

  app.post("/send", async (req, res) => {
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : null;
    if (!cwd || !prompt) { res.status(400).json({ error: "missing cwd or prompt" }); return; }
    const session = deps.store.get(cwd);
    if (!session) { res.status(404).end(); return; }
    await deps.bridge.send(session.session_uuid, prompt);
    res.status(204).end();
  });
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test integration`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/integration.test.ts
git commit -m "feat(server): POST /focus and /send delegate to VscodeBridge"
```

---

## Task 13: Wire Notifier into HookHandler

**Files:**
- Modify: `d:/code/cc-hub/src/hook-handler.ts`
- Modify: `d:/code/cc-hub/tests/hook-handler.test.ts`

Fire a notification when a session transitions to `waiting`.

- [ ] **Step 1: Add failing test**

Append to `tests/hook-handler.test.ts`:

```ts
import { Notifier } from "../src/notifier.js";

describe("HookHandler + Notifier", () => {
  it("notifies when session transitions to waiting", async () => {
    const store = new SessionStore(":memory:");
    const resolver = new StubResolver();
    const sends: any[] = [];
    const notifier = new Notifier((opts) => sends.push(opts));
    const handler = new HookHandler(store, resolver as any, notifier);

    await handler.handle({ event_type: "session_start", cwd: "x", session_uuid: "u", timestamp: 1 });
    expect(sends).toHaveLength(0);

    await handler.handle({ event_type: "stop", cwd: "d:\\code\\dragonfly", session_uuid: "u", timestamp: 2 });
    expect(sends).toHaveLength(1);
    expect(sends[0].title).toContain("dragonfly");
  });

  it("does NOT notify if already waiting (no transition)", async () => {
    const store = new SessionStore(":memory:");
    const resolver = new StubResolver();
    const sends: any[] = [];
    const notifier = new Notifier((opts) => sends.push(opts));
    const handler = new HookHandler(store, resolver as any, notifier);

    await handler.handle({ event_type: "stop", cwd: "x", session_uuid: "u", timestamp: 1 });
    await handler.handle({ event_type: "stop", cwd: "x", session_uuid: "u", timestamp: 2 });
    expect(sends).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test hook-handler`
Expected: FAIL — HookHandler ctor doesn't accept notifier.

- [ ] **Step 3: Update HookHandler to accept and use notifier**

Edit `src/hook-handler.ts`. Update constructor:

```ts
import type { Notifier } from "./notifier.js";

export class HookHandler {
  constructor(
    private store: SessionStore,
    private resolver: SessionResolver,
    private notifier?: Notifier,
  ) {}
```

In `handle`, after `this.store.upsert(next)`:

```ts
    const wasWaiting = existing?.status === "waiting";
    const isWaiting = next.status === "waiting";
    if (this.notifier && isWaiting && !wasWaiting) {
      void this.notifier.notify({
        project: next.project_name,
        message: "Claude is waiting for you",
      });
    }
```

- [ ] **Step 4: Run tests**

Run: `pnpm test hook-handler`
Expected: 8 passed (6 old + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/hook-handler.ts tests/hook-handler.test.ts
git commit -m "feat(hook-handler): fire notification on transition to waiting"
```

---

## Task 14: PowerShell Hook Emitter

**Files:**
- Create: `d:/code/cc-hub/hooks/cc-hub-emit.ps1`

Single PowerShell script invoked by all 5 hook types. Reads stdin (hook payload), composes a `HookEvent`, POSTs to daemon. Fails silently on any error so it never blocks Claude.

- [ ] **Step 1: Create the script**

Create `d:/code/cc-hub/hooks/cc-hub-emit.ps1`:

```powershell
# cc-hub hook emitter — invoked by ~/.claude/settings.json hooks
# Usage: cc-hub-emit.ps1 <event_type>
# Reads hook payload from stdin (Claude Code convention).
# Fails silently on any error to never block Claude.

param([Parameter(Mandatory)][string]$EventType)

$ErrorActionPreference = "SilentlyContinue"

try {
  $stdin = [Console]::In.ReadToEnd()
  $payload = $null
  if ($stdin) { $payload = $stdin | ConvertFrom-Json }

  # Resolve port (falls back to 8765 if port file missing)
  $portFile = Join-Path $HOME ".cc-hub\port"
  $port = 8765
  if (Test-Path $portFile) {
    $portFromFile = Get-Content $portFile -ErrorAction SilentlyContinue
    if ($portFromFile -match '^\d+$') { $port = [int]$portFromFile }
  }

  # Map Claude's event_type names to ours (validated in Task 3 spike)
  $typeMap = @{
    "SessionStart" = "session_start"
    "Stop" = "stop"
    "UserPromptSubmit" = "user_prompt"
    "PreToolUse" = "pre_tool_use"
    "PostToolUse" = "post_tool_use"
  }
  $ourType = $typeMap[$EventType]
  if (-not $ourType) { return }

  # Best-effort extraction — exact field names confirmed in spike doc
  $cwd = $payload.cwd
  if (-not $cwd) { $cwd = $env:CLAUDE_PROJECT_DIR }
  if (-not $cwd) { $cwd = (Get-Location).Path }

  $sessionId = $payload.session_id
  if (-not $sessionId) { $sessionId = $env:CLAUDE_SESSION_ID }

  $body = @{
    event_type = $ourType
    cwd = $cwd
    session_uuid = $sessionId
    timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress

  Invoke-RestMethod -Uri "http://127.0.0.1:$port/event" `
    -Method Post -Body $body -ContentType "application/json" `
    -TimeoutSec 2 | Out-Null
} catch {
  # swallow — never block Claude
}

exit 0
```

- [ ] **Step 2: Manual smoke (defer; needs daemon running)**

Skip for now — verified in Task 18 end-to-end.

- [ ] **Step 3: Commit**

```bash
git add hooks/cc-hub-emit.ps1
git commit -m "feat(hooks): cc-hub-emit.ps1 PowerShell hook emitter (fail-silent)"
```

---

## Task 15: install:hooks CLI Command

**Files:**
- Create: `d:/code/cc-hub/src/install-hooks.ts`

Idempotent: reads `~/.claude/settings.json`, merges `hooks` block, writes back. Backup created on first run.

- [ ] **Step 1: Create the script**

Create `src/install-hooks.ts`:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_SCRIPT_ABS = path.resolve("hooks", "cc-hub-emit.ps1");
const MARKER = "cc-hub-emit.ps1";

const TARGETS: Array<{ key: string; matcher?: string }> = [
  { key: "SessionStart" },
  { key: "Stop" },
  { key: "UserPromptSubmit" },
  { key: "PreToolUse", matcher: ".*" },
  { key: "PostToolUse", matcher: ".*" },
];

function commandFor(eventName: string): string {
  return `powershell -NoProfile -File ${HOOK_SCRIPT_ABS} ${eventName}`;
}

async function readSettings(): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeSettings(s: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function ensureHookEntry(
  hooks: Record<string, any[]>,
  key: string,
  matcher: string | undefined,
  command: string,
): void {
  if (!Array.isArray(hooks[key])) hooks[key] = [];
  const groups = hooks[key];

  for (const g of groups) {
    if (Array.isArray(g.hooks)) {
      for (const h of g.hooks) {
        if (typeof h.command === "string" && h.command.includes(MARKER)) return;  // already present
      }
    }
  }

  const newGroup: Record<string, any> = { hooks: [{ type: "command", command }] };
  if (matcher) newGroup.matcher = matcher;
  groups.push(newGroup);
}

async function main(): Promise<void> {
  const settings = await readSettings();

  // Backup once
  const backup = SETTINGS_PATH + ".cc-hub.bak";
  try { await fs.access(backup); }
  catch { try { await fs.copyFile(SETTINGS_PATH, backup); } catch { /* no original yet */ } }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  for (const t of TARGETS) {
    ensureHookEntry(settings.hooks, t.key, t.matcher, commandFor(t.key));
  }

  await writeSettings(settings);
  console.log(`Hooks installed to ${SETTINGS_PATH}`);
  console.log(`Backup at ${backup}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test the installer**

Backup your real settings first:

```powershell
Copy-Item C:/Users/mike2/.claude/settings.json C:/Users/mike2/.claude/settings.json.preinstall
```

Run: `pnpm install:hooks`
Expected: prints "Hooks installed to ..." and the settings.json now has 5 entries containing `cc-hub-emit.ps1`.

Run it a second time: `pnpm install:hooks`
Expected: no duplicate entries (idempotent).

Restore: `Copy-Item C:/Users/mike2/.claude/settings.json.preinstall C:/Users/mike2/.claude/settings.json -Force`

- [ ] **Step 3: Commit**

```bash
git add src/install-hooks.ts
git commit -m "feat(install): install:hooks CLI merges cc-hub entries into ~/.claude/settings.json"
```

---

## Task 16: Daemon Entry Point + Port File

**Files:**
- Create: `d:/code/cc-hub/src/index.ts`

Wires everything together, picks a port, writes `~/.cc-hub/port`, starts listening.

- [ ] **Step 1: Create src/index.ts**

```ts
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import pino from "pino";
import { createApp } from "./server.js";
import { SessionStore } from "./session-store.js";
import { SessionResolver } from "./session-resolver.js";
import { HookHandler } from "./hook-handler.js";
import { VscodeBridge } from "./vscode-bridge.js";
import { Notifier } from "./notifier.js";

const HUB_HOME = path.join(os.homedir(), ".cc-hub");
const PORT_FILE = path.join(HUB_HOME, "port");
const DB_FILE = path.join(HUB_HOME, "state.db");
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_PORT = 8765;

const log = pino({ transport: { target: "pino/file", options: { destination: path.join(HUB_HOME, "cc-hub.log") } } });

async function findFreePort(start: number, maxTries = 10): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    const free = await new Promise<boolean>((resolve) => {
      const net = require("node:net");
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`no free port in [${start}, ${start + maxTries})`);
}

async function main(): Promise<void> {
  await fs.mkdir(HUB_HOME, { recursive: true });

  const port = await findFreePort(DEFAULT_PORT);
  await fs.writeFile(PORT_FILE, String(port));

  const store = new SessionStore(DB_FILE);
  const resolver = new SessionResolver(PROJECTS_ROOT);
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  const webDir = path.resolve("dist/web");

  const { app, server } = createApp({ store, handler, bridge, notifier, webDir });

  // Serve web UI if built
  const express = (await import("express")).default;
  app.use(express.static(webDir, { fallthrough: true }));

  server.listen(port, "127.0.0.1", () => {
    log.info({ port }, "cc-hub listening");
    console.log(`cc-hub listening on http://127.0.0.1:${port}`);
  });

  const shutdown = () => {
    log.info("shutting down");
    server.close(() => { store.close(); process.exit(0); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it starts**

Run: `pnpm start`
Expected: stdout prints `cc-hub listening on http://127.0.0.1:8765`. `~/.cc-hub/port` exists with content `8765`. `~/.cc-hub/state.db` exists. `Ctrl+C` cleanly shuts down.

- [ ] **Step 3: Smoke POST /event to running daemon**

In another terminal:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/event `
  -Method Post -ContentType "application/json" `
  -Body '{"event_type":"session_start","cwd":"d:\\code\\dragonfly","session_uuid":"abc","timestamp":1715760000000}'
```

Then GET sessions:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/sessions
```

Expected: response shows the dragonfly session with `status: "active"`. A desktop toast appears later if you send a `stop` event with the same cwd.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): index.ts entry point with port discovery and graceful shutdown"
```

---

## Task 17: Web UI

**Files:**
- Create: `d:/code/cc-hub/web/index.html`
- Create: `d:/code/cc-hub/web/app.tsx`
- Create: `d:/code/cc-hub/web/style.css`
- Create: `d:/code/cc-hub/web/tailwind.config.js`
- Create: `d:/code/cc-hub/vite.config.ts`

Single-page dashboard. List of session cards. Status color (green=active, yellow=waiting, gray=idle, red=stale). Click card title → POST /focus. Inline textarea + send button → POST /send. Live updates via `/ws`.

- [ ] **Step 1: Create vite.config.ts**

```ts
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  resolve: {
    alias: { react: "preact/compat", "react-dom": "preact/compat" },
  },
});
```

- [ ] **Step 2: Create web/index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>cc-hub</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div id="app"></div>
    <script type="module" src="/app.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create web/style.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Create web/tailwind.config.js**

```js
export default {
  content: ["./index.html", "./app.tsx"],
  theme: { extend: {} },
};
```

- [ ] **Step 5: Create web/app.tsx**

```tsx
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

interface Session {
  cwd: string;
  session_uuid: string | null;
  project_name: string;
  status: "active" | "waiting" | "idle" | "stale";
  last_event_at: number;
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
}

const STATUS_COLOR: Record<Session["status"], string> = {
  active: "bg-emerald-500",
  waiting: "bg-amber-500",
  idle: "bg-slate-500",
  stale: "bg-red-500",
};

function Card({ s, onFocus, onSend }: {
  s: Session;
  onFocus: (cwd: string) => void;
  onSend: (cwd: string, prompt: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div class="rounded-lg border border-slate-800 p-4 bg-slate-900 flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class={`w-3 h-3 rounded-full ${STATUS_COLOR[s.status]}`} />
        <button
          class="text-lg font-semibold text-left hover:underline"
          onClick={() => onFocus(s.cwd)}
        >{s.project_name}</button>
        <span class="text-xs text-slate-500 ml-auto">{s.status}</span>
      </div>
      <div class="text-xs text-slate-500 font-mono">{s.cwd}</div>
      {s.last_message_preview && (
        <div class="text-sm text-slate-300 line-clamp-2">{s.last_message_preview}</div>
      )}
      <div class="flex gap-2 mt-2">
        <textarea
          class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm resize-none"
          rows={2}
          placeholder="Send a prompt to this session..."
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <button
          class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 rounded px-3 text-sm"
          disabled={!draft.trim()}
          onClick={() => { onSend(s.cwd, draft); setDraft(""); }}
        >Send</button>
      </div>
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    fetch("/sessions").then((r) => r.json()).then(setSessions);
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "session_changed") {
        setSessions((prev) => {
          const others = prev.filter((s) => s.cwd !== msg.session.cwd);
          return [msg.session, ...others].sort((a, b) => b.last_event_at - a.last_event_at);
        });
      }
    };
    return () => ws.close();
  }, []);

  const onFocus = (cwd: string) =>
    fetch("/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const onSend = (cwd: string, prompt: string) =>
    fetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, prompt }) });

  return (
    <div class="max-w-4xl mx-auto p-6">
      <h1 class="text-2xl font-bold mb-6">cc-hub</h1>
      {sessions.length === 0 && (
        <div class="text-slate-500 text-center py-10">No sessions yet. Open a Claude Code panel in any VSCode window.</div>
      )}
      <div class="grid gap-4">
        {sessions.map((s) => <Card key={s.cwd} s={s} onFocus={onFocus} onSend={onSend} />)}
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
```

- [ ] **Step 6: Add postcss + tailwind processing**

Tailwind needs a postcss step. Add to `web/`:

`web/postcss.config.js`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

Add devDeps and install:

```powershell
pnpm add -D postcss autoprefixer
```

- [ ] **Step 7: Build the web UI**

Run: `pnpm build:web`
Expected: `dist/web/index.html`, `dist/web/assets/*.js`, `dist/web/assets/*.css` exist.

- [ ] **Step 8: Restart daemon and verify dashboard loads**

```powershell
pnpm start
start http://127.0.0.1:8765
```

Expected: browser shows the dashboard with "No sessions yet". POST a fake event:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/event -Method Post `
  -ContentType "application/json" `
  -Body '{"event_type":"session_start","cwd":"d:\\code\\testproj","session_uuid":"u","timestamp":1715760000000}'
```

The browser should show the new card without refresh (WS push).

- [ ] **Step 9: Commit**

```bash
git add web/ vite.config.ts package.json pnpm-lock.yaml
git commit -m "feat(web): preact + tailwind dashboard with live WS updates and send/focus"
```

---

## Task 18: End-to-End Manual Smoke Test

**Goal:** Run through the spec's "Manual smoke" checklist against the real product. Document results.

**Files:**
- Create: `d:/code/cc-hub/docs/superpowers/smoke-test-2026-05-15.md`

- [ ] **Step 1: Start the daemon**

```powershell
cd d:/code/cc-hub
pnpm build:web
pnpm start
```

Leave running. Open `http://127.0.0.1:8765` in browser.

- [ ] **Step 2: Install hooks (real this time)**

```powershell
pnpm install:hooks
```

- [ ] **Step 3: Open two VSCode windows in different folders**

E.g. `d:/code/dragonfly` and `d:/code/openruterati`. Open Claude Code panel in each.

- [ ] **Step 4: Run through checklist (record results in smoke-test-2026-05-15.md)**

```markdown
# cc-hub Smoke Test — 2026-05-15

## Setup
- daemon: pnpm start ✓
- web UI: http://127.0.0.1:8765 ✓
- two VSCode windows: dragonfly + openruterati ✓

## Checklist

### 1. Dashboard auto-populates on SessionStart
- [ ] Open Claude panel in dragonfly → card appears within 2s
- [ ] Open Claude panel in openruterati → second card appears
- [ ] Both cards show green (active) status

### 2. Status flips to waiting on Stop
- [ ] Send a quick prompt in dragonfly, wait for Claude to finish
- [ ] Card flips amber
- [ ] Desktop notification appears with "dragonfly · Claude is waiting for you"

### 3. Cross-window focus works
- [ ] In browser, click the dragonfly card title
- [ ] dragonfly VSCode window comes to front

### 4. Prompt prefill works
- [ ] In dragonfly card on dashboard, type "list files" → click Send
- [ ] dragonfly VSCode window comes to front
- [ ] Claude panel prompt box now contains "list files" (not auto-submitted)

### 5. Restart daemon retains state
- [ ] Ctrl+C the daemon
- [ ] pnpm start again
- [ ] Open browser → cards still present (loaded from SQLite)

## Issues found
(record any defects here)

## Result
PASS / FAIL — overall
```

- [ ] **Step 5: Uninstall hooks if smoke test fails**

If anything in steps 1-4 fails badly, revert hooks:

```powershell
Copy-Item C:/Users/mike2/.claude/settings.json.cc-hub.bak C:/Users/mike2/.claude/settings.json -Force
```

- [ ] **Step 6: Commit the smoke test report**

```bash
git add docs/superpowers/smoke-test-2026-05-15.md
git commit -m "docs: smoke-test results for Phase 1 (pass/fail with notes)"
```

- [ ] **Step 7: Verification gate**

If smoke test passes all 5 checks → Phase 1 done. Tag the commit:

```bash
git tag v0.1.0-phase1
```

If anything failed → file the issue back in the spec's Open Questions section, and open a follow-up task before declaring Phase 1 done.

---

## Self-Review Summary

Spec coverage verified — every spec section maps to one or more tasks above:

| Spec section | Implementing task(s) |
|---|---|
| 一句話定義, 解決什麼 | Architecture covered across Tasks 9, 16, 17 |
| 已知約束 | Task 3 spike validates each constraint empirically |
| 架構 | Tasks 9, 11, 16 (server + WS), Task 17 (web UI) |
| 元件 (8 files) | Tasks 4–17 each create exactly one component file |
| 資料模型 | Task 2 (types) + Task 4 (store) |
| API (5 endpoints + WS) | Tasks 9 (POST /event), 10 (GET /sessions, /sessions/:cwd), 11 (WS), 12 (focus, send) |
| 資料流 場景 A | Tasks 6+13 (handler+notifier) + 11 (WS) + 12 (focus) |
| 資料流 場景 B | Task 12 (POST /send) + Task 17 (UI input box) |
| 錯誤處理 | Task 14 (fail-silent), Task 16 (port fallback), Task 6 (last-write-wins) |
| 測試策略 | Tasks 4–13 (TDD unit/integration), Task 18 (manual smoke) |
| 技術棧 | Task 1 (deps pin) |
| 安裝/啟動 | Task 15 (install:hooks), Task 16 (start), Task 17 (build:web) |
| YAGNI 清單 | (negative scope — confirmed by NOT being in any task) |
| Open Questions (5) | Task 3 spike resolves all five, blocks subsequent tasks if any answer changes shape |

Type consistency verified: `Session`, `HookEvent`, `SessionStatus`, `StoreEvents` defined once in Task 2 and used unchanged in Tasks 4, 6, 9–13, 17. Method signatures (`SessionStore.upsert/get/list`, `HookHandler.handle`, `SessionResolver.resolveLatest`, `VscodeBridge.focus/send`, `Notifier.notify`) consistent across definition and call sites.

No placeholders found.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-cc-hub-phase1.md`.**
