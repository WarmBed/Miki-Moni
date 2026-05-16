import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HOOK_SCRIPT_ABS = path.resolve("hooks", "cc-hub-emit.ps1");
const MARKER = "cc-hub-emit.ps1";

const TARGETS: Array<{ key: string; matcher?: string }> = [
  { key: "SessionStart" },
  { key: "Stop" },
  { key: "UserPromptSubmit" },
  { key: "PreToolUse", matcher: ".*" },
  { key: "PostToolUse", matcher: ".*" },
];

function commandFor(eventName: string): string {
  return `powershell -NoProfile -File ${HOOK_SCRIPT_ABS} ${eventName}`;
}

async function readSettings(): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeSettings(s: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function ensureHookEntry(
  hooks: Record<string, any[]>,
  key: string,
  matcher: string | undefined,
  command: string,
): void {
  if (!Array.isArray(hooks[key])) hooks[key] = [];
  const groups = hooks[key];

  for (const g of groups) {
    if (Array.isArray(g.hooks)) {
      for (const h of g.hooks) {
        if (typeof h.command === "string" && h.command.includes(MARKER)) return;  // already present
      }
    }
  }

  const newGroup: Record<string, any> = { hooks: [{ type: "command", command }] };
  if (matcher) newGroup.matcher = matcher;
  groups.push(newGroup);
}

async function main(): Promise<void> {
  const settings = await readSettings();

  // Backup once
  const backup = SETTINGS_PATH + ".cc-hub.bak";
  try { await fs.access(backup); }
  catch { try { await fs.copyFile(SETTINGS_PATH, backup); } catch { /* no original yet */ } }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  for (const t of TARGETS) {
    ensureHookEntry(settings.hooks, t.key, t.matcher, commandFor(t.key));
  }

  await writeSettings(settings);
  console.log(`Hooks installed to ${SETTINGS_PATH}`);
  console.log(`Backup at ${backup}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
