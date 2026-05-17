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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import nacl from "tweetnacl";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.MOCK_WORKER_PORT ?? 8787);
const WEB_PHONE_DIR = path.resolve(__dirname, "..", "..", "dist", "web-phone");

// ── State ──────────────────────────────────────────────────────────────────

interface DaemonEntry {
  ws: WebSocket;
  id: string;
  pubkey: Buffer;
}

interface PairingEntry {
  daemon?: WebSocket;
  daemonId?: string;
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
<title>miki-moni phone web client</title>
<h1>miki-moni phone web client not built yet</h1>
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

  // Phone connections: no SSO check (local dev only — see file header)

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (isDaemon) {
      handleDaemonConnection(ws, req);
    } else {
      handlePhoneConnection(ws, req);
    }
  });
});

// ── Daemon connection handler (Ed25519 challenge-response) ─────────────────

function handleDaemonConnection(ws: WebSocket, req: http.IncomingMessage): void {
  const pubkeyHdr = req.headers["x-daemon-pubkey"];
  if (!pubkeyHdr || typeof pubkeyHdr !== "string") {
    log("daemon connect: missing X-Daemon-Pubkey");
    ws.close(1008, "missing X-Daemon-Pubkey");
    return;
  }

  const pubkey = Buffer.from(pubkeyHdr, "base64");
  if (pubkey.length !== 32) {
    log("daemon connect: bad pubkey length", { length: pubkey.length });
    ws.close(1008, "bad pubkey length");
    return;
  }

  const daemon_id = crypto
    .createHash("sha256")
    .update(pubkey)
    .digest("hex")
    .slice(0, 32);

  // Issue challenge
  const nonce = crypto.randomBytes(32);
  const issued_at_ms = Date.now();
  ws.send(JSON.stringify({
    type: "challenge",
    nonce: nonce.toString("base64"),
    issued_at_ms,
  }));

  log("daemon challenge sent", { daemon_id });

  let authed = false;

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authed) {
      // Expect challenge_response first
      if (msg.type !== "challenge_response") {
        log("daemon: expected challenge_response", { got: msg.type });
        ws.close(1008, "expected challenge_response");
        return;
      }

      let sig: Uint8Array;
      try {
        sig = new Uint8Array(Buffer.from(msg.sig, "base64"));
      } catch {
        log("daemon: bad sig encoding");
        ws.close(1008, "bad sig encoding");
        return;
      }

      // Signed bytes: nonce (32B) ++ issued_at_ms (8B big-endian)
      const issuedBuf = Buffer.alloc(8);
      issuedBuf.writeBigUInt64BE(BigInt(issued_at_ms));
      const sigMsg = new Uint8Array(Buffer.concat([nonce, issuedBuf]));

      const ok = nacl.sign.detached.verify(sigMsg, sig, new Uint8Array(pubkey));
      if (!ok) {
        log("daemon: challenge_response sig failed", { daemon_id });
        ws.close(4001, "bad_sig");
        return;
      }

      authed = true;
      daemons.set(daemon_id, { ws, id: daemon_id, pubkey });
      log(`daemon authed: ${daemon_id}`);
      ws.send(JSON.stringify({ type: "ready", daemon_id }));
      return;
    }

    // ── Post-auth daemon messages ──────────────────────────────────────────

    if (msg.type === "register_pairing") {
      const token = String(msg.token ?? "");
      if (!token) return;
      let entry = pairings.get(token);
      if (!entry) {
        entry = {};
        pairings.set(token, entry);
      }
      entry.daemon = ws;
      entry.daemonId = daemon_id;
      log(`daemon registered pairing token`, { token, daemon_id });
      return;
    }

    if (msg.type === "pair_ack") {
      // Forward pair_ack to all phones waiting on this daemon
      const phones = phonesByDaemon.get(daemon_id);
      if (phones) {
        for (const phone of phones) {
          if (phone.readyState === WebSocket.OPEN) {
            try { phone.send(JSON.stringify({ type: "pair_ack" })); } catch {}
          }
        }
      }
      return;
    }

    // envelope: broadcast to all paired phones
    if (msg.type === "envelope") {
      const phones = phonesByDaemon.get(daemon_id);
      if (phones) {
        for (const phone of phones) {
          if (phone.readyState === WebSocket.OPEN) {
            try { phone.send(raw.toString()); } catch {}
          }
        }
      }
      return;
    }

    // Generic relay fallback: forward anything else to paired phones
    const phones = phonesByDaemon.get(daemon_id);
    if (phones) {
      for (const phone of phones) {
        if (phone.readyState === WebSocket.OPEN) {
          try { phone.send(raw.toString()); } catch {}
        }
      }
    }
  });

  ws.on("close", () => {
    if (authed && daemons.get(daemon_id)?.ws === ws) {
      daemons.delete(daemon_id);
      log(`daemon disconnected`, { daemon_id });
    }
  });

  ws.on("error", (err) => {
    log("daemon ws error", { daemon_id, err: String(err) });
  });
}

// ── Phone connection handler ───────────────────────────────────────────────

function handlePhoneConnection(ws: WebSocket, req: http.IncomingMessage): void {
  const urlObj = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const pairingToken =
    (req.headers["x-pairing-token"] as string | undefined) ??
    urlObj.searchParams.get("pairing_token") ??
    undefined;
  const daemonIdParam =
    (req.headers["x-daemon-id"] as string | undefined) ??
    urlObj.searchParams.get("daemon_id") ??
    undefined;

  if (pairingToken) {
    // Pairing flow: phone provides a pairing token
    const entry = pairings.get(pairingToken);
    if (!entry || !entry.daemon || entry.daemon.readyState !== WebSocket.OPEN) {
      log("phone: pairing token not found or daemon gone", { pairingToken });
      ws.close(4040, "pairing_token_not_found");
      return;
    }

    const daemonId = entry.daemonId!;
    entry.phone = ws;

    // Look up daemon pubkey to send pair_init
    const daemonEntry = daemons.get(daemonId);
    if (daemonEntry) {
      ws.send(JSON.stringify({
        type: "pair_init",
        daemon_pubkey: daemonEntry.pubkey.toString("base64"),
      }));
    }

    log("phone connected via pairing token", { pairingToken, daemonId });

    // Track phone under this daemon
    let phoneSet = phonesByDaemon.get(daemonId);
    if (!phoneSet) {
      phoneSet = new Set();
      phonesByDaemon.set(daemonId, phoneSet);
    }
    phoneSet.add(ws);

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "pair_offer") {
        // Forward pair_offer to daemon
        const d = entry!.daemon;
        if (d && d.readyState === WebSocket.OPEN) {
          d.send(raw.toString());
        }
        return;
      }

      // Other phone messages: forward to daemon
      const d = daemons.get(daemonId);
      if (d && d.ws.readyState === WebSocket.OPEN) {
        d.ws.send(raw.toString());
      }
    });

    ws.on("close", () => {
      const ps = phonesByDaemon.get(daemonId);
      if (ps) {
        ps.delete(ws);
        if (ps.size === 0) phonesByDaemon.delete(daemonId);
      }
      if (entry!.phone === ws) entry!.phone = undefined;
      log("phone disconnected (pairing)", { pairingToken, daemonId });
    });

    ws.on("error", (err) => {
      log("phone ws error (pairing)", { pairingToken, err: String(err) });
    });

  } else if (daemonIdParam) {
    // Direct daemon-id flow (legacy / post-pair direct channel)
    attachPhone(ws, daemonIdParam);

  } else {
    log("phone connect: missing X-Pairing-Token or daemon_id");
    ws.close(1008, "need X-Pairing-Token or daemon_id");
  }
}

// ── Helper: attach phone directly to a daemon by daemon_id ────────────────

function byteLength(raw: unknown): number {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
  return 0;
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

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-worker listening on http://127.0.0.1:${PORT}`);
  console.log(`  WSS /v1/daemon  — Ed25519 challenge-response (X-Daemon-Pubkey header)`);
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
