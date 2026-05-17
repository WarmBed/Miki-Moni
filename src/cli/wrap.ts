// `miki claude` — wrap Claude Agent SDK in a long-lived process so miki-moni
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
//   miki claude                 # new session, cwd=$PWD
//   miki claude -c              # resume last session in cwd
//   miki claude -r <uuid>       # resume specific session

import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { WebSocket } from "ws";
import { query, type SDKMessage, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { PushableAsyncIterable } from "./pushable-iter.js";
import { PORT_FILE } from "../data-dir.js";

interface WrapArgs {
  resume?: string;
  continue: boolean;
  fresh: boolean;  // explicit opt-in to a brand-new session; otherwise we auto-continue
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "auto";
  cwd: string;
}

function parseArgs(argv: string[]): WrapArgs {
  const args: WrapArgs = { continue: false, fresh: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { args.resume = next; i++; }
      else { /* picker not supported here — treat as no-op */ }
    } else if (a === "-c" || a === "--continue") {
      args.continue = true;
    } else if (a === "--new" || a === "--fresh") {
      args.fresh = true;
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

// Quick liveness check — port file alone is unreliable because a crashed
// daemon leaves it behind. HTTP GET /sessions is cheap and unambiguous.
function pingDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/sessions`, { timeout: 800 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) > 0);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Canonical default port (mirrors src/index.ts DEFAULT_PORT). When PORT_FILE
// points at a dead port (stale entry from a daemon that crashed before
// cleanup), we probe this BEFORE assuming nothing's home. Otherwise wrap's
// auto-spawn forks a duplicate daemon on a different port and the dashboard
// + CLI split-brain across two daemons (root cause of the 8766 race).
const MIKI_DEFAULT_PORT = 8765;

// If no daemon is reachable, spawn one as a detached background process so
// `miki claude` works as a single-command UX. The child keeps running after
// the wrap exits (other wraps + dashboard browser can attach to it).
async function ensureDaemonRunning(): Promise<number | null> {
  const existing = await readDaemonPort();
  if (existing && await pingDaemon(existing)) return existing;
  // PORT_FILE stale (or missing). Before spawning a duplicate, see if a live
  // daemon is actually sitting on the default port — common when the previous
  // daemon got hard-killed and a new one is already up but PORT_FILE wasn't
  // refreshed. Saves us from racing over PORT_FILE with a needless spawn.
  if (existing !== MIKI_DEFAULT_PORT && await pingDaemon(MIKI_DEFAULT_PORT)) {
    return MIKI_DEFAULT_PORT;
  }

  // Locate this script's directory → walk up to project root → find tsx + index.
  // Works for both dev (src/cli/wrap.ts under tsx) and a published npm package
  // shipped with the same layout (we don't pre-compile TS).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.join(here, "..", "..");
  const indexEntry = path.join(here, "..", "index.ts");

  const req = createRequire(import.meta.url);
  let tsxBin: string;
  try {
    const tsxPkgPath = req.resolve("tsx/package.json", { paths: [projectRoot] });
    const tsxPkg = req(tsxPkgPath);
    const tsxBinRel = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx;
    if (!tsxBinRel) throw new Error("tsx bin not found");
    tsxBin = path.join(path.dirname(tsxPkgPath), tsxBinRel);
  } catch (err) {
    process.stdout.write(`${yellow(`[miki] could not locate tsx — install miki-moni cleanly: ${(err as Error).message}`)}\n`);
    return null;
  }

  process.stdout.write(`${dim(`[miki] daemon not running — spawning in background…`)}\n`);
  // Log file under HUB_HOME so the daemon's stdout/stderr isn't lost.
  const logPath = path.join(os.homedir(), ".miki-moni", "daemon.log");
  try { await fs.mkdir(path.dirname(logPath), { recursive: true }); } catch { /* ignore */ }
  const out = await fs.open(logPath, "a").catch(() => null);
  const stdio: any = out
    ? ["ignore", out.fd, out.fd]
    : ["ignore", "ignore", "ignore"];
  const child = spawn(process.execPath, [tsxBin, indexEntry], {
    detached: true,
    stdio,
    windowsHide: true,
  });
  child.unref();
  // open() handle is now owned by the child via fd inheritance — close ours.
  if (out) out.close().catch(() => { /* ignore */ });

  // Poll for port file + liveness up to 10s.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const p = await readDaemonPort();
    if (p && await pingDaemon(p)) {
      process.stdout.write(`${dim(`[miki] daemon up (port ${p}, log → ${logPath})`)}\n`);
      return p;
    }
  }
  process.stdout.write(`${yellow(`[miki] daemon failed to come up in 10s — see ${logPath}`)}\n`);
  return null;
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

// Set when we've streamed at least one text block in the current turn via
// stream_event deltas. While true, the assistant-complete handler skips
// reprinting text (which would duplicate everything on screen). Reset on
// each result.
let didStreamThisTurn = false;
function renderMessage(msg: SDKMessage): void {
  if (msg.type === "system" && msg.subtype === "init") {
    const session = (msg as any).session_id ?? "(no id yet)";
    process.stdout.write(`${dim("─".repeat(60))}\n`);
    process.stdout.write(`${dim(`session: ${session}`)}\n`);
    process.stdout.write(`${dim("─".repeat(60))}\n`);
    return;
  }
  if (msg.type === "stream_event") {
    const ev = (msg as any).event;
    if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
      process.stdout.write(`\n${green(bold("● "))} `);
      didStreamThisTurn = true;
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      process.stdout.write(ev.delta.text);
    } else if (ev?.type === "content_block_stop" && didStreamThisTurn) {
      process.stdout.write(`\n`);
    }
    return;
  }
  if (msg.type === "assistant") {
    const m = (msg as any).message;
    const content = m?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          // Already streamed via stream_event — skip duplicate print.
          if (didStreamThisTurn) continue;
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
    didStreamThisTurn = false;  // ready for next turn
    return;
  }
}

function printPrompt(): void {
  process.stdout.write(`\n${yellow("> ")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(3)); // skip "node miki claude"

  // Resolve session uuid up front when --continue.
  let resumeUuid: string | undefined = args.resume;
  if (!resumeUuid && args.continue) {
    const found = await findLatestSessionInCwd(args.cwd);
    if (found) resumeUuid = found;
  }

  // Open WS to daemon with auto-reconnect. Daemon hot-reload during dev or any
  // network blip kills the connection — we re-dial every 3s indefinitely.
  // `currentWs` is mutated on each reconnect; `getWs()` always returns the
  // freshest one so message handlers always read latest. If no daemon is
  // running yet, we spawn one as a detached background process so the user's
  // single `miki claude` invocation Just Works.
  const port = await ensureDaemonRunning();
  let currentWs: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const getWs = (): WebSocket | null => currentWs;

  // Mutable handle to the SDK Query. WS message handler is registered inside
  // connect() (called BEFORE `q` is created), so we need a mutable ref so the
  // handler reads the latest value when daemon pushes set_permission_mode.
  // Also tracked: current mode so we can echo it back after each setPermissionMode.
  let currentQ: Query | null = null;
  let currentMode: NonNullable<WrapArgs["permissionMode"]> = args.permissionMode ?? "default";

  function connect(): void {
    if (!port) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/wrap`);
    currentWs = ws;
    ws.on("open", () => {
      process.stdout.write(`${dim(`[wrap] WS connected to daemon (port ${port})`)}\n`);
      ws.send(JSON.stringify({
        type: "register",
        session_uuid: resumeUuid ?? null,
        cwd: args.cwd,
        pid: process.pid,
        permission_mode: currentMode,
      }));
      // If we already had a session_uuid from SDK init (i.e., this is a
      // RECONNECT after init already happened), tell daemon right away.
      if (resumeUuid) {
        ws.send(JSON.stringify({ type: "session_uuid", session_uuid: resumeUuid }));
      }
    });
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.type === "push" && typeof m.prompt === "string") {
          const imgs = Array.isArray(m.images) ? m.images.filter((i: any) => i?.media_type && i?.data) : undefined;
          sendUser(m.prompt, "hub", imgs);
        } else if (m?.type === "ask_question_answer" && typeof m.question_id === "string") {
          // Dashboard answered an open AskUserQuestion. Format indices to a
          // readable answer string and push as a user message.
          if (!pendingAsk || pendingAsk.id !== m.question_id) return;  // stale
          const indices: string[][] = Array.isArray(m.answers) ? m.answers : [];
          const answer = formatAnswerFromIndices(indices);
          if (answer.trim()) answerAsk(answer);
        } else if (m?.type === "set_permission_mode" && typeof m.mode === "string") {
          // Dashboard requested a mode switch. SDK only supports this in
          // streaming-input mode (we are), and `q` must exist (created after
          // first connect). On success echo `permission_mode_changed` back so
          // daemon updates the map + rebroadcasts to all browser clients.
          const newMode = m.mode as NonNullable<WrapArgs["permissionMode"]>;
          const q = currentQ;
          if (!q) {
            process.stdout.write(`${yellow(`[wrap] set_permission_mode received but SDK query not ready yet`)}\n`);
            return;
          }
          q.setPermissionMode(newMode).then(() => {
            currentMode = newMode;
            process.stdout.write(`${cyan(`[hub] permission mode → ${newMode}`)}\n`);
            const live = getWs();
            if (live && live.readyState === live.OPEN && resumeUuid) {
              try { live.send(JSON.stringify({ type: "permission_mode_changed", session_uuid: resumeUuid, mode: newMode })); }
              catch { /* ignore */ }
            }
          }).catch((err: unknown) => {
            process.stdout.write(`${yellow(`[wrap] setPermissionMode failed: ${(err as Error).message}`)}\n`);
          });
        } else if (m?.type === "interrupt") {
          // Dashboard pressed the ⏹ button. Stop whatever the model is doing.
          const q = currentQ;
          if (!q) {
            process.stdout.write(`${yellow(`[wrap] interrupt received but SDK query not ready yet`)}\n`);
            return;
          }
          q.interrupt().then(() => {
            process.stdout.write(`${cyan(`[hub] ⏹ interrupted`)}\n`);
            // Activity is meaningless once interrupted; clear so dashboard stops showing "Ideating"
            setActivity(null);
          }).catch((err: unknown) => {
            process.stdout.write(`${yellow(`[wrap] interrupt failed: ${(err as Error).message}`)}\n`);
          });
        }
      } catch { /* ignore non-JSON */ }
    });
    ws.on("error", (err) => {
      process.stdout.write(`${yellow(`[wrap] WS error: ${(err as Error).message}`)}\n`);
    });
    ws.on("close", (code) => {
      process.stdout.write(`${yellow(`[wrap] WS closed (code=${code}) — reconnecting in 3s…`)}\n`);
      currentWs = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    });
  }
  connect();

  // The push-able iterable that feeds query() — both stdin reader and WS push
  // messages into it.
  const messages = new PushableAsyncIterable<SDKUserMessage>();

  // Activity broadcaster — pushes "Ideating" / "Using <tool>" / "Replying" to
  // daemon whenever the SDK stream signals a state transition. Daemon relays
  // to dashboard. Cleared on result.
  let currentActivity: string | null = null;
  function setActivity(label: string | null): void {
    if (label === currentActivity) return;
    currentActivity = label;
    const liveWs = getWs();
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "activity", session_uuid: resumeUuid, label })); }
      catch { /* ignore */ }
    }
  }

  // ── AskUserQuestion tracking ─────────────────────────────────────────────
  // When Claude uses the AskUserQuestion tool, we surface it to dashboard +
  // terminal and wait for the user's answer. Answer can come from either:
  //   - dashboard WS (user clicked the picker in browser)
  //   - terminal stdin (user typed a number 1-N or free text)
  // First one wins; we then push the answer as a regular user message into
  // the query iterable so Claude can see the response.
  interface QQuestion { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }
  interface PendingAsk { id: string; questions: QQuestion[] }
  let pendingAsk: PendingAsk | null = null;

  function emitAskQuestion(id: string, questions: QQuestion[]): void {
    pendingAsk = { id, questions };
    // 1. Daemon broadcast
    const liveWs = getWs();
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "ask_question", session_uuid: resumeUuid, question_id: id, questions })); }
      catch { /* ignore */ }
    }
    // 2. Terminal fallback render
    process.stdout.write(`\n${yellow(bold("❓ Claude 在問你問題："))}\n`);
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]!;
      process.stdout.write(`\n${bold(`Q${qi + 1}. ${q.question}`)}\n`);
      q.options.forEach((opt, i) => {
        process.stdout.write(`  ${cyan(String(i + 1))}. ${opt.label}${opt.description ? dim(` — ${opt.description}`) : ""}\n`);
      });
    }
    process.stdout.write(`\n${dim("→ 在 dashboard 點選 OR terminal 直接輸入答案文字 / 編號 (如 1 或 1,3)")}\n`);
    printPrompt();
  }

  // Convert raw user input (from stdin or dashboard) into a tidy answer string
  // formatted as Claude expects. For dashboard, we get structured selections;
  // for terminal, we get a string the user typed.
  function formatAnswerFromIndices(indicesPerQuestion: string[][]): string {
    if (!pendingAsk) return "";
    const lines: string[] = [];
    pendingAsk.questions.forEach((q, qi) => {
      const idxs = indicesPerQuestion[qi] ?? [];
      const picks = idxs.map((idx) => {
        const n = parseInt(idx, 10);
        if (Number.isFinite(n) && n >= 1 && n <= q.options.length) return q.options[n - 1]!.label;
        return idx;  // free-text fallback
      });
      lines.push(`${q.question} → ${picks.join(" / ")}`);
    });
    return lines.join("\n");
  }

  function answerAsk(answer: string): void {
    if (!pendingAsk) return;
    const id = pendingAsk.id;
    pendingAsk = null;
    // Tell daemon to dismiss any open picker for this question
    const liveWs = getWs();
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "ask_question_done", session_uuid: resumeUuid, question_id: id })); }
      catch { /* ignore */ }
    }
    process.stdout.write(`${cyan("→ 回應：")}${answer}\n`);
    sendUser(answer, "stdin");
  }

  interface HubImage { media_type: string; data: string }  // data = base64
  function sendUser(text: string, source: "stdin" | "hub", images?: HubImage[]): void {
    const hasText = !!text.trim();
    const hasImages = images && images.length > 0;
    if (!hasText && !hasImages) return;

    if (source === "hub") {
      const imgNote = hasImages ? cyan(` [${images!.length} image${images!.length > 1 ? "s" : ""}]`) : "";
      process.stdout.write(`\n${cyan("[hub] ")}${text}${imgNote}\n`);
    }

    // Build SDK content: string for text-only, array of blocks when images present.
    // Image blocks come first per Anthropic recommendation (Claude pays attention earlier).
    let content: any = text;
    if (hasImages) {
      const blocks: any[] = images!.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.media_type, data: img.data },
      }));
      if (hasText) blocks.push({ type: "text", text });
      content = blocks;
    }

    messages.push({
      type: "user",
      parent_tool_use_id: null,
      session_id: resumeUuid ?? "",
      message: { role: "user", content },
    } as SDKUserMessage);
    // New user input → Claude is about to think. Flip immediately.
    setActivity("Ideating");
    // Tell daemon a new turn started — wrapped sessions don't fire Claude
    // Code's UserPromptSubmit hook, so the cell status would otherwise stay
    // wherever the last turn left it. Daemon synthesizes a user_prompt event
    // → status flips to "active" + the dashboard's STOP button appears.
    const liveWs = getWs();
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "turn_start", session_uuid: resumeUuid })); }
      catch { /* ignore */ }
      // Push the user text optimistically so the dashboard cell's "user" line
      // updates the moment Enter is pressed — without waiting 1-2s for the SDK
      // to flush to JSONL and /sessions/previews to repoll. Text-only; images
      // aren't surfaced in the small-card preview anyway.
      if (hasText) {
        try {
          liveWs.send(JSON.stringify({
            type: "user_message",
            session_uuid: resumeUuid,
            text,
            ts: Date.now(),
          }));
        } catch { /* ignore */ }
      }
    }
  }

  // (message handler is now wired up inside connect() above so it re-binds on each reconnect)

  // Cold-start banner so the user knows we're alive and waiting for input.
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  process.stdout.write(`${bold("miki claude")} ${dim("· cwd=" + args.cwd)}\n`);
  if (resumeUuid) process.stdout.write(`${dim("resuming session: " + resumeUuid)}\n`);
  else if (args.fresh) process.stdout.write(`${dim("new session (--fresh — auto-sending 'hi' to wake SDK)")}\n`);
  else process.stdout.write(`${dim("new session (uuid will appear once SDK init fires)")}\n`);
  if (port) process.stdout.write(`${dim("daemon: ws://127.0.0.1:" + port + "/wrap")}\n`);
  else process.stdout.write(`${yellow("daemon: NOT connected (no port file — start miki-moni daemon)")}\n`);
  process.stdout.write(`${dim("─".repeat(60))}\n`);
  printPrompt();

  // Start the query — long-lived, single shot for the whole session.
  // `allowDangerouslySkipPermissions: true` is required for runtime switching
  // to `bypassPermissions` mode. Without it, SDK rejects the setPermissionMode
  // call with "Cannot set permission mode to bypassPermissions because the
  // session was not launched with --dangerously-skip-permissions". Default
  // behavior is unchanged — user still has to explicitly pick bypass from the
  // dashboard chip; we're only unlocking the option.
  const q = query({
    prompt: messages,
    options: {
      cwd: args.cwd,
      resume: resumeUuid,
      model: args.model,
      permissionMode: args.permissionMode,
      allowDangerouslySkipPermissions: true,
      // Stream Anthropic raw stream_event chunks back via the SDK so we can
      // forward text-deltas to the dashboard in real time. Without this, the
      // SDK only emits whole assistant messages on completion — the cell
      // preview only updates once Claude's done a full turn.
      includePartialMessages: true,
      // AskUserQuestion needs user interaction; let it through and we'll
      // surface the question ourselves once the tool_use appears in the
      // message stream (Happy's pattern). For everything else, allow.
      canUseTool: async (toolName: string, input: any) => {
        return { behavior: "allow", updatedInput: (input ?? {}) as Record<string, unknown> };
      },
    } as any,
  });
  currentQ = q;

  // --fresh: auto-push a tiny "hi" to wake the SDK so init fires and a
  // session_uuid surfaces immediately. Without this, a brand-new session
  // sits dormant (no UUID, dashboard can't bind) until the user types in
  // the terminal. Costs one tiny API turn.
  if (args.fresh && !resumeUuid) {
    sendUser("hi", "stdin");
  }

  // Read user input from stdin without blocking the message loop. readline
  // gives us line-by-line entry; for multi-line input the user can paste.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // If a question is pending, parse line as answer(s).
    //   Single question: "1" / "2,3" / "free text"
    //   Multiple questions: "1; 2,3; 1" (semicolon-separated per question)
    if (pendingAsk) {
      const segs = trimmed.includes(";") ? trimmed.split(";").map((s) => s.trim()) : [trimmed];
      const idxPerQ: string[][] = pendingAsk.questions.map((_, qi) => {
        const seg = segs[qi] ?? "";
        return seg.split(",").map((s) => s.trim()).filter(Boolean);
      });
      const answer = formatAnswerFromIndices(idxPerQ);
      if (answer.trim()) { answerAsk(answer); return; }
    }
    sendUser(trimmed, "stdin");
  });
  rl.on("close", () => messages.end());

  // Consume the SDK stream — render + ship to daemon
  try {
    for await (const m of q) {
      renderMessage(m);
      const liveWs = getWs();
      // Tell daemon the session uuid as soon as we see it (first init message)
      if (liveWs && liveWs.readyState === liveWs.OPEN && m.type === "system" && (m as any).subtype === "init") {
        const sid = (m as any).session_id as string | undefined;
        if (sid && sid !== resumeUuid) {
          resumeUuid = sid;
          liveWs.send(JSON.stringify({ type: "session_uuid", session_uuid: sid }));
        }
      }
      // Mirror message to daemon (optional — daemon already reads JSONL)
      if (liveWs && liveWs.readyState === liveWs.OPEN) {
        try { liveWs.send(JSON.stringify({ type: "message", message: m })); } catch { /* ignore */ }
      }
      // Streaming text deltas: when SDK emits a partial stream_event with a
      // text_delta inside a content_block_delta, forward the chunk to daemon
      // for real-time UI rendering. JSON-input deltas (tool_use argument
      // streams) we skip for now — UI doesn't have a place to surface them.
      if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid && m.type === "stream_event") {
        const ev = (m as any).event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          try {
            liveWs.send(JSON.stringify({
              type: "assistant_delta",
              session_uuid: resumeUuid,
              index: typeof ev.index === "number" ? ev.index : 0,
              text: ev.delta.text,
            }));
          } catch { /* ignore */ }
        } else if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
          // Start of a new text block — tell client to start a new buffer slot.
          try {
            liveWs.send(JSON.stringify({
              type: "assistant_delta_start",
              session_uuid: resumeUuid,
              index: typeof ev.index === "number" ? ev.index : 0,
            }));
          } catch { /* ignore */ }
        } else if (ev?.type === "message_stop") {
          // Whole assistant message complete — client should flush its
          // streaming buffer (next /sessions/previews refresh will replace it
          // with the canonical text from JSONL).
          try {
            liveWs.send(JSON.stringify({
              type: "assistant_delta_end",
              session_uuid: resumeUuid,
            }));
          } catch { /* ignore */ }
        }
      }
      // Activity tracking — derive a coarse state per message for the
      // dashboard cell header to show live progress.
      if (m.type === "assistant") {
        const content = (m as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_use" && typeof block.name === "string") {
              setActivity(`Using ${block.name}`);
              // AskUserQuestion: surface to dashboard + terminal so user can pick.
              if (block.name === "AskUserQuestion" && block.input && typeof block.input === "object") {
                const qs = (block.input as any).questions;
                if (Array.isArray(qs) && qs.length > 0) {
                  emitAskQuestion(block.id || `q-${Date.now()}`, qs as QQuestion[]);
                }
              }
            } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
              setActivity("Replying");
            }
          }
        }
      } else if (m.type === "user") {
        const content = (m as any).message?.content;
        if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
          // Tool just returned — model will ideate again before next move.
          setActivity("Ideating");
        }
      } else if (m.type === "result") {
        setActivity(null);
        // Tell daemon the turn ended. Without this signal the dashboard cell
        // stays in "進行中" forever (no Stop hook fires for SDK-driven wrap
        // sessions) — and worse, the cell's STOP button overlays SEND, so
        // clicking what looks like "send" actually invokes interrupt.
        const liveResultWs = getWs();
        if (liveResultWs && liveResultWs.readyState === liveResultWs.OPEN && resumeUuid) {
          try { liveResultWs.send(JSON.stringify({ type: "turn_end", session_uuid: resumeUuid })); }
          catch { /* ignore */ }
        }
        printPrompt();
      }
    }
  } finally {
    rl.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const liveWs = getWs();
    if (liveWs) try { liveWs.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error("\nwrap failed:", err);
  process.exit(1);
});
