#!/usr/bin/env node
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const EVENT_TYPE = "agent-turn-complete";

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function payloadType(payload) {
  return payload?.type ?? payload?.event_type ?? payload?.eventType ?? null;
}

function sessionIdOf(payload) {
  return payload?.session_id
    ?? payload?.sessionId
    ?? payload?.session_meta?.id
    ?? payload?.sessionMeta?.id
    ?? payload?.payload?.id
    ?? null;
}

async function walkJsonlFiles(root, out = []) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

async function findRolloutPath(sessionId) {
  const root = process.env.MIKI_CODEX_SESSIONS_ROOT
    ?? path.join(os.homedir(), ".codex", "sessions");
  const files = await walkJsonlFiles(root);
  const matches = files.filter((file) => path.basename(file).includes(sessionId));
  if (matches.length === 0) return null;
  const stats = await Promise.all(matches.map(async (file) => ({ file, stat: await fs.stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0].file;
}

async function cwdFromRollout(file, sessionId) {
  if (!file) return null;
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "session_meta" && row?.payload?.id === sessionId && typeof row.payload.cwd === "string") {
        return row.payload.cwd;
      }
    } catch {
      // Ignore unrelated partial lines.
    }
  }
  return null;
}

async function readPort() {
  if (process.env.MIKI_PORT && /^\d+$/.test(process.env.MIKI_PORT)) return Number(process.env.MIKI_PORT);
  const portFile = process.env.MIKI_PORT_FILE ?? path.join(os.homedir(), ".miki-moni", "port");
  try {
    const raw = await fs.readFile(portFile, "utf8");
    if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  } catch {
    // Default below.
  }
  return 8765;
}

async function seenSet() {
  const seenPath = process.env.MIKI_CODEX_SEEN_PATH
    ?? path.join(os.homedir(), ".miki-moni", "codex-seen-uuids.json");
  try {
    const raw = await fs.readFile(seenPath, "utf8");
    const ids = JSON.parse(raw);
    return { seenPath, ids: new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : []) };
  } catch {
    return { seenPath, ids: new Set() };
  }
}

async function writeSeen(seenPath, ids) {
  await fs.mkdir(path.dirname(seenPath), { recursive: true });
  await fs.writeFile(seenPath, JSON.stringify([...ids], null, 2));
}

async function postEvent(port, body) {
  const payload = JSON.stringify(body);
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/event",
      method: "POST",
      timeout: 2000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function main() {
  const payload = await readStdin();
  if (!payload || payloadType(payload) !== EVENT_TYPE) return;
  const sessionId = sessionIdOf(payload);
  if (typeof sessionId !== "string" || !sessionId) return;

  const rolloutPath = await findRolloutPath(sessionId);
  const cwd = await cwdFromRollout(rolloutPath, sessionId)
    ?? (typeof payload.cwd === "string" ? payload.cwd : null)
    ?? process.cwd();
  const port = await readPort();
  const now = Date.now();
  const seen = await seenSet();

  if (!seen.ids.has(sessionId)) {
    await postEvent(port, {
      event_type: "session_start",
      agent: "codex",
      cwd,
      session_uuid: sessionId,
      timestamp: now,
    });
    seen.ids.add(sessionId);
    await writeSeen(seen.seenPath, seen.ids);
  }
  await postEvent(port, {
    event_type: "user_prompt",
    agent: "codex",
    cwd,
    session_uuid: sessionId,
    timestamp: now + 1,
  });
  await postEvent(port, {
    event_type: "stop",
    agent: "codex",
    cwd,
    session_uuid: sessionId,
    timestamp: now + 2,
  });
}

main().catch(() => {
  // Never block Codex on dashboard hook failures.
});
