// `cch claude` — wrap Claude Agent SDK in a long-lived process so cc-hub
// daemon can push prompts into the SAME query() stream as the user's terminal,
// without spawning a new `claude -p` per message.
//
// Architecture (one process per session):
//
//   ┌─ stdin (readline) ────┐
//   │                        │
//   │                        ▼
//   │              ┌─ PushableAsyncIterable ─┐
//   │              │   .push(SDKUserMessage) │
//   │              └─────────────┬───────────┘
//   │                            │
//   │                            ▼
//   │                ┌── query({ prompt, options: { resume, cwd } })
//   │                │
//   │                ▼ for await (msg of query)
//   │   ┌─ render to terminal ───┐
//   │   │  + send to daemon over │
//   │   │  WebSocket             │
//   │   └────────────────────────┘
//   │
//   └─ daemon ws.onmessage ──── parses { type:"push", prompt } → push to iter
//
// Usage:
//   cch claude                 # new session, cwd=$PWD
//   cch claude -c              # resume last session in cwd
//   cch claude -r <uuid>       # resume specific session

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import readline from "node:readline";
import { WebSocket } from "ws";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { PushableAsyncIterable } from "./pushable-iter.js";

const PORT_FILE = path.join(os.homedir(), ".cc-hub", "port");

interface WrapArgs {
  resume?: string;
  continue: boolean;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  cwd: string;
}

function parseArgs(argv: string[]): WrapArgs {
  const args: WrapArgs = { continue: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { args.resume = next; i++; }
      else { /* picker not supported here — treat as no-op */ }
    } else if (a === "-c" || a === "--continue") {
      args.continue = true;
    } else if (a === "--model") {
      args.model = argv[++i];
    } else if (a === "--permission-mode") {
      const next = argv[++i] as WrapArgs["permissionMode"];
      args.permissionMode = next;
    } else if (a === "--bypass-permissions") {
      args.permissionMode = "bypassPermissions";
    }
  }
  return args;
}

async function readDaemonPort(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PORT_FILE, "utf8");
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// Find most recent session uuid for resuming -c (we mirror Claude's "last
// session in this cwd" lookup by reading ~/.claude/projects/<encoded>/*.jsonl
// and picking the newest by mtime). Claude itself also accepts --continue
// but it expects to control session IDs; for our wrap we want to forward an
// explicit UUID into query({ resume }) so we know which session we own.
async function findLatestSessionInCwd(cwd: string): Promise<string | null> {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[]; try { dirs = await fs.readdir(projectsRoot); } catch { return null; }
  let best: { uuid: string; mtime: number } | null = null;
  for (const d of dirs) {
    const dirPath = path.join(projectsRoot, d);
    let files: string[]; try { files = await fs.readdir(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dirPath, f);
      try {
        const raw = await fs.readFile(fp, "utf8");
        // Confirm this transcript matches the wrapper's cwd
        const firstLineWithCwd = raw.split(/\r?\n/).find((l) => l.includes('"cwd"'));
        if (!firstLineWithCwd) continue;
        const parsed = JSON.parse(firstLineWithCwd);
        if (typeof parsed?.cwd !== "string") continue;
        if (path.resolve(parsed.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) continue;
        const stat = await fs.stat(fp);
        if (!best || stat.mtimeMs > best.mtime) {
          best = { uuid: f.replace(/\.jsonl$/, ""), mtime: stat.mtimeMs };
        }
      } catch { /* skip */ }
    }
  }
  return best?.uuid ?? null;
}

// Pretty terminal rendering for SDK messages. Intentionally simple — full
// fidelity (markdown, syntax highlight, spinners) is for later. Goal here is
// "you can clearly see what Claude is doing in the terminal".
const ESC = (s: string, code: number) => `\x1b[${code}m${s}\x1b[0m`;
const cyan  = (s: string) => ESC(s, 36);
const green = (s: string) => ESC(s, 32);
const yellow = (s: string) => ESC(s, 33);
const dim   = (s: string) => ESC(s, 2);
const bold  = (s: string) => ESC(s, 1);

function renderMessage(msg: SDKMessage): void {
  if (msg.type === "system" && msg.subtype === "init") {
    const session = (msg as any).session_id ?? "(no id yet)";
    process.stdout.write(`${dim("─".repeat(60))}\n`);
    process.stdout.write(`${dim(`session: ${session}`)}\n`);
    process.stdout.write(`${dim("─".repeat(60))}\n`);
    return;
  }
  if (msg.type === "assistant") {
    const m = (msg as any).message;
    const content = m?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          process.stdout.write(`\n${green(bold("● "))} ${block.text}\n`);
        } else if (block.type === "tool_use") {
          const desc = (block.input && typeof block.input === "object" && "description" in block.input)
            ? (block.input as any).description
            : null;
          process.stdout.write(`\n${cyan("⚒ " + block.name)}${desc ? dim(" · " + desc) : ""}\n`);
        }
      }
    }
    return;
  }
  if (msg.type === "user") {
    const m = (msg as any).message;
    const content = m?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          const preview = text.replace(/\s+/g, " ").slice(0, 200);
          process.stdout.write(`${dim("  ↳ " + preview + (text.length > 200 ? "…" : ""))}\n`);
        }
      }
    }
    return;
  }
  if (msg.type === "result") {
    const subtype = (msg as any).subtype;
    const cost = (msg as any).total_cost_usd;
    process.stdout.write(`\n${dim(`└─ ${subtype}${cost ? ` · $${cost.toFixed(4)}` : ""}`)}\n`);
    return;
  }
}

function printPrompt(): void {
  process.stdout.write(`\n${yellow("> ")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3)); // skip "node cch claude"

  // Resolve session uuid up front when --continue
  let resumeUuid: string | undefined = args.resume;
  if (!resumeUuid && args.continue) {
    const found = await findLatestSessionInCwd(args.cwd);
    if (found) resumeUuid = found;
  }

  // Open WS to daemon (optional — if daemon isn't running, run standalone).
  const port = await readDaemonPort();
  let ws: WebSocket | null = null;
  if (port) {
    ws = new WebSocket(`ws://127.0.0.1:${port}/wrap`);
    ws.on("open", () => {
      process.stdout.write(`${dim(`[wrap] WS connected to daemon (port ${port})`)}\n`);
      ws!.send(JSON.stringify({
        type: "register",
        session_uuid: resumeUuid ?? null,  // null = unknown until first init message
        cwd: args.cwd,
        pid: process.pid,
      }));
    });
    ws.on("error", (err) => {
      process.stdout.write(`${yellow(`[wrap] WS error: ${(err as Error).message}`)}\n`);
    });
    ws.on("close", (code) => {
      process.stdout.write(`${yellow(`[wrap] WS closed (code=${code}) — dashboard send will fall back to -p`)}\n`);
    });
  }

  // The push-able iterable that feeds query() — both stdin reader and WS push
  // messages into it.
  const messages = new PushableAsyncIterable<SDKUserMessage>();

  function sendUser(text: string, source: "stdin" | "hub"): void {
    if (!text.trim()) return;
    if (source === "hub") process.stdout.write(`\n${cyan("[hub] ")}${text}\n`);
    messages.push({
      type: "user",
      parent_tool_use_id: null,
      session_id: resumeUuid ?? "",
      message: { role: "user", content: text },
    } as SDKUserMessage);
  }

  if (ws) {
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.type === "push" && typeof m.prompt === "string") {
          sendUser(m.prompt, "hub");
        }
      } catch { /* ignore non-JSON */ }
    });
  }

  // Cold-start banner so the user knows we're alive and waiting for input.
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  process.stdout.write(`${bold("cch claude")} ${dim("· cwd=" + args.cwd)}\n`);
  if (resumeUuid) process.stdout.write(`${dim("resuming session: " + resumeUuid)}\n`);
  else process.stdout.write(`${dim("new session (uuid will appear once SDK init fires)")}\n`);
  if (ws) process.stdout.write(`${dim("daemon: ws://127.0.0.1:" + port + "/wrap")}\n`);
  else process.stdout.write(`${yellow("daemon: NOT connected (no port file — start cc-hub daemon)")}\n`);
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  printPrompt();

  // Start the query — long-lived, single shot for the whole session.
  const q = query({
    prompt: messages,
    options: {
      cwd: args.cwd,
      resume: resumeUuid,
      model: args.model,
      permissionMode: args.permissionMode,
    },
  });

  // Read user input from stdin without blocking the message loop. readline
  // gives us line-by-line entry; for multi-line input the user can paste.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => sendUser(line, "stdin"));
  rl.on("close", () => messages.end());

  // Consume the SDK stream — render + ship to daemon
  try {
    for await (const m of q) {
      renderMessage(m);
      // Tell daemon the session uuid as soon as we see it (first init message)
      if (ws && ws.readyState === ws.OPEN && m.type === "system" && (m as any).subtype === "init") {
        const sid = (m as any).session_id as string | undefined;
        if (sid && sid !== resumeUuid) {
          resumeUuid = sid;
          ws.send(JSON.stringify({ type: "session_uuid", session_uuid: sid }));
        }
      }
      // Mirror message to daemon (optional — daemon already reads JSONL)
      if (ws && ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify({ type: "message", message: m })); } catch { /* ignore */ }
      }
      // Re-print prompt after result so user knows we're ready
      if (m.type === "result") printPrompt();
    }
  } finally {
    rl.close();
    if (ws) try { ws.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error("\nwrap failed:", err);
  process.exit(1);
});
