import type { AgentAdapter, AgentId, InstallResult, WrapArgs, InternalEvent } from "../types.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = "claude";

  async installHooks(): Promise<InstallResult> {
    // Phase 1.3 moves the existing install-hooks.ts logic here.
    throw new Error("ClaudeAdapter.installHooks not yet migrated");
  }

  async uninstallHooks(): Promise<void> {
    throw new Error("ClaudeAdapter.uninstallHooks not implemented");
  }

  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *wrap(_args: WrapArgs): AsyncIterable<InternalEvent> {
    // Phase 4 moves wrap-process.ts logic here.
    throw new Error("ClaudeAdapter.wrap not yet migrated");
  }
}
