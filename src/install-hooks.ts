// src/install-hooks.ts
import { allAdapters } from "./agents/registry.js";

async function main(): Promise<void> {
  for (const adapter of allAdapters()) {
    try {
      const result = await adapter.installHooks();
      if (result.installed) {
        console.log(`[${adapter.id}] hooks installed${result.backupPath ? ` (backup: ${result.backupPath})` : ""}`);
      } else {
        console.log(`[${adapter.id}] skipped: ${result.warning ?? "no reason given"}`);
      }
    } catch (err) {
      console.error(`[${adapter.id}] install failed:`, err);
      process.exitCode = 1;
    }
  }
}

main();
