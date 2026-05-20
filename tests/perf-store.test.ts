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
