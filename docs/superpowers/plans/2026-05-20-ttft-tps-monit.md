# TTFT / TPS Monit Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record TTFT (Time-to-First-Token) and TPS (chars/sec during streaming) per turn, expose a `/metrics` API, and add a Monit button to the dashboard header that opens a panel with dual trend charts (48h rolling window).

**Architecture:** A new `PerfTracker` class accumulates in-memory per-turn timing state by intercepting existing `user_prompt` hooks and `assistant_delta_*` WS events already flowing through the daemon. On each turn end it writes one row to a new `perf_metrics` SQLite table (via `PerfStore`). The web dashboard gains a Monit button (header right side) that fetches `GET /metrics?window=Xh` and renders two pure-SVG trend charts with fleet-average colouring — no new npm dependencies.

**Tech Stack:** Node.js / TypeScript, better-sqlite3, Express 5, Preact, Tailwind CSS, Vitest

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/perf-store.ts` | SQLite `perf_metrics` table CRUD + 48h rolling cleanup |
| Create | `src/perf-tracker.ts` | In-memory per-turn state; computes TTFT & TPS; writes to PerfStore |
| Create | `tests/perf-store.test.ts` | Unit tests for PerfStore |
| Create | `tests/perf-tracker.test.ts` | Unit tests for PerfTracker |
| Modify | `src/hook-handler.ts` | Call `perfTracker.onUserPrompt()` on `user_prompt` events |
| Modify | `src/server.ts` | Wire PerfTracker into WS delta handler + add `GET /metrics` endpoint |
| Modify | `web/app.tsx` | Add `IconMonit`, `MonitPanel`, `MetricChart` components + header button |

---

## Task 1: PerfStore — SQLite layer

**Files:**
- Create: `src/perf-store.ts`
- Create: `tests/perf-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/perf-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { PerfStore } from "../src/perf-store.js";

describe("PerfStore", () => {
  let store: PerfStore;
  beforeEach(() => { store = new PerfStore(":memory:"); });

  it("inserts a metric row and retrieves it in the window", () => {
    const now = Date.now();
    store.insert({ session_uuid: "s1", ts: now, ttft_ms: 320, tps: 45.2, char_count: 450, duration_ms: 9960 });
    const rows = store.query(now - 1000, now + 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ttft_ms).toBe(320);
    expect(rows[0]!.tps).toBeCloseTo(45.2);
  });

  it("returns empty array when no rows in window", () => {
    const now = Date.now();
    store.insert({ session_uuid: "s1", ts: now - 100_000, ttft_ms: 200, tps: 30, char_count: 300, duration_ms: 10000 });
    expect(store.query(now - 1000, now)).toHaveLength(0);
  });

  it("deleteOlderThan removes rows outside retention window", () => {
    const now = Date.now();
    store.insert({ session_uuid: "s1", ts: now - 200_000, ttft_ms: 100, tps: 20, char_count: 200, duration_ms: 10000 });
    store.insert({ session_uuid: "s2", ts: now, ttft_ms: 150, tps: 25, char_count: 250, duration_ms: 10000 });
    const deleted = store.deleteOlderThan(now - 50_000);
    expect(deleted).toBe(1);
    expect(store.query(0, now + 1000)).toHaveLength(1);
  });

  it("fleetAvg returns null when no rows", () => {
    const now = Date.now();
    const avg = store.fleetAvg(now - 1000, now);
    expect(avg.avg_ttft).toBeNull();
    expect(avg.avg_tps).toBeNull();
  });

  it("fleetAvg returns correct averages", () => {
    const now = Date.now();
    store.insert({ session_uuid: "s1", ts: now, ttft_ms: 200, tps: 40, char_count: 400, duration_ms: 10000 });
    store.insert({ session_uuid: "s2", ts: now, ttft_ms: 400, tps: 60, char_count: 600, duration_ms: 10000 });
    const avg = store.fleetAvg(now - 1000, now + 1000);
    expect(avg.avg_ttft).toBe(300);
    expect(avg.avg_tps).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd d:\code\cc-hub
pnpm test tests/perf-store.test.ts
```
Expected: FAIL — "Cannot find module '../src/perf-store.js'"

- [ ] **Step 3: Implement PerfStore**

```typescript
// src/perf-store.ts
import Database from "better-sqlite3";

export interface PerfMetricRow {
  session_uuid: string;
  ts: number;         // unix ms
  ttft_ms: number | null;
  tps: number | null; // chars/sec
  char_count: number;
  duration_ms: number;
}

export interface FleetAvg {
  avg_ttft: number | null;
  avg_tps: number | null;
}

export class PerfStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS perf_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT NOT NULL,
        ts INTEGER NOT NULL,
        ttft_ms INTEGER,
        tps REAL,
        char_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_perf_ts ON perf_metrics(ts);
    `);
  }

  insert(row: PerfMetricRow): void {
    this.db.prepare(`
      INSERT INTO perf_metrics (session_uuid, ts, ttft_ms, tps, char_count, duration_ms)
      VALUES (@session_uuid, @ts, @ttft_ms, @tps, @char_count, @duration_ms)
    `).run(row);
  }

  query(fromTs: number, toTs: number): PerfMetricRow[] {
    return this.db.prepare(
      "SELECT session_uuid, ts, ttft_ms, tps, char_count, duration_ms FROM perf_metrics WHERE ts >= ? AND ts <= ? ORDER BY ts ASC"
    ).all(fromTs, toTs) as PerfMetricRow[];
  }

  fleetAvg(fromTs: number, toTs: number): FleetAvg {
    const row = this.db.prepare(`
      SELECT AVG(ttft_ms) AS avg_ttft, AVG(tps) AS avg_tps
      FROM perf_metrics WHERE ts >= ? AND ts <= ? AND ttft_ms IS NOT NULL AND tps IS NOT NULL
    `).get(fromTs, toTs) as { avg_ttft: number | null; avg_tps: number | null };
    return { avg_ttft: row.avg_ttft ?? null, avg_tps: row.avg_tps ?? null };
  }

  deleteOlderThan(beforeTs: number): number {
    const r = this.db.prepare("DELETE FROM perf_metrics WHERE ts < ?").run(beforeTs);
    return r.changes;
  }

  close(): void { this.db.close(); }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
pnpm test tests/perf-store.test.ts
```
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```
git add src/perf-store.ts tests/perf-store.test.ts
git commit -m "feat: add PerfStore for perf_metrics SQLite table"
```

---

## Task 2: PerfTracker — in-memory computation

**Files:**
- Create: `src/perf-tracker.ts`
- Create: `tests/perf-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/perf-tracker.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PerfTracker } from "../src/perf-tracker.js";
import type { PerfStore } from "../src/perf-store.js";

function makeMockStore(): PerfStore & { rows: unknown[] } {
  const rows: unknown[] = [];
  return {
    rows,
    insert: vi.fn((row) => rows.push(row)),
    query: vi.fn(() => []),
    fleetAvg: vi.fn(() => ({ avg_ttft: null, avg_tps: null })),
    deleteOlderThan: vi.fn(() => 0),
    close: vi.fn(),
  } as unknown as PerfStore & { rows: unknown[] };
}

describe("PerfTracker", () => {
  let store: ReturnType<typeof makeMockStore>;
  let tracker: PerfTracker;

  beforeEach(() => {
    store = makeMockStore();
    tracker = new PerfTracker(store);
  });

  it("records TTFT when delta_start follows user_prompt", () => {
    const promptTs = 1000;
    tracker.onUserPrompt("s1", promptTs);

    vi.setSystemTime(promptTs + 350);
    tracker.onDeltaStart("s1");

    tracker.onDelta("s1", "Hello world");
    vi.setSystemTime(promptTs + 1350);
    tracker.onDeltaEnd("s1");

    expect(store.insert).toHaveBeenCalledOnce();
    const row = (store.rows[0] as any);
    expect(row.ttft_ms).toBe(350);
    expect(row.session_uuid).toBe("s1");
  });

  it("records TPS as chars/sec", () => {
    const promptTs = 2000;
    tracker.onUserPrompt("s1", promptTs);
    vi.setSystemTime(promptTs + 200);
    tracker.onDeltaStart("s1");

    tracker.onDelta("s1", "abc");      // 3 chars
    tracker.onDelta("s1", "defgh");    // 5 chars = 8 total
    vi.setSystemTime(promptTs + 1200); // 1000 ms streaming → 8 tps
    tracker.onDeltaEnd("s1");

    const row = (store.rows[0] as any);
    expect(row.char_count).toBe(8);
    expect(row.tps).toBeCloseTo(8.0);
  });

  it("stores null TTFT when no prior user_prompt", () => {
    tracker.onDeltaStart("s1");
    tracker.onDelta("s1", "hi");
    vi.setSystemTime(Date.now() + 500);
    tracker.onDeltaEnd("s1");

    const row = (store.rows[0] as any);
    expect(row.ttft_ms).toBeNull();
  });

  it("cleans up turn state after delta_end", () => {
    tracker.onUserPrompt("s1", Date.now());
    tracker.onDeltaStart("s1");
    tracker.onDelta("s1", "text");
    tracker.onDeltaEnd("s1");

    // second turn without new user_prompt → TTFT null
    store.insert = vi.fn();
    tracker.onDeltaStart("s1");
    tracker.onDelta("s1", "more");
    tracker.onDeltaEnd("s1");
    expect((store.insert as any).mock.calls[0][0].ttft_ms).toBeNull();
  });

  it("ignores sessions with no delta activity (no insert)", () => {
    tracker.onUserPrompt("s1", Date.now());
    // no delta events
    expect(store.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm test tests/perf-tracker.test.ts
```
Expected: FAIL — "Cannot find module '../src/perf-tracker.js'"

- [ ] **Step 3: Implement PerfTracker**

```typescript
// src/perf-tracker.ts
import type { PerfStore } from "./perf-store.js";

interface TurnState {
  promptTs: number | null;
  deltaStartTs: number | null;
  charCount: number;
}

const RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours

export class PerfTracker {
  private turns = new Map<string, TurnState>();

  constructor(private store: PerfStore) {}

  onUserPrompt(sessionUuid: string, ts: number): void {
    this.turns.set(sessionUuid, { promptTs: ts, deltaStartTs: null, charCount: 0 });
  }

  onDeltaStart(sessionUuid: string): void {
    const state = this.turns.get(sessionUuid);
    if (state) {
      state.deltaStartTs = Date.now();
    } else {
      this.turns.set(sessionUuid, { promptTs: null, deltaStartTs: Date.now(), charCount: 0 });
    }
  }

  onDelta(sessionUuid: string, text: string): void {
    const state = this.turns.get(sessionUuid);
    if (state) state.charCount += text.length;
  }

  onDeltaEnd(sessionUuid: string): void {
    const state = this.turns.get(sessionUuid);
    if (!state || state.deltaStartTs === null) return;

    const now = Date.now();
    const duration_ms = now - state.deltaStartTs;
    const ttft_ms = state.promptTs !== null && state.deltaStartTs !== null
      ? state.deltaStartTs - state.promptTs
      : null;
    const tps = duration_ms > 0 ? (state.charCount / duration_ms) * 1000 : null;

    this.store.insert({
      session_uuid: sessionUuid,
      ts: now,
      ttft_ms,
      tps,
      char_count: state.charCount,
      duration_ms,
    });

    // Reset: keep entry but clear timing so next turn starts fresh
    this.turns.set(sessionUuid, { promptTs: null, deltaStartTs: null, charCount: 0 });

    // Rolling cleanup — fire and forget
    this.store.deleteOlderThan(now - RETENTION_MS);
  }
}
```

- [ ] **Step 4: Run tests**

```
pnpm test tests/perf-tracker.test.ts
```
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```
git add src/perf-tracker.ts tests/perf-tracker.test.ts
git commit -m "feat: add PerfTracker for in-memory TTFT/TPS computation"
```

---

## Task 3: Wire PerfTracker into HookHandler

**Files:**
- Modify: `src/hook-handler.ts` (add optional `perfTracker` dep + call `onUserPrompt`)
- Modify: `tests/hook-handler.test.ts` (add one test to verify `onUserPrompt` is called)

- [ ] **Step 1: Read the existing hook-handler test to understand its setup**

```
# Open tests/hook-handler.test.ts to see the existing mock pattern
```

- [ ] **Step 2: Add a failing test for perfTracker integration**

At the bottom of `tests/hook-handler.test.ts`, add:

```typescript
it("calls perfTracker.onUserPrompt when user_prompt event arrives", async () => {
  const store = new SessionStore(":memory:");
  const resolver = new SessionResolver(":memory:");
  const onUserPrompt = vi.fn();
  const mockPerfTracker = { onUserPrompt } as any;
  const handler = new HookHandler(store, resolver, undefined, mockPerfTracker);

  await handler.handle({
    event_type: "user_prompt",
    cwd: "d:\\code\\test",
    session_uuid: "uuid-perf-1",
    timestamp: 99000,
  });

  expect(onUserPrompt).toHaveBeenCalledWith("uuid-perf-1", 99000);
});
```

- [ ] **Step 3: Run the new test to confirm it fails**

```
pnpm test tests/hook-handler.test.ts
```
Expected: FAIL — "Expected 1 call, received 0"

- [ ] **Step 4: Modify HookHandler to accept and call PerfTracker**

In `src/hook-handler.ts`, change the constructor and `handle` method:

```typescript
// Add import at top
import type { PerfTracker } from "./perf-tracker.js";

// Change constructor signature
export class HookHandler {
  constructor(
    private store: SessionStore,
    private resolver: SessionResolver,
    private notifier?: Notifier,
    private perfTracker?: PerfTracker,  // ← add this
  ) {}

  async handle(ev: HookEvent): Promise<void> {
    // ... existing code unchanged until after this.store.upsert(next) ...
    this.store.upsert(next);

    // ← Add after upsert:
    if (ev.event_type === "user_prompt" && sessionUuid && this.perfTracker) {
      this.perfTracker.onUserPrompt(sessionUuid, ev.timestamp);
    }

    // ... rest of existing code (notifier block) unchanged ...
  }
}
```

- [ ] **Step 5: Run all hook-handler tests**

```
pnpm test tests/hook-handler.test.ts
```
Expected: all PASS (including new one)

- [ ] **Step 6: Commit**

```
git add src/hook-handler.ts tests/hook-handler.test.ts
git commit -m "feat: wire PerfTracker.onUserPrompt into HookHandler"
```

---

## Task 4: Wire PerfTracker into server.ts WS handler + `/metrics` endpoint

**Files:**
- Modify: `src/server.ts` (two changes: delta WS interception + new route)

- [ ] **Step 1: Find where to inject PerfTracker in server deps**

Look at the `createServer` function signature / deps type in `src/server.ts`. Find the `ServerDeps` interface (or equivalent). Add `perfTracker?: PerfTracker` to it.

```typescript
// In the deps interface / type (search for "store:" in server.ts to find it):
perfTracker?: import("./perf-tracker.js").PerfTracker;
```

- [ ] **Step 2: Intercept delta events in the WrapWS message handler**

Find line ~1113 in `src/server.ts`:
```typescript
} else if ((m?.type === "assistant_delta" || m?.type === "assistant_delta_start" || m?.type === "assistant_delta_end") && typeof m.session_uuid === "string") {
  // Streaming text deltas from the SDK partial-message stream. Just
  // pass-through to all dashboard WS clients...
  const out = JSON.stringify(m);
  for (const c of wss.clients) {
    if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
  }
```

Replace with:
```typescript
} else if ((m?.type === "assistant_delta" || m?.type === "assistant_delta_start" || m?.type === "assistant_delta_end") && typeof m.session_uuid === "string") {
  const pt = deps.perfTracker;
  if (pt) {
    if (m.type === "assistant_delta_start") pt.onDeltaStart(m.session_uuid);
    else if (m.type === "assistant_delta" && typeof m.text === "string") pt.onDelta(m.session_uuid, m.text);
    else if (m.type === "assistant_delta_end") pt.onDeltaEnd(m.session_uuid);
  }
  const out = JSON.stringify(m);
  for (const c of wss.clients) {
    if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
  }
```

- [ ] **Step 3: Add `GET /metrics` endpoint**

Add this route in `src/server.ts` near the other `GET` routes (e.g. after `GET /sessions`):

```typescript
app.get("/metrics", (req: Request, res: Response) => {
  const perfStore = (deps as any).__perfStore as import("./perf-store.js").PerfStore | undefined;
  if (!perfStore) { res.status(501).json({ error: "metrics_unavailable" }); return; }

  const WINDOWS: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "48h": 48 };
  const windowKey = typeof req.query.window === "string" ? req.query.window : "24h";
  const hours = WINDOWS[windowKey] ?? 24;
  const windowMs = hours * 60 * 60 * 1000;
  const now = Date.now();
  const fromTs = now - windowMs;

  const metrics = perfStore.query(fromTs, now);
  const fleet = perfStore.fleetAvg(fromTs, now);

  res.json({
    metrics,
    fleet_avg_ttft: fleet.avg_ttft,
    fleet_avg_tps: fleet.avg_tps,
    window_ms: windowMs,
  });
});
```

- [ ] **Step 4: Expose `__perfStore` in server deps**

In `src/index.ts` (or wherever `createServer` is called), when constructing the server deps, add:

```typescript
// After constructing PerfStore and PerfTracker:
import { PerfStore } from "./perf-store.js";
import { PerfTracker } from "./perf-tracker.js";
import { DB_FILE } from "./data-dir.js";

const perfStore = new PerfStore(DB_FILE);
const perfTracker = new PerfTracker(perfStore);

// Pass to createServer deps:
const serverDeps = {
  store,
  handler,
  // ... existing deps ...
  perfTracker,
  __perfStore: perfStore,   // accessed by /metrics route
};
```

Also pass `perfTracker` to `HookHandler` constructor:
```typescript
const handler = new HookHandler(store, resolver, notifier, perfTracker);
```

- [ ] **Step 5: Run typecheck**

```
pnpm typecheck
```
Expected: no errors

- [ ] **Step 6: Run full test suite**

```
pnpm test
```
Expected: all existing tests PASS (new deps are optional so existing tests won't break)

- [ ] **Step 7: Commit**

```
git add src/server.ts src/index.ts
git commit -m "feat: wire PerfTracker into server delta events and add GET /metrics"
```

---

## Task 5: Web — Monit button + MonitPanel + SVG charts

**Files:**
- Modify: `web/app.tsx` (add ~250 lines near end of file)

This task adds three components inline in `app.tsx` following the existing pattern (all icons and components are defined inline there):

1. `IconMonit` — SVG icon for the button
2. `MetricChart` — reusable SVG trend chart with fleet-avg colouring
3. `MonitPanel` — overlay panel with window selector and two charts

- [ ] **Step 1: Add `IconMonit` SVG**

In `web/app.tsx`, find the last icon definition (search for the last `function Icon` before the main `App` component) and add after it:

```tsx
function IconMonit({ size = 20, class: cls = "" }: { size?: number; class?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" class={cls}
         xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="4" width="16" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
      <path d="M5 11 L7.5 8 L10 10 L13 6.5 L15 8.5" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="7" y1="16" x2="13" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  );
}
```

- [ ] **Step 2: Add `MetricChart` component**

Add this pure-SVG chart component in `web/app.tsx` (before the `App` component):

```tsx
interface MetricPoint { ts: number; value: number; }

function MetricChart({
  data,
  fleetAvg,
  label,
  unit,
  higherIsBetter,
}: {
  data: MetricPoint[];
  fleetAvg: number | null;
  label: string;
  unit: string;
  higherIsBetter: boolean;
}) {
  const W = 340, H = 90, PAD_L = 0, PAD_B = 0;

  if (data.length === 0) {
    return (
      <div class="flex flex-col gap-1">
        <div class="text-xs text-neutral-400 font-medium">{label}</div>
        <div class="flex items-center justify-center h-[90px] text-xs text-neutral-500">暫無資料</div>
      </div>
    );
  }

  const xs = data.map(d => d.ts);
  const ys = data.map(d => d.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = 0, maxY = Math.max(...ys) * 1.25 || 1;

  const scaleX = (ts: number) => PAD_L + ((ts - minX) / (maxX - minX || 1)) * (W - PAD_L);
  const scaleY = (v: number) => H - PAD_B - ((v - minY) / (maxY - minY)) * (H - PAD_B);

  const pts = data.map(d => ({ x: scaleX(d.ts), y: scaleY(d.value), v: d.value }));
  const avgY = fleetAvg !== null ? scaleY(fleetAvg) : null;

  // Build coloured area segments (above / below avg)
  function buildAreaPath(points: typeof pts, above: boolean): string {
    if (avgY === null || points.length < 2) return "";
    const segs: Array<typeof pts> = [];
    let cur: typeof pts = [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i]!;
      const isAbove = pt.y < avgY; // SVG Y is inverted
      if ((above && isAbove) || (!above && !isAbove)) {
        cur.push(pt);
      } else {
        if (cur.length >= 1) segs.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 1) segs.push(cur);

    return segs.map(seg => {
      if (seg.length === 1) return "";
      const top = seg.map(p => `${p.x},${p.y}`).join(" ");
      const bot = `${seg[seg.length - 1]!.x},${avgY} ${seg[0]!.x},${avgY}`;
      return `M ${seg[0]!.x},${avgY} L ${top} L ${bot} Z`;
    }).join(" ");
  }

  const greenPath = buildAreaPath(pts, higherIsBetter ? true : false);
  const redPath   = buildAreaPath(pts, higherIsBetter ? false : true);
  const linePts = pts.map(p => `${p.x},${p.y}`).join(" ");

  const lastVal = data[data.length - 1]?.value ?? 0;
  const fmt = (v: number) => unit === "ms" ? `${Math.round(v)}ms` : `${v.toFixed(1)}/s`;

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between">
        <span class="text-xs text-neutral-400 font-medium">{label}</span>
        <span class="text-xs text-neutral-300 tabular-nums">{fmt(lastVal)}</span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="overflow-visible">
        {/* Fleet avg dashed line */}
        {avgY !== null && (
          <line x1={0} y1={avgY} x2={W} y2={avgY}
                stroke="#60a5fa" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>
        )}
        {/* Coloured area */}
        {greenPath && <path d={greenPath} fill="#22c55e" opacity="0.25"/>}
        {redPath   && <path d={redPath}   fill="#ef4444" opacity="0.25"/>}
        {/* Main line */}
        <polyline points={linePts} fill="none" stroke="#d4d4d4" stroke-width="1.5"
                  stroke-linejoin="round" stroke-linecap="round"/>
        {/* Last dot */}
        {pts.length > 0 && (
          <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y}
                  r="2.5" fill="#d4d4d4"/>
        )}
      </svg>
      {avgY !== null && fleetAvg !== null && (
        <div class="flex items-center gap-3 text-[10px] text-neutral-500">
          <span class="flex items-center gap-1">
            <span class="inline-block w-2 h-2 rounded-sm bg-green-500 opacity-60"/>
            {higherIsBetter ? "超越" : "超越"}
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block w-2 h-2 rounded-sm bg-red-500 opacity-60"/>
            落後
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block w-4 border-t border-dashed border-blue-400 opacity-70"/>
            fleet 平均 ({fmt(fleetAvg)})
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add `MonitPanel` component**

Add this component in `web/app.tsx` (after `MetricChart`, before `App`):

```tsx
type MetricWindow = "1h" | "6h" | "24h" | "48h";

interface MetricsApiRow {
  ts: number; session_uuid: string;
  ttft_ms: number | null; tps: number | null;
  char_count: number; duration_ms: number;
}

interface MetricsApiResponse {
  metrics: MetricsApiRow[];
  fleet_avg_ttft: number | null;
  fleet_avg_tps: number | null;
  window_ms: number;
}

function MonitPanel({ onClose }: { onClose: () => void }) {
  const [window_, setWindow] = useState<MetricWindow>("24h");
  const [data, setData] = useState<MetricsApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/metrics?window=${window_}`)
      .then(r => r.json())
      .then((d: MetricsApiResponse) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [window_]);

  const ttftPoints: MetricPoint[] = (data?.metrics ?? [])
    .filter(m => m.ttft_ms !== null)
    .map(m => ({ ts: m.ts, value: m.ttft_ms! }));

  const tpsPoints: MetricPoint[] = (data?.metrics ?? [])
    .filter(m => m.tps !== null)
    .map(m => ({ ts: m.ts, value: m.tps! }));

  const WINDOWS: MetricWindow[] = ["1h", "6h", "24h", "48h"];

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-end pointer-events-none">
      <div class="pointer-events-auto mt-14 mr-2 w-[400px] bg-neutral-900 border border-neutral-700
                  rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div class="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <span class="text-sm font-medium text-neutral-200">效能監控</span>
          <div class="flex items-center gap-3">
            {/* Window selector */}
            <div class="flex gap-1">
              {WINDOWS.map(w => (
                <button key={w}
                  class={`px-2 py-0.5 rounded text-xs transition-colors ${
                    window_ === w
                      ? "bg-neutral-600 text-white"
                      : "text-neutral-400 hover:text-neutral-200"
                  }`}
                  onClick={() => setWindow(w)}>
                  {w}
                </button>
              ))}
            </div>
            <button onClick={onClose} class="text-neutral-400 hover:text-neutral-200 transition-colors">
              <IconX size={16}/>
            </button>
          </div>
        </div>
        {/* Charts */}
        <div class="p-4 flex flex-col gap-6">
          {loading ? (
            <div class="flex items-center justify-center h-24 text-xs text-neutral-500">載入中…</div>
          ) : (
            <>
              <MetricChart
                data={ttftPoints}
                fleetAvg={data?.fleet_avg_ttft ?? null}
                label="TTFT 趨勢"
                unit="ms"
                higherIsBetter={false}
              />
              <MetricChart
                data={tpsPoints}
                fleetAvg={data?.fleet_avg_tps ?? null}
                label="TPS 趨勢"
                unit="/s"
                higherIsBetter={true}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add state and button to App component**

In the `App` component's state section, add:
```tsx
const [monitOpen, setMonitOpen] = useState(false);
```

In the header right-side buttons area (near `NewCliButton` / `IconSettings`), add:
```tsx
<button
  class="p-1.5 rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 transition-colors"
  title="效能監控"
  onClick={() => setMonitOpen(v => !v)}>
  <IconMonit size={18}/>
</button>
```

At the bottom of the App's return JSX (before the closing tag), add:
```tsx
{monitOpen && <MonitPanel onClose={() => setMonitOpen(false)}/>}
```

- [ ] **Step 5: Build and verify no type errors**

```
pnpm typecheck
pnpm build:all
```
Expected: clean build, no type errors

- [ ] **Step 6: Manual smoke test**

```
pnpm dev:all
# Open http://127.0.0.1:8765
# Click the Monit icon button in header
# Panel opens, shows "暫無資料" (no data yet since no turns have run)
# Click 1h/6h/24h/48h tabs — no errors in console
```

- [ ] **Step 7: Commit**

```
git add web/app.tsx
git commit -m "feat: add Monit panel with TTFT/TPS SVG trend charts"
```

---

## Task 6: Integration smoke test

- [ ] **Step 1: Run a full turn through the system**

```
pnpm dev
# In a second terminal, simulate events:
curl -X POST http://127.0.0.1:8766/event \
  -H "Content-Type: application/json" \
  -d '{"event_type":"user_prompt","cwd":"d:\\code\\test","session_uuid":"smoke-1","timestamp":'$(date +%s000)'}'
```

- [ ] **Step 2: Verify `/metrics` returns data after a wrapped session turn completes**

After running a real `miki claude` wrapped session and completing one turn:

```
curl "http://127.0.0.1:8765/metrics?window=1h" | jq '.metrics | length'
```
Expected: `1` (or more if multiple turns ran)

- [ ] **Step 3: Run full test suite one final time**

```
pnpm test && pnpm typecheck
```
Expected: all PASS

- [ ] **Step 4: Final commit**

```
git add -A
git commit -m "feat: TTFT/TPS monitoring complete — PerfStore + PerfTracker + Monit panel"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| TTFT per turn | Task 2 (PerfTracker), Task 3 (delta_start timing) |
| TPS per turn | Task 2 (char accumulation), Task 3 (delta_end calc) |
| 48h rolling window | Task 1 (PerfStore.deleteOlderThan), Task 2 (RETENTION_MS) |
| `/metrics` API with window param | Task 4 |
| Fleet average line | Task 1 (fleetAvg), Task 5 (MetricChart dashed line) |
| Green/red area colouring | Task 5 (MetricChart buildAreaPath) |
| Time window switcher (1h/6h/24h/48h) | Task 5 (MonitPanel WINDOWS) |
| Monit button in header | Task 5 (App state + button) |
| Non-wrapped hook sessions get TTFT | Task 3 (HookHandler.onUserPrompt) |
| No new npm dependencies | All tasks — pure SVG, better-sqlite3 already present |

### Placeholder check

None found — all steps contain complete code.

### Type consistency

- `PerfMetricRow` defined in `perf-store.ts`, used in `perf-tracker.ts` via import ✓
- `PerfTracker` optional in `HookHandler` constructor and server deps ✓
- `MetricPoint` interface defined before `MetricChart` uses it ✓
- `MetricsApiRow` / `MetricsApiResponse` defined before `MonitPanel` uses them ✓
