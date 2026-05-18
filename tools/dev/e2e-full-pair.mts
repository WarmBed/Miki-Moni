// Full E2E phone pairing + envelope round-trip against LIVE relay + LIVE
// local daemon. Run from cc-hub repo root:
//   npx tsx tools/dev/e2e-full-pair.mts
//
// Verifies, end-to-end:
//   1. WS upgrade to wss://relay.f1telemetrystationpro.org/v1/phone returns 101
//   2. Relay sends pair_init carrying daemon's X25519 enc_pubkey
//   3. Phone-side ECDH against daemon_pubkey produces the same key the daemon
//      will later use to encrypt outbound envelopes
//   4. Phone sends pair_offer → relay forwards to daemon → daemon writes peer
//      to config + sends pair_ack → relay marks phone authed + forwards back
//   5. Triggering a session event on local daemon (POST /event) results in an
//      encrypted envelope landing on the phone WS, decryptable with the ECDH
//      shared secret, with a session payload matching what we POSTed
//
// Failure prints the FIRST step that broke. Pass exits 0.
//
// Side-effect: adds ONE entry to ~/.miki-moni/config.json paired_peers. The
// script revokes it on success so the config doesn't accumulate test peers.

import WebSocket from "ws";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";

const RELAY = "wss://relay.f1telemetrystationpro.org";
const DAEMON_HTTP = "http://127.0.0.1:8765";

const G = "\x1b[32m"; const R = "\x1b[31m"; const Y = "\x1b[33m"; const D = "\x1b[2m"; const N = "\x1b[0m";
const ok = (s: string) => console.log(`${G}✓${N} ${s}`);
const fail = (s: string) => { console.log(`${R}✗${N} ${s}`); process.exit(1); };
const info = (s: string) => console.log(`${D}· ${s}${N}`);

function toB64(b: Uint8Array): string { return naclUtil.encodeBase64(b); }
function fromB64(s: string): Uint8Array { return naclUtil.decodeBase64(s); }

function encryptEnvelope(plaintext: object, key: Uint8Array, to = "daemon"): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const pt = naclUtil.decodeUTF8(JSON.stringify(plaintext));
  const ct = nacl.secretbox(pt, nonce, key);
  return JSON.stringify({ v: 1, to, ct: toB64(ct), nonce: toB64(nonce), ts: Date.now() });
}
function decryptEnvelope(raw: string, key: Uint8Array): any | null {
  try {
    const e = JSON.parse(raw);
    if (e.v !== 1) return null;
    const pt = nacl.secretbox.open(fromB64(e.ct), fromB64(e.nonce), key);
    if (!pt) return null;
    return JSON.parse(naclUtil.encodeUTF8(pt));
  } catch { return null; }
}

// Must match src/pairing.ts:computePeerId — sha256 → base64 → strip +/= → 16 chars
function computePeerId(phonePubB64: string): string {
  return createHash("sha256")
    .update(phonePubB64)
    .digest("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 16);
}

function httpPostJson(url: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => chunks += c);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // ── 1. Load config ──────────────────────────────────────────────────────
  const cfgPath = path.join(os.homedir(), ".miki-moni", "config.json");
  const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as {
    remote?: { worker_url: string; pair_token: string };
  };
  const token = cfg.remote?.pair_token;
  if (!token) fail("no pair_token in config — daemon not paired publicly");
  info(`token=${token}`);

  // ── 2. Generate ephemeral phone keypairs ────────────────────────────────
  const encKp = nacl.box.keyPair();          // X25519 for ECDH
  const signKp = nacl.sign.keyPair();        // Ed25519 for reconnect (not used here)
  const phoneEncPubB64 = toB64(encKp.publicKey);
  const phoneSignPubB64 = toB64(signKp.publicKey);
  const peerId = computePeerId(phoneEncPubB64);
  info(`phone peer_id=${peerId}`);

  // ── 3. Connect to relay via pair_token ──────────────────────────────────
  const ws = new WebSocket(`${RELAY}/v1/phone`, { headers: { "X-Pairing-Token": token } });
  const close = () => { try { ws.close(); } catch { /* */ } };
  let pairInit: { daemon_pubkey: string } | null = null;
  let sharedSecret: Uint8Array | null = null;
  let pairAck: any = null;
  const decryptedEvents: any[] = [];

  const opened = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("error", () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  if (!opened) { close(); fail("WS open failed (5s timeout / error)"); }
  ok(`WS upgrade 101 (open)`);

  ws.on("message", (raw) => {
    const text = raw.toString();
    // First message expected: pair_init (plaintext JSON)
    if (!pairInit) {
      try {
        const m = JSON.parse(text);
        if (m.type === "pair_init") {
          pairInit = m;
          // derive shared
          sharedSecret = nacl.box.before(fromB64(m.daemon_pubkey), encKp.secretKey);
          return;
        }
      } catch { /* fallthrough */ }
    }
    // After pair_offer, expect pair_ack (still plaintext from relay)
    if (!pairAck) {
      try {
        const m = JSON.parse(text);
        if (m.type === "pair_ack") { pairAck = m; return; }
      } catch { /* */ }
    }
    // Encrypted envelopes from daemon broadcasts
    if (sharedSecret) {
      const decrypted = decryptEnvelope(text, sharedSecret);
      if (decrypted) {
        decryptedEvents.push(decrypted);
        return;
      }
    }
    // Otherwise, log for diagnostics
    info(`(unhandled msg: ${text.slice(0, 150)})`);
  });

  // ── 4. Wait for pair_init ───────────────────────────────────────────────
  const gotInit = await new Promise<boolean>((resolve) => {
    const id = setInterval(() => {
      if (pairInit) { clearInterval(id); resolve(true); }
    }, 50);
    setTimeout(() => { clearInterval(id); resolve(false); }, 4000);
  });
  if (!gotInit) { close(); fail("no pair_init within 4s"); }
  ok(`received pair_init (daemon_pubkey=${pairInit!.daemon_pubkey.slice(0, 16)}…)`);
  ok(`derived shared secret via ECDH`);

  // ── 5. Send pair_offer ──────────────────────────────────────────────────
  ws.send(JSON.stringify({
    type: "pair_offer",
    phone_pubkey: phoneEncPubB64,            // X25519 (for shared-secret derivation)
    phone_sign_pubkey: phoneSignPubB64,      // Ed25519 (for reconnect sig)
    peer_id: peerId,
    peer_name: `e2e-probe-${Date.now()}`,
  }));
  info(`sent pair_offer`);

  // ── 6. Wait for pair_ack ────────────────────────────────────────────────
  const gotAck = await new Promise<boolean>((resolve) => {
    const id = setInterval(() => {
      if (pairAck) { clearInterval(id); resolve(true); }
    }, 50);
    setTimeout(() => { clearInterval(id); resolve(false); }, 6000);
  });
  if (!gotAck) { close(); fail("no pair_ack within 6s — daemon never replied via relay"); }
  ok(`received pair_ack (relay routed daemon→phone)`);

  // Also register our peer_id so daemon→phone envelopes addressed to phone:<peer_id> reach us
  ws.send(JSON.stringify({ type: "register_peer_id", peer_id: peerId }));

  // Give relay a moment to mark us authed
  await new Promise((r) => setTimeout(r, 500));

  // ── 7. Trigger a session event on local daemon ──────────────────────────
  const testUuid = `e2e-probe-${Date.now()}`;
  const testCwd = `D:\\code\\e2e-probe-${Date.now()}`;
  const evResp = await httpPostJson(`${DAEMON_HTTP}/event`, {
    event_type: "session_start",
    cwd: testCwd,
    session_uuid: testUuid,
    timestamp: Date.now(),
  });
  if (evResp.status !== 204) {
    close();
    fail(`POST /event returned ${evResp.status}: ${evResp.body}`);
  }
  info(`POST /event 204 (session_start uuid=${testUuid.slice(0, 16)}…)`);

  // ── 8. Wait for the encrypted broadcast to land on phone ────────────────
  const gotEvent = await new Promise<boolean>((resolve) => {
    const id = setInterval(() => {
      const hit = decryptedEvents.find((e) =>
        (e?.kind === "event" || e?.type === "session_changed") &&
        (e?.session?.session_uuid === testUuid || e?.session?.cwd?.toLowerCase() === testCwd.toLowerCase())
      );
      if (hit) { clearInterval(id); resolve(true); }
    }, 100);
    setTimeout(() => { clearInterval(id); resolve(false); }, 8000);
  });
  if (!gotEvent) {
    info(`decrypted events seen: ${decryptedEvents.length}`);
    for (const e of decryptedEvents.slice(0, 3)) info(`  ${JSON.stringify(e).slice(0, 200)}`);
    close();
    fail("daemon broadcast didn't reach phone within 8s (or didn't decrypt to expected event)");
  }
  ok(`daemon → relay → phone broadcast received + decrypted`);

  // ── 9. Revoke this test peer so config doesn't grow ─────────────────────
  ws.send(JSON.stringify({ type: "revoke_self", phone_sign_pubkey: phoneSignPubB64 }));
  info(`sent revoke_self (cleanup; config will drop this peer)`);

  await new Promise((r) => setTimeout(r, 500));
  close();
  console.log(`\n${G}E2E PASS${N} — daemon ↔ relay ↔ phone full round-trip verified.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`${R}probe crashed:${N}`, e);
  process.exit(2);
});
