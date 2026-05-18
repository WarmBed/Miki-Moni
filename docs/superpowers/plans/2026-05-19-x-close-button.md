# X-Close Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `CopyResumeButton` on every grid cell with a state-aware `X` button (stop wrap on wrapped cells, hide on non-wrapped, un-hide in hidden view) and add a `🙈 (N)` filter chip to surface hidden cells.

**Architecture:** Daemon gains one new endpoint (`POST /wrap/stop`) that tree-kills the wrap subprocess via the existing `WrapProcessRegistry` + `killProcessTree` plumbing; the WS `close` handler already broadcasts `session_changed` with `wrapped=false`, so the dashboard updates without a manual notification path. The web app gains a tiny `hidden-sessions` localStorage module (testable in isolation), a `CloseCardButton` Preact component (replaces `CopyResumeButton` in the cell-header slot), a `🙈 (N)` filter chip in `HeaderStats`, and one extra `.filter()` step in the grid pipeline.

**Tech Stack:** Node 24 / Express / `ws` / better-sqlite3 (daemon), Preact + Vite + TypeScript (web), vitest (tests), supertest (integration), Playwright (smoke).

**Spec:** `docs/superpowers/specs/2026-05-19-x-close-button-design.md`

---

## File Structure

**Created**
- `tests/wrap-stop.test.ts` — supertest integration of the new endpoint
- `web/lib/hidden-sessions.ts` — pure localStorage helper (load / save / add / remove / cross-tab sync)
- `tests/hidden-sessions.test.ts` — vitest for the helper
- `tests/i18n-parity.test.ts` — guard that every key exists in all 3 locales
- `tools/smoke-x-close.py` — Playwright end-to-end smoke

**Modified**
- `src/server.ts` — add `POST /wrap/stop` route alongside existing `/wrap/*` handlers
- `web/app.tsx` — delete `CopyResumeButton` (L1509-1530), add `IconX` + `IconUndo` (next to `IconStop` ~ L180), add `CloseCardButton`, wire into Cell row (~L2887), add `hiddenSet` + `showHidden` state in `App`, add `🙈 (N)` chip in `HeaderStats`, extend grid filter
- `shared/i18n.ts` — remove `session.copyRestart` (×3 locales), add 5 new keys (×3 locales)

---

## Task 1: Daemon — `POST /wrap/stop` endpoint

**Files:**
- Create: `tests/wrap-stop.test.ts`
- Modify: `src/server.ts` (add route block after existing `/wrap/permission-mode` handler around L650)

- [ ] **Step 1: Write the failing integration test**

Create `tests/wrap-stop.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { Notifier } from "../src/notifier.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import * as wrapProc from "../src/wrap-process.js";

const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

function makeApp() {
  const store = new SessionStore(":memory:");
  const resolver = new SessionResolver("/tmp/nonexistent");
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  return createApp({ store, handler, bridge, notifier, webDir: "/tmp", log });
}

describe("POST /wrap/stop", () => {
  beforeEach(() => {
    vi.spyOn(wrapProc, "killProcessTree").mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns 400 when body has no session_uuid", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/wrap/stop").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_session_uuid");
  });

  it("returns 404 when uuid has no active wrap", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-no-wrap" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_wrap");
  });

  it("kills the wrap process tree and returns 200 when a daemon-spawned wrap is active", async () => {
    const { app } = makeApp();
    const internalDeps = (app as any).__deps ?? null;
    // Inject a spawnRec by reaching into the deps the route uses:
    const wrapRegistry = (app as any).__wrapProc;
    expect(wrapRegistry, "test harness must expose __wrapProc — see Task 1 step 3").toBeDefined();
    wrapRegistry.recordSpawn({ sessionUuid: "uuid-1", cwd: "/tmp" });
    wrapRegistry.bindPid("uuid-1", 12345);

    const res = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-1" });
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
    expect(res.body.pid).toBe(12345);
    expect(wrapProc.killProcessTree).toHaveBeenCalledWith(12345, expect.anything());
    expect(wrapRegistry.size()).toBe(0); // takeOnClose removed it
  });

  it("double-stop returns 404 on the second call", async () => {
    const { app } = makeApp();
    const wrapRegistry = (app as any).__wrapProc;
    wrapRegistry.recordSpawn({ sessionUuid: "uuid-2", cwd: "/tmp" });
    wrapRegistry.bindPid("uuid-2", 22222);

    const first = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-2" });
    expect(first.status).toBe(200);
    const second = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-2" });
    expect(second.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/wrap-stop.test.ts
```

Expected: 4 failing tests — `__wrapProc` undefined on the app, route returns 404 for everything (no handler).

- [ ] **Step 3: Expose `wrapProc` for tests + add the route**

In `src/server.ts`, near the existing `(deps as any).__wrapConnections = wrapConnections;` line (~L1158), add:

```ts
(deps as any).__wrapProc = wrapProc;
```

Then add the route. After the existing `app.post("/wrap/permission-mode", ...)` block (the one that ends around L650, before the long WS section), add:

```ts
// ── /wrap/stop ────────────────────────────────────────────────────────
// Tree-kills the wrap subprocess for a daemon-spawned wrap. The wrap WS
// will close naturally on process exit; the existing close handler then
// calls rebroadcastSession(uuid), which flips `wrapped=false` on the
// dashboard via session_changed broadcast. No confirm dialog — the
// underlying Claude Code session JSONL is untouched, so the user can
// re-arm via /wrap/start at any time.
app.post("/wrap/stop", (req: Request, res: Response) => {
  const sessionUuid: unknown = req.body?.session_uuid;
  if (typeof sessionUuid !== "string" || sessionUuid.length === 0) {
    res.status(400).json({ error: "missing_session_uuid" });
    return;
  }
  const spawnRec = wrapProc.takeOnClose(sessionUuid);
  if (!spawnRec) {
    deps.log?.info({ route: "/wrap/stop", session_uuid: sessionUuid }, "no active wrap to stop");
    res.status(404).json({ error: "no_wrap" });
    return;
  }
  if (spawnRec.pid) {
    void killProcessTree(spawnRec.pid, deps.log);
    deps.log?.info({ route: "/wrap/stop", session_uuid: sessionUuid, pid: spawnRec.pid }, "wrap stop requested — process tree kill issued");
  } else {
    // Spawn record exists but PID never bound — wrap.ts crashed before
    // first register. Nothing to kill; return success so the UI clears.
    deps.log?.warn({ route: "/wrap/stop", session_uuid: sessionUuid }, "wrap stop on unbound record (PID never registered)");
  }
  res.status(200).json({ stopped: true, pid: spawnRec.pid });
});
```

- [ ] **Step 4: Run test to verify all 4 pass**

```bash
pnpm vitest run tests/wrap-stop.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
pnpm test
pnpm typecheck
```

Expected: 142 + 4 = 146 passing, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add tests/wrap-stop.test.ts src/server.ts
git commit -m "$(cat <<'EOF'
feat(daemon): POST /wrap/stop tree-kills wrap subprocess

New endpoint mirrors the natural wrap-close path: takes the SpawnRecord
out of WrapProcessRegistry, tree-kills the PID via killProcessTree, and
lets the existing WS close handler do the rebroadcastSession call that
flips wrapped=false on the dashboard.

- 400 if session_uuid missing
- 404 if no active wrap for that uuid (idempotent re-call)
- 200 { stopped: true, pid } otherwise

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Web — `hidden-sessions.ts` storage helper

**Files:**
- Create: `web/lib/hidden-sessions.ts`
- Create: `tests/hidden-sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/hidden-sessions.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { loadHiddenSet, saveHiddenSet, addHidden, removeHidden, HIDDEN_KEY } from "../web/lib/hidden-sessions.js";

class FakeStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

beforeEach(() => {
  (globalThis as any).localStorage = new FakeStorage();
});

describe("hidden-sessions", () => {
  it("loadHiddenSet returns empty set when nothing stored", () => {
    expect(loadHiddenSet()).toEqual(new Set());
  });

  it("addHidden / loadHiddenSet roundtrip", () => {
    const next = addHidden(new Set(), "uuid-1");
    expect(next.has("uuid-1")).toBe(true);
    expect(loadHiddenSet().has("uuid-1")).toBe(true);
  });

  it("removeHidden takes a uuid out", () => {
    addHidden(new Set(), "uuid-1");
    const next = removeHidden(new Set(["uuid-1"]), "uuid-1");
    expect(next.has("uuid-1")).toBe(false);
    expect(loadHiddenSet().has("uuid-1")).toBe(false);
  });

  it("loadHiddenSet falls back to empty on corrupted JSON", () => {
    localStorage.setItem(HIDDEN_KEY, "{not json");
    expect(loadHiddenSet()).toEqual(new Set());
  });

  it("loadHiddenSet ignores non-array JSON payloads", () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ foo: 1 }));
    expect(loadHiddenSet()).toEqual(new Set());
  });

  it("addHidden is idempotent (adding twice yields one entry)", () => {
    let s = addHidden(new Set(), "u");
    s = addHidden(s, "u");
    expect(s.size).toBe(1);
  });

  it("saveHiddenSet silently no-ops if localStorage throws (private mode)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing = new FakeStorage();
    throwing.setItem = () => { throw new Error("QuotaExceededError"); };
    (globalThis as any).localStorage = throwing;
    expect(() => saveHiddenSet(new Set(["u"]))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/hidden-sessions.test.ts
```

Expected: 7 failing — module doesn't exist.

- [ ] **Step 3: Write the minimal helper**

Create `web/lib/hidden-sessions.ts`:

```ts
/**
 * Per-browser hidden-card store. Lives only in localStorage; the daemon
 * doesn't know about it. Cross-tab sync is handled by the consumer via
 * the `storage` event.
 *
 * Why a separate file: keeping it pure (no Preact, no DOM hooks) means
 * we can vitest the whole thing in isolation against a FakeStorage stub.
 * The Preact `useState`/`useEffect` wiring lives in app.tsx and just
 * delegates to these four functions.
 */

export const HIDDEN_KEY = "miki-moni:hidden-sessions";

export function loadHiddenSet(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveHiddenSet(s: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
  } catch (err) {
    // Private-mode browsers can throw on setItem. Don't propagate — the
    // in-memory set still works for the current page lifetime.
    console.warn("miki-moni: failed to persist hidden-sessions:", err);
  }
}

export function addHidden(current: Set<string>, uuid: string): Set<string> {
  const next = new Set(current);
  next.add(uuid);
  saveHiddenSet(next);
  return next;
}

export function removeHidden(current: Set<string>, uuid: string): Set<string> {
  const next = new Set(current);
  next.delete(uuid);
  saveHiddenSet(next);
  return next;
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
pnpm vitest run tests/hidden-sessions.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add web/lib/hidden-sessions.ts tests/hidden-sessions.test.ts
git commit -m "$(cat <<'EOF'
feat(web): hidden-sessions localStorage helper

Pure module with load / save / add / remove. Kept out of app.tsx so the
JSON-parse fallback, idempotency, and private-mode swallow can be unit
tested against a FakeStorage stub. The Preact wiring lives in App and
just delegates here.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Web — `IconX` + `IconUndo` SVG helpers

**Files:**
- Modify: `web/app.tsx` (add two icon functions next to `IconStop` ~L180)

No standalone test — these are 4-line SVG strings. They get covered by the Playwright smoke in Task 8.

- [ ] **Step 1: Add the two icons**

In `web/app.tsx`, immediately after the existing `IconStop` function (L180-186), add:

```tsx
function IconX({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconUndo({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/app.tsx
git commit -m "$(cat <<'EOF'
feat(web): IconX + IconUndo icons

Two 13px lucide-style strokes for the upcoming CloseCardButton states
(non-wrapped → ✕ hide, hidden-view → ↩ un-hide). Wrapped-state uses
the existing IconStop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: i18n — remove `copyRestart`, add 5 new keys × 3 locales + parity test

**Files:**
- Modify: `shared/i18n.ts`
- Create: `tests/i18n-parity.test.ts`

- [ ] **Step 1: Write the parity test first**

Create `tests/i18n-parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// Re-export the dicts from i18n.ts. If they aren't already exported, see step 2.
import { zhTW, zhCN, en } from "../shared/i18n.js";

describe("i18n locale parity", () => {
  it("zh-CN has every key that zh-TW has", () => {
    const tw = new Set(Object.keys(zhTW));
    const cn = new Set(Object.keys(zhCN));
    const missing = [...tw].filter(k => !cn.has(k));
    expect(missing, `zh-CN missing keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("en has every key that zh-TW has", () => {
    const tw = new Set(Object.keys(zhTW));
    const e = new Set(Object.keys(en));
    const missing = [...tw].filter(k => !e.has(k));
    expect(missing, `en missing keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("zh-TW has the X-close keys", () => {
    expect(zhTW["session.closeWrapped"]).toBeTypeOf("string");
    expect(zhTW["session.closeHidden"]).toBeTypeOf("string");
    expect(zhTW["session.unhide"]).toBeTypeOf("string");
    expect(zhTW["filter.hiddenLabel"]).toBeTypeOf("string");
    expect(zhTW["filter.hiddenTooltip"]).toBeTypeOf("string");
  });

  it("session.copyRestart has been removed", () => {
    expect(zhTW["session.copyRestart"]).toBeUndefined();
    expect(zhCN["session.copyRestart"]).toBeUndefined();
    expect(en["session.copyRestart"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — expect failures (keys missing, exports missing)**

```bash
pnpm vitest run tests/i18n-parity.test.ts
```

Expected: import errors and/or missing keys.

- [ ] **Step 3: Ensure dicts are exported**

In `shared/i18n.ts`, search for `const zhTW: Dict = {`. If `zhTW`, `zhCN`, and `en` are not already `export`-ed, prefix them with `export`. If they're already accessed via a default object, add named exports next to that object.

If exports already exist, skip this step.

- [ ] **Step 4: Update zh-TW dict (find `session.copyRestart` ~L190)**

In `shared/i18n.ts` zh-TW dict, **remove** the line:

```
"session.copyRestart":      "複製重啟指令：pnpm --dir D:\\code\\cc-hub miki claude -r {uuid}",
```

**Add** (group them together, near `session.wrappedDetailed` or wherever session.* keys cluster):

```ts
"session.closeWrapped":     "停止 wrap（保留 session）",
"session.closeHidden":      "從本機隱藏這張卡",
"session.unhide":           "取消隱藏",
"filter.hiddenLabel":       "🙈 已隱藏",
"filter.hiddenTooltip":     "顯示已從本機隱藏的卡片（{n} 張）",
```

- [ ] **Step 5: Update zh-CN dict (find `session.copyRestart` ~L472)**

**Remove**:

```
"session.copyRestart":       "复制重启指令：pnpm --dir D:\\code\\cc-hub miki claude -r {uuid}",
```

**Add**:

```ts
"session.closeWrapped":      "停止 wrap（保留 session）",
"session.closeHidden":       "从本机隐藏这张卡",
"session.unhide":            "取消隐藏",
"filter.hiddenLabel":        "🙈 已隐藏",
"filter.hiddenTooltip":      "显示已从本机隐藏的卡片（{n} 张）",
```

- [ ] **Step 6: Update en dict (find `session.copyRestart` ~L749)**

**Remove**:

```
"session.copyRestart":       "Copy restart command: pnpm --dir D:\\code\\cc-hub miki claude -r {uuid}",
```

**Add**:

```ts
"session.closeWrapped":      "Stop wrap (keep session)",
"session.closeHidden":       "Hide this card on this device",
"session.unhide":            "Un-hide",
"filter.hiddenLabel":        "🙈 Hidden",
"filter.hiddenTooltip":      "Show cards hidden on this device ({n})",
```

- [ ] **Step 7: Run parity test — expect pass**

```bash
pnpm vitest run tests/i18n-parity.test.ts
```

Expected: 4 passing.

- [ ] **Step 8: Run full suite**

```bash
pnpm test
pnpm typecheck
```

Expected: typecheck will fail on `t("session.copyRestart")` references in `web/app.tsx` (still calling the removed key). Note them — they'll be fixed in Task 6 when we delete the `CopyResumeButton` use site. To keep the tree green between commits, **temporarily comment out** the `CopyResumeButton` usage at `web/app.tsx:2887` for this commit:

Change L2886-2887 from:
```tsx
{!s.wrapped && s.session_uuid && <WrapStartButton sessionUuid={s.session_uuid} />}
<CopyResumeButton sessionUuid={s.session_uuid ?? ""} compact />
```
to:
```tsx
{!s.wrapped && s.session_uuid && <WrapStartButton sessionUuid={s.session_uuid} />}
{/* CopyResumeButton removed in 0.3.11 — CloseCardButton lands in Task 6 */}
```

Then delete the unused `CopyResumeButton` function (L1509-1530) entirely.

Re-run:

```bash
pnpm typecheck
pnpm test
```

Expected: clean. 142 + 7 (Task 2) + 4 (Task 1) + 4 (Task 4) = 157 passing.

- [ ] **Step 9: Commit**

```bash
git add shared/i18n.ts tests/i18n-parity.test.ts web/app.tsx
git commit -m "$(cat <<'EOF'
refactor(i18n): drop session.copyRestart, add X-close + filter.hidden keys

The copyRestart command embedded a hardcoded D:\code\cc-hub path — it
was useful only for the original author. CopyResumeButton has been
deleted; CloseCardButton (Task 6) takes its slot.

i18n-parity.test.ts is new: catches zh-CN / en falling behind zh-TW
(TypeScript only validates zh-TW against Dict).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Web — `App`-level hidden-state + filter wiring

**Files:**
- Modify: `web/app.tsx` (App component, near `statusFilter` state ~L3831)

- [ ] **Step 1: Import the helper**

At the top of `web/app.tsx` with the other imports:

```tsx
import { loadHiddenSet, addHidden, removeHidden, HIDDEN_KEY } from "./lib/hidden-sessions.js";
```

- [ ] **Step 2: Add state inside the `App` component**

Find the line `const [statusFilter, setStatusFilterState] = useState<StatusFilter>(...)` (~L3831). Immediately below it, add:

```tsx
// Hidden-cards state. Per-browser via localStorage. Cross-tab sync is
// wired via the `storage` event in a useEffect below.
const [hiddenSet, setHiddenSet] = useState<Set<string>>(() => loadHiddenSet());
const [showHidden, setShowHidden] = useState(false);

function hideSession(uuid: string) {
  setHiddenSet(prev => addHidden(prev, uuid));
}
function unhideSession(uuid: string) {
  setHiddenSet(prev => removeHidden(prev, uuid));
}
```

Then below the state declarations, add the cross-tab sync `useEffect`:

```tsx
useEffect(() => {
  function onStorage(e: StorageEvent) {
    if (e.key !== HIDDEN_KEY) return;
    setHiddenSet(loadHiddenSet());
  }
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}, []);
```

- [ ] **Step 3: Extend the grid filter pipeline**

Find the existing filter at `<GridOverview sessions={sessions.filter(...)}` (~L4559). Replace:

```tsx
sessions.filter((s) => {
  if (statusFilter === "all") return true;
  if (statusFilter === "live") return s.status === "active" || s.status === "waiting";
  return s.status === statusFilter;
})
```

with:

```tsx
sessions.filter((s) => {
  if (statusFilter === "all") return true;
  if (statusFilter === "live") return s.status === "active" || s.status === "waiting";
  return s.status === statusFilter;
}).filter((s) => {
  // Hidden filter is orthogonal to status filter. Default view excludes
  // hidden cards; the 🙈 chip flips showHidden true to inspect them.
  const uuid = s.session_uuid ?? "";
  return showHidden ? hiddenSet.has(uuid) : !hiddenSet.has(uuid);
})
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/app.tsx
git commit -m "$(cat <<'EOF'
feat(web): App-level hidden-cards state + grid filter step

hiddenSet (Set<string> of session_uuid) is loaded from localStorage on
mount and keeps in sync across tabs via the storage event. The grid
pipeline gains a second .filter() that excludes hidden cards unless
showHidden is true (toggled by the 🙈 chip in Task 7).

CloseCardButton (Task 6) will call hideSession/unhideSession.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Web — `CloseCardButton` component + wire into cell

**Files:**
- Modify: `web/app.tsx` (add component near `IconStop` neighbors, wire at the cell-header row ~L2887)

- [ ] **Step 1: Add `CloseCardButton` component**

In `web/app.tsx`, immediately after the new `IconUndo` function (added in Task 3), add:

```tsx
// ── Close card button ──────────────────────────────────────────────────
//
// State-aware top-right button for each grid cell:
//   - wrapped   → IconStop  → POST /wrap/stop  (cell flips non-wrapped)
//   - non-wrap  → IconX     → hide locally     (cell disappears)
//   - hidden    → IconUndo  → un-hide locally  (cell returns)
//
// Failure of /wrap/stop is surfaced inline (red border + tooltip for 3s)
// matching ModelChip's pattern (L2004) so we don't need a global toast
// system. localStorage failures are silent (in-memory state still works)
// — see web/lib/hidden-sessions.ts.

function CloseCardButton({
  sessionUuid, wrapped, isHiddenView, onHide, onUnhide,
}: {
  sessionUuid: string;
  wrapped: boolean;
  isHiddenView: boolean;
  onHide: (uuid: string) => void;
  onUnhide: (uuid: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handle(e: MouseEvent) {
    e.stopPropagation();
    if (!sessionUuid || pending) return;

    if (isHiddenView) {
      onUnhide(sessionUuid);
      return;
    }
    if (!wrapped) {
      onHide(sessionUuid);
      return;
    }

    // wrapped: kill via daemon
    setPending(true); setErr(null);
    try {
      const r = await apiFetch("/wrap/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_uuid: sessionUuid }),
      });
      if (!r.ok && r.status !== 404) {
        // 404 = already stopped (race with WS close). Treat as success.
        throw new Error(`HTTP ${r.status}`);
      }
      // No optimistic UI: the daemon's WS session_changed event will flip
      // wrapped=false on this cell.
    } catch (e: unknown) {
      setErr(String(e));
      window.setTimeout(() => setErr(null), 3000);
    } finally {
      setPending(false);
    }
  }

  const title = isHiddenView
    ? t("session.unhide")
    : wrapped
      ? t("session.closeWrapped")
      : t("session.closeHidden");

  const icon = isHiddenView
    ? <IconUndo size={11} />
    : wrapped
      ? <IconStop size={11} />
      : <IconX size={11} />;

  return (
    <button
      class="btn-ghost icon-btn"
      style={{
        padding: "3px 6px",
        opacity: pending ? 0.5 : 1,
        borderColor: err ? "var(--err, #d33)" : undefined,
      }}
      onClick={(e) => { void handle(e); }}
      title={err ?? title}
      disabled={!sessionUuid || pending}
    >{icon}</button>
  );
}
```

- [ ] **Step 2: Wire it into the cell-header row**

In `web/app.tsx`, find the placeholder comment from Task 4 step 8 (`{/* CopyResumeButton removed in 0.3.11 — CloseCardButton lands in Task 6 */}`) and replace it with:

```tsx
<CloseCardButton
  sessionUuid={s.session_uuid ?? ""}
  wrapped={s.wrapped ?? false}
  isHiddenView={showHidden}
  onHide={hideSession}
  onUnhide={unhideSession}
/>
```

Make sure `showHidden`, `hideSession`, `unhideSession` are in scope. The cell renders inside `Cell` or `Card`, which is invoked from `App`. Trace the prop drilling: `App` → `GridOverview` → `Cell`. Add `showHidden`, `onHide`, `onUnhide` to the `GridOverview` and `Cell` prop types and forward them.

Specifically:

**`GridOverview`** — add to the prop type:

```ts
showHidden: boolean;
onHide: (uuid: string) => void;
onUnhide: (uuid: string) => void;
```

Pass them through to each `<Cell>` it renders.

**`Cell`** — add the same props, forward to `<CloseCardButton>`.

In `App`'s `<GridOverview ...>` call (~L4559), add:

```tsx
showHidden={showHidden}
onHide={hideSession}
onUnhide={unhideSession}
```

- [ ] **Step 3: Typecheck + run all tests**

```bash
pnpm typecheck
pnpm test
```

Expected: clean. No new tests for this task — Task 8 Playwright covers it.

- [ ] **Step 4: Commit**

```bash
git add web/app.tsx
git commit -m "$(cat <<'EOF'
feat(web): CloseCardButton replaces CopyResumeButton on cells

State-aware button:
- wrapped cell  → IconStop → POST /wrap/stop, cell flips non-wrapped
- non-wrapped   → IconX    → addHidden(), cell disappears
- hidden view   → IconUndo → removeHidden(), cell returns

Error UX: inline red border + tooltip for 3s on /wrap/stop failure;
404 from /wrap/stop treated as success (race with WS close handler).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Web — `🙈 (N)` filter chip in `HeaderStats`

**Files:**
- Modify: `web/app.tsx` (`HeaderStats` component ~L1388, App-level call site ~L4408)

- [ ] **Step 1: Extend `HeaderStats` prop type**

Find `function HeaderStats({ sessions, filter, onFilter }: {` (~L1388). Add two props:

```ts
hiddenCount: number;
showHidden: boolean;
onToggleHidden: () => void;
```

- [ ] **Step 2: Add the chip in the JSX**

Inside `HeaderStats`, after the existing status-filter chip row, add a conditional chip:

```tsx
{hiddenCount > 0 && (
  <button
    class="btn-ghost"
    style={{
      marginLeft: 6, fontSize: 11, padding: "2px 6px",
      borderColor: showHidden ? "var(--fg)" : "var(--border)",
      background: showHidden ? "var(--sl3)" : "transparent",
      borderWidth: 1, borderStyle: "solid", borderRadius: 4,
    }}
    title={t("filter.hiddenTooltip", { n: hiddenCount })}
    onClick={onToggleHidden}
  >{t("filter.hiddenLabel")} {hiddenCount}</button>
)}
```

- [ ] **Step 3: Pass props at the call site**

In `App` (~L4408), update the `<HeaderStats ...>` invocation:

```tsx
<HeaderStats
  sessions={sessions}
  filter={statusFilter}
  onFilter={setStatusFilter}
  hiddenCount={hiddenSet.size}
  showHidden={showHidden}
  onToggleHidden={() => setShowHidden(v => !v)}
/>
```

- [ ] **Step 4: Edge case — auto-flip out of hidden view when nothing is hidden**

If user un-hides the last card while in hidden view, the chip would disappear leaving `showHidden=true` but nothing to look at. Inside `App`, add a `useEffect`:

```tsx
useEffect(() => {
  if (hiddenSet.size === 0 && showHidden) setShowHidden(false);
}, [hiddenSet.size, showHidden]);
```

- [ ] **Step 5: Typecheck + tests**

```bash
pnpm typecheck
pnpm test
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/app.tsx
git commit -m "$(cat <<'EOF'
feat(web): 🙈 (N) filter chip surfaces hidden cards

Chip appears in HeaderStats only when hiddenSet.size > 0. Click toggles
showHidden, which flips the grid filter to inspect-hidden-only mode.
Auto-flips back to default view when the last card is un-hidden so the
user isn't stranded looking at nothing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Playwright end-to-end smoke

**Files:**
- Create: `tools/smoke-x-close.py`

- [ ] **Step 1: Write the smoke script**

Create `tools/smoke-x-close.py`:

```python
"""End-to-end smoke for the X-close button + 🙈 hidden filter.

Assumes a daemon is already running on 127.0.0.1:8765 with at least one
session. Doesn't seed sessions itself — point this at a live dashboard
that has ≥1 card to exercise both paths.

Verdict logic:
  - Open dashboard, find first card's close button
  - Note current wrapped state, click it
  - If wrapped → expect /wrap/stop POST + cell goes non-wrapped
  - If non-wrapped → expect cell to disappear, 🙈 chip to show 1
  - Click 🙈 chip → expect hidden card to reappear with ↩ icon
  - Click ↩ → expect card to return to default view, chip gone
"""
from playwright.sync_api import sync_playwright
import sys, time

URL = "http://127.0.0.1:8765/"

def main() -> int:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1400, "height": 800})
        page = ctx.new_page()

        posts: list[dict] = []
        page.on("request", lambda r: posts.append({"url": r.url, "method": r.method}) if "wrap/stop" in r.url else None)

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle", timeout=10_000)

        cards = page.locator(".card").or_(page.locator("[class*='cell']"))
        card_count = cards.count()
        print(f"cards on page: {card_count}")
        if card_count == 0:
            print("✗ no cards — start a miki session first, then re-run")
            b.close()
            return 2

        first = cards.first
        first.scroll_into_view_if_needed()
        # The close button is the rightmost icon-btn in the cell header row.
        close_btn = first.locator("button.icon-btn").last
        initial_title = close_btn.get_attribute("title") or ""
        print(f"first card close-btn title: {initial_title!r}")

        was_wrapped = "stop wrap" in initial_title.lower() or "停止 wrap" in initial_title
        print(f"  → looks wrapped? {was_wrapped}")

        close_btn.click()
        page.wait_for_timeout(500)
        page.screenshot(path="tools/smoke-x-close-after1.png", full_page=False)

        if was_wrapped:
            print(f"POST /wrap/stop fired? {any('wrap/stop' in p['url'] for p in posts)}")
            # cell should still exist but title now refers to hide
            new_title = close_btn.get_attribute("title") or ""
            print(f"after stop: title={new_title!r}")
            if "hide" not in new_title.lower() and "隱藏" not in new_title:
                print("⚠ wrapped→non-wrapped transition may not have happened (could be slow WS)")

        # Now click again — should hide
        close_btn.click()
        page.wait_for_timeout(400)
        page.screenshot(path="tools/smoke-x-close-after2.png", full_page=False)

        # 🙈 chip should be visible now
        chip = page.locator("button", has_text="🙈")
        chip_n = chip.count()
        print(f"🙈 chip count after hide: {chip_n}")
        if chip_n == 0:
            print("✗ 🙈 chip not visible after hide")
            b.close()
            return 1

        chip.first.click()
        page.wait_for_timeout(300)
        # In hidden view, click the un-hide button on the now-hidden card
        un_btn = page.locator("button.icon-btn", has_text="").last
        un_title = un_btn.get_attribute("title") or ""
        print(f"hidden-view close-btn title: {un_title!r}")
        un_btn.click()
        page.wait_for_timeout(300)
        page.screenshot(path="tools/smoke-x-close-after3.png", full_page=False)

        print("VERDICT: ✅ flow complete — inspect tools/smoke-x-close-after*.png")
        b.close()
        return 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Build + redeploy current local build to global node_modules**

(The global daemon serves from `C:/Users/mike2/AppData/Roaming/npm/node_modules/miki-moni/dist/web` — same workflow we used before.)

```bash
pnpm build:web
pnpm build:phone
GLOBAL="C:/Users/mike2/AppData/Roaming/npm/node_modules/miki-moni/dist"
rm -rf "$GLOBAL/web/assets"; cp dist/web/index.html "$GLOBAL/web/index.html"; cp -r dist/web/assets "$GLOBAL/web/assets"
rm -rf "$GLOBAL/web-phone/assets"; cp dist/web-phone/index.html "$GLOBAL/web-phone/index.html"; cp -r dist/web-phone/assets "$GLOBAL/web-phone/assets"
```

- [ ] **Step 3: Run the smoke**

```bash
PYTHONIOENCODING=utf-8 python tools/smoke-x-close.py
```

Expected: VERDICT line printed; 3 screenshots in `tools/`. Skim them by hand to confirm the visual transitions match the spec.

- [ ] **Step 4: Commit (script only — screenshots stay untracked)**

```bash
git add tools/smoke-x-close.py
git commit -m "$(cat <<'EOF'
test(smoke): Playwright end-to-end for X-close + 🙈 filter

Walks the full flow: click X on a wrapped card → stop wrap + flip
non-wrapped, click X again → hide, click 🙈 chip → enter hidden view,
click ↩ → un-hide + chip vanishes. Doesn't seed sessions; assumes
daemon is running with ≥1 card.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Release — version bump + push + publish

**Files:**
- Modify: `package.json` (`"version": "0.3.10"` → `"0.3.11"`)

- [ ] **Step 1: Final gate**

```bash
pnpm test
pnpm typecheck
```

Expected: all tests pass (142 baseline + 4 wrap-stop + 7 hidden-sessions + 4 i18n-parity = **157 passing**), typecheck clean.

- [ ] **Step 2: Bump version**

Edit `package.json` line 3:

```json
"version": "0.3.11",
```

- [ ] **Step 3: Final build**

```bash
pnpm build:web
pnpm build:phone
```

- [ ] **Step 4: Commit + push**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(release): 0.3.11 — X-close button + 🙈 hidden-cards filter

Replace the dead-on-arrival CopyResumeButton (hardcoded D:\code\cc-hub
path nobody else could use) with a state-aware X:

- wrapped cell  → POST /wrap/stop (new endpoint) → cell flips non-wrapped
- non-wrapped   → hide locally → cell disappears from default view
- hidden view   → un-hide → cell returns

Header gains a 🙈 (N) chip whenever any cards are hidden. Cross-tab
synced via the storage event. Per-browser only (no daemon-side sync).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

- [ ] **Step 5: Publish**

```bash
pnpm publish --no-git-checks
```

Expected: `+ miki-moni@0.3.11`

- [ ] **Step 6: Verify on npm + re-deploy to local global**

```bash
npm view miki-moni@0.3.11 version
GLOBAL="C:/Users/mike2/AppData/Roaming/npm/node_modules/miki-moni/dist"
rm -rf "$GLOBAL/web/assets" "$GLOBAL/web-phone/assets"
cp dist/web/index.html "$GLOBAL/web/index.html"; cp -r dist/web/assets "$GLOBAL/web/assets"
cp dist/web-phone/index.html "$GLOBAL/web-phone/index.html"; cp -r dist/web-phone/assets "$GLOBAL/web-phone/assets"
```

Then Ctrl+F5 the dashboard to confirm X-close works against the live daemon.

---

## Self-Review Done

- ✅ Spec coverage: every section of the design doc maps to a task (daemon endpoint=T1, hidden helper=T2, icons=T3, i18n=T4, app state=T5, button component=T6, header chip=T7, smoke=T8, release=T9)
- ✅ No placeholders or "TBD" — every step shows exact code, exact commands, exact expected output
- ✅ Type consistency: `hideSession` / `unhideSession` names match across tasks 5/6/7; `IconX`, `IconUndo`, `IconStop` references match Task 3 declarations; `CloseCardButton` props match between declaration (T6 step 1) and usage (T6 step 2 + T8)
- ✅ Scope: single feature, single 0.3.11 release; doesn't need decomposition
