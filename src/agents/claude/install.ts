// src/agents/claude/install.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { InstallResult } from "../types.js";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
// Was: ../hooks/miki-emit.ps1 from src/. Now we're one dir deeper (src/agents/claude/).
const HOOK_SCRIPT_ABS = path.resolve(_moduleDir, "..", "..", "..", "hooks", "miki-emit.ps1");
const MARKER = "miki-emit.ps1";
const LEGACY_MARKERS = ["cc-hub-emit.ps1"];

const TARGETS: Array<{ key: string; matcher?: string }> = [
  { key: "SessionStart" },
  { key: "Stop" },
  { key: "UserPromptSubmit" },
  { key: "PreToolUse", matcher: ".*" },
  { key: "PostToolUse", matcher: ".*" },
];

function commandFor(eventName: string): string {
  return `powershell -NoProfile -File "${HOOK_SCRIPT_ABS}" ${eventName}`;
}

async function readSettings(): Promise<Record<string, any>> {
  let raw: string;
  try {
    raw = await fs.readFile(SETTINGS_PATH, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Could not parse ${SETTINGS_PATH} — file is not valid JSON. ` +
      `Fix the file by hand (or restore from a backup), then re-run install:hooks. ` +
      `Original error: ${(err as Error).message}`,
    );
  }
}

async function writeSettings(s: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function isLegacyGroup(g: any): boolean {
  if (!Array.isArray(g?.hooks)) return false;
  return g.hooks.some((h: any) =>
    typeof h?.command === "string" && LEGACY_MARKERS.some((m) => h.command.includes(m)),
  );
}

function ensureHookEntry(
  hooks: Record<string, any[]>,
  key: string,
  matcher: string | undefined,
  command: string,
): void {
  if (!Array.isArray(hooks[key])) hooks[key] = [];
  hooks[key] = hooks[key].filter((g) => !isLegacyGroup(g));
  const groups = hooks[key];
  for (const g of groups) {
    if (Array.isArray(g.hooks)) {
      for (const h of g.hooks) {
        if (typeof h.command === "string" && h.command.includes(MARKER)) return;
      }
    }
  }
  const newGroup: Record<string, any> = { hooks: [{ type: "command", command }] };
  if (matcher) newGroup.matcher = matcher;
  groups.push(newGroup);
}

export async function installClaudeHooks(): Promise<InstallResult> {
  const settings = await readSettings();
  const backup = SETTINGS_PATH + ".miki-moni.bak";
  try { await fs.access(backup); }
  catch { try { await fs.copyFile(SETTINGS_PATH, backup); } catch { /* no original yet */ } }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  for (const t of TARGETS) {
    ensureHookEntry(settings.hooks, t.key, t.matcher, commandFor(t.key));
  }
  await writeSettings(settings);
  return { installed: true, backupPath: backup };
}
