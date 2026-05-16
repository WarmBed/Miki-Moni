import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../src/session-store.js";
import type { Session } from "../src/types.js";

const sample: Session = {
  cwd: "d:\\code\\dragonfly",
  session_uuid: "uuid-a",
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

  it("upserts a session by session_uuid", () => {
    store.upsert(sample);
    expect(store.get(sample.session_uuid!)).toEqual(sample);
  });

  it("overwrites existing session on second upsert with same session_uuid", () => {
    store.upsert(sample);
    store.upsert({ ...sample, status: "waiting", last_event_at: 1715760001000 });
    expect(store.get(sample.session_uuid!)?.status).toBe("waiting");
  });

  it("supports multiple sessions per cwd (one row per session_uuid)", () => {
    store.upsert(sample);
    store.upsert({ ...sample, session_uuid: "uuid-b" });
    store.upsert({ ...sample, session_uuid: "uuid-c", cwd: "d:\\code\\openruterati", project_name: "openruterati" });
    expect(store.list()).toHaveLength(3);
    expect(store.getByCwd("d:\\code\\dragonfly")).toHaveLength(2);
    expect(store.getByCwd("d:\\code\\openruterati")).toHaveLength(1);
  });

  it("emits session_changed on upsert", () => {
    const seen: Session[] = [];
    store.on("session_changed", (s) => seen.push(s));
    store.upsert(sample);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.session_uuid).toBe(sample.session_uuid);
  });

  it("returns undefined for unknown session_uuid", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("throws when session_uuid is missing", () => {
    expect(() => store.upsert({ ...sample, session_uuid: null }))
      .toThrow(/session_uuid is required/);
  });
});
