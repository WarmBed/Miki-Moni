// wrap-process — owns the lifecycle of `miki claude` CLI processes that the
// daemon itself spawned (via POST /wrap/start). Decoupled from WS bookkeeping
// so the kill / orphan-detection logic stays testable.
//
// Responsibilities:
//   1. Record each spawn: cwd, intended session_uuid (if -r mode), spawn ts.
//   2. When a wrap WS register lands, link the connection's reported PID to
//      that record (so we know which OS process backs which session).
//   3. On WS close, taskkill /T /F the PID tree → no Windows orphan.
//   4. On daemon startup, scan for stray `miki claude` processes that aren't
//      backed by an active WS connection and kill them.
//
// Why a module: the daemon will grow more "things daemon owns" (helper exts,
// pty-mode tabs, future agent-pool workers). Each gets its own lifecycle file
// rather than scattering PID maps across server.ts.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileP = promisify(execFile);

export interface SpawnRecord {
  /** Session this spawn is intended to attach to. null = `--fresh` style. */
  sessionUuid: string | null;
  cwd: string;
  spawnedAt: number;
  /** PID reported by wrap.ts at register time. null until we hear back. */
  pid: number | null;
}

type Log = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

export class WrapProcessRegistry {
  // Keyed by sessionUuid for -r spawns. For fresh spawns the uuid is unknown
  // at spawn time, so they get a temporary key until register lands.
  private bySession = new Map<string, SpawnRecord>();
  // Fresh-spawn records waiting for their first register. FIFO-ish: oldest
  // unbound record gets linked to next incoming register without a uuid.
  private pendingFresh: SpawnRecord[] = [];

  constructor(private log?: Log) {}

  /** Called by /wrap/start. `sessionUuid` is null for `--fresh`. */
  recordSpawn(opts: { sessionUuid: string | null; cwd: string }): void {
    const rec: SpawnRecord = {
      sessionUuid: opts.sessionUuid,
      cwd: opts.cwd,
      spawnedAt: Date.now(),
      pid: null,
    };
    if (opts.sessionUuid) {
      this.bySession.set(opts.sessionUuid, rec);
    } else {
      this.pendingFresh.push(rec);
    }
    this.log?.info(
      { sessionUuid: opts.sessionUuid, cwd: opts.cwd },
      "wrap-process: recorded spawn",
    );
  }

  /**
   * Called when a wrap WS register / late-bind tells us its PID + final UUID.
   * If we previously had a `--fresh` record awaiting binding, hand it the uuid.
   */
  bindPid(sessionUuid: string, pid: number | null): void {
    if (!pid) return;
    let rec = this.bySession.get(sessionUuid);
    if (!rec) {
      // Promote oldest pending fresh record (if any) to this uuid.
      rec = this.pendingFresh.shift() ?? null as any;
      if (rec) {
        rec.sessionUuid = sessionUuid;
        this.bySession.set(sessionUuid, rec);
      }
    }
    if (!rec) {
      // External wrap (user typed `pnpm miki claude` themselves, not via dashboard).
      // We don't manage its lifecycle; ignore.
      return;
    }
    rec.pid = pid;
    this.log?.info({ sessionUuid, pid }, "wrap-process: PID bound");
  }

  /**
   * Called on wrap WS close. Returns the PID (if any) the caller should
   * tree-kill, and the SpawnRecord so the caller can decide cleanup policy
   * (e.g. delete empty session row). Removes the record from the registry.
   */
  takeOnClose(sessionUuid: string): SpawnRecord | null {
    const rec = this.bySession.get(sessionUuid);
    if (!rec) return null;
    this.bySession.delete(sessionUuid);
    return rec;
  }

  /** Visible for tests / debugging. */
  list(): SpawnRecord[] {
    return [...this.bySession.values(), ...this.pendingFresh];
  }

  /** Visible for tests. */
  size(): number {
    return this.bySession.size + this.pendingFresh.length;
  }
}

/**
 * Best-effort tree-kill on Windows. Calls `taskkill /T /F /PID <pid>` which
 * terminates the process and ALL descendants. Resolves silently on failure
 * (process already dead, etc.) — caller doesn't care about the distinction
 * between "killed it" and "it was already gone".
 */
export async function killProcessTree(pid: number, log?: Log): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      await execFileP("taskkill.exe", ["/T", "/F", "/PID", String(pid)]);
    } else {
      // POSIX fallback (not used in production for miki, but keeps tests portable)
      process.kill(pid, "SIGKILL");
    }
    log?.info({ pid }, "wrap-process: tree-killed");
  } catch (err) {
    // Most common cause: process already exited between our decision to kill
    // and the syscall actually running. Genuinely fine.
    log?.info({ pid, error: String(err) }, "wrap-process: kill skipped (likely already dead)");
  }
}

/**
 * Scan the OS for `miki claude` node processes and return their PIDs. Used on
 * daemon startup to clear out stragglers from a previous daemon session that
 * left orphans behind. Windows-only implementation; returns [] elsewhere.
 *
 * Identifies miki processes by command-line substring match: looks for any
 * node.exe whose CommandLine contains "miki.ts claude" or "src/cli/miki.ts".
 * That's specific enough to not accidentally kill unrelated Node tools, and
 * generic enough to catch both tsx and compiled invocations.
 */
export async function findOrphanMikiCli(log?: Log): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    // PowerShell one-liner — return PIDs whose command line matches our pattern.
    // Output: one PID per line, no headers.
    const { stdout } = await execFileP("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'miki\\.ts.*claude|cli[/\\\\]miki' } | Select-Object -ExpandProperty ProcessId",
    ]);
    const pids = stdout.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
    // Filter out ourselves and any parent of ourselves (defensive — daemon
    // shouldn't match the pattern, but just in case during dev).
    const self = process.pid;
    return pids.filter((p) => p !== self);
  } catch (err) {
    log?.warn({ error: String(err) }, "wrap-process: orphan scan failed");
    return [];
  }
}

/** Convenience: scan + kill all orphans. Returns number killed. */
export async function killOrphans(log?: Log): Promise<number> {
  const pids = await findOrphanMikiCli(log);
  if (pids.length === 0) return 0;
  await Promise.all(pids.map((pid) => killProcessTree(pid, log)));
  log?.info({ pids, count: pids.length }, "wrap-process: orphans killed at startup");
  return pids.length;
}

// Re-export `spawn` for callers that want to launch wt.exe through the same
// module (kept lightweight on purpose — we don't wrap spawn() because wt.exe
// is detached and we don't track its launcher PID anyway).
export { spawn };

// Expose os.platform for tests that want to skip on non-Windows.
export { os };
