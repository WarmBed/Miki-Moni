// src/agents/types.ts
export type AgentId = "claude" | "codex";

export interface InstallResult {
  installed: boolean;          // true if we wrote (or were already correctly set up); false on skip
  warning?: string;            // human-readable reason for skip
  backupPath?: string;
}

export interface WrapArgs {
  sessionUuid: string;
  cwd: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface InternalEvent {
  type: "message" | "tool_use" | "tool_result" | "turn_start" | "turn_end" | "error";
  payload: unknown;
}

export interface AgentAdapter {
  readonly id: AgentId;
  installHooks(): Promise<InstallResult>;
  uninstallHooks(): Promise<void>;
  wrap(args: WrapArgs): AsyncIterable<InternalEvent>;
}
