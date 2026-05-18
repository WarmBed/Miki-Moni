// E2E phone-side probe: connects to wss://relay.f1telemetrystationpro.org/v1/phone with
// the persistent pairing token from local config, and watches for daemon
// activity through the relay. Confirms WS upgrade + daemon-side handshake
// (daemon must have registered the token with the relay) + relay routing
// envelopes correctly.
//
// Run: npx tsx D:/tmp/e2e-phone-probe.mts
//
// Pass criteria:
//   1. WS upgrade returns 101
//   2. Within 5s we receive at least one message from the relay
//      (typically pair_offer containing daemon's enc_pubkey — proves the
//       daemon is registered against THIS pairing token on the relay)

import WebSocket from "ws";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const RELAY = "wss://relay.f1telemetrystationpro.org";

interface Config {
  remote?: { worker_url: string; pair_token: string };
}

async function main() {
  const cfgRaw = await fs.readFile(
    path.join(os.homedir(), ".miki-moni", "config.json"),
    "utf8",
  );
  const cfg = JSON.parse(cfgRaw) as Config;
  const token = cfg.remote?.pair_token;
  if (!token) {
    console.error("no pair_token in config — daemon never paired publicly?");
    process.exit(2);
  }
  console.log(`token: ${token}`);
  console.log(`relay: ${RELAY}/v1/phone`);

  const url = `${RELAY}/v1/phone`;
  const ws = new WebSocket(url, {
    headers: { "X-Pairing-Token": token },
  });

  const start = Date.now();
  let opened = false;
  let upgradeStatus: number | null = null;
  const received: string[] = [];

  ws.on("upgrade", (res) => {
    upgradeStatus = res.statusCode ?? null;
    console.log(`upgrade status: ${upgradeStatus}`);
  });
  ws.on("unexpected-response", (_req, res) => {
    upgradeStatus = res.statusCode ?? null;
    console.log(`unexpected-response: ${upgradeStatus}`);
    res.resume();
  });
  ws.on("open", () => {
    opened = true;
    console.log(`OPEN at +${Date.now() - start}ms`);
  });
  ws.on("message", (raw) => {
    const s = raw.toString();
    received.push(s);
    // Truncate large frames for readability
    const preview = s.length > 200 ? `${s.slice(0, 200)}…(${s.length} bytes)` : s;
    console.log(`MSG at +${Date.now() - start}ms: ${preview}`);
  });
  ws.on("close", (code, reason) => {
    console.log(`CLOSE code=${code} reason=${reason.toString()} at +${Date.now() - start}ms`);
  });
  ws.on("error", (err) => {
    console.log(`ERROR at +${Date.now() - start}ms: ${err.message}`);
  });

  // Wait up to 6s for activity
  await new Promise<void>((resolve) => setTimeout(resolve, 6000));

  console.log("\n=== verdict ===");
  console.log(`upgrade 101: ${opened ? "✅" : `❌ status=${upgradeStatus}`}`);
  console.log(`messages received: ${received.length > 0 ? `✅ ${received.length}` : "❌ 0"}`);

  try { ws.close(); } catch { /* ignore */ }
  process.exit(opened && received.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(2);
});
