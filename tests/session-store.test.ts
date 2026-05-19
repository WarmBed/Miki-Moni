import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session-store.js";
import type { Session } from "../src/types.js";

const sample: Session = {
  cwd: "d:\\code\\dragonfly",
  session_uuid: "uuid-a",
  agent: "claude",
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

  it("migrates v2 databases to v3 without deleting existing sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "miki-store-v2-"));
    const dbPath = path.join(dir, "sessions.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta (version) VALUES (2);
      CREATE TABLE sessions (
        session_uuid TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        project_name TEXT NOT NULL,
        status TEXT NOT NULL,
        last_event_at INTEGER NOT NULL,
        last_message_preview TEXT NOT NULL DEFAULT '',
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        vscode_pid INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO sessions (session_uuid, cwd, project_name, status, last_event_at, last_message_preview, tokens_in, tokens_out, vscode_pid)
      VALUES ('old-uuid', 'd:\\code\\old', 'old', 'waiting', 123, '', 0, 0, NULL)
    `).run();
    db.close();

    const migrated = new SessionStore(dbPath);
    expect(migrated.get("old-uuid")).toMatchObject({
      session_uuid: "old-uuid",
      agent: "claude",
      cwd: "d:\\code\\old",
      status: "waiting",
    });
    migrated.close();
  });
});
