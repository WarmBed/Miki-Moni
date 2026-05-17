#!/usr/bin/env node
// `miki` global CLI shim.
//
// After `npm link` (run once from the cc-hub repo), this file is reachable
// on PATH as `miki`. We invoke `node` directly with tsx as an ESM loader,
// avoiding the `.cmd` shim — Node 24+ forbids spawning .cmd/.bat for
// security, so we point at tsx's own JS entry instead.
//
// process.cwd() is preserved by inherit: subcommand logic (e.g. miki claude →
// findLatestSessionInCwd) reads process.cwd() from the spawned child, which
// inherits the caller's directory. That's the whole point — `miki claude`
// from anywhere acts on that anywhere's cwd.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const target = path.join(projectRoot, "src", "cli", "miki.ts");

// Resolve tsx's JS entry via its package.json — works regardless of pnpm's
// .pnpm-store layout or Windows path quirks. tsx's `bin` is a plain string
// pointing at its real .mjs CLI entry; older packages use `bin: { name: path }`
// so we handle both shapes. Spawning that with node skips the .cmd wrapper
// entirely (Node 24 forbids .cmd spawn).
const require = createRequire(import.meta.url);
const tsxPkgPath = require.resolve("tsx/package.json", { paths: [projectRoot] });
const tsxPkg = require(tsxPkgPath);
const tsxBinRel = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx;
if (!tsxBinRel) {
  console.error(`miki: could not locate tsx CLI entry in ${tsxPkgPath}`);
  process.exit(1);
}
const tsxBin = path.join(path.dirname(tsxPkgPath), tsxBinRel);

const child = spawn(process.execPath, [tsxBin, target, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error(`miki: failed to spawn node\n${err.message}`);
  process.exit(1);
});
