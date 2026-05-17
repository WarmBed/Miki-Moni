// Self-host sub-wizard: spawns wrangler to deploy a worker + pages project to
// the user's own Cloudflare account, captures the resulting URLs, and writes
// them into Config.remote.
//
// Best-effort: if wrangler isn't installed, or any spawn fails, surface a
// clear message + bail back to the wizard. We never partially mutate config.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { select } from "./prompt.js";
import { t } from "./i18n-cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// data-dir / package root: src/cli/setup-self-host.ts → ../../ = repo root
// (or, when installed via npm, the package install dir).
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const WORKER_DIR = path.join(PKG_ROOT, "worker");
// Self-host uses a stripped wrangler config (no routes / custom_domain) so
// the user's deploy doesn't accidentally hijack relay.f1telemetrystationpro.org from the
// author's hosted instance when they happen to share a CF account.
const WORKER_SELFHOST_CONFIG = path.join(WORKER_DIR, "wrangler-selfhost.toml");
const PHONE_DIST = path.join(PKG_ROOT, "dist", "web-phone");

function suggestName(prefix: string): string {
  const rand = randomBytes(3).toString("hex");   // 6 hex chars, low collision risk
  return `${prefix}-${rand}`;
}

/** Resolve wrangler's bin entry from worker/'s package.json — same trick that
 *  bin/miki.mjs uses for tsx. Avoids npx entirely (no PATH issues, no shell,
 *  no Node 24 DEP0190 deprecation noise), and works regardless of which
 *  directory the user ran `miki setup` from. */
let _wranglerBinCache: string | null | undefined;
function findWranglerBin(): string | null {
  if (_wranglerBinCache !== undefined) return _wranglerBinCache;
  try {
    // require.resolve relative to WORKER_DIR's package.json — finds wrangler
    // even when miki setup is invoked from the user's home dir.
    const req = createRequire(path.join(WORKER_DIR, "package.json"));
    const pkgPath = req.resolve("wrangler/package.json");
    const pkg = req(pkgPath);
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wrangler;
    if (!binRel) { _wranglerBinCache = null; return null; }
    _wranglerBinCache = path.join(path.dirname(pkgPath), binRel);
    return _wranglerBinCache;
  } catch {
    _wranglerBinCache = null;
    return null;
  }
}

function checkWranglerAvailable(): boolean {
  return findWranglerBin() !== null;
}

/** Spawn wrangler with the given args, inherit stdio so user sees prompts.
 *  Optional env merges into process.env (used for CLOUDFLARE_ACCOUNT_ID). */
function runWrangler(args: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  const bin = findWranglerBin();
  if (!bin) return Promise.resolve(1);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd, stdio: "inherit",
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** Spawn wrangler + capture both stdout AND stderr (wrangler prints account
 *  list to stderr on the "multiple accounts" error). */
function runWranglerCaptured(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const bin = findWranglerBin();
  if (!bin) return Promise.resolve({ code: 1, out: "", err: "wrangler_missing" });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(process.execPath, [bin, ...args], {
      cwd, stdio: ["inherit", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); process.stdout.write(d); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); process.stderr.write(d); });
    child.on("exit", (code) => resolve({ code: code ?? 1, out, err }));
    child.on("error", () => resolve({ code: 1, out, err }));
  });
}

/** Parse "More than one account" error from wrangler stderr. Returns the
 *  account list as [{label, id}] or null if the error message doesn't match. */
function parseMultiAccountError(stderr: string): Array<{ label: string; id: string }> | null {
  if (!/More than one account available/i.test(stderr)) return null;
  // Lines look like: `\`Mike25326799@gmail.com's Account\`: \`f566818c…\``
  const matches = Array.from(stderr.matchAll(/`([^`]+)`:\s*`([a-f0-9]{32})`/gi));
  if (matches.length < 2) return null;
  return matches.map((m) => ({ label: m[1]!, id: m[2]! }));
}

async function pickAccountId(accounts: Array<{ label: string; id: string }>): Promise<string> {
  console.log("");
  console.log(t("selfhost.step2.multiacc"));
  console.log("");
  return await select<string>({
    message: t("selfhost.step2.pickacc"),
    choices: accounts.map((a) => ({ name: `${a.label}  (${a.id.slice(0, 8)}…)`, value: a.id })),
  });
}

/** Extract a deployed URL from wrangler's stdout. Wrangler 3 / 4 output varies:
 *    "Uploaded miki-relay-abc123 (1.75 sec)"
 *    "Deployed miki-relay-abc123 triggers (2.90 sec)"
 *    sometimes the workers.dev URL is on a separate line, sometimes only
 *    in the dashboard. Pages always prints "https://<hash>.<name>.pages.dev"
 *    and "https://<branch>.<name>.pages.dev".
 *  Returns the synthesized URL if parse fails — we can construct it from
 *  `<name>.<accountId>.workers.dev` patterns. */
function parseUrl(out: string, kind: "worker" | "pages"): string | null {
  if (kind === "worker") {
    const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
    return m ? m[0] : null;
  }
  const branch = out.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
  return branch ? branch[0] : null;
}

/** Wrangler 3 doesn't always print the workers.dev URL after deploy (only
 *  shows custom domain or nothing). Parse the worker name from the "Uploaded
 *  <name>" line so we can synthesize the URL from <name>.<account>.workers.dev
 *  — but we need the account's workers.dev subdomain, which we get via
 *  `wrangler subdomain` or fall back to a sensible default with the user's
 *  Cloudflare username. For v1 we just construct <name>.workers.dev with the
 *  account_id; user can correct manually if wrong. */
function parseWorkerName(out: string): string | null {
  const m = out.match(/(?:Uploaded|Deployed)\s+([a-z0-9_-]+)\s/i);
  return m ? m[1]! : null;
}

export async function runSelfHostWizard(cfg: Config): Promise<Config> {
  // Suppress Node's DEP0190 / DeprecationWarning noise from npx/wrangler
  // internals — end users panic when they see "DeprecationWarning" mid-flow.
  // (We only do this for the duration of the wizard; revert at end.)
  const prevNoDep = (process as any).noDeprecation;
  (process as any).noDeprecation = true;

  console.log("");
  console.log("─".repeat(64));
  console.log("📦 " + t("selfhost.intro.1"));
  console.log("");
  console.log("   " + t("selfhost.intro.2"));
  console.log("   " + t("selfhost.intro.3"));
  console.log("");
  console.log("   " + t("selfhost.intro.4"));
  console.log("─".repeat(64));
  console.log("");

  if (!checkWranglerAvailable()) {
    console.error(t("selfhost.wrangler.missing"));
    console.error(t("selfhost.wrangler.install"));
    console.error(t("selfhost.wrangler.retry"));
    throw new Error("wrangler_missing");
  }

  // Sanity: worker source + phone bundle must be present.
  try { await fs.access(path.join(WORKER_DIR, "wrangler.toml")); }
  catch {
    console.error(`✗ Worker source not found in ${WORKER_DIR}`);
    console.error("  This npm package wasn't shipped with worker/ — please file an issue.");
    throw new Error("worker_source_missing");
  }
  try { await fs.access(path.join(PHONE_DIST, "index.html")); }
  catch {
    console.error(`✗ Phone bundle not found in ${PHONE_DIST}`);
    console.error("  Run `pnpm build:phone` (or reinstall the npm package).");
    throw new Error("phone_bundle_missing");
  }

  // Auto-generate unique names. End users don't care about CF's URL scheme;
  // we just need names that won't collide on their own account. The random
  // suffix gives 16M collision space.
  const workerName = suggestName("miki-relay");
  const pagesName = suggestName("miki");

  // 1/3: wrangler login (interactive — opens browser).
  console.log(t("selfhost.step1"));
  console.log(t("selfhost.step1.browser"));
  console.log("");
  const loginCode = await runWrangler(["login"], WORKER_DIR);
  if (loginCode !== 0) {
    console.error("");
    console.error("✗ Cloudflare login failed (exit " + loginCode + ")。");
    throw new Error("wrangler_login_failed");
  }
  console.log(t("selfhost.step1.ok"));
  console.log("");

  // 2/3: Worker deploy. Use the self-host config (no routes/custom_domain)
  // so we never hijack the author's hosted relay.f1telemetrystationpro.org.
  console.log(t("selfhost.step2"));
  console.log("");
  const deployArgs = ["deploy", "--config", WORKER_SELFHOST_CONFIG, "--name", workerName];
  let accountEnv: Record<string, string> | undefined;
  let wOut = await runWranglerCaptured(deployArgs, WORKER_DIR);
  if (wOut.code !== 0) {
    const multi = parseMultiAccountError(wOut.err);
    if (multi) {
      const accountId = await pickAccountId(multi);
      accountEnv = { CLOUDFLARE_ACCOUNT_ID: accountId };
      console.log("");
      console.log(`${t("selfhost.step2.retry")} ${accountId.slice(0, 8)}…`);
      console.log("");
      wOut = await runWranglerCaptured(deployArgs, WORKER_DIR, accountEnv);
    }
  }
  if (wOut.code !== 0) {
    console.error("");
    console.error(t("selfhost.step2.fail"));
    throw new Error("worker_deploy_failed");
  }
  let workerUrl = parseUrl(wOut.out, "worker");
  if (!workerUrl) {
    // Older wrangler may not print the workers.dev URL post-deploy. Ask the
    // user to paste it from the CF dashboard rather than fail outright.
    const deployedName = parseWorkerName(wOut.out) ?? workerName;
    console.log("");
    console.log(`✓ Relay deployed as '${deployedName}', ${t("selfhost.step2.urlfail")}`);
    console.log("  https://dash.cloudflare.com → Workers & Pages → " + deployedName);
    console.log("  → Settings → Triggers");
    console.log("");
    const { input } = await import("./prompt.js");
    const pasted = await input({
      message: t("selfhost.step2.urlinput"),
      validate: (v) => /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?$/i.test(v) || "請貼完整的 https://...workers.dev URL",
    });
    workerUrl = pasted.replace(/\/$/, "");
  }
  console.log("");
  console.log(`${t("selfhost.step2.ok")} ${workerUrl}`);
  console.log("");

  // 3/3: Pages deploy. Reuse the chosen account.
  console.log(t("selfhost.step3"));
  console.log("");
  await runWrangler(["pages", "project", "create", pagesName, "--production-branch=main"], WORKER_DIR, accountEnv);
  const pOut = await runWranglerCaptured(
    ["pages", "deploy", PHONE_DIST, "--project-name", pagesName, "--branch=main", "--commit-dirty=true"],
    WORKER_DIR,
    accountEnv,
  );
  if (pOut.code !== 0) {
    console.error("");
    console.error(t("selfhost.step3.fail"));
    throw new Error("pages_deploy_failed");
  }
  const pagesUrl = parseUrl(pOut.out, "pages") ?? `https://${pagesName}.pages.dev`;
  console.log("");
  console.log(`${t("selfhost.step3.ok")} ${pagesUrl}`);
  console.log("");

  // Worker URL needs ws:// prefix for our config.
  const wsUrl = workerUrl.replace(/^https:/, "wss:");

  console.log("─".repeat(64));
  console.log(t("selfhost.done.title"));
  console.log("");
  console.log("   Relay:     " + wsUrl);
  console.log("   Phone app: " + pagesUrl);
  console.log("─".repeat(64));
  console.log("");

  // Restore prior deprecation setting before we hand back to the caller.
  (process as any).noDeprecation = prevNoDep;

  return {
    ...cfg,
    remote: {
      ...(cfg.remote ?? {}),
      worker_url: wsUrl,
      phone_pwa_url: pagesUrl.endsWith("/") ? pagesUrl : pagesUrl + "/",
    },
  };
}
