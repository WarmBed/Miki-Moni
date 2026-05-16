export type SessionStatus = "active" | "waiting" | "idle" | "stale";

export interface Session {
  cwd: string;                  // primary key, e.g. "d:\\code\\dragonfly"
  session_uuid: string | null;
  project_name: string;
  status: SessionStatus;
  last_event_at: number;        // unix ms
  last_message_preview: string;
  tokens_in: number;
  tokens_out: number;
  vscode_pid: number | null;
}

export type HookEventType =
  | "session_start"
  | "stop"
  | "user_prompt"
  | "pre_tool_use"
  | "post_tool_use";

export interface HookEvent {
  event_type: HookEventType;
  cwd: string;
  session_uuid: string | null;
  timestamp: number;
  extra?: Record<string, unknown>;
}

export interface StoreEvents {
  session_changed: (session: Session) => void;
}
