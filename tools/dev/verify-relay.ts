/**
 * tools/dev/verify-relay.ts — automated E2E self-verification
 *
 * Proves the full encrypted relay path works against LIVE processes
 * (real daemon + real mock-worker over real WebSockets).
 *
 * Exit 0 on success, exit 1 with diagnostics on failure.
 *
 * Children are spawned via `pnpm exec tsx` so TypeScript sources run
 * directly without a compile step. The daemon's HOME / USERPROFILE env
 * vars are redirected to a temp dir so it picks up a synthetic config
 * instead of the user's real ~/.miki-moni/config.json.
 *
 * Usage:
 *   pnpm verify
 *   (or: pnpm exec tsx tools/dev/verify-relay.ts)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

// ── ANSI colors ────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const c = (code: string, s: string) => (process.stdout.isTTY ? `${code}${s}${R}` : s);

// ── Crypto helpers (inline — no import from src/ to keep this self-contained) ─

function toBase64(bytes: Uint8Array): string {
  return naclUtil.encodeBase64(bytes);
}
function fromBase64(s: string): Uint8Array {
  return naclUtil.decodeBase64(s);
}
function encryptEnvelope(
  plaintext: object,
  sharedSecret: Uint8Array,
  to: string,
): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ptBytes = naclUtil.decodeUTF8(JSON.stringify(plaintext));
  const ctBytes = nacl.secretbox(ptBytes, nonce, sharedSecret);
  const env = {
    v: 1,
    to,
    ct: toBase64(ctBytes),
    nonce: toBase64(nonce),
    ts: Date.now(),
  };
  return JSON.stringify(env);
}
function decryptEnvelope(raw: string, sharedSecret: Uint8Array): unknown | null {
  try {
    const env = JSON.parse(raw) as {
      v: number;
      ct: string;
      nonce: string;
      ts: number;
    };
    if (env.v !== 1) return null;
    const ctBytes = fromBase64(env.ct);
    const nonceBytes = fromBase64(env.nonce);
    if (nonceBytes.length !== nacl.secretbox.nonceLength) return null;
    const ptBytes = nacl.secretbox.open(ctBytes, nonceBytes, sharedSecret);
    if (!ptBytes) return null;
    return JSON.parse(naclUtil.encodeUTF8(ptBytes));
  } catch {
    return null;
  }
}

// ── ID derivation (must match production logic) ────────────────────────────

/** Matches RelayClient.peerSelfId() */
function computeDaemonId(daemonPubkeyB64: string): string {
  return daemonPubkeyB64.replace(/[+/=]/g, "").slice(0, 16);
}

/** Matches pairing.ts computePeerId() */
function computePeerId(phonePubkeyB64: string): string {
  return createHash("sha256")
    .update(phonePubkeyB64)
    .digest("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 16);
}

// ── Process management ─────────────────────────────────────────────────────

interface ManagedProc {
  name: string;
  child: ChildProcess;
  lines: string[];      // rolling stdout+stderr buffer (last ~200 lines)
}

function spawnProc(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ManagedProc {
  const child = spawn("pnpm", ["exec", "tsx", ...args], {
    stdio: "pipe",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

  const lines: string[] = [];
  const MAX_LINES = 200;

  function captureLine(line: string): void {
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    chunk.toString().split(/\r?\n/).forEach((l) => l && captureLine(`[stdout] ${l}`));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunk.toString().split(/\r?\n/).forEach((l) => l && captureLine(`[stderr] ${l}`));
  });

  return { name, child, lines };
}

function killProc(p: ManagedProc): void {
  try {
    if (p.child.exitCode === null && !p.child.killed) {
      p.child.kill("SIGTERM");
    }
  } catch { /* ignore */ }
}

function printTail(p: ManagedProc, n = 30): void {
  const tail = p.lines.slice(-n);
  console.error(c(YELLOW, `\n--- ${p.name} last ${tail.length} lines ---`));
  tail.forEach((l) => console.error(c(DIM, l)));
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error(`GET ${url} timeout`)); });
  });
}

function httpPost(url: string, payload: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: Number(urlObj.port),
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (d: Buffer) => (data += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error(`POST ${url} timeout`)); });
    req.write(body);
    req.end();
  });
}

// ── Poll helpers ───────────────────────────────────────────────────────────

async function pollUntil(
  fn: () => Promise<boolean>,
  intervalMs: number,
  maxMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function readPortFile(portFile: string): Promise<number | null> {
  try {
    const txt = await fs.readFile(portFile, "utf8");
    const n = Number(txt.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ── Verification results ───────────────────────────────────────────────────

interface Check {
  name: string;
  passed: boolean;
  error?: string;
}

function printSummary(checks: Check[]): void {
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  console.log("\n" + c(BOLD, "═".repeat(width + 12)));
  console.log(c(BOLD, " Verification Results"));
  console.log(c(BOLD, "═".repeat(width + 12)));
  for (const ch of checks) {
    const icon = ch.passed ? c(GREEN, "PASS") : c(RED, "FAIL");
    const name = ch.name.padEnd(width);
    const err = ch.error ? c(DIM, `  (${ch.error})`) : "";
    console.log(`  ${icon}  ${name}${err}`);
  }
  console.log(c(BOLD, "═".repeat(width + 12)));
  const allPassed = checks.every((c) => c.passed);
  if (allPassed) {
    console.log(c(GREEN + BOLD, "  ALL CHECKS PASSED\n"));
  } else {
    console.log(c(RED + BOLD, "  SOME CHECKS FAILED\n"));
  }
}

// ── WS receive helper ──────────────────────────────────────────────────────

function waitForMessage(
  ws: WebSocket,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WS message timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(raw.toString());
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(c(BOLD + CYAN, "\nmiki-moni E2E relay verifier\n"));

  // ── Step 1: Generate keypairs + derive shared secret ──────────────────

  const daemonKp = nacl.box.keyPair();
  const phoneKp = nacl.box.keyPair();
  const sharedSecret = nacl.box.before(phoneKp.publicKey, daemonKp.secretKey);
  // (phone uses same ECDH with reversed roles — same output)
  const phoneSharedSecret = nacl.box.before(daemonKp.publicKey, phoneKp.secretKey);

  const daemonPubB64 = toBase64(daemonKp.publicKey);
  const daemonPrivB64 = toBase64(daemonKp.secretKey);
  const phonePubB64 = toBase64(phoneKp.publicKey);

  // ── Step 2 & 3: Derive IDs (must match production logic) ────────────

  const daemonId = computeDaemonId(daemonPubB64);
  const peerId = computePeerId(phonePubB64);

  console.log(c(DIM, `  daemon_id : ${daemonId}`));
  console.log(c(DIM, `  peer_id   : ${peerId}\n`));

  // ── Step 4: Write synthetic config to temp dir ───────────────────────

  const ts = Date.now();
  const tempDir = path.join(os.tmpdir(), `miki-moni-verify-${ts}`);
  const tempHome = path.join(tempDir, "home");
  const hubDir = path.join(tempHome, ".miki-moni");
  await fs.mkdir(hubDir, { recursive: true });

  const configPath = path.join(hubDir, "config.json");
  const config = {
    device: {
      name: "verify-bot",
      pubkey: daemonPubB64,
      privkey: daemonPrivB64,
      created_at: ts,
    },
    remote: {
      worker_url: "ws://127.0.0.1:8787/v1/daemon",
      x_daemon_auth_token: "local-dev-token",
    },
    paired_peers: [
      {
        peer_id: peerId,
        peer_name: "verify-phone",
        peer_pubkey: phonePubB64,
        shared_secret: toBase64(sharedSecret),
        paired_at: ts,
        last_seen_at: null,
      },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(c(DIM, `  temp config: ${configPath}\n`));

  // ── Tracked state for cleanup ────────────────────────────────────────

  const procs: ManagedProc[] = [];
  let phone: WebSocket | null = null;
  const checks: Check[] = [];
  let failed = false;

  async function cleanup(): Promise<void> {
    phone?.close();
    for (const p of procs) killProc(p);
    // Wait a moment for processes to exit
    await new Promise((r) => setTimeout(r, 500));
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  async function bail(reason: string, ...failedProcs: ManagedProc[]): Promise<never> {
    console.error(c(RED + BOLD, `\nFATAL: ${reason}`));
    for (const p of failedProcs) printTail(p);
    printSummary(checks);
    await cleanup();
    process.exit(1);
  }

  // ── Step 5: Spawn mock-worker ────────────────────────────────────────

  console.log(c(CYAN, "Starting mock-worker..."));
  const worker = spawnProc("mock-worker", ["tools/mock-worker/server.ts"], {
    MOCK_WORKER_PORT: "8787",
    MOCK_WORKER_TOKEN: "local-dev-token",
  });
  procs.push(worker);

  const workerReady = await pollUntil(async () => {
    const r = await httpGet("http://127.0.0.1:8787/v1/health");
    if (r.status !== 200) return false;
    const body = JSON.parse(r.body) as { ok?: boolean };
    return body.ok === true;
  }, 500, 10_000);

  if (!workerReady) {
    await bail("mock-worker did not become healthy within 10s", worker);
  }
  console.log(c(GREEN, "  mock-worker ready\n"));

  // ── Step 6: Spawn daemon with redirected HOME ────────────────────────

  console.log(c(CYAN, "Starting daemon..."));

  // Node.js os.homedir() checks USERPROFILE on Windows, HOME on POSIX.
  // We set both so the daemon uses our temp dir on any platform.
  const daemon = spawnProc("daemon", ["src/index.ts"], {
    HOME: tempHome,
    USERPROFILE: tempHome,
  });
  procs.push(daemon);

  const portFile = path.join(hubDir, "port");
  let daemonPort = 8765; // default; overridden below after port file appears

  const daemonReady = await pollUntil(async () => {
    // First, discover the actual port from the port file (daemon writes it on startup)
    const p = await readPortFile(portFile);
    if (p !== null) daemonPort = p;
    const r = await httpGet(`http://127.0.0.1:${daemonPort}/sessions`);
    return r.status === 200;
  }, 500, 10_000);

  if (!daemonReady) {
    await bail("daemon did not become ready within 10s", daemon, worker);
  }
  console.log(c(GREEN, `  daemon ready on port ${daemonPort}\n`));

  // ── Step 7: Connect phone WS ────────────────────────────────────────

  console.log(c(CYAN, "Connecting simulated phone..."));
  const phoneWsUrl = `ws://127.0.0.1:8787/v1/phone?daemon_id=${daemonId}`;

  await new Promise<void>((resolve, reject) => {
    phone = new WebSocket(phoneWsUrl);
    phone.once("open", resolve);
    phone.once("error", reject);
    setTimeout(() => reject(new Error("Phone WS connection timeout")), 5000);
  });
  console.log(c(GREEN, "  phone connected\n"));

  // ── Step 8: Trigger a session_start via POST /event ─────────────────

  const testCwd = "/tmp/miki-moni-verify-workspace";
  const testUuid = `verify-uuid-${ts}`;

  console.log(c(CYAN, "Posting session_start event..."));
  const evResp = await httpPost(`http://127.0.0.1:${daemonPort}/event`, {
    event_type: "session_start",
    cwd: testCwd,
    session_uuid: testUuid,
    timestamp: Date.now(),
  });
  if (evResp.status !== 204) {
    await bail(`POST /event returned ${evResp.status}: ${evResp.body}`, daemon, worker);
  }
  console.log(c(GREEN, "  event posted\n"));

  // ── Step 9: Verify: phone receives encrypted event ──────────────────

  console.log(c(CYAN, "Verifying: session event delivered to phone..."));
  let eventCheck: Check = { name: "Session event → phone", passed: false };

  try {
    // May need to drain a few messages before we find the event
    const deadline = Date.now() + 3000;
    let eventReceived = false;

    while (!eventReceived && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      let rawMsg: string;
      try {
        rawMsg = await waitForMessage(phone!, Math.min(remaining, 500));
      } catch {
        break;
      }

      const pt = decryptEnvelope(rawMsg, phoneSharedSecret) as {
        kind?: string;
        session?: { cwd?: string; status?: string };
      } | null;

      if (
        pt &&
        pt.kind === "event" &&
        pt.session?.cwd === testCwd &&
        pt.session?.status === "active"
      ) {
        eventReceived = true;
        eventCheck = { name: "Session event → phone", passed: true };
      }
    }

    if (!eventReceived) {
      eventCheck.error = "no matching decrypted event within 3s";
    }
  } catch (err) {
    eventCheck.error = String(err);
  }

  checks.push(eventCheck);
  if (!eventCheck.passed) failed = true;
  console.log(
    eventCheck.passed
      ? c(GREEN, "  PASS: received encrypted session event\n")
      : c(RED, `  FAIL: ${eventCheck.error}\n`),
  );

  // ── Step 10 & 11: request_snapshot + verify state_snapshot ──────────

  console.log(c(CYAN, "Sending request_snapshot..."));
  let snapshotCheck: Check = { name: "request_snapshot → state_snapshot", passed: false };

  try {
    const reqMsg = encryptEnvelope({ kind: "request_snapshot" }, phoneSharedSecret, "daemon");
    phone!.send(reqMsg);

    const deadline = Date.now() + 2000;
    let snapshotReceived = false;

    while (!snapshotReceived && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      let rawMsg: string;
      try {
        rawMsg = await waitForMessage(phone!, Math.min(remaining, 500));
      } catch {
        break;
      }

      const pt = decryptEnvelope(rawMsg, phoneSharedSecret) as {
        kind?: string;
        sessions?: Array<{ cwd?: string }>;
      } | null;

      if (pt && pt.kind === "state_snapshot" && Array.isArray(pt.sessions)) {
        const hasSession = pt.sessions.some((s) => s.cwd === testCwd);
        if (hasSession) {
          snapshotReceived = true;
          snapshotCheck = { name: "request_snapshot → state_snapshot", passed: true };
        } else {
          snapshotCheck.error = `snapshot missing session cwd=${testCwd}`;
        }
      }
    }

    if (!snapshotReceived && !snapshotCheck.error) {
      snapshotCheck.error = "no state_snapshot received within 2s";
    }
  } catch (err) {
    snapshotCheck.error = String(err);
  }

  checks.push(snapshotCheck);
  if (!snapshotCheck.passed) failed = true;
  console.log(
    snapshotCheck.passed
      ? c(GREEN, "  PASS: state_snapshot received and contains the session\n")
      : c(RED, `  FAIL: ${snapshotCheck.error}\n`),
  );

  // ── Step 12 & 13: ping / pong ────────────────────────────────────────

  console.log(c(CYAN, "Sending ping..."));
  let pingCheck: Check = { name: "ping → pong", passed: false };
  const echoVal = `echo-${Math.random().toString(36).slice(2)}`;

  try {
    const pingMsg = encryptEnvelope({ kind: "ping", echo: echoVal }, phoneSharedSecret, "daemon");
    phone!.send(pingMsg);

    const deadline = Date.now() + 1000;
    let pongReceived = false;

    while (!pongReceived && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      let rawMsg: string;
      try {
        rawMsg = await waitForMessage(phone!, Math.min(remaining, 500));
      } catch {
        break;
      }

      const pt = decryptEnvelope(rawMsg, phoneSharedSecret) as {
        kind?: string;
        echo?: string;
      } | null;

      if (pt && pt.kind === "pong" && pt.echo === echoVal) {
        pongReceived = true;
        pingCheck = { name: "ping → pong", passed: true };
      }
    }

    if (!pongReceived) {
      pingCheck.error = "no matching pong within 1s";
    }
  } catch (err) {
    pingCheck.error = String(err);
  }

  checks.push(pingCheck);
  if (!pingCheck.passed) failed = true;
  console.log(
    pingCheck.passed
      ? c(GREEN, "  PASS: pong received with correct echo\n")
      : c(RED, `  FAIL: ${pingCheck.error}\n`),
  );

  // ── Step 14: Print summary ────────────────────────────────────────────

  printSummary(checks);

  // ── Step 15: Cleanup ─────────────────────────────────────────────────

  if (failed) {
    for (const p of procs) printTail(p);
  }

  await cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(c(RED + BOLD, "\nUnhandled error:"), err);
  process.exit(1);
});
