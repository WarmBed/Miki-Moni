#!/usr/bin/env node
/**
 * Package the miki-helper VSCode extension into a .vsix and install it
 * into the user's local VSCode (`code --install-extension`).
 *
 * Idempotent — uses `--force` to overwrite any existing install. Re-run this
 * after editing extension/src/* to deploy changes.
 */
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, "..", "extension");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // For npm/code commands on Windows, don't use shell to avoid path quoting issues
    const useShell = opts.shell !== false && !cmd.includes("code");
    const child = spawn(cmd, args, { stdio: "inherit", shell: useShell, ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on("error", reject);
  });
}

function findCodePath() {
  try {
    // Try to find code.cmd in PATH (handles spaces in path better)
    if (process.platform === "win32") {
      const result = execSync("where code.cmd", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      if (result) return result.split("\n")[0];
    }
    // Fallback: try 'code'
    const result = execSync("where code", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (result) return result.split("\n")[0];
  } catch {}
  return "code"; // fallback
}

async function installExtension(vsixPath) {
  return new Promise((resolve, reject) => {
    const codePath = findCodePath();
    // Use shell for code command to properly resolve the path
    const child = spawn("cmd", ["/c", codePath, "--install-extension", vsixPath, "--force"], {
      stdio: "inherit",
      shell: false,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`code exited ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  console.log(`[install-helper] extension dir: ${extDir}`);

  console.log("[install-helper] compiling TypeScript…");
  await run("npm", ["run", "compile"], { cwd: extDir });

  console.log("[install-helper] packaging VSIX…");
  await run("npm", ["run", "package"], { cwd: extDir });

  const entries = await readdir(extDir);
  const vsixes = entries.filter((e) => e.endsWith(".vsix"));
  if (vsixes.length === 0) throw new Error("no .vsix produced in extension/");
  const withMtime = await Promise.all(
    vsixes.map(async (f) => ({ f, mtime: (await stat(path.join(extDir, f))).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const vsix = path.join(extDir, withMtime[0].f);
  console.log(`[install-helper] installing: ${vsix}`);

  await installExtension(vsix);

  console.log("");
  console.log("✅ miki-helper installed. Restart your VSCode windows to activate it.");
  console.log("   Then in the dashboard, click 送出 to verify prompts reach the right Claude panel.");
}

main().catch((err) => { console.error("[install-helper] failed:", err.message); process.exit(1); });
