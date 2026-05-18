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
import type { Config, Locale } from "../config.js";
import { HUB_HOME } from "../data-dir.js";
import { runSelfHostWizard } from "./setup-self-host.js";
import { select } from "./prompt.js";
import { setLocale, t, LOCALE_CHOICES } from "./i18n-cli.js";

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
  // Step 0: pick UI language (English / Traditional / Simplified Chinese)
  // ALWAYS asked first — even on re-running `miki setup`, the user might
  // want to switch. cfg.locale (if present) becomes the default so existing
  // users can just hit Enter to keep it.
  let cfgWithLocale = cfg;
  if (!opts.forceChoice) {
    const lang = await pickLocale(cfg.locale);
    setLocale(lang);
    if (lang !== cfg.locale) cfgWithLocale = { ...cfg, locale: lang };
  }

  const choice = opts.forceChoice ?? await pickChoice();
  switch (choice) {
    case "hosted":
      return applyHosted(cfgWithLocale);
    case "self-host":
      return await runSelfHostWizard(cfgWithLocale);
    case "local-only":
      await markLocalOnly();
      return applyLocalOnly(cfgWithLocale);
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

async function pickLocale(current?: Locale): Promise<Locale> {
  // Tri-lingual banner — at this point we don't know which language the user
  // reads so all three are shown side by side. Default falls back to the
  // existing config locale (re-running `miki setup`) or "en" on first run.
  console.log("");
  console.log("✨ Welcome to miki-moni! / 歡迎 / 欢迎");
  console.log("");
  return await select<Locale>({
    message: "Language / 語言 / 语言：",
    choices: LOCALE_CHOICES.map((c) => ({ name: c.name, value: c.value })),
    default: current ?? "en",
  });
}

async function pickChoice(): Promise<Choice> {
  console.log("");
  console.log(t("wizard.welcome"));
  console.log("");
  return await select<Choice>({
    message: t("wizard.pick.relay"),
    choices: [
      { name: t("wizard.choice.hosted"), value: "hosted", description: t("wizard.choice.hosted.desc") },
      { name: t("wizard.choice.selfhost"), value: "self-host", description: t("wizard.choice.selfhost.desc") },
      { name: t("wizard.choice.local"), value: "local-only", description: t("wizard.choice.local.desc") },
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
