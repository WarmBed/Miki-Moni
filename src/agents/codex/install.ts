import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import toml from "@iarna/toml";
import type { InstallResult } from "../types.js";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT_ABS = path.resolve(_moduleDir, "..", "..", "..", "hooks", "miki-emit-codex.mjs");
const EXPECTED_NOTIFY = ["node", HOOK_SCRIPT_ABS];

function notifyEquals(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function _installCodexHooksTo(targetPath: string): Promise<InstallResult> {
  let parsed: Record<string, unknown> = {};
  let originalText: string | null = null;
  try {
    originalText = await fs.readFile(targetPath, "utf8");
    parsed = toml.parse(originalText) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const existing = parsed.notify;
  if (existing && !notifyEquals(existing, EXPECTED_NOTIFY)) {
    return {
      installed: false,
      warning: `${targetPath} already defines notify = ${JSON.stringify(existing)}. Skipping. ` +
        `To enable Miki-Moni Codex hooks, merge manually so the array invokes ` +
        `node "${HOOK_SCRIPT_ABS}" first.`,
    };
  }

  if (notifyEquals(existing, EXPECTED_NOTIFY)) {
    return { installed: true };
  }

  parsed.notify = EXPECTED_NOTIFY;
  let backup: string | undefined;
  if (originalText !== null) {
    backup = `${targetPath}.miki-moni.bak`;
    try { await fs.access(backup); } catch { await fs.writeFile(backup, originalText); }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, toml.stringify(parsed as toml.JsonMap));
  return { installed: true, backupPath: backup };
}

export async function installCodexHooks(): Promise<InstallResult> {
  return _installCodexHooksTo(CONFIG_PATH);
}
