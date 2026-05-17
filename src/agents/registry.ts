import type { AgentAdapter, AgentId } from "./types.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { CodexAdapter } from "./codex/adapter.js";

const adapters: Record<AgentId, AgentAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};

export function getAdapter(id: AgentId): AgentAdapter {
  return adapters[id];
}

export function allAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
