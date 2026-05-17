#!/usr/bin/env node
// miki-emit-codex.mjs — invoked by Codex `notify` (see ~/.codex/config.toml).
// Reads JSON payload from stdin, fans out 1–3 POSTs to the Miki-Moni daemon.
// Fails silently on any error to never block Codex.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const DATA_DIR = path.join(os.homedir(), ".miki-moni");
const SEEN_PATH = path.join(DATA_DIR, "codex-seen-uuids.json");
const CAPACITY = 500;

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function readPort() {
  try {
    const p = fs.readFileSync(path.join(DATA_DIR, "port"), "utf8").trim();
    if (/^\d+$/.test(p)) return parseInt(p, 10);
  } catch {}
  return 8765;
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")).order || []; }
  catch { return []; }
}
function saveSeen(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SEEN_PATH, JSON.stringify({ order: list }));
  } catch {}
}
function recordSeen(uuid) {
  const list = loadSeen();
  const idx = list.indexOf(uuid);
  const firstSight = idx === -1;
  if (idx !== -1) list.splice(idx, 1);
  list.push(uuid);
  while (list.length > CAPACITY) list.shift();
  saveSeen(list);
  return firstSight;
}

function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// Codex notify payload does not include cwd. We resolve it by scanning the
// rollout files for one whose name contains our UUID and reading its
// session_meta.cwd. Best-effort; falls back to process.cwd().
function findCwdForUuid(uuid) {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsRoot)) return process.cwd();
  const candidates = [];
  for (const year of safeReaddir(sessionsRoot)) {
    for (const month of safeReaddir(path.join(sessionsRoot, year))) {
      for (const day of safeReaddir(path.join(sessionsRoot, year, month))) {
        for (const f of safeReaddir(path.join(sessionsRoot, year, month, day))) {
          if (!f.endsWith(".jsonl") || !f.includes(uuid)) continue;
          candidates.push(path.join(sessionsRoot, year, month, day, f));
        }
      }
    }
  }
  for (const file of candidates) {
    try {
      const firstLine = fs.readFileSync(file, "utf8").split("\n", 1)[0];
      const obj = JSON.parse(firstLine);
      if (obj.type === "session_meta" && obj.payload?.cwd) return obj.payload.cwd;
    } catch {}
  }
  return process.cwd();
}

function post(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, path: "/event", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
      timeout: 2000,
    }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", () => resolve());
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.write(data); req.end();
  });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (payload?.type !== "agent-turn-complete") return;

    // Codex notify provides session UUID via env var CODEX_SESSION_ID; some
    // versions also include it inline in the payload — accept both.
    const uuid = process.env.CODEX_SESSION_ID || payload["session-id"] || payload.session_id;
    if (!uuid) return;

    const cwd = findCwdForUuid(uuid);
    const firstSight = recordSeen(uuid);
    const port = readPort();
    const now = Date.now();
    const base = { agent: "codex", cwd, session_uuid: uuid };

    const events = [];
    if (firstSight) events.push({ ...base, event_type: "session_start", timestamp: now });
    events.push({ ...base, event_type: "user_prompt", timestamp: now + 1 });
    events.push({ ...base, event_type: "stop", timestamp: now + 2 });

    for (const ev of events) await post(port, ev);
  } catch { /* never block codex */ }
})();
