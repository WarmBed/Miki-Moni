import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const installerPath = path.resolve(__dirname, "..", "src", "install-hooks.ts");

function runInstaller(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["tsx", installerPath], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function makePaths(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = {
    claudeSettings: path.join(dir, "claude", "settings.json"),
    codexConfig: path.join(dir, "codex", "config.toml"),
  };
  await mkdir(path.dirname(paths.claudeSettings), { recursive: true });
  await mkdir(path.dirname(paths.codexConfig), { recursive: true });
  return paths;
}

describe("install-hooks", () => {
  it("installs Claude hooks and Codex notify into empty configs", async () => {
    const paths = await makePaths("miki-install-hooks-");
    const result = await runInstaller({
      MIKI_CLAUDE_SETTINGS_PATH: paths.claudeSettings,
      MIKI_CODEX_CONFIG_PATH: paths.codexConfig,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await readFile(paths.claudeSettings, "utf8")).hooks.SessionStart[0].hooks[0].command)
      .toContain("miki-emit.ps1");
    expect(await readFile(paths.codexConfig, "utf8")).toContain("miki-emit-codex.mjs");
  });

  it("keeps an existing matching Codex notify config unchanged", async () => {
    const paths = await makePaths("miki-install-hooks-present-");
    const existing = 'notify = ["node", "D:\\\\code\\\\cc-hub\\\\hooks\\\\miki-emit-codex.mjs"]\n';
    await writeFile(paths.codexConfig, existing);
    const result = await runInstaller({
      MIKI_CLAUDE_SETTINGS_PATH: paths.claudeSettings,
      MIKI_CODEX_CONFIG_PATH: paths.codexConfig,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readFile(paths.codexConfig, "utf8")).toBe(existing);
  });

  it("does not overwrite a different existing Codex notify command", async () => {
    const paths = await makePaths("miki-install-hooks-conflict-");
    const existing = 'notify = ["node", "custom-notify.mjs"]\n';
    await writeFile(paths.codexConfig, existing);
    const result = await runInstaller({
      MIKI_CLAUDE_SETTINGS_PATH: paths.claudeSettings,
      MIKI_CODEX_CONFIG_PATH: paths.codexConfig,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("already defines notify");
    expect(await readFile(paths.codexConfig, "utf8")).toBe(existing);
    await expect(stat(paths.codexConfig + ".miki-moni.bak")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
