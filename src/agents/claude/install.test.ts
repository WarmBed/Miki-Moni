import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { installClaudeHooks } from "./install.js";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

describe("installClaudeHooks", () => {
  let savedSettings: string | null = null;
  let savedBackup: string | null = null;

  beforeEach(async () => {
    try { savedSettings = await fs.readFile(SETTINGS_PATH, "utf8"); } catch { savedSettings = null; }
    try { savedBackup = await fs.readFile(SETTINGS_PATH + ".miki-moni.bak", "utf8"); } catch { savedBackup = null; }
  });

  afterEach(async () => {
    if (savedSettings === null) { await fs.rm(SETTINGS_PATH, { force: true }); }
    else { await fs.writeFile(SETTINGS_PATH, savedSettings); }
    if (savedBackup === null) { await fs.rm(SETTINGS_PATH + ".miki-moni.bak", { force: true }); }
    else { await fs.writeFile(SETTINGS_PATH + ".miki-moni.bak", savedBackup); }
  });

  it("installs all 5 hook targets and is idempotent", async () => {
    const r1 = await installClaudeHooks();
    expect(r1.installed).toBe(true);
    const s1 = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf8"));
    expect(Object.keys(s1.hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse"]),
    );
    const r2 = await installClaudeHooks();
    expect(r2.installed).toBe(true);
    const s2 = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf8"));
    for (const k of Object.keys(s1.hooks)) {
      expect(s2.hooks[k].length).toBe(s1.hooks[k].length);
    }
  });
});
