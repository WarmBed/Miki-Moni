import type { AgentAdapter, AgentId, InstallResult, WrapArgs, InternalEvent } from "../types.js";
import { installClaudeHooks } from "./install.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = "claude";

  async installHooks(): Promise<InstallResult> {
    return installClaudeHooks();
  }

  async uninstallHooks(): Promise<void> {
    throw new Error("ClaudeAdapter.uninstallHooks not implemented");
  }

  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *wrap(_args: WrapArgs): AsyncIterable<InternalEvent> {
    throw new Error("ClaudeAdapter.wrap not yet migrated");
  }
}
