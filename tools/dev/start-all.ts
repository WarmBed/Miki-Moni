/**
 * tools/dev/start-all.ts — dev launcher
 *
 * Starts the miki-moni daemon and mock-worker concurrently with prefixed output.
 * Ctrl+C (SIGINT) kills both cleanly.
 *
 * Usage:
 *   pnpm dev:all
 *   (or: pnpm exec tsx tools/dev/start-all.ts)
 *
 * NOTE: This launcher does NOT build the web UIs.
 *   Run `pnpm build:all` first if you want to browse the phone web client.
 *
 * Children are spawned via `pnpm exec tsx` so TypeScript sources are run
 * directly without a separate compile step.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ── ANSI colors (no chalk dep) ─────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function color(c: string, s: string): string {
  // Disable colors when stdout is not a TTY (e.g. piped to a file)
  if (!process.stdout.isTTY) return s;
  return `${c}${s}${RESET}`;
}

// ── Process spawning ───────────────────────────────────────────────────────

interface Proc {
  name: string;
  prefix: string;
  prefixColor: string;
  child: ChildProcess;
}

function spawnProc(
  name: string,
  args: string[],
  prefixColor: string,
  env?: NodeJS.ProcessEnv,
): Proc {
  const child = spawn("pnpm", ["exec", "tsx", ...args], {
    stdio: "pipe",
    env: { ...process.env, ...env },
    // shell needed on Windows for pnpm to resolve correctly
    shell: process.platform === "win32",
  });

  const prefix = `[${name}]`;

  function pipeLine(stream: NodeJS.ReadableStream | null, isErr = false): void {
    if (!stream) return;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const tag = color(prefixColor + BOLD, prefix.padEnd(10));
      const text = isErr ? color(DIM, line) : line;
      process.stdout.write(`${tag} ${text}\n`);
    });
  }

  pipeLine(child.stdout);
  pipeLine(child.stderr, true);

  child.on("exit", (code, signal) => {
    const reason = signal ?? `code ${code}`;
    process.stdout.write(
      `${color(prefixColor + BOLD, prefix)} ${color(DIM, `exited (${reason})`)}\n`,
    );
  });

  return { name, prefix, prefixColor, child };
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function killProc(proc: ChildProcess, name: string): void {
  if (proc.exitCode !== null || proc.killed) return;
  process.stdout.write(color(DIM, `  sending SIGTERM to ${name}...\n`));
  proc.kill("SIGTERM");
}

function killAll(procs: Proc[]): void {
  for (const p of procs) killProc(p.child, p.name);
}

async function waitOrForce(procs: Proc[], timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const allDone = procs.every(
      (p) => p.child.exitCode !== null || p.child.killed,
    );
    if (allDone) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const p of procs) {
    if (p.child.exitCode === null && !p.child.killed) {
      process.stdout.write(color(RED, `  forcing SIGKILL on ${p.name}\n`));
      p.child.kill("SIGKILL");
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(color(BOLD, "\nmiki-moni dev launcher"));
  console.log(color(DIM, "Ctrl+C to stop both processes\n"));

  const procs: Proc[] = [
    spawnProc("daemon", ["src/index.ts"], CYAN),
    spawnProc("worker", ["tools/mock-worker/server.ts"], YELLOW, {
      MOCK_WORKER_PORT: "8787",
      MOCK_WORKER_TOKEN: "local-dev-token",
    }),
  ];

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(color(BOLD, "\n\nShutting down...\n"));
    killAll(procs);
    await waitOrForce(procs, 5000);
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  // If a child exits on its own (crash), log it — don't auto-restart
  for (const p of procs) {
    p.child.on("exit", (code) => {
      if (shuttingDown) return;
      if (code !== 0) {
        process.stdout.write(
          color(RED, `${p.prefix} crashed with code ${code}. Stopping all.\n`),
        );
        void shutdown();
      }
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
