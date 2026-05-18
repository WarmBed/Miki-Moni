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
