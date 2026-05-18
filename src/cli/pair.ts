import WebSocket from "ws";
import qrcode from "qrcode-terminal";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PORT_FILE } from "../data-dir.js";
import {
  loadOrInitConfig,
  saveConfig,
  addPairedPeer,
  removePairedPeer,
  findPeerById,
  type Config,
  type PairedPeer,
} from "../config.js";
import {
  fromBase64,
  toBase64,
  deriveSharedSecret,
  sign as signMsg,
} from "../crypto.js";
import {
  generateNewPairingToken,
  pairingQrPayload,
  computePeerId,
  PAIRING_TOKEN_TTL_MS,
} from "../pairing.js";
import { CONFIG_FILE as CONFIG_PATH } from "../data-dir.js";

function usage(): never {
  console.error("Usage:");
  console.error("  pnpm pair                       Show the persistent QR (default).");
  console.error("                                  Auto-creates the token on first run.");
  console.error("  pnpm pair --rotate              Regenerate the persistent token (invalidates the old QR).");
  console.error("  pnpm pair --new                 One-shot ephemeral token (10 min TTL).");
  console.error("  pnpm pair --list                List paired phones.");
  console.error("  pnpm pair --revoke <peer_id>    Remove a phone from local config + relay.");
  console.error("");
  console.error("Optional flags for --new and --rotate:");
  console.error("  --worker-url=<wss://...>        Override relay URL (otherwise from config).");
  process.exit(1);
}

function parseArgs(argv: string[]): {
  cmd: "show" | "rotate" | "new" | "list" | "revoke";
  workerUrl?: string;
  peerId?: string;
  name?: string;
} {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  if (args.includes("--list")) return { cmd: "list" };
  const revIdx = args.indexOf("--revoke");
  if (revIdx >= 0) {
    const peerId = args[revIdx + 1];
    if (!peerId) usage();
    return { cmd: "revoke", peerId };
  }
  const workerUrl = args.find((a) => a.startsWith("--worker-url="))?.split("=")[1];
  const name = args.find((a) => a.startsWith("--name="))?.split("=")[1];
  if (args.includes("--rotate")) return { cmd: "rotate", workerUrl, name };
  if (args.includes("--new")) return { cmd: "new", workerUrl, name };
  return { cmd: "show", workerUrl, name };
}

async function cmdList(cfg: Config): Promise<void> {
  if (cfg.paired_peers.length === 0) {
    console.log("(no paired peers)");
    return;
  }
  for (const p of cfg.paired_peers) {
    const paired = new Date(p.paired_at).toISOString();
    console.log(
      `${p.peer_id}  ${p.peer_name}  paired=${paired}  last_seen=${
        p.last_seen_at ? new Date(p.last_seen_at).toISOString() : "never"
      }`,
    );
  }
}

async function cmdRevoke(cfg: Config, peerId: string): Promise<void> {
  const peer = findPeerById(cfg, peerId);
  if (!peer) {
    console.error(`No peer with id ${peerId}`);
    process.exit(1);
  }
  // 1. Local config
  const next = removePairedPeer(cfg, peerId);
  await saveConfig(CONFIG_PATH, next);
  console.log(`[ok] Removed ${peerId} from local config`);

  // 2. Relay-side revoke (best-effort). Requires worker URL + peer's signing
  //    pubkey — older configs may lack the latter, in which case the relay
  //    still has the phone's signing pubkey but we can't address it.
  if (!peer.peer_sign_pubkey) {
    console.warn(
      `[warn] peer ${peerId} has no peer_sign_pubkey in config (paired before this field was added).\n` +
      `       Local config cleaned; the relay's paired_phones entry will remain until you reset the daemon\n` +
      `       (pnpm pair --reset, not yet implemented) or the phone calls revoke_self.`,
    );
    return;
  }
  const workerUrl = cfg.remote?.worker_url;
  if (!workerUrl) {
    console.warn(`[warn] no remote.worker_url in config — skipping relay revoke`);
    return;
  }
  try {
    await pushRevokeToRelay(workerUrl, cfg, peer.peer_sign_pubkey);
    console.log(`[ok] Relay acknowledged revoke for ${peerId}`);
  } catch (e: unknown) {
    console.warn(`[warn] relay revoke failed: ${(e as Error).message}. Local config is clean; retry later if needed.`);
  }
}

/** Open a daemon WS to relay, complete challenge-response, send revoke_phone, close. */
async function pushRevokeToRelay(
  workerUrl: string,
  cfg: Config,
  phone_sign_pubkey_b64: string,
): Promise<void> {
  const signPriv = fromBase64(cfg.device.signing_privkey);
  const wsUrl = workerUrl.replace(/\/$/, "").includes("/v1/")
    ? workerUrl.replace(/\/$/, "")
    : `${workerUrl.replace(/\/$/, "")}/v1/daemon`;

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { "X-Daemon-Pubkey": cfg.device.signing_pubkey },
    });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("revoke timed out (10s)"));
    }, 10_000);
    let ready = false;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; nonce?: string; issued_at_ms?: number };
      if (!ready && msg.type === "challenge") {
        const nonce = fromBase64(msg.nonce!);
        const sigMsg = buildChallengeMessage(nonce, msg.issued_at_ms!);
        ws.send(JSON.stringify({ type: "challenge_response", sig: toBase64(signMsg(sigMsg, signPriv)) }));
        return;
      }
      if (!ready && msg.type === "ready") {
        ready = true;
        ws.send(JSON.stringify({ type: "revoke_phone", phone_pubkey_b64: phone_sign_pubkey_b64 }));
        // Relay processes synchronously and broadcasts phone_revoked back to us;
        // we don't need to wait for that — closing right after send is safe.
        setTimeout(() => { ws.close(); clearTimeout(timeout); resolve(); }, 200);
      }
    });
    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
    ws.on("close", () => { if (!ready) { clearTimeout(timeout); reject(new Error("ws closed before ready")); } });
  });
}

/** Detached daemon spawn so the user doesn't need a second terminal. If a daemon
 *  is already running, the second one fails fast on port/lock conflict — harmless. */
function spawnDaemonInBackground(): void {
  try {
    const cwd = process.cwd();
    const child = spawn("pnpm", ["start"], {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",  // pnpm.cmd lookup needs shell on Windows
    });
    child.unref();
    console.log(`[ok] Daemon spawned in background (pid ${child.pid}). It will connect to the relay shortly.`);
    console.log(`     If it doesn't, open another terminal and run \`pnpm start\` manually.`);
  } catch (e: unknown) {
    console.warn(`[warn] Could not auto-spawn daemon (${(e as Error).message}). Run \`pnpm start\` manually.`);
  }
}

/** Bytes the daemon must sign in response to a challenge:
 *  nonce (32B) ++ issued_at_ms (8B big-endian). Matches worker's
 *  handshake.ts:buildChallengeMessage exactly. */
function buildChallengeMessage(nonce: Uint8Array, issuedAtMs: number): Uint8Array {
  const out = new Uint8Array(nonce.length + 8);
  out.set(nonce, 0);
  new DataView(out.buffer, nonce.length, 8).setBigUint64(0, BigInt(issuedAtMs), false);
  return out;
}

async function cmdNew(cfg: Config, workerUrlArg?: string): Promise<void> {
  const workerUrl = workerUrlArg ?? cfg.remote?.worker_url;
  if (!workerUrl) {
    console.error("Missing worker URL.");
    console.error("Either set `remote.worker_url` in ~/.miki-moni/config.json, or pass:");
    console.error("  pnpm pair --new --worker-url=wss://relay.f1telemetrystationpro.org");
    process.exit(1);
  }

  // Daemon-side Ed25519 (signing) + X25519 (encryption) keys from config.
  const signPriv = fromBase64(cfg.device.signing_privkey);
  const signPub = fromBase64(cfg.device.signing_pubkey);
  const encPriv = fromBase64(cfg.device.privkey);
  const encPub = fromBase64(cfg.device.pubkey);
  const daemonId = createHash("sha256").update(signPub).digest("hex").slice(0, 32);

  // 16-char Crockford base32 token shown in QR + manual entry.
  const pairingToken = generateNewPairingToken();
  const qrPayload = pairingQrPayload({
    worker_url: workerUrl,
    pairing_token: pairingToken,
    daemon_pubkey: cfg.device.pubkey,
    device_name: cfg.device.name,
  });

  // Daemon-side WS hits /v1/daemon endpoint. Append path if caller passed bare host.
  const wsUrl = workerUrl.replace(/\/$/, "").includes("/v1/")
    ? workerUrl.replace(/\/$/, "")
    : `${workerUrl.replace(/\/$/, "")}/v1/daemon`;

  console.log(`\nConnecting to ${wsUrl} ...`);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        "X-Daemon-Pubkey": cfg.device.signing_pubkey,
        "X-Daemon-Enc-Pubkey": cfg.device.pubkey,    // X25519, for phone ECDH (must be sent so DO stores it)
        "X-Daemon-Id": daemonId,
      },
    });

    let ready = false;
    let printedQr = false;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Pairing timed out after ${PAIRING_TOKEN_TTL_MS / 60_000} min`));
    }, PAIRING_TOKEN_TTL_MS);

    ws.on("open", () => { /* wait for challenge */ });

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // --- Challenge-response handshake ---
      if (!ready && msg.type === "challenge") {
        const nonce = fromBase64(msg.nonce);
        const sigMsg = buildChallengeMessage(nonce, msg.issued_at_ms);
        const sig = signMsg(sigMsg, signPriv);
        ws.send(JSON.stringify({ type: "challenge_response", sig: toBase64(sig) }));
        return;
      }
      if (!ready && msg.type === "ready") {
        ready = true;
        // Register this pairing token with the coordinator so the phone can claim it.
        ws.send(JSON.stringify({ type: "register_pairing", token: pairingToken }));
        if (!printedQr) {
          printedQr = true;
          console.log("Ready. Scan this QR with your phone:\n");
          qrcode.generate(qrPayload, { small: true });
          console.log("\nOr type this 16-char code (case-insensitive, dashes optional):\n");
          const grouped = pairingToken.match(/.{1,4}/g)?.join("-") ?? pairingToken;
          console.log(`  ${grouped}\n`);
          console.log(`Pairing URL: ${qrPayload}`);
          console.log(`Token expires in ${PAIRING_TOKEN_TTL_MS / 60_000} min.\n`);
          console.log("Waiting for phone to scan and complete pairing...");
        }
        return;
      }

      // --- Phone offer arrives via DO ---
      if (ready && msg.type === "pair_offer") {
        const phonePubB64 = msg.phone_pubkey as string;
        const phoneSignPubB64 = msg.phone_sign_pubkey as string | undefined;
        if (typeof phonePubB64 !== "string") {
          console.warn("pair_offer missing phone_pubkey, ignoring");
          return;
        }
        const phonePub = fromBase64(phonePubB64);
        const sharedSecret = deriveSharedSecret(encPriv, phonePub);
        const peer: PairedPeer = {
          peer_id: computePeerId(phonePubB64),
          peer_name: typeof msg.phone_name === "string" ? msg.phone_name : "phone",
          peer_pubkey: phonePubB64,
          peer_sign_pubkey: typeof phoneSignPubB64 === "string" ? phoneSignPubB64 : undefined,
          shared_secret: toBase64(sharedSecret),
          paired_at: Date.now(),
          last_seen_at: null,
        };

        // Acknowledge to phone (worker DO will route this back).
        ws.send(JSON.stringify({ type: "pair_ack", daemon_id: daemonId }));

        // Persist. MERGE into existing remote — don't replace, or we'll wipe
        // any persistent pair_token / phone_pwa_url the user set up earlier
        // (silent data loss).
        const updated = addPairedPeer(
          { ...cfg, remote: { ...(cfg.remote ?? {}), worker_url: workerUrl } },
          peer,
        );
        await saveConfig(CONFIG_PATH, updated);

        console.log(`\n[ok] Paired ${peer.peer_name} (id=${peer.peer_id})`);
        clearTimeout(timeout);
        ws.close();
        // Fire-and-forget background daemon spawn so the phone sees sessions
        // without the user having to open another terminal.
        spawnDaemonInBackground();
        resolve();
        return;
      }
    });

    ws.on("close", (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed before handshake (code ${code})`));
      }
      // After ready but before pair_offer arrived — caller's timeout handles it.
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Persistent QR commands ──────────────────────────────────────────────────
//
// `pnpm pair` (default) just renders the existing persistent QR. First-run
// creates the token. `pnpm pair --rotate` regenerates it (invalidating any old
// printed/saved copy). The token lives in config.remote.pair_token and is
// re-registered with the relay coordinator by RelayClient on every daemon
// start (with persistent:true), so the QR keeps working across restarts.

async function ensurePersistentToken(cfg: Config, workerUrlArg?: string): Promise<Config> {
  const workerUrl = workerUrlArg ?? cfg.remote?.worker_url;
  if (!workerUrl) {
    console.error("Missing worker URL.");
    console.error("Either set `remote.worker_url` in ~/.miki-moni/config.json, or pass:");
    console.error("  pnpm pair --worker-url=wss://relay.f1telemetrystationpro.org");
    process.exit(1);
  }
  if (cfg.remote?.pair_token) return cfg;
  const token = generateNewPairingToken();
  const next: Config = {
    ...cfg,
    remote: { ...(cfg.remote ?? { worker_url: workerUrl }), worker_url: workerUrl, pair_token: token },
  };
  await saveConfig(CONFIG_PATH, next);
  console.log("[ok] Generated a new persistent pair token and saved to config.");
  return next;
}

function printQrAndCode(cfg: Config): void {
  if (!cfg.remote?.pair_token || !cfg.remote.worker_url) {
    console.error("No persistent token in config — this should never happen after ensurePersistentToken().");
    return;
  }
  const qrPayload = pairingQrPayload({
    worker_url: cfg.remote.worker_url,
    pairing_token: cfg.remote.pair_token,
    daemon_pubkey: cfg.device.pubkey,
    device_name: cfg.device.name,
  });
  console.log("\nScan this QR (永久有效，rotate 前都能用):\n");
  qrcode.generate(qrPayload, { small: true });
  console.log("\nOr type this 16-char code (case-insensitive, dashes optional):\n");
  const grouped = cfg.remote.pair_token.match(/.{1,4}/g)?.join("-") ?? cfg.remote.pair_token;
  console.log(`  ${grouped}\n`);
  console.log(`Pairing URL: ${qrPayload}`);
  console.log("\nThis token survives daemon restarts and can pair multiple devices.");
  console.log("Rotate when leaked or unused: `pnpm pair --rotate`");
}

async function cmdShow(cfg: Config, workerUrlArg?: string): Promise<void> {
  const next = await ensurePersistentToken(cfg, workerUrlArg);
  printQrAndCode(next);
  if (next.paired_peers.length > 0) {
    console.log(`\nAlready paired (${next.paired_peers.length}):`);
    for (const p of next.paired_peers) {
      const paired = new Date(p.paired_at).toISOString().slice(0, 16).replace("T", " ");
      console.log(`  ${p.peer_id}  ${p.peer_name}  (paired ${paired})`);
    }
    console.log("\nRevoke a device: `pnpm pair --revoke <peer_id>`");
  }
}

// ── Daemon lifecycle helpers (used by cmdRotate to hot-swap the running
//    daemon so the new pair_token gets registered with the relay without
//    a manual restart). Mirrors the spawn dance in wrap.ts:ensureDaemonRunning. ─

async function readPortFile(): Promise<number | null> {
  try {
    const raw = await fsp.readFile(PORT_FILE, "utf8");
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function pingDaemonHttp(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/sessions`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) > 0);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function postAdmin(port: number, route: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: route, method: "POST",
      headers: { "content-length": "0" }, timeout: 2000,
    }, (res) => { res.resume(); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function spawnDetachedDaemon(): Promise<void> {
  // Locate tsx via package.json — same approach as wrap.ts so behaviour stays
  // consistent across pnpm-store layouts. spawning `node <tsx-bin> src/index.ts`
  // avoids Node 24's .cmd-spawn ban and doesn't need npm/pnpm on PATH.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.join(here, "..", "..");
  const indexEntry = path.join(here, "..", "index.ts");
  const req = createRequire(import.meta.url);
  const tsxPkgPath = req.resolve("tsx/package.json", { paths: [projectRoot] });
  const tsxPkg = req(tsxPkgPath);
  const tsxBinRel = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx;
  if (!tsxBinRel) throw new Error("tsx bin not found");
  const tsxBin = path.join(path.dirname(tsxPkgPath), tsxBinRel);

  const logPath = path.join(os.homedir(), ".miki-moni", "daemon.log");
  try { await fsp.mkdir(path.dirname(logPath), { recursive: true }); } catch { /* ignore */ }
  const out = await fsp.open(logPath, "a").catch(() => null);
  const stdio: any = out ? ["ignore", out.fd, out.fd] : ["ignore", "ignore", "ignore"];
  const child = spawn(process.execPath, [tsxBin, indexEntry], { detached: true, stdio, windowsHide: true });
  child.unref();
  if (out) out.close().catch(() => { /* ignore */ });
}

/**
 * Best-effort revoke a stale persistent token on the OLD worker before we
 * switch to a new worker URL. Without this, switching relays orphans the
 * old token on the previous coordinator (persistent tokens never auto-
 * expire), and anyone who recovers the old QR can still pair against that
 * old relay forever. Fire-and-forget; failure is non-fatal because the
 * primary security perimeter is the daemon side.
 */
async function revokeOldRelayToken(oldWorkerUrl: string, oldToken: string): Promise<void> {
  const httpsUrl = oldWorkerUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/$/, "");
  try {
    const r = await fetch(`${httpsUrl}/v1/pairing/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: oldToken }),
    });
    if (r.ok) console.log(`[ok] revoked stale token on previous relay (${httpsUrl})`);
    else console.log(`[info] previous relay returned HTTP ${r.status} for revoke (non-fatal)`);
  } catch (e) {
    console.log(`[info] could not reach previous relay to revoke (${(e as Error).message}). Non-fatal.`);
  }
}

async function cmdRotate(cfg: Config, workerUrlArg?: string): Promise<void> {
  const workerUrl = workerUrlArg ?? cfg.remote?.worker_url;
  if (!workerUrl) {
    console.error("Missing worker URL — pass `--worker-url=` or set in config first.");
    process.exit(1);
  }

  // If user is moving to a NEW relay, try to invalidate the old token over
  // there first. Persistent tokens on a different coordinator never expire
  // on their own — leaving the old QR usable against the old relay is a
  // security-adjacent footgun.
  const previousWorkerUrl = cfg.remote?.worker_url;
  const previousToken = cfg.remote?.pair_token;
  if (previousWorkerUrl && previousToken && previousWorkerUrl !== workerUrl) {
    await revokeOldRelayToken(previousWorkerUrl, previousToken);
  }

  const token = generateNewPairingToken();
  const next: Config = {
    ...cfg,
    remote: { ...(cfg.remote ?? { worker_url: workerUrl }), worker_url: workerUrl, pair_token: token },
  };
  await saveConfig(CONFIG_PATH, next);
  console.log("[ok] Rotated persistent pair token. Old QR is now invalid.");
  console.log("[note] Existing paired phones are unaffected — they reconnect via signing key, not token.");

  // Hot-swap the daemon so the new token gets registered with the relay
  // without the user having to manually Ctrl+C + restart. Previously this
  // was a footgun: the new QR would 404 at /v1/phone because the relay's
  // PairingCoordinator DO still held the stale token.
  //
  // IMPORTANT: /admin/restart already re-execs the daemon itself (with
  // MIKI_NO_TRAY_SPAWN=1). We previously ALSO called spawnDetachedDaemon()
  // unconditionally, creating two daemons racing to bind 8765 / overwrite
  // PORT_FILE — exactly the singleton-guard race the daemon's bootstrap
  // tries to avoid. Now: only spawn a fresh daemon if /admin/restart was
  // NOT acked (i.e. the old daemon couldn't restart itself, so we need a
  // cold start from outside).
  const port = await readPortFile();
  if (port && await pingDaemonHttp(port)) {
    process.stdout.write("[…] restarting daemon to register the new token… ");
    const acked = await postAdmin(port, "/admin/restart");
    if (!acked) {
      console.log("FAILED — falling back to cold-start spawn");
      console.error("[warn] /admin/restart did not ack. Attempting fresh spawn.");
      try { await spawnDetachedDaemon(); } catch (e) {
        console.error(`[warn] could not respawn daemon: ${(e as Error).message}`);
        console.error("[warn] start manually: pnpm start (from D:\\code\\cc-hub or wherever miki-moni lives)");
        printQrAndCode(next);
        return;
      }
    }
    // Wait for the new daemon to register the token + come up (up to 10s).
    let ready = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const p = await readPortFile();
      if (p && await pingDaemonHttp(p)) { ready = true; break; }
    }
    console.log(ready ? "OK" : "TIMED OUT — daemon may still be coming up, give it a moment");
  } else {
    console.log("[info] No running daemon detected. The new token will be active when you next `pnpm start`.");
  }

  printQrAndCode(next);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cfg = await loadOrInitConfig(CONFIG_PATH);
  switch (args.cmd) {
    case "list":
      await cmdList(cfg);
      return;
    case "revoke":
      await cmdRevoke(cfg, args.peerId!);
      return;
    case "new":
      await cmdNew(cfg, args.workerUrl);
      return;
    case "show":
      await cmdShow(cfg, args.workerUrl);
      return;
    case "rotate":
      await cmdRotate(cfg, args.workerUrl);
      return;
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
