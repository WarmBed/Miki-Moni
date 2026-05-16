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
