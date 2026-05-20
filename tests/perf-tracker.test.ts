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
