import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import pino from "pino";
import { createApp } from "./server.js";
import { SessionStore } from "./session-store.js";
import { SessionResolver } from "./session-resolver.js";
import { HookHandler } from "./hook-handler.js";
import { VscodeBridge } from "./vscode-bridge.js";
import { Notifier } from "./notifier.js";
import { loadOrInitConfig } from "./config.js";
import { RelayClient } from "./relay-client.js";

const HUB_HOME = path.join(os.homedir(), ".cc-hub");
const PORT_FILE = path.join(HUB_HOME, "port");
const DB_FILE = path.join(HUB_HOME, "state.db");
const CONFIG_FILE = path.join(HUB_HOME, "config.json");
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

async function main(): Promise<void> {
  await fs.mkdir(HUB_HOME, { recursive: true });

  // Multi-stream: write to file AND mirror to stdout so `pnpm dev:all`'s
  // [daemon] prefix shows logs in real time.
  const fileStream = (await import("node:fs")).createWriteStream(path.join(HUB_HOME, "cc-hub.log"), { flags: "a" });
  const log = pino(
    { level: "debug" },
    pino.multistream([
      { stream: process.stdout },
      { stream: fileStream },
    ]),
  );

  const port = await findFreePort(DEFAULT_PORT);
  await fs.writeFile(PORT_FILE, String(port));

  const store = new SessionStore(DB_FILE);
  // Wipe stale sessions on every daemon start. Hooks will repopulate the row
  // for any panel that's still actively firing events; closed/idle ones stay
  // out. Dashboard total = "currently in use" instead of "ever seen".
  const cleared = store.truncate();
  log.info({ cleared }, "session store wiped on startup");
  const resolver = new SessionResolver(PROJECTS_ROOT);
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  const webDir = path.resolve("dist/web");

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
    log.info({ port }, "cc-hub listening");
    console.log(`cc-hub listening on http://127.0.0.1:${port}`);
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
