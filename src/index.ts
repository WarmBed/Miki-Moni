import path from "node:path";
import os from "node:os";
import http from "node:http";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
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

  // Sweep up `miki claude` orphans left behind by the previous daemon session
  // (Windows wt.exe doesn't reliably propagate window-close to child node
  // processes — so a daemon crash, manual kill, or hot-reload typically
  // leaves the wrap CLIs alive). Best-effort; failure here is non-fatal.
  killOrphans(log).then((n) => {
    if (n > 0) log.info({ killed: n }, "swept orphan `miki claude` processes from previous daemon");
  }).catch((err) => log.warn({ error: String(err) }, "orphan sweep failed (non-fatal)"));
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
  });

  const shutdown = async () => {
    log.info("shutting down");
    if (relay) { try { await relay.stop(); } catch { /* ignore */ } }
    server.close(() => { store.close(); process.exit(0); });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
