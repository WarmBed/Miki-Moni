import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import type { Session, StoreEvents } from "./types.js";

// v2 schema: PK is session_uuid (one row per Claude session, not per workspace).
// Multiple sessions per cwd are supported (e.g. 3 Claude tabs in the same VSCode workspace).
const SCHEMA_VERSION = 2;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
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
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_last_event ON sessions(last_event_at);
`;

const UPSERT_SQL = `
INSERT INTO sessions (session_uuid, cwd, project_name, status, last_event_at,
                     last_message_preview, tokens_in, tokens_out, vscode_pid)
VALUES (@session_uuid, @cwd, @project_name, @status, @last_event_at,
        @last_message_preview, @tokens_in, @tokens_out, @vscode_pid)
ON CONFLICT(session_uuid) DO UPDATE SET
  cwd = excluded.cwd,
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
    this.migrateIfNeeded();
    this.db.exec(CREATE_SQL);
  }

  /**
   * If the existing DB has an old schema (v1, where PK was cwd), drop the table.
   * Data loss is acceptable here — session state rebuilds from incoming hooks within seconds.
   */
  private migrateIfNeeded(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);`);
    const row = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as { version?: number } | undefined;
    const currentVersion = row?.version ?? 1;
    if (currentVersion !== SCHEMA_VERSION) {
      this.db.exec(`DROP TABLE IF EXISTS sessions;`);
      this.db.exec(`DELETE FROM schema_meta;`);
      this.db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
    }
  }

  /**
   * Upsert a session. `session.session_uuid` MUST be non-null (the PK).
   * Throws if null — callers should drop events without session_uuid.
   */
  upsert(session: Session): void {
    if (!session.session_uuid) {
      throw new Error("SessionStore.upsert: session_uuid is required (cannot be null)");
    }
    this.db.prepare(UPSERT_SQL).run(session);
    this.emit("session_changed", session);
  }

  /** Get by session_uuid (primary key). */
  get(sessionUuid: string): Session | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE session_uuid = ?").get(sessionUuid) as Session | undefined;
  }

  /** Get all sessions for a given cwd (may be multiple — e.g. 3 Claude tabs in the same workspace). */
  getByCwd(cwd: string): Session[] {
    return this.db.prepare("SELECT * FROM sessions WHERE cwd = ? ORDER BY last_event_at DESC").all(cwd) as Session[];
  }

  list(): Session[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY last_event_at DESC").all() as Session[];
  }

  close(): void {
    this.db.close();
  }
}
