import path from "node:path";
import os from "node:os";
import http from "node:http";
import { promises as fs, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pino from "pino";
import { createApp } from "./server.js";
import { SessionStore } from "./session-store.js";
import { SessionResolver } from "./session-resolver.js";
import { HookHandler } from "./hook-handler.js";
import { VscodeBridge } from "./vscode-bridge.js";
import { Notifier } from "./notifier.js";
import { loadOrInitConfig } from "./config.js";
import { RelayClient } from "./relay-client.js";
import { HUB_HOME, PORT_FILE, DB_FILE, CONFIG_FILE, LOG_FILE, migrateLegacyHubHome } from "./data-dir.js";
import { killOrphans } from "./wrap-process.js";

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_PORT = 8765;

async function findFreePort(start: number, maxTries = 10): Promise<number> {
  const net = await import("node:net");
  for (let i = 0; i < maxTries; i++) {
    const port = start + i;
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`no free port in [${start}, ${start + maxTries})`);
}

// HTTP-probe a daemon on the given port. Returns true if it answers /sessions
// within 800ms. Used as the singleton guard so a second `pnpm start` (or
// wrap's auto-spawn) doesn't fork a duplicate daemon on a different port that
// would race over PORT_FILE.
async function pingDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/sessions`, { timeout: 800 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) > 0);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function readPortFile(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PORT_FILE, "utf8");
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function main(): Promise<void> {
  // Move legacy ~/.cc-hub into ~/.miki-moni on first boot after rename.
  // Idempotent: no-op once new dir exists.
  const mig = await migrateLegacyHubHome();
  if (mig.migrated) {
    console.log("migrated ~/.cc-hub → ~/.miki-moni (legacy install detected)");
  }
  await fs.mkdir(HUB_HOME, { recursive: true });

  // Multi-stream: file gets the full debug trace for post-hoc support; stdout
  // is quiet by default ("warn") so a normal end-user only sees genuine
  // problems. Power users override with MIKI_LOG_LEVEL=info / debug etc.
  const fileStream = (await import("node:fs")).createWriteStream(LOG_FILE, { flags: "a" });
  const log = pino(
    { level: "debug" },
    pino.multistream([
      { stream: process.stdout, level: process.env.MIKI_LOG_LEVEL ?? "warn" },
      { stream: fileStream, level: "debug" },
    ]),
  );

  // Singleton guard. PORT_FILE is shared global state; if another daemon is
  // already alive, claiming a different port and overwriting PORT_FILE causes
  // the dashboard and CLIs to split-brain across two daemons. Probe the
  // currently-recorded port first, then the canonical default, then bail.
  //
  // The "two-daemons" race used to surface like this:
  //   1. Daemon A runs on 8765, PORT_FILE=8765
  //   2. A crashes; PORT_FILE still points at 8765 but no one's home
  //   3. `miki claude` wrap reads 8765, ping fails, autostarts Daemon B
  //   4. B's findFreePort skips 8765 (TIME_WAIT) → binds 8766 → writes
  //      PORT_FILE=8766
  //   5. A's old socket clears, user runs `pnpm start` again → Daemon C binds
  //      8765 → writes PORT_FILE=8765 → race over PORT_FILE
  // Refusing to start when a live daemon is detected eliminates the race
  // entirely. Set MIKI_FORCE_RESTART=1 to skip the guard (e.g. for debugging).
  if (!process.env.MIKI_FORCE_RESTART) {
    for (const candidate of [await readPortFile(), DEFAULT_PORT]) {
      if (candidate && await pingDaemon(candidate)) {
        console.log(`miki-moni daemon already running on http://127.0.0.1:${candidate} — exiting (set MIKI_FORCE_RESTART=1 to override)`);
        // Reconcile PORT_FILE in case it drifted (e.g. step 4 above): if the
        // live port doesn't match PORT_FILE, fix it so the next CLI finds
        // home on the first try.
        const recorded = await readPortFile();
        if (recorded !== candidate) {
          await fs.writeFile(PORT_FILE, String(candidate));
          log.info({ from: recorded, to: candidate }, "reconciled stale PORT_FILE");
        }
        process.exit(0);
      }
    }
  }

  const port = await findFreePort(DEFAULT_PORT);
  await fs.writeFile(PORT_FILE, String(port));

  const store = new SessionStore(DB_FILE);
  // On daemon startup we don't know what's still alive. Mark everything stale
  // (but DON'T delete) — dashboard can filter them out; hook events + wrap
  // reconnects will upgrade the row back to "active" on next signal. This is
  // safer than truncate(), which lost the row entirely and prevented /send
  // routing for wrap sessions until they fired another hook.
  const staled = store.markAllStale();
  log.info({ staled }, "marked all sessions stale on startup");

  // Opt-in orphan sweep. The `taskkill /T /F` in killProcessTree turned out
  // to bring down the *current* daemon when the matched orphan happened to
  // share a Windows job object with us (reproducible inside Claude Code's
  // bash sandbox + likely the user's terminal too — daemon would die ~1.5s
  // after listen with no exception, no signal, just TerminateProcess).
  // Until killOrphans uses a safer mechanism (skip /T, or verify parent is
  // dead before killing), it stays off by default. Wraps left over from a
  // crashed daemon session just sit there — annoying but not fatal.
  if (process.env.MIKI_KILL_ORPHANS === "1") {
    killOrphans(log).then((n) => {
      if (n > 0) log.info({ killed: n }, "swept orphan `miki claude` processes from previous daemon");
    }).catch((err) => log.warn({ error: String(err) }, "orphan sweep failed (non-fatal)"));
  }
  const resolver = new SessionResolver(PROJECTS_ROOT);
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  // Resolve dist/web relative to this source file. After a global npm install
  // the daemon's process.cwd() is the user's calling dir, not the package
  // root, so path.resolve("dist/web") would point at the wrong place.
  const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(_moduleDir, "..", "dist", "web");

  const { app, server } = createApp({ store, handler, bridge, notifier, webDir, log });

  // Serve web UI if built
  const express = (await import("express")).default;
  app.use(express.static(webDir, { fallthrough: true }));

  // Phase 2: optional remote relay to user's Cloudflare Worker
  const config = await loadOrInitConfig(CONFIG_FILE);
  let relay: RelayClient | null = null;
  if (config.remote && config.paired_peers.length > 0) {
    relay = new RelayClient({ config, store, bridge });
    await relay.start();
    log.info({ worker_url: config.remote.worker_url, peers: config.paired_peers.length }, "relay started");
    console.log(`relay -> ${config.remote.worker_url} (${config.paired_peers.length} peer${config.paired_peers.length === 1 ? "" : "s"})`);
  } else {
    log.info("relay disabled (no remote configured or no paired peers)");
  }

  server.listen(port, "127.0.0.1", () => {
    log.info({ port }, "miki-moni listening");
    console.log(`miki-moni listening on http://127.0.0.1:${port}`);
    // Windows-only: spawn the sleeping-cat tray icon so the user has a
    // visible reminder the daemon is alive. Detached + unref'd so it owns
    // its own lifetime; the script watches our PID and self-exits when we
    // die. Failures here are non-fatal — the daemon is fully usable
    // without the tray icon.
    // Skip if MIKI_NO_TRAY_SPAWN=1 — set by /admin/restart / /admin/rotate-pair
    // so respawned daemons don't duplicate the cat icon (the previous tray
    // follows us via /admin/pid).
    if (process.platform === "win32" && process.env.MIKI_NO_TRAY_SPAWN !== "1") {
      spawnTrayHelper(port, log).catch((err) => {
        log.warn({ err: String(err) }, "tray helper spawn failed (non-fatal)");
      });
    }
  });

  const shutdown = async () => {
    log.info("shutting down");
    if (relay) { try { await relay.stop(); } catch { /* ignore */ } }
    server.close(() => { store.close(); process.exit(0); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Spawn tools/tray.ps1 as a detached child. The script renders a tray icon
// with right-click menu (Open / Restart / Quit) and self-exits when our PID
// disappears. Resolved relative to this file so it works whether the daemon
// was launched from the repo or via a packaged `miki` global install.
async function spawnTrayHelper(port: number, log: pino.Logger): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/index.ts compiled lives one level under repo root; tools/tray.ps1
  // lives at the repo root. Two candidate paths so this works both in
  // tsx-direct and in a built dist/ layout.
  const candidates = [
    path.resolve(here, "..", "tools", "tray.ps1"),
    path.resolve(here, "..", "..", "tools", "tray.ps1"),
  ];
  let scriptPath: string | null = null;
  for (const p of candidates) {
    try { await fs.access(p); scriptPath = p; break; } catch { /* try next */ }
  }
  if (!scriptPath) {
    log.warn({ candidates }, "tray.ps1 not found — skipping tray icon");
    return;
  }
  // Two Windows-spawn quirks fixed here:
  //
  // 1. PowerShell's argv parser mangles Windows-style backslash paths when
  //    they come through Node's CreateProcess wrapping ("D:\code\..."
  //    became "D:codec..."). Forward slashes work natively on every
  //    Windows tool and don't get eaten by escape processing.
  //
  // 2. STA is required for WinForms NotifyIcon (default MTA caused silent
  //    exit on Application.Run when spawned from Node's CreateProcess
  //    DETACHED_PROCESS flag).
  //
  // 3. Going through `cmd /c start /B` instead of spawning powershell.exe
  //    directly side-steps a subtler Node-on-Windows issue where the
  //    detached child still inherits CreateProcess flags that prevent
  //    PowerShell from running a WinForms message pump. Direct spawn died
  //    silently within ~1s; `Start-Process` from PowerShell worked fine,
  //    and so does the cmd /c start indirection — both yield a process
  //    with the flags Application.Run() expects.
  const scriptForPs = scriptPath.replace(/\\/g, "/");
  // -ExecutionPolicy Bypass: many users have the default `Restricted` policy
  // which silently refuses to run .ps1 files. Bypass only applies to this one
  // process invocation (we don't touch their system-wide policy).
  // Capture stdout/stderr to the daemon log so silent crashes are debuggable.
  const trayLog = path.join(path.dirname(LOG_FILE), "tray.log");
  const child = spawn(
    "cmd.exe",
    [
      "/c", "start", "/B", "",
      "powershell.exe",
      "-NoProfile", "-STA",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", scriptForPs,
      "-DaemonPid", String(process.pid),
      "-Port", String(port),
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  child.on("error", (err) => log.warn({ err: String(err) }, "tray helper error"));
  child.unref();
  log.info({ scriptPath, pid: child.pid, trayLog }, "tray helper spawned");
}

// Catch silent crashes (Node's default for uncaughtException is to exit
// with no error message). Write to LOG_FILE directly because pino's stream
// may not flush before exit. ONLY catch — do NOT subscribe to beforeExit /
// exit, which fire on every normal Node tick when the loop drains and
// produce noise that looks like crashes.
function logFatal(kind: string, err: unknown): void {
  try {
    const line = JSON.stringify({ level: 60, time: Date.now(), pid: process.pid, kind, err: String(err), stack: (err as Error)?.stack }) + "\n";
    appendFileSync(LOG_FILE, line);
    process.stderr.write(line);
  } catch { /* nothing we can do */ }
}
process.on("uncaughtException", (err) => { logFatal("uncaughtException", err); process.exit(1); });
process.on("unhandledRejection", (reason) => { logFatal("unhandledRejection", reason); });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
