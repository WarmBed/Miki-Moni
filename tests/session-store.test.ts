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
