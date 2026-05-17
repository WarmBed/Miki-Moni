import type { AgentAdapter, AgentId, InstallResult, WrapArgs, InternalEvent } from "../types.js";
import { installCodexHooks } from "./install.js";

export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = "codex";

  async installHooks(): Promise<InstallResult> {
    return installCodexHooks();
  }

  async uninstallHooks(): Promise<void> { /* Phase 6 */ }

  // eslint-disable-next-line require-yield, @typescript-eslint/no-unused-vars
  async *wrap(_args: WrapArgs): AsyncIterable<InternalEvent> {
    throw new Error("CodexAdapter.wrap not yet implemented (Phase 4)");
  }
}
