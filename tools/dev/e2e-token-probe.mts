// Quick probe — does pair_token still work via query param (browser path)
// vs header (my E2E script path)? If one fails and the other passes, we know
// the worker has an inconsistency. If both fail, the token state on the DO
// is gone.

import WebSocket from "ws";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const RELAY = "wss://relay.f1telemetrystationpro.org";

async function probe(label: string, url: string, headers: Record<string, string> = {}) {
  console.log(`\n--- ${label} ---`);
  console.log(`url: ${url}`);
  console.log(`headers: ${JSON.stringify(headers)}`);
  const ws = new WebSocket(url, { headers });
  const start = Date.now();
  let upgradeStatus: number | null = null;
  ws.on("upgrade", (res) => { upgradeStatus = res.statusCode ?? null; });
  ws.on("unexpected-response", (_req, res) => { upgradeStatus = res.statusCode ?? null; res.resume(); });
  const result = await new Promise<{ ok: boolean; msg: string }>((resolve) => {
    let firstMsg: string | null = null;
    ws.once("open", () => {
      console.log(`OPEN at +${Date.now() - start}ms (101)`);
    });
    ws.on("message", (raw) => {
      firstMsg = raw.toString();
      console.log(`MSG at +${Date.now() - start}ms: ${firstMsg.slice(0, 200)}`);
    });
    ws.on("close", (code, reason) => {
      console.log(`CLOSE code=${code} reason="${reason.toString()}" at +${Date.now() - start}ms`);
      resolve({
        ok: firstMsg !== null && code !== 4002,
        msg: firstMsg ?? `closed ${code}`,
      });
    });
    ws.on("error", (err) => {
      console.log(`ERROR: ${err.message}`);
    });
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ ok: firstMsg !== null, msg: firstMsg ?? "timeout" });
    }, 5000);
  });
  console.log(`upgrade status: ${upgradeStatus}`);
  return result;
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), ".miki-moni", "config.json"), "utf8")) as {
    remote?: { pair_token: string };
  };
  const token = cfg.remote!.pair_token;
  console.log(`token: ${token}`);

  // Path 1: X-Pairing-Token header (my script's path)
  const a = await probe("via X-Pairing-Token header", `${RELAY}/v1/phone`, { "X-Pairing-Token": token });

  // Path 2: ?token= query param (browser's path) — needs Origin too?
  const b = await probe("via ?token= query (no Origin)", `${RELAY}/v1/phone?token=${token}`);

  // Path 3: ?token= with Origin header (simulating browser)
  const c = await probe("via ?token= query + Origin", `${RELAY}/v1/phone?token=${token}`, {
    Origin: "https://miki-moni.pages.dev",
  });

  console.log(`\n=== summary ===`);
  console.log(`header path:        ${a.ok ? "PASS" : "FAIL"} — ${a.msg.slice(0, 100)}`);
  console.log(`query param:        ${b.ok ? "PASS" : "FAIL"} — ${b.msg.slice(0, 100)}`);
  console.log(`query+Origin:       ${c.ok ? "PASS" : "FAIL"} — ${c.msg.slice(0, 100)}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
