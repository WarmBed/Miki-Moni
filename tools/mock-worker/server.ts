/**
 * mock-worker/server.ts — Local Node.js stand-in for the user's Cloudflare Worker.
 *
 * DEV-ONLY DEVIATIONS FROM PRODUCTION:
 *   1. No Cloudflare Access SSO on /v1/phone — any phone connection is accepted.
 *      (Real Worker enforces CF-Access-Authenticated-User-Email header.)
 *   2. State lives in process-local Maps, not Durable Objects.
 *   3. Plain HTTP/WS on 127.0.0.1, not Cloudflare TLS edge.
 *   4. Single process / single host — not globally distributed.
 *
 * This file MUST NOT be deployed to production.
 *
 * Protocol reference: docs/protocols/relay-protocol.md
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.MOCK_WORKER_PORT ?? 8787);
const DAEMON_TOKEN = process.env.MOCK_WORKER_TOKEN ?? "local-dev-token";
const WEB_PHONE_DIR = path.resolve(__dirname, "..", "..", "dist", "web-phone");

// ── State ──────────────────────────────────────────────────────────────────

interface DaemonEntry {
  ws: WebSocket;
  id: string;
}

interface PairingEntry {
  daemon?: WebSocket;
  phone?: WebSocket;
}

/** daemon_id → DaemonEntry */
const daemons = new Map<string, DaemonEntry>();
/** daemon_id → Set of phone WebSockets */
const phonesByDaemon = new Map<string, Set<WebSocket>>();
/** pairing_token → PairingEntry */
const pairings = new Map<string, PairingEntry>();

// ── Logging ────────────────────────────────────────────────────────────────

function ts(): string {
  const d = new Date();
  const pad = (n: number, z = 2) => String(n).padStart(z, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function log(msg: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? " " + JSON.stringify(meta) : "";
  console.log(`[${ts()}] ${msg}${suffix}`);
}

// ── MIME helper ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function mime(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ── HTTP server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const rawUrl = req.url ?? "/";

  // Health endpoint
  if (rawUrl === "/v1/health") {
    const phoneCount = Array.from(phonesByDaemon.values()).reduce(
      (n, s) => n + s.size,
      0,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        mode: "mock-worker",
        daemons: daemons.size,
        phones: phoneCount,
        pairings: pairings.size,
      }),
    );
    return;
  }

  // Static file serving from dist/web-phone/
  const cleanPath = rawUrl.split("?")[0]!.replace(/^\/+/, "");
  // Prevent path traversal
  const safe = path.normalize(cleanPath || "index.html").replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(WEB_PHONE_DIR, safe);

  // Ensure resolved path stays inside WEB_PHONE_DIR
  if (!filePath.startsWith(WEB_PHONE_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mime(filePath) });
    res.end(data);
  } catch {
    // File not found — serve friendly fallback only for root requests
    if (cleanPath === "" || cleanPath === "index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html>
<meta charset="utf-8">
<title>cc-hub phone web client</title>
<h1>cc-hub phone web client not built yet</h1>
<p>Run <code>pnpm build:phone</code> from the repo root to build it.</p>`,
      );
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  }
});

// ── WebSocket upgrade ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  const isDaemon = url.startsWith("/v1/daemon");
  const isPhone = url.startsWith("/v1/phone");

  if (!isDaemon && !isPhone) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const daemonAuth = req.headers["x-daemon-auth"] as string | undefined;
  const urlObj = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const pairingToken = (req.headers["x-pairing-token"] as string | undefined) ?? urlObj.searchParams.get("pairing_token") ?? undefined;
  const daemonId = (req.headers["x-daemon-id"] as string | undefined) ?? urlObj.searchParams.get("daemon_id") ?? undefined;

  // Daemon connections require X-Daemon-Auth
  if (isDaemon && daemonAuth !== DAEMON_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nX-Error: bad X-Daemon-Auth\r\n\r\n");
    socket.destroy();
    log("daemon rejected: bad X-Daemon-Auth");
    return;
  }

  // Phone connections: no SSO check (local dev only — see file header)

  // Must supply either X-Pairing-Token or X-Daemon-Id
  if (!pairingToken && !daemonId) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nX-Error: need X-Pairing-Token or X-Daemon-Id\r\n\r\n",
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const role = isDaemon ? "daemon" : "phone";
    if (pairingToken) {
      attachPairing(ws, pairingToken, role);
    } else if (daemonId) {
      if (isDaemon) {
        attachDaemon(ws, daemonId);
      } else {
        attachPhone(ws, daemonId);
      }
    }
  });
});

// ── Connection handlers ────────────────────────────────────────────────────

function byteLength(raw: unknown): number {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  return 0;
}

function attachDaemon(ws: WebSocket, id: string): void {
  daemons.set(id, { ws, id });
  log("daemon connected", { id });

  ws.on("message", (raw, isBinary) => {
    const phones = phonesByDaemon.get(id);
    if (!phones || phones.size === 0) return;
    const size = byteLength(raw);
    log(`daemon->phone(${phones.size}) ${size} bytes`, { id });
    for (const p of phones) {
      if (p.readyState === WebSocket.OPEN) {
        p.send(raw, { binary: isBinary });
      }
    }
  });

  ws.on("close", () => {
    if (daemons.get(id)?.ws === ws) daemons.delete(id);
    log("daemon disconnected", { id });
  });

  ws.on("error", (err) => {
    log("daemon ws error", { id, err: String(err) });
  });
}

function attachPhone(ws: WebSocket, daemonId: string): void {
  let set = phonesByDaemon.get(daemonId);
  if (!set) {
    set = new Set();
    phonesByDaemon.set(daemonId, set);
  }
  set.add(ws);
  log("phone connected", { daemonId, total: set.size });

  ws.on("message", (raw, isBinary) => {
    const d = daemons.get(daemonId);
    if (!d || d.ws.readyState !== WebSocket.OPEN) return;
    const size = byteLength(raw);
    log(`phone->daemon ${size} bytes`, { daemonId });
    d.ws.send(raw, { binary: isBinary });
  });

  ws.on("close", () => {
    set!.delete(ws);
    if (set!.size === 0) phonesByDaemon.delete(daemonId);
    log("phone disconnected", { daemonId, remaining: set!.size });
  });

  ws.on("error", (err) => {
    log("phone ws error", { daemonId, err: String(err) });
  });
}

function attachPairing(ws: WebSocket, token: string, role: "daemon" | "phone"): void {
  let entry = pairings.get(token);
  if (!entry) {
    entry = {};
    pairings.set(token, entry);
  }

  if (role === "daemon") {
    entry.daemon = ws;
  } else {
    entry.phone = ws;
  }
  log(`pairing ${role} connected`, { token });

  ws.on("message", (raw, isBinary) => {
    const e = pairings.get(token);
    if (!e) return;
    const other = role === "daemon" ? e.phone : e.daemon;
    if (!other || other.readyState !== WebSocket.OPEN) return;
    const size = byteLength(raw);
    const direction = role === "daemon" ? "daemon->phone" : "phone->daemon";
    log(`pairing ${direction} ${size} bytes`, { token });
    other.send(raw, { binary: isBinary });
  });

  ws.on("close", () => {
    const e = pairings.get(token);
    if (!e) return;
    if (role === "daemon" && e.daemon === ws) e.daemon = undefined;
    if (role === "phone" && e.phone === ws) e.phone = undefined;
    if (!e.daemon && !e.phone) pairings.delete(token);
    log(`pairing ${role} disconnected`, { token });
  });

  ws.on("error", (err) => {
    log(`pairing ${role} ws error`, { token, err: String(err) });
  });
}

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-worker listening on http://127.0.0.1:${PORT}`);
  console.log(`  WSS /v1/daemon  — X-Daemon-Auth: ${DAEMON_TOKEN}`);
  console.log(`  WSS /v1/phone   — no auth (local dev mode, see file header)`);
  console.log(`  GET /v1/health  — JSON health check`);
  console.log(`  GET /           — serves dist/web-phone/ (run pnpm build:phone first)`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(): void {
  console.log("\nshutting down mock-worker...");
  for (const d of daemons.values()) d.ws.close();
  for (const set of phonesByDaemon.values()) for (const p of set) p.close();
  for (const e of pairings.values()) {
    e.daemon?.close();
    e.phone?.close();
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
