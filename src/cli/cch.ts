#!/usr/bin/env node
// `cch` — cc-hub CLI dispatcher.
// Subcommands:
//   cch claude [args]   → wrap Claude in a persistent SDK query() so cc-hub
//                          daemon can push prompts mid-session without -p
async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "claude") {
    await import("./wrap.js");
    return;
  }
  console.error("usage: cch <subcommand>");
  console.error("");
  console.error("subcommands:");
  console.error("  claude [-c | -r <uuid>] [--model X] [--bypass-permissions]");
  console.error("           Wrap a Claude Code session so cc-hub dashboard can push");
  console.error("           prompts into it in real time (no `claude -p` re-spawn).");
  process.exit(1);
}
main();
