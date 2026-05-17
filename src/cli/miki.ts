#!/usr/bin/env node
// `miki` — miki-moni CLI dispatcher.
//
// Subcommands:
//   miki claude [args]    Wrap a Claude Code session (auto-spawns daemon if down)
//   miki start            Run the daemon explicitly (foreground)
//   miki pair             Show / rotate / list the phone pairing QR
//   miki install-hooks    Install Claude Code hooks so non-wrapped panels show up in dashboard

import qrcode from "qrcode-terminal";
import { readFileSync } from "node:fs";
import { loadOrInitConfig, saveConfig } from "../config.js";
import { CONFIG_FILE, PORT_FILE } from "../data-dir.js";
import { generateNewPairingToken, pairingQrPayload } from "../pairing.js";
import { runSetupWizard, shouldRunWizard } from "./setup-wizard.js";

/** Last port the daemon listened on (written to PORT_FILE on startup). If
 *  this is the first ever run there's no file yet, so fall back to the
 *  conventional default; the daemon's own "listening on" line will show the
 *  real port a second later if it differs. */
function lastKnownPort(): number {
  try {
    const n = Number(readFileSync(PORT_FILE, "utf8").trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* first run */ }
  return 8765;
}

/** Print "scan / open / type" banner whenever the user starts the daemon. Read
 *  the persistent pair token from config; auto-generate one on first ever run
 *  so a fresh `npm install -g miki-moni && miki start` already has a working
 *  QR to wave at a phone. */
async function printPairBanner(): Promise<void> {
  try {
    let cfg = await loadOrInitConfig(CONFIG_FILE);
    const workerUrl = cfg.remote?.worker_url;
    if (!workerUrl) {
      return;
    }
    let token = cfg.remote!.pair_token;
    if (!token) {
      token = generateNewPairingToken();
      cfg = {
        ...cfg,
        remote: { ...cfg.remote!, pair_token: token },
      };
      await saveConfig(CONFIG_FILE, cfg);
    }
    const payload = pairingQrPayload({
      worker_url: workerUrl,
      pairing_token: token,
      daemon_pubkey: cfg.device.pubkey,
      device_name: cfg.device.name,
      phone_pwa_url: cfg.remote?.phone_pwa_url,
    });
    const grouped = token.match(/.{1,4}/g)!.join("-");
    const localUrl = `http://127.0.0.1:${lastKnownPort()}`;
    console.log("");
    console.log("📱 Phone pairing — scan QR, open URL, or type the 16-char code:");
    console.log("");
    qrcode.generate(payload, { small: true });
    console.log("");
    console.log("   URL:    " + payload);
    console.log("   Code:   " + grouped);
    console.log("   Local:  " + localUrl + "   ← 同台電腦在這看 dashboard，不走 relay");
    console.log("   (QR / URL / Code are permanent — rotate with `miki pair --rotate`)");
    console.log("");
  } catch (e) {
    // Best-effort: never block daemon startup on banner failure.
    console.error("miki: pair banner skipped: " + (e as Error).message);
  }
}

/** First-run setup wizard. Runs once on a fresh install before the daemon
 *  starts; subsequent runs no-op silently. Wizard writes Config.remote — so
 *  the rest of the pipeline (banner, RelayClient) "just works" after. */
async function maybeRunSetupWizard(): Promise<void> {
  try {
    const cfg = await loadOrInitConfig(CONFIG_FILE);
    if (!await shouldRunWizard(cfg)) return;
    const next = await runSetupWizard(cfg);
    await saveConfig(CONFIG_FILE, next);
  } catch (e) {
    console.error("miki setup: " + (e as Error).message);
    // Don't crash daemon startup — they can re-run `miki setup` later.
  }
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "claude") {
    await import("./wrap.js");
    return;
  }
  if (sub === "start" || sub === "daemon") {
    await maybeRunSetupWizard();
    await printPairBanner();
    await import("../index.js");
    return;
  }
  if (sub === "setup") {
    // Explicit re-trigger of the wizard. Removes the local-only marker so the
    // user can change their mind, then runs it.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { HUB_HOME } = await import("../data-dir.js");
    try { await fs.unlink(path.join(HUB_HOME, "wizard-local-only")); } catch { /* not there, fine */ }
    let cfg = await loadOrInitConfig(CONFIG_FILE);
    // Preserve pair_token across wizard re-runs — existing paired phones use
    // it; only the relay URL is being reconfigured.
    const preservedToken = cfg.remote?.pair_token;
    cfg = { ...cfg };
    delete (cfg as any).remote;
    let next = await runSetupWizard(cfg);
    if (preservedToken && next.remote) {
      next = { ...next, remote: { ...next.remote, pair_token: preservedToken } };
    }
    await saveConfig(CONFIG_FILE, next);
    console.log("✓ Setup complete. Starting daemon…");
    console.log("");
    await printPairBanner();
    await import("../index.js");
    return;
  }
  if (sub === "pair") {
    // Strip "pair" so pair.ts's parseArgs (which reads slice(2)) sees the
    // remaining flags (--rotate, --new, --list, --revoke, etc.) as if it
    // were invoked directly.
    process.argv = [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)];
    await import("./pair.js");
    return;
  }
  if (sub === "install-hooks") {
    await import("../install-hooks.js");
    return;
  }
  console.error("usage: miki <subcommand>");
  console.error("");
  console.error("subcommands:");
  console.error("  claude [-c | -r <uuid> | --fresh] [--model X] [--bypass-permissions]");
  console.error("           Wrap a Claude Code session. Auto-spawns the daemon if not");
  console.error("           already running. Dashboard at http://localhost:8765");
  console.error("  start    Run the miki-moni daemon in the foreground.");
  console.error("           Prints the phone-pairing QR + URL + 16-char code on startup.");
  console.error("           First run also walks through a setup wizard.");
  console.error("  setup    Re-run the first-run wizard (hosted vs self-host vs local-only).");
  console.error("  pair     Show the permanent phone-pairing QR. Subcommands:");
  console.error("             miki pair                show current QR (auto-creates on first run)");
  console.error("             miki pair --rotate       regenerate token");
  console.error("             miki pair --list         list paired phones");
  console.error("             miki pair --revoke <id>  revoke a paired phone");
  console.error("  install-hooks");
  console.error("           Install Claude Code hooks into ~/.claude/settings.json so");
  console.error("           non-wrapped VSCode panels also show up in the dashboard.");
  process.exit(1);
}
main();
