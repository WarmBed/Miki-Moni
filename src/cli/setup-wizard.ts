// First-run setup wizard. Invoked once on a fresh install — when
// `config.remote` is missing — to pick how phones reach the daemon.
//
//   1. Hosted (default, recommended)   — use relay.f1telemetrystationpro.org. Zero setup.
//   2. Self-host                       — auto wrangler deploy to user's CF.
//   3. Local-only                      — no phone access; mark remote = null.
//
// In non-TTY contexts (CI, headless start), the wizard silently picks
// hosted-defaults so `miki start` never blocks. Mutation is pure: returns
// the new Config; caller writes it.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../config.js";
import { HUB_HOME } from "../data-dir.js";
import { runSelfHostWizard } from "./setup-self-host.js";
import { select } from "./prompt.js";

const HOSTED_RELAY_URL = "wss://relay.f1telemetrystationpro.org";
const HOSTED_PHONE_PWA_URL = "https://miki-moni.pages.dev/";

/** Sentinel file written when the user explicitly picks "local-only" so we
 *  don't re-ask on every `miki start`. They can delete this file or run
 *  `miki setup` to bring up the wizard again. */
const WIZARD_LOCAL_ONLY_MARKER = path.join(HUB_HOME, "wizard-local-only");

async function localOnlyChosen(): Promise<boolean> {
  try { await fs.access(WIZARD_LOCAL_ONLY_MARKER); return true; } catch { return false; }
}

async function markLocalOnly(): Promise<void> {
  try { await fs.mkdir(HUB_HOME, { recursive: true }); } catch { /* ignore */ }
  await fs.writeFile(WIZARD_LOCAL_ONLY_MARKER, new Date().toISOString() + "\n");
}

type Choice = "hosted" | "self-host" | "local-only";

export interface SetupWizardOpts {
  /** Skip the prompt and use the given choice (testing, --setup flag). */
  forceChoice?: Choice;
}

export async function runSetupWizard(cfg: Config, opts: SetupWizardOpts = {}): Promise<Config> {
  const choice = opts.forceChoice ?? await pickChoice();
  switch (choice) {
    case "hosted":
      return applyHosted(cfg);
    case "self-host":
      return await runSelfHostWizard(cfg);
    case "local-only":
      await markLocalOnly();
      return applyLocalOnly(cfg);
  }
}

/** Non-TTY (e.g. systemd, CI, redirected stdin) → skip wizard so
 *  `miki start` never hangs waiting for input. */
export async function shouldRunWizard(cfg: Config): Promise<boolean> {
  if (cfg.remote?.worker_url) return false;
  if (await localOnlyChosen()) return false;
  if (!process.stdin.isTTY) return false;
  return true;
}

async function pickChoice(): Promise<Choice> {
  console.log("");
  console.log("✨ Welcome to miki-moni! First-time setup.");
  console.log("");
  return await select<Choice>({
    message: "配對手機要透過哪條路徑連回 daemon？",
    choices: [
      {
        name: "Hosted relay（推薦） — 用 relay.f1telemetrystationpro.org，零設定",
        value: "hosted",
        description: "免費共用 relay。Zero-knowledge — relay 看不到你內容。99% 使用者選這個。",
      },
      {
        name: "Self-host — 自動部署到你的 Cloudflare 帳號",
        value: "self-host",
        description: "需要 CF 帳號 + wrangler。約 5 分鐘。完全自主，不依賴作者基礎設施。",
      },
      {
        name: "Local-only — 只用 127.0.0.1:8765 dashboard，不配手機",
        value: "local-only",
        description: "完全本機。安全度最高，但手機 / 跨機器無法用。",
      },
    ],
    default: "hosted",
  });
}

function applyHosted(cfg: Config): Config {
  return {
    ...cfg,
    remote: {
      ...(cfg.remote ?? {}),
      worker_url: HOSTED_RELAY_URL,
      phone_pwa_url: HOSTED_PHONE_PWA_URL,
    },
  };
}

function applyLocalOnly(cfg: Config): Config {
  // We can't actually set `remote: null` in the typed Config — remote is
  // optional. Instead unset it and leave a sentinel field elsewhere if
  // needed. For now: just delete remote entirely; subsequent starts will
  // re-trigger the wizard. Mark with an internal flag stored separately.
  const next: Config = { ...cfg };
  delete (next as any).remote;
  // Suppress wizard re-trigger by writing a sentinel into device.created_at-ish
  // metadata. Simpler: write a marker file beside config.
  return next;
}

export { HOSTED_RELAY_URL, HOSTED_PHONE_PWA_URL };
