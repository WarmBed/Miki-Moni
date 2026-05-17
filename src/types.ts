export type { AgentId } from "./agents/types.js";
import type { AgentId } from "./agents/types.js";

export type SessionStatus = "active" | "waiting" | "idle" | "stale";

export interface Session {
  agent: AgentId;
  cwd: string;
  session_uuid: string | null;
  project_name: string;
  status: SessionStatus;
  last_event_at: number;
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
  agent: AgentId;
  event_type: HookEventType;
  cwd: string;
  session_uuid: string | null;
  timestamp: number;
  extra?: Record<string, unknown>;
}

export interface StoreEvents {
  session_changed: (session: Session) => void;
  session_removed: (sessionUuid: string) => void;
}
