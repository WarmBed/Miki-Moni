// REAL browser E2E — opens the deployed PWA in headless Chromium, scans QR
// fragment, attempts pair, captures ALL console messages + network requests
// + websocket events. This is what should have run from the start instead of
// my Node-side simulator.

import { chromium, type ConsoleMessage } from "playwright";

const URL = "https://miki-moni.pages.dev/#t=MTBXN3F2W8HQVE2J&r=wss%3A%2F%2Frelay.f1telemetrystationpro.org";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleMessages: { type: string; text: string }[] = [];
  page.on("console", (m: ConsoleMessage) => {
    consoleMessages.push({ type: m.type(), text: m.text() });
  });
  page.on("pageerror", (e) => {
    consoleMessages.push({ type: "pageerror", text: e.message });
  });

  // Capture all WebSocket events
  const wsEvents: string[] = [];
  page.on("websocket", (ws) => {
    wsEvents.push(`WS opened → ${ws.url()}`);
    ws.on("framereceived", (f) => {
      const payload = typeof f.payload === "string" ? f.payload : `<binary ${(f.payload as Buffer).byteLength}b>`;
      wsEvents.push(`  ← ${payload.slice(0, 200)}`);
    });
    ws.on("framesent", (f) => {
      const payload = typeof f.payload === "string" ? f.payload : `<binary ${(f.payload as Buffer).byteLength}b>`;
      wsEvents.push(`  → ${payload.slice(0, 200)}`);
    });
    ws.on("close", () => wsEvents.push(`WS closed`));
    ws.on("socketerror", (err) => wsEvents.push(`WS socketerror: ${err}`));
  });

  // Capture failed HTTP requests
  const failedRequests: string[] = [];
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });

  console.log(`Opening ${URL}`);
  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 15000 });
  } catch (e) {
    console.log(`goto failed: ${(e as Error).message}`);
  }

  // 3 screenshots over 30s to catch whatever UI state the page lands on
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "D:/tmp/e2e-shot-3s.png", fullPage: true });
  console.log("screenshot @ 3s → D:/tmp/e2e-shot-3s.png");

  await page.waitForTimeout(10000);
  await page.screenshot({ path: "D:/tmp/e2e-shot-13s.png", fullPage: true });
  console.log("screenshot @ 13s → D:/tmp/e2e-shot-13s.png");

  await page.waitForTimeout(15000);
  await page.screenshot({ path: "D:/tmp/e2e-shot-28s.png", fullPage: true });
  console.log("screenshot @ 28s → D:/tmp/e2e-shot-28s.png");

  console.log("\n=== console ===");
  for (const m of consoleMessages) console.log(`[${m.type}] ${m.text}`);

  console.log("\n=== websockets ===");
  for (const e of wsEvents) console.log(e);

  console.log("\n=== failed/error responses ===");
  for (const r of failedRequests) console.log(r);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(2); });
