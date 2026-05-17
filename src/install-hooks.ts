import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
// Resolve the hook script relative to THIS source file, not the current
// working directory. After a global `npm install -g miki-moni` the user
// will run `miki install-hooks` from anywhere — process.cwd() is no longer
// the cc-hub repo so `path.resolve("hooks", ...)` would point at the wrong
// place. Module-relative gives us the package's own hooks/ dir.
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT_ABS = path.resolve(_moduleDir, "..", "hooks", "miki-emit.ps1");
const MARKER = "miki-emit.ps1";
// Legacy markers from pre-rename installs. Any hook group whose command
// references one of these is stripped before we install the current entry —
// otherwise upgrade-and-rerun produces two hooks firing per event.
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
    console.error(`Could not parse ${SETTINGS_PATH} — file is not valid JSON.`);
    console.error(`Original error: ${(err as Error).message}`);
    console.error(`Fix the file by hand (or restore from a backup), then re-run install:hooks.`);
    process.exit(1);
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
  // Drop legacy entries first so a re-install after rename doesn't double-fire.
  hooks[key] = hooks[key].filter((g) => !isLegacyGroup(g));
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
  const backup = SETTINGS_PATH + ".miki-moni.bak";
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
