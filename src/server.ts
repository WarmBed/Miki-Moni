import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { SessionStore } from "./session-store.js";
import type { HookHandler } from "./hook-handler.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Notifier } from "./notifier.js";
import type { AgentId, HookEvent, Session } from "./types.js";
import { normalizeCwd, pendingCodexSessionUuid } from "./hook-handler.js";
import {
  SessionResolver,
  readTranscriptTail,
  readSessionPreview,
  readTranscriptPreview,
  readTranscriptTailForSource,
  sessionHasAnyTurns,
  readOriginalCwd,
  type SessionPreview,
} from "./session-resolver.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ExtRegistry } from "./ext-registry.js";
import type { ExtMessage } from "./protocol-ext.js";
import { randomUUID } from "node:crypto";
import { WrapProcessRegistry, killProcessTree, killOrphans } from "./wrap-process.js";
import type { VersionChecker } from "./version-check.js";

// Miki repo root — derived from this file's location (src/server.ts → repo root).
// `bin/miki.js` is the canonical CLI entry: it self-resolves tsx and avoids
// Node 24's `.cmd`/`.bat` spawn ban (see bin/miki.js comment). /wrap/start
// spawns it as `node <abs path> claude [args...]` — works whether or not the
// user has run `npm link`, and doesn't depend on pnpm/npm being on the new
// wt window's PATH.
const MIKI_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIKI_BIN_JS = path.join(MIKI_REPO_ROOT, "bin", "miki.js");

type Log = { info: (obj: Record<string, unknown>, msg?: string) => void; warn: (obj: Record<string, unknown>, msg?: string) => void; error: (obj: Record<string, unknown>, msg?: string) => void };
type TerminalChild = { on: (event: "error", cb: (err: Error) => void) => unknown; unref: () => void };
type TerminalSpawner = (args: string[]) => TerminalChild;
type CodexImage = { media_type: string; data: string };
type CodexRunResult = { reply: string; durationMs: number };
type CodexRunner = (opts: { sessionUuid: string; cwd: string; prompt: string; images?: CodexImage[]; signal?: AbortSignal; timeoutMs?: number }) => Promise<CodexRunResult>;

export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
  log?: Log;
  heartbeat?: { pingMs: number; pongTimeoutMs: number };  // default: { 30_000, 10_000 }
  versionChecker?: VersionChecker;
  transcriptRoots?: { claudeProjectsRoot?: string; codexSessionsRoot?: string };
  terminalSpawner?: TerminalSpawner;
  codexRunner?: CodexRunner;
  perfTracker?: import("./perf-tracker.js").PerfTracker;
  perfStore?: import("./perf-store.js").PerfStore;
}

function codexImageExt(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    default: return ".img";
  }
}

async function writeCodexImageFiles(images: CodexImage[] | undefined): Promise<{ dir: string; files: string[] } | null> {
  if (!images?.length) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miki-codex-images-"));
  const files: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const file = path.join(dir, `image-${i + 1}${codexImageExt(img.media_type)}`);
    await fs.writeFile(file, Buffer.from(img.data, "base64"));
    files.push(file);
  }
  return { dir, files };
}

async function runCodexExec(opts: { sessionUuid: string; cwd: string; prompt: string; images?: CodexImage[]; signal?: AbortSignal; timeoutMs?: number }): Promise<CodexRunResult> {
  const start = Date.now();
  const isPending = opts.sessionUuid.startsWith("codex-pending:");
  const imageFiles = await writeCodexImageFiles(opts.images);
  const imageArgs = imageFiles?.files.flatMap((file) => ["--image", file]) ?? [];
  const codexArgs = isPending
    ? ["exec", "-C", opts.cwd, ...imageArgs, "-"]
    : ["exec", "resume", ...imageArgs, opts.sessionUuid, "-"];
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "codex", ...codexArgs], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (child.pid) void killProcessTree(child.pid);
      finish(() => reject(new Error(`codex exec timed out after ${opts.timeoutMs ?? 600000}ms`)));
    }, opts.timeoutMs ?? 600_000);
    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (imageFiles) void fs.rm(imageFiles.dir, { recursive: true, force: true });
      cb();
    };
    const onAbort = () => {
      if (child.pid) void killProcessTree(child.pid);
      finish(() => reject(new Error("codex exec interrupted")));
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        finish(() => resolve({ reply: stdout.trim() || stderr.trim(), durationMs: Date.now() - start }));
      } else {
        finish(() => reject(new Error(`codex exec exited ${code}: ${(stderr || stdout).trim()}`)));
      }
    });
    child.stdin.end(opts.prompt);
  });
}

function parseHookEvent(body: unknown): HookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.event_type !== "string") return null;
  if (typeof b.cwd !== "string") return null;
  if (typeof b.timestamp !== "number") return null;
  const validTypes = ["session_start", "stop", "user_prompt", "pre_tool_use", "post_tool_use"];
  if (!validTypes.includes(b.event_type)) return null;
  const agent: AgentId = b.agent === "codex" ? "codex" : "claude";
  return {
    event_type: b.event_type as HookEvent["event_type"],
    agent,
    cwd: b.cwd,
    session_uuid: typeof b.session_uuid === "string" ? b.session_uuid : null,
    timestamp: b.timestamp,
    extra: (b.extra as Record<string, unknown>) ?? undefined,
  };
}

export function createApp(deps: ServerDeps): { app: Express; server: http.Server; registry: ExtRegistry } {
  const app = express();
  const spawnTerminal: TerminalSpawner = deps.terminalSpawner ?? ((args) => spawn("wt.exe", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }));
  const codexRunner = deps.codexRunner ?? runCodexExec;
  const activeCodexExecs = new Map<string, AbortController>();
  // 20mb to accommodate pasted images (base64) on /send. Hook payloads are tiny.
  app.use(express.json({ limit: "20mb" }));

  // ── DNS-rebinding guard ──────────────────────────────────────────────
  // The daemon binds 127.0.0.1 only, but DNS rebinding lets a malicious page
  // on `evil.com` make that hostname resolve to 127.0.0.1 in the user's
  // browser, then `fetch("http://evil.com:8765/send", ...)` from a page the
  // user is visiting. Same-origin doesn't help — the page IS evil.com, so
  // it's allowed to talk to itself. Result: arbitrary prompt injection into
  // the user's Claude panel, or worse — `/admin/quit`, `/admin/rotate-pair`.
  //
  // We reject any request whose Host header isn't a localhost/loopback form,
  // and (if present) whose Origin/Referer isn't a localhost form. Loopback
  // hostnames an attacker can't poison: literal IPs and `localhost`. Any
  // attacker-controlled domain name pointing at 127.0.0.1 is rejected.
  //
  // Bypass via env for testing or unusual setups (e.g. accessing the dashboard
  // through a deliberately-configured reverse proxy): MIKI_TRUSTED_HOSTS="a,b".
  const trustedHosts = new Set<string>([
    "127.0.0.1",
    "localhost",
    "[::1]",
    "::1",
    ...(process.env.MIKI_TRUSTED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  ]);
  function hostnameOf(hostHeader: string | undefined): string | null {
    if (!hostHeader) return null;
    // Strip port. IPv6 is bracketed `[::1]:8765` — keep the brackets in the key.
    const m = hostHeader.match(/^(\[[^\]]+\]|[^:]+)/);
    return m ? m[1]!.toLowerCase() : null;
  }
  function isTrustedUrl(raw: string | undefined): boolean {
    if (!raw) return true;  // absent is fine (most fetches don't set Origin)
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      // URL.hostname strips brackets from [::1] — accept both forms.
      return trustedHosts.has(host) || trustedHosts.has(`[${host}]`);
    } catch {
      return false;
    }
  }
  app.use((req, res, next) => {
    const host = hostnameOf(req.headers.host);
    if (!host || !trustedHosts.has(host)) {
      deps.log?.warn({ route: req.path, host: req.headers.host, origin: req.headers.origin }, "rejected non-loopback Host");
      res.status(403).json({ error: "host_not_allowed", host: req.headers.host });
      return;
    }
    if (!isTrustedUrl(req.headers.origin as string | undefined)) {
      deps.log?.warn({ route: req.path, origin: req.headers.origin }, "rejected cross-origin");
      res.status(403).json({ error: "origin_not_allowed", origin: req.headers.origin });
      return;
    }
    if (!isTrustedUrl(req.headers.referer as string | undefined)) {
      deps.log?.warn({ route: req.path, referer: req.headers.referer }, "rejected cross-referer");
      res.status(403).json({ error: "referer_not_allowed", referer: req.headers.referer });
      return;
    }
    next();
  });

  // Lifecycle registry for `miki claude` CLIs the daemon launched via
  // /wrap/start. Owns: spawn record, reported PID, tree-kill on disconnect.
  // External sessions (VSCode panels, user-started `miki claude`) are NOT in
  // here — they manage their own lifetime.
  const wrapProc = new WrapProcessRegistry(deps.log);

  app.post("/event", async (req: Request, res: Response) => {
    const ev = parseHookEvent(req.body);
    if (!ev) { deps.log?.warn({ route: "/event", body: req.body }, "invalid hook event"); res.status(400).json({ error: "invalid hook event" }); return; }
    deps.log?.info({ route: "/event", event_type: ev.event_type, cwd: ev.cwd, session_uuid: ev.session_uuid }, "hook event in");
    await deps.handler.handle(ev);
    res.status(204).end();
  });

  // ── Admin endpoints (used by the system-tray helper) ──────────────────
  // Quit: graceful exit. The tray script falls back to Stop-Process if we
  // don't actually exit within ~1s, so this is best-effort.
  app.post("/admin/quit", (_req, res) => {
    res.json({ ok: true });
    deps.log?.info({ route: "/admin/quit" }, "admin/quit received — exiting");
    setTimeout(() => process.exit(0), 100);
  });
  // Spawn a detached replacement daemon and schedule our exit. Shared by
  // /admin/restart and /admin/rotate-pair (rotate must restart so RelayClient
  // re-registers the new token with the relay coordinator).
  async function scheduleRespawn(): Promise<void> {
    try {
      const { spawn } = await import("node:child_process");
      // Windows quirk: a `detached + stdio:"ignore" + windowsHide:true` respawn
      // inherits no console, and the new daemon dies silently. Going through
      // `cmd /c start "" /MIN program args` forces CREATE_NEW_CONSOLE so the
      // respawned daemon owns its own (minimized) console window. The empty
      // "" is the mandatory window title slot — without it `start` treats
      // the first quoted arg as the program name and fails with
      // "Windows can't find 'X'".
      const isWin = process.platform === "win32";
      // MIKI_NO_TRAY_SPAWN: tell the respawned daemon to skip spawning its
      // own tray helper — the current tray follows our pid via /admin/pid
      // polling and stays alive across the respawn. Without this, restart/
      // rotate ends up with two cat icons (old tray that survived + new
      // tray spawned by replacement daemon).
      const childEnv = { ...process.env, MIKI_FORCE_RESTART: "1", MIKI_NO_TRAY_SPAWN: "1" };
      // Respawn via `node bin/miki.js start` — we CANNOT just re-exec
      // process.argv because tsx loads itself via `--import tsx/esm` (a
      // node CLI flag that doesn't survive in argv), so the new node
      // would try to parse src/cli/miki.ts as plain JS and instantly
      // crash on the first `import` statement. bin/miki.js is the
      // canonical CLI entry — it knows how to find tsx and spawn it.
      const nodeExe = process.argv[0]!;
      const nodeArgs = [MIKI_BIN_JS, "start"];
      const spawnArgs = isWin
        ? ["/c", "start", "", "/MIN", nodeExe, ...nodeArgs]
        : nodeArgs;
      const spawnCmd = isWin ? "cmd.exe" : nodeExe;
      const child = spawn(spawnCmd, spawnArgs, {
        detached: true,
        stdio: "ignore",
        env: childEnv,
        windowsHide: false,
      });
      child.on("error", (err) => deps.log?.error({ err: String(err) }, "respawn child error"));
      deps.log?.info({ binEntry: MIKI_BIN_JS, launcherPid: child.pid }, "respawn launched");
      child.unref();
    } catch (err) {
      deps.log?.error({ err: String(err) }, "respawn failed; just exiting");
    }
    // 400ms buys time for the child to start its own bind attempt with the
    // FORCE_RESTART path that takes over PORT_FILE without dueling.
    setTimeout(() => process.exit(0), 400);
  }

  // Used by tray.ps1's watcher to detect daemon respawn (after rotate/restart).
  // Without this, the tray watches the OLD pid, sees it die, and exits — leaving
  // the user with no tray icon even though a new daemon is now alive.
  app.get("/admin/pid", (_req, res) => {
    res.json({ pid: process.pid });
  });

  // Read-only — surfaces the cached npm-latest version of miki-moni so
  // the CLI banner and dashboard settings popover can show an update
  // hint. Daemon's VersionChecker owns the 24h cache + fetch; consumers
  // never talk to npm directly. Always 200; failure modes encoded in
  // `error`. No auth (matches /admin/pid).
  app.get("/admin/version-check", async (_req, res) => {
    if (!deps.versionChecker) {
      res.json({ current: null, latest: null, hasUpdate: false, fetchedAt: 0, error: "npm_unreachable" });
      return;
    }
    const info = await deps.versionChecker.get();
    res.json(info);
  });

  app.post("/admin/restart", async (_req, res) => {
    res.json({ ok: true });
    deps.log?.info({ route: "/admin/restart" }, "admin/restart received — respawning");
    void scheduleRespawn();
  });

  // Rotate the persistent pair token. New QR/URL/code; old phones still work
  // (signing key, not token, is what re-auths them — but the *next* phone you
  // try to pair with the old QR will be rejected). Restarts the daemon so
  // RelayClient registers the new token with the relay coordinator on next
  // connect. Tray menu's "Rotate pairing token" hits this.
  app.post("/admin/rotate-pair", async (_req, res) => {
    try {
      const { loadOrInitConfig, saveConfig } = await import("./config.js");
      const { generateNewPairingToken } = await import("./pairing.js");
      const { CONFIG_FILE } = await import("./data-dir.js");
      const cfg = await loadOrInitConfig(CONFIG_FILE);
      if (!cfg.remote?.worker_url) {
        res.status(400).json({ error: "no remote configured — run `miki setup` first" });
        return;
      }
      const token = generateNewPairingToken();
      const next = {
        ...cfg,
        remote: { ...cfg.remote, pair_token: token },
      };
      await saveConfig(CONFIG_FILE, next);
      deps.log?.info({ route: "/admin/rotate-pair" }, "rotated pair token — respawning to re-register with relay");
      res.json({
        token,
        worker_url: cfg.remote.worker_url,
        phone_pwa_url: cfg.remote.phone_pwa_url ?? null,
      });
      // Respawn so RelayClient picks up the new token on reconnect.
      void scheduleRespawn();
    } catch (err) {
      deps.log?.error({ err: String(err) }, "/admin/rotate-pair failed");
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  });

  app.get("/sessions", (_req, res) => {
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const wrapAct: Map<string, string> | undefined = (deps as any).__wrapActivity;
    const wrapMode: Map<string, string> | undefined = (deps as any).__wrapPermissionMode;
    const wrapModelMap: Map<string, string> | undefined = (deps as any).__wrapModel;
    const wrapEffortMap: Map<string, string> | undefined = (deps as any).__wrapEffort;
    const wrapAskMap: Map<string, { question_id: string; questions: unknown[] }> | undefined = (deps as any).__wrapAsks;
    const list = deps.store.list().map((s) => ({
      ...s,
      wrapped: wrapConns?.has(s.session_uuid ?? "") ?? false,
      activity: s.session_uuid ? wrapAct?.get(s.session_uuid) ?? null : null,
      permission_mode: s.session_uuid ? wrapMode?.get(s.session_uuid) ?? null : null,
      current_model: s.session_uuid ? wrapModelMap?.get(s.session_uuid) ?? null : null,
      current_effort: s.session_uuid ? wrapEffortMap?.get(s.session_uuid) ?? null : null,
      pending_ask: s.session_uuid ? wrapAskMap?.get(s.session_uuid) ?? null : null,
    }));
    res.json(list);
  });

  app.get("/metrics", (req: Request, res: Response) => {
    const perfStore = deps.perfStore;
    if (!perfStore) { res.status(501).json({ error: "metrics_unavailable" }); return; }

    const WINDOWS: Record<string, number> = { "1h": 1, "6h": 6, "24h": 24, "48h": 48 };
    const windowKey = typeof req.query.window === "string" ? req.query.window : "24h";
    const hours = WINDOWS[windowKey] ?? 24;
    const windowMs = hours * 60 * 60 * 1000;
    const now = Date.now();
    const fromTs = now - windowMs;

    const agentFilter = req.query.agent === "claude" || req.query.agent === "codex" ? req.query.agent : null;
    const allMetrics = perfStore.query(fromTs, now).map((row) => {
      const session = deps.store.get(row.session_uuid);
      return {
        ...row,
        agent: session?.agent ?? null,
        project_name: session?.project_name ?? null,
        cwd: session?.cwd ?? null,
      };
    });
    const metrics = agentFilter ? allMetrics.filter((row) => row.agent === agentFilter) : allMetrics;
    const avg = (values: number[]): number | null => values.length > 0 ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
    const fleet = {
      avg_ttft: avg(metrics.map((row) => row.ttft_ms).filter((n): n is number => n !== null)),
      avg_tps: avg(metrics.map((row) => row.tps).filter((n): n is number => n !== null)),
    };

    res.json({
      metrics,
      fleet_avg_ttft: fleet.avg_ttft,
      fleet_avg_tps: fleet.avg_tps,
      agent: agentFilter,
      window_ms: windowMs,
    });
  });

  // Dashboard answer to an AskUserQuestion. Routes back to the wrapper's WS,
  // which then turns it into a regular user message into the query stream.
  app.post("/wrap/answer", (req: Request, res: Response) => {
    const sessionUuid = typeof req.body?.session_uuid === "string" ? req.body.session_uuid : null;
    const questionId = typeof req.body?.question_id === "string" ? req.body.question_id : null;
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!sessionUuid || !questionId || !answers) {
      res.status(400).json({ error: "missing session_uuid / question_id / answers" });
      return;
    }
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const ws = wrapConns?.get(sessionUuid);
    if (!ws || ws.readyState !== ws.OPEN) {
      res.status(404).json({ error: "wrap not connected" });
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "ask_question_answer", question_id: questionId, answers }));
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Interrupt the currently running SDK query() in the wrapper — calls
  // Query.interrupt() inside wrap.ts. Used by the ⏹ button next to send.
  app.post("/wrap/interrupt", (req: Request, res: Response) => {
    const sessionUuid = typeof req.body?.session_uuid === "string" ? req.body.session_uuid : null;
    if (!sessionUuid) { res.status(400).json({ error: "missing session_uuid" }); return; }
    const session = deps.store.get(sessionUuid);
    if (session?.agent === "codex") {
      const active = activeCodexExecs.get(sessionUuid);
      if (!active) {
        res.status(404).json({ error: "codex_exec_not_running" });
        return;
      }
      active.abort();
      deps.log?.info({ route: "/wrap/interrupt", session_uuid: sessionUuid, agent: "codex" }, "codex exec interrupt requested");
      res.status(200).json({ ok: true, mode: "codex-exec" });
      return;
    }
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const ws = wrapConns?.get(sessionUuid);
    if (!ws || ws.readyState !== ws.OPEN) {
      res.status(404).json({ error: "wrap not connected" });
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "interrupt" }));
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // /sessions/previews MUST come before /sessions/:session_uuid (Express order)
  app.get("/sessions/previews", async (_req, res) => {
    const sessions = deps.store.list();
    const projectsRoot = deps.transcriptRoots?.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
    const codexSessionsRoot = deps.transcriptRoots?.codexSessionsRoot ?? path.join(os.homedir(), ".codex", "sessions");
    const transcriptResolver = new SessionResolver(projectsRoot, codexSessionsRoot);

    const previews: SessionPreview[] = [];
    await Promise.all(sessions.map(async (s) => {
      if (!s.session_uuid) return;
      const resolved = await transcriptResolver.findTranscript(s.session_uuid);
      if (!resolved) return;
      try {
        const p = await readTranscriptPreview(resolved.source, s.session_uuid, resolved.path);
        previews.push(p);
      } catch (err) {
        deps.log?.warn({ route: "/sessions/previews", uuid: s.session_uuid, error: String(err) }, "preview failed");
      }
    }));
    deps.log?.info({ route: "/sessions/previews", count: previews.length }, "previews served");
    res.json(previews);
  });

  app.get("/sessions/:session_uuid", (req, res) => {
    const session = deps.store.get(decodeURIComponent(req.params.session_uuid!));
    if (!session) { res.status(404).end(); return; }
    res.json(session);
  });

  // Lightweight poll endpoint: returns just file stat (no read of JSONL).
  // Client polls this every ~2s; if last_modified/file_size differ from cached,
  // re-fetch the full transcript. Cheap = fs.stat only.
  app.get("/sessions/:session_uuid/transcript-meta", async (req, res) => {
    const sessionUuid = decodeURIComponent(req.params.session_uuid!);
    const projectsRoot = deps.transcriptRoots?.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
    const codexSessionsRoot = deps.transcriptRoots?.codexSessionsRoot ?? path.join(os.homedir(), ".codex", "sessions");
    const transcriptResolver = new SessionResolver(projectsRoot, codexSessionsRoot);
    try {
      const resolved = await transcriptResolver.findTranscript(sessionUuid);
      if (resolved) {
        const stat = await fs.stat(resolved.path);
        res.json({ session_uuid: sessionUuid, file_size: stat.size, last_modified: stat.mtime.toISOString() });
        return;
      }
      // Same pending-session courtesy as the full /transcript endpoint:
      // freshly-spawned wrap CLI may not have a .jsonl yet.
      if (deps.store.get(sessionUuid)) {
        res.json({ session_uuid: sessionUuid, file_size: 0, last_modified: null, pending: true });
        return;
      }
      res.status(404).json({ error: "transcript not found", session_uuid: sessionUuid });
    } catch {
      res.status(404).json({ error: "projects dir not found" });
    }
  });

  app.get("/sessions/:session_uuid/transcript", async (req, res) => {
    const sessionUuid = decodeURIComponent(req.params.session_uuid!);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 10000);
    const projectsRoot = deps.transcriptRoots?.claudeProjectsRoot ?? path.join(os.homedir(), ".claude", "projects");
    const codexSessionsRoot = deps.transcriptRoots?.codexSessionsRoot ?? path.join(os.homedir(), ".codex", "sessions");
    const transcriptResolver = new SessionResolver(projectsRoot, codexSessionsRoot);
    const resolved = await transcriptResolver.findTranscript(sessionUuid);
    if (!resolved) {
      // Session may have been just spawned — wrap CLI registered with daemon
      // but Claude SDK hasn't written the .jsonl yet. If it's a known session
      // in our store, return an empty pending transcript instead of 404 so
      // the dashboard can show "waiting for first message" cleanly.
      if (deps.store.get(sessionUuid)) {
        res.json({
          session_uuid: sessionUuid,
          transcript_path: null,
          file_size: 0,
          last_modified: null,
          turn_count: 0,
          turns: [],
          pending: true,
        });
        return;
      }
      deps.log?.warn({ route: "/sessions/:id/transcript", sessionUuid }, "transcript not found");
      res.status(404).json({ error: "transcript not found", session_uuid: sessionUuid });
      return;
    }
    try {
      const turns = await readTranscriptTailForSource(resolved.source, resolved.path, limit);
      const stat = await fs.stat(resolved.path);
      deps.log?.info({ route: "/sessions/:id/transcript", sessionUuid, returned: turns.length, fileSize: stat.size }, "transcript served");
      res.json({
        session_uuid: sessionUuid,
        transcript_path: resolved.path,
        file_size: stat.size,
        last_modified: stat.mtime.toISOString(),
        turn_count: turns.length,
        turns,
      });
    } catch (err) {
      deps.log?.error({ route: "/sessions/:id/transcript", sessionUuid, error: String(err) }, "transcript read failed");
      res.status(500).json({ error: String(err) });
    }
  });

  function buildFocusUrl(sessionUuid: string | null): string {
    const base = "vscode://anthropic.claude-code/open";
    return sessionUuid ? `${base}?session=${encodeURIComponent(sessionUuid)}` : base;
  }

  function buildSendUrl(sessionUuid: string | null, prompt: string): string {
    const parts: string[] = [];
    if (sessionUuid) parts.push(`session=${encodeURIComponent(sessionUuid)}`);
    parts.push(`prompt=${encodeURIComponent(prompt)}`);
    return `vscode://anthropic.claude-code/open?${parts.join("&")}`;
  }

  // /focus and /send accept session_uuid (primary). For backwards compatibility,
  // a cwd-only request still works: we pick the most recently active session in that cwd.
  function resolveSession(body: any): { session: Session | null; key: string; via: "session_uuid" | "cwd" | null } {
    if (typeof body?.session_uuid === "string" && body.session_uuid) {
      const s = deps.store.get(body.session_uuid);
      return { session: s ?? null, key: body.session_uuid, via: "session_uuid" };
    }
    if (typeof body?.cwd === "string" && body.cwd) {
      const cwd = normalizeCwd(body.cwd);
      const list = deps.store.getByCwd(cwd);
      return { session: list[0] ?? null, key: cwd, via: "cwd" };
    }
    return { session: null, key: "", via: null };
  }

  app.post("/focus", async (req: Request, res: Response) => {
    const { session, key, via } = resolveSession(req.body);
    if (!via) { deps.log?.warn({ route: "/focus" }, "missing session_uuid or cwd"); res.status(400).json({ error: "missing session_uuid or cwd" }); return; }
    if (!session) { deps.log?.warn({ route: "/focus", via, key }, "session not found"); res.status(404).json({ error: "session not found", lookup: { via, key } }); return; }
    if (session.agent === "codex") {
      res.status(501).json({ error: "codex_focus_unsupported", message: "Codex VSCode focus is not supported yet", session_uuid: session.session_uuid });
      return;
    }
    const url = buildFocusUrl(session.session_uuid);
    try {
      await deps.bridge.focus(session.session_uuid);
      deps.log?.info({ route: "/focus", via, key, cwd: session.cwd, session_uuid: session.session_uuid, project: session.project_name, url }, "URI launched");
      res.status(200).json({ ok: true, url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name });
    } catch (err) {
      deps.log?.error({ route: "/focus", via, key, url, error: String(err) }, "bridge.focus threw");
      res.status(500).json({ error: String(err), url });
    }
  });

  // Dashboard click → spawn a Windows Terminal tab running either `miki claude`
  // (managed wrap) or `codex` (unmanaged terminal). Claude can wrap/resume an
  // existing session; Codex fresh sessions surface later via notify/transcript
  // ingestion and do not have wrap controls yet.
  //
  // Body:
  //   { session_uuid }            → attach to existing Claude session: `miki claude -r <uuid>`
  //   { cwd, agent?: "claude" }   → fresh Claude session: `miki claude --fresh`
  //   { cwd, agent: "codex" }     → fresh Codex terminal: `cmd.exe /d /k codex`
  //
  // `--fresh` is critical for the no-uuid path: it tells wrap.ts to push a
  // synthetic "hi" so the SDK init fires immediately and a session_uuid lands
  // on the WS register — which is what wrap-process registry keys on for
  // tree-kill / empty-row eviction.
  app.post("/wrap/start", async (req: Request, res: Response) => {
    const sessionUuid = typeof req.body?.session_uuid === "string" && req.body.session_uuid
      ? req.body.session_uuid : null;
    const cwdHint = typeof req.body?.cwd === "string" && req.body.cwd
      ? req.body.cwd : null;
    const requestedAgent = req.body?.agent === "codex" ? "codex"
      : req.body?.agent === undefined || req.body?.agent === "claude" ? "claude"
      : null;
    if (!requestedAgent) {
      res.status(400).json({ error: "invalid_agent", allowed: ["claude", "codex"] });
      return;
    }

    let cwd = cwdHint;
    let agent: AgentId = requestedAgent;
    let commandArgs: string[] = agent === "claude" ? ["node", MIKI_BIN_JS, "claude"] : ["cmd.exe", "/d", "/k", "codex"];
    let managedWrap = agent === "claude";

    if (sessionUuid) {
      const s = deps.store.get(sessionUuid);
      if (!s) {
        res.status(404).json({ error: "session not found", session_uuid: sessionUuid });
        return;
      }
      agent = s.agent;
      commandArgs = agent === "claude" ? ["node", MIKI_BIN_JS, "claude"] : ["cmd.exe", "/d", "/k", "codex"];
      managedWrap = agent === "claude";
      if (s.agent === "codex") {
        res.status(501).json({ error: "codex_wrap_unsupported", message: "Codex wrap/start is not supported yet", session_uuid: sessionUuid });
        return;
      }
      const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
      if (wrapConns?.has(sessionUuid)) {
        res.status(409).json({ error: "session already wrapped" });
        return;
      }
      // For resume: cwd MUST be the cwd-at-session-start, not the DB.cwd,
      // not the latest-hook cwd. The SDK encodes its projects-dir lookup
      // from this exact value; mismatching it = "No conversation found
      // with session ID" crash. Find the JSONL, read its first cwd field,
      // and use that. Falls back to DB.cwd only when transcript missing.
      const projectsRoot = path.join(os.homedir(), ".claude", "projects");
      let tpath: string | null = null;
      try {
        const dirs = await fs.readdir(projectsRoot);
        for (const d of dirs) {
          const candidate = path.join(projectsRoot, d, `${sessionUuid}.jsonl`);
          try { await fs.access(candidate); tpath = candidate; break; }
          catch { /* keep looking */ }
        }
      } catch { /* projects root missing — fall through */ }
      if (!tpath) {
        res.status(404).json({
          error: "no transcript file found for this session — cannot resume",
          session_uuid: sessionUuid,
        });
        return;
      }
      const originalCwd = await readOriginalCwd(tpath);
      if (!originalCwd) {
        deps.log?.warn({ route: "/wrap/start", session_uuid: sessionUuid, tpath }, "transcript missing cwd metadata, falling back to DB.cwd");
      } else if (originalCwd.toLowerCase() !== s.cwd.toLowerCase()) {
        deps.log?.info({ route: "/wrap/start", session_uuid: sessionUuid, db_cwd: s.cwd, original_cwd: originalCwd }, "DB.cwd diverged from JSONL cwd — using JSONL");
      }
      cwd = originalCwd ?? s.cwd;
      commandArgs.push("-r", sessionUuid);
    } else {
      if (agent === "codex") {
        // Fresh Codex sessions are intentionally unmanaged for now. Codex will
        // appear in the dashboard once its notify hook or transcript poll sees
        // the newly-created rollout.
      } else {
      // Fresh-session path: ensure the wrap binds a uuid immediately so the
      // lifecycle registry can track / kill it later. Without --fresh the
      // SDK only inits after the user types something, leaving us blind to
      // the wrap's true session_uuid if they close the window first.
        commandArgs.push("--fresh");
      }
    }

    if (!cwd) {
      res.status(400).json({ error: "missing session_uuid or cwd" });
      return;
    }

    // Validate cwd exists and is a directory — otherwise wt -d would silently
    // open the new tab in the user's home dir, which is confusing UX.
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) {
        res.status(400).json({ error: "cwd is not a directory", cwd });
        return;
      }
    } catch {
      res.status(400).json({ error: "cwd does not exist", cwd });
      return;
    }

    // `wt -w new new-tab -d <cwd> -- node <bin/miki.js> claude [-r <uuid> | --fresh]`
    // `wt -w new new-tab -d <cwd> -- cmd.exe /d /k codex`
    // -w new   = always a fresh wt window (avoids "where did my tab go" if user
    //            already has wt open in a different virtual desktop)
    // -d <cwd> = sets the tab's starting directory (W11 Terminal v1.7+)
    // We invoke `node <abs path>` rather than `miki` so the spawn works:
    //   - without `npm link` (miki may not be on PATH yet)
    //   - across Node versions (24+ blocks .cmd spawn from Node, but here wt
    //     opens a real shell so .cmd would work — node-direct just removes one
    //     more failure mode)
    // For Codex we deliberately go through cmd.exe so the npm shim
    // `codex.cmd` is resolved by PATH; Windows Terminal does not resolve
    // extensionless shell commands when it CreateProcess-es the command after
    // `--` directly.
    const wtArgs = [
      "-w", "new",
      "new-tab",
      "-d", cwd,
      "--",
      ...commandArgs,
    ];

    let spawnedSessionUuid = sessionUuid;
    try {
      const child = spawnTerminal(wtArgs);
      child.on("error", (err) => {
        deps.log?.error({ route: "/wrap/start", error: String(err) }, "wt.exe spawn error event");
      });
      child.unref();
      // Tell the lifecycle registry to expect this wrap. wrap.ts will report
      // its real node PID when it sends `register` over the WS. wt.exe itself
      // is a launcher that exits after handing off, so its PID is useless to
      // us — we wait for the in-process wrap to phone home with its own PID.
      if (managedWrap) wrapProc.recordSpawn({ sessionUuid, cwd });
      if (!managedWrap && agent === "codex" && !sessionUuid) {
        const cwdNorm = normalizeCwd(cwd);
        const pendingUuid = pendingCodexSessionUuid(cwdNorm, randomUUID());
        spawnedSessionUuid = pendingUuid;
        deps.store.upsert({
          session_uuid: pendingUuid,
          agent: "codex",
          cwd: cwdNorm,
          project_name: path.basename(cwdNorm.replace(/\\/g, "/")),
          status: "active",
          last_event_at: Date.now(),
          last_message_preview: "Codex CLI launched - waiting for first turn",
          tokens_in: 0,
          tokens_out: 0,
          vscode_pid: null,
        });
      }
      deps.log?.info({ route: "/wrap/start", session_uuid: sessionUuid, cwd, agent, commandArgs, managedWrap }, "wt new-tab spawned");
      res.status(200).json({ ok: true, session_uuid: spawnedSessionUuid, cwd, agent, managed_wrap: managedWrap, mode: sessionUuid ? "resume" : "new" });
    } catch (err) {
      const msg = String(err);
      deps.log?.error({ route: "/wrap/start", error: msg }, "wt.exe spawn threw");
      res.status(503).json({ ok: false, error: `failed to spawn wt.exe: ${msg}` });
    }
  });

  app.post("/wrap/model", (req: Request, res: Response) => {
    // model="" / null means "fall back to SDK default" — wrap.ts treats
    // empty-string the same as undefined. We still accept and pass through.
    const uuid = typeof req.body?.session_uuid === "string" ? req.body.session_uuid : null;
    const modelRaw = req.body?.model;
    const model: string = typeof modelRaw === "string" ? modelRaw : "";
    if (!uuid) { res.status(400).json({ error: "missing session_uuid" }); return; }
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const wrapWs = wrapConns?.get(uuid);
    if (!wrapWs || wrapWs.readyState !== wrapWs.OPEN) {
      res.status(409).json({ error: "session not wrapped or wrap WS not connected" });
      return;
    }
    try {
      wrapWs.send(JSON.stringify({ type: "set_model", model }));
      deps.log?.info({ route: "/wrap/model", session_uuid: uuid, model }, "pushed set_model to wrap");
      res.status(202).json({ ok: true, queued: true, model });
    } catch (err) {
      deps.log?.error({ route: "/wrap/model", session_uuid: uuid, model, error: String(err) }, "push failed");
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/wrap/effort", (req: Request, res: Response) => {
    // SDK reasoning-effort levels per @anthropic-ai/claude-agent-sdk
    // (sdk.d.ts:472-480). `xhigh` falls back to high on models that don't
    // support it; `max` is gated to specific models (Opus 4.6/4.7, Sonnet
    // 4.6). Empty string / null = "clear runtime override; fall back to
    // SDK default", same convention as /wrap/model.
    const uuid = typeof req.body?.session_uuid === "string" ? req.body.session_uuid : null;
    const effortRaw = req.body?.effort;
    const effort: string = typeof effortRaw === "string" ? effortRaw : "";
    const allowed = ["", "low", "medium", "high", "xhigh", "max"];
    if (!uuid) { res.status(400).json({ error: "missing session_uuid" }); return; }
    if (!allowed.includes(effort)) {
      res.status(400).json({ error: "invalid effort", allowed: allowed.filter((x) => x) });
      return;
    }
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const wrapWs = wrapConns?.get(uuid);
    if (!wrapWs || wrapWs.readyState !== wrapWs.OPEN) {
      res.status(409).json({ error: "session not wrapped or wrap WS not connected" });
      return;
    }
    try {
      wrapWs.send(JSON.stringify({ type: "set_effort", effort }));
      deps.log?.info({ route: "/wrap/effort", session_uuid: uuid, effort }, "pushed set_effort to wrap");
      res.status(202).json({ ok: true, queued: true, effort });
    } catch (err) {
      deps.log?.error({ route: "/wrap/effort", session_uuid: uuid, effort, error: String(err) }, "push failed");
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/wrap/permission-mode", (req: Request, res: Response) => {
    const uuid = typeof req.body?.session_uuid === "string" ? req.body.session_uuid : null;
    const mode = typeof req.body?.mode === "string" ? req.body.mode : null;
    const allowed = ["default", "acceptEdits", "bypassPermissions", "plan", "auto"];
    if (!uuid || !mode) { res.status(400).json({ error: "missing session_uuid or mode" }); return; }
    if (!allowed.includes(mode)) { res.status(400).json({ error: "invalid mode", allowed }); return; }
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const wrapWs = wrapConns?.get(uuid);
    if (!wrapWs || wrapWs.readyState !== wrapWs.OPEN) {
      res.status(409).json({ error: "session not wrapped or wrap WS not connected" });
      return;
    }
    try {
      wrapWs.send(JSON.stringify({ type: "set_permission_mode", mode }));
      deps.log?.info({ route: "/wrap/permission-mode", session_uuid: uuid, mode }, "pushed set_permission_mode to wrap");
      res.status(202).json({ ok: true, queued: true, mode });
    } catch (err) {
      deps.log?.error({ route: "/wrap/permission-mode", session_uuid: uuid, mode, error: String(err) }, "push failed");
      res.status(500).json({ error: String(err) });
    }
  });

  // ── /wrap/stop ────────────────────────────────────────────────────────
  // Tree-kills the wrap subprocess for a daemon-spawned wrap. The wrap WS
  // will close naturally on process exit; the existing close handler then
  // calls rebroadcastSession(uuid), which flips `wrapped=false` on the
  // dashboard via session_changed broadcast. No confirm dialog — the
  // underlying Claude Code session JSONL is untouched, so the user can
  // re-arm via /wrap/start at any time.
  app.post("/wrap/stop", (req: Request, res: Response) => {
    const sessionUuid: unknown = req.body?.session_uuid;
    if (typeof sessionUuid !== "string" || sessionUuid.length === 0) {
      res.status(400).json({ error: "missing_session_uuid" });
      return;
    }
    const spawnRec = wrapProc.takeOnClose(sessionUuid);
    if (!spawnRec) {
      deps.log?.info({ route: "/wrap/stop", session_uuid: sessionUuid }, "no active wrap to stop");
      res.status(404).json({ error: "no_wrap" });
      return;
    }
    if (spawnRec.pid) {
      void killProcessTree(spawnRec.pid, deps.log);
      deps.log?.info({ route: "/wrap/stop", session_uuid: sessionUuid, pid: spawnRec.pid }, "wrap stop requested — process tree kill issued");
    } else {
      deps.log?.warn({ route: "/wrap/stop", session_uuid: sessionUuid }, "wrap stop on unbound record (PID never registered)");
    }
    res.status(200).json({ stopped: true, pid: spawnRec.pid });
  });

  app.post("/send", async (req: Request, res: Response) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : null;
    const submitFlag = req.body?.submit === true;  // false (default) = prefill via URI
    // Pasted images. Only meaningful for wrap-push fast path — VSCode prefill
    // can't carry images through vscode:// URI, and `claude -p` stdin doesn't
    // accept image blocks either, so those paths just drop them with a warning.
    const images: Array<{ media_type: string; data: string }> | undefined =
      Array.isArray(req.body?.images)
        ? req.body.images
            .filter((i: any) => typeof i?.media_type === "string" && typeof i?.data === "string")
            .map((i: any) => ({ media_type: i.media_type, data: i.data }))
        : undefined;
    // auto_enter (only meaningful with submit=false): after prefilling via URI,
    // send {ENTER} keystroke to foreground window so the panel's live session
    // submits — no -p spawn, no cache rebuild, uses panel's hot context.
    // Default true (= zero-friction one-click). Set false to leave prompt in
    // input box for manual review/edit before Enter.
    const autoEnter = req.body?.auto_enter !== false;
    const maxBudgetUsd = typeof req.body?.max_budget_usd === "number" ? req.body.max_budget_usd : 5;
    const { session, key, via } = resolveSession(req.body);
    const hasPrompt = typeof prompt === "string" && prompt.length > 0;
    const hasImages = (images?.length ?? 0) > 0;
    if (!via || (!hasPrompt && !hasImages)) { deps.log?.warn({ route: "/send", hasKey: !!via, hasPrompt, hasImages, submit: submitFlag }, "missing session_uuid/cwd or prompt/images"); res.status(400).json({ error: "missing session_uuid or cwd, or missing prompt/images" }); return; }
    const promptText = prompt ?? "";
    if (!session) { deps.log?.warn({ route: "/send", via, key, submit: submitFlag }, "session not found"); res.status(404).json({ error: "session not found", lookup: { via, key } }); return; }
    if (session.agent === "codex") {
      if (!session.session_uuid) {
        res.status(400).json({ ok: false, error: "missing_session_uuid", message: "Codex send requires a session_uuid" });
        return;
      }
      if (activeCodexExecs.has(session.session_uuid)) {
        res.status(409).json({ ok: false, error: "codex_exec_already_running", mode: "codex-exec" });
        return;
      }
      const controller = new AbortController();
      activeCodexExecs.set(session.session_uuid, controller);
      const start = Date.now();
      try {
        const result = await codexRunner({
          sessionUuid: session.session_uuid,
          cwd: session.cwd,
          prompt: hasPrompt ? promptText : "Please respond to the attached image(s).",
          images,
          signal: controller.signal,
        });
        deps.perfTracker?.recordCompletedTurn(session.session_uuid, start, result.reply);
        deps.store.upsert({
          ...session,
          status: "active",
          last_event_at: Date.now(),
          last_message_preview: (result.reply || (hasPrompt ? promptText : `[image x ${images?.length ?? 0}]`)).slice(0, 240),
        });
        deps.log?.info({ route: "/send", mode: "codex-exec", session_uuid: session.session_uuid, cwd: session.cwd, durationMs: result.durationMs, promptLength: prompt?.length ?? 0, imageCount: images?.length ?? 0 }, "codex exec OK");
        res.status(200).json({
          ok: true,
          mode: "codex-exec",
          session_uuid: session.session_uuid,
          cwd: session.cwd,
          project: session.project_name,
          reply: result.reply,
          duration_ms: result.durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - start;
        if (controller.signal.aborted) {
          deps.log?.warn({ route: "/send", mode: "codex-exec", session_uuid: session.session_uuid, durationMs }, "codex exec interrupted");
          res.status(499).json({ ok: false, interrupted: true, error: "codex_exec_interrupted", mode: "codex-exec", duration_ms: durationMs });
          return;
        }
        deps.log?.error({ route: "/send", mode: "codex-exec", session_uuid: session.session_uuid, durationMs, error: String(err) }, "codex exec failed");
        res.status(500).json({ ok: false, error: String(err), mode: "codex-exec", duration_ms: durationMs });
      } finally {
        if (activeCodexExecs.get(session.session_uuid) === controller) activeCodexExecs.delete(session.session_uuid);
      }
      return;
    }

    // FAST PATH (highest priority): if a `miki claude` wrapper is alive for this
    // session, push through its long-running query() — no spawn, no -p, no
    // resume marker, no extra cost. Bypasses ALL other modes (prefill, helper,
    // submit) regardless of submitFlag, because wrap-push is strictly better
    // than any of them when available.
    if (session.session_uuid) {
      const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
      const wrapWs = wrapConns?.get(session.session_uuid);
      if (wrapWs && wrapWs.readyState === wrapWs.OPEN) {
        try {
          wrapWs.send(JSON.stringify({ type: "push", prompt: promptText, images }));
          deps.log?.info({ route: "/send", mode: "wrap-push", session_uuid: session.session_uuid, project: session.project_name, promptLength: promptText.length, imageCount: images?.length ?? 0 }, "pushed via wrap WS");
          res.status(200).json({
            ok: true,
            mode: "wrap-push",
            session_uuid: session.session_uuid,
            cwd: session.cwd,
            project: session.project_name,
            reply: "(streaming to wrapper — see terminal / next dashboard refresh)",
            duration_ms: 0,
          });
          return;
        } catch (err) {
          deps.log?.error({ route: "/send", mode: "wrap-push", session_uuid: session.session_uuid, error: String(err) }, "wrap push threw, falling through to other modes");
          // fall through
        }
      }
    }

    if (!submitFlag) {
      // PREFILL+ENTER mode — route via helper extension. The legacy direct-SendKeys
      // path (prefillAndSubmitLegacy) does NOT reliably deliver prompts (verified
      // end-to-end: see 2026-05-16 spec). Opt in to legacy explicitly with ?legacy=1
      // for debugging the Win32 focus mechanism in isolation.
      const url = buildSendUrl(session.session_uuid, promptText);
      const legacyMode = req.query.legacy === "1";

      if (legacyMode) {
        try {
          const r = await deps.bridge.prefillAndSubmitLegacy(session.session_uuid, promptText, { cwd: session.cwd });
          deps.log?.info({ route: "/send", mode: "legacy", session_uuid: session.session_uuid, diag: r.diag }, "legacy path used");
          res.status(200).json({ ok: true, mode: "legacy", url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name, diag: r.diag });
        } catch (err) {
          deps.log?.error({ route: "/send", mode: "legacy", error: String(err) }, "legacy path threw");
          res.status(500).json({ error: String(err), url });
        }
        return;
      }

      if (!autoEnter) {
        // prefill-only (no Enter): still use legacy send (just URI open, no keystroke)
        try {
          await deps.bridge.send(session.session_uuid, promptText);
          deps.log?.info({ route: "/send", mode: "prefill", session_uuid: session.session_uuid }, "URI prefilled (not submitted)");
          res.status(200).json({ ok: true, mode: "prefill", url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name });
        } catch (err) {
          deps.log?.error({ route: "/send", mode: "prefill", error: String(err) }, "bridge.send threw");
          res.status(500).json({ error: String(err), url });
        }
        return;
      }

      // Default: helper path (auto_enter=true, no ?legacy=1)
      const result = await deps.bridge.submitViaHelper({
        sessionUuid: session.session_uuid!,
        prompt: promptText,
        cwd: session.cwd,
        registry,
        timeoutMs: 10_000,
      });
      if (!result.ok && result.error?.includes("no miki-helper")) {
        deps.log?.warn({ route: "/send", mode: "helper", cwd: session.cwd }, "no helper for cwd");
        res.status(503).json({ ok: false, error: result.error, mode: "helper", url, cwd: session.cwd });
        return;
      }
      deps.log?.info({ route: "/send", mode: "helper", session_uuid: session.session_uuid, ok: result.ok, error: result.error, diag: result.diag }, "helper path");
      res.status(200).json({
        ok: result.ok, mode: "helper",
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.diag !== undefined ? { diag: result.diag } : {}),
        url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name,
      });
      return;
    }

    // SUBMIT mode (real API cost) — spawn `claude -r <uuid> -p "..."`
    if (!session.session_uuid) {
      res.status(400).json({ error: "submit mode requires session_uuid (got null)" });
      return;
    }

    deps.log?.info({ route: "/send", mode: "submit", session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name, promptLength: promptText.length, maxBudgetUsd }, "spawning headless claude...");
    const start = Date.now();
    try {
      const result = await deps.bridge.submit({
        sessionUuid: session.session_uuid,
        cwd: session.cwd,
        prompt: promptText,
        maxBudgetUsd,
      });
      deps.log?.info({ route: "/send", mode: "submit", session_uuid: session.session_uuid, project: session.project_name, replyLength: result.reply.length, durationMs: result.durationMs }, "headless claude OK");
      res.status(200).json({
        ok: true,
        mode: "submit",
        session_uuid: session.session_uuid,
        cwd: session.cwd,
        project: session.project_name,
        reply: result.reply,
        duration_ms: result.durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      deps.log?.error({ route: "/send", mode: "submit", session_uuid: session.session_uuid, durationMs, error: String(err) }, "headless claude failed");
      res.status(500).json({ error: String(err), mode: "submit", duration_ms: durationMs });
    }
  });

  const server = http.createServer(app);
  // IMPORTANT: multiple WebSocketServer instances on the same http.Server fight
  // for the 'upgrade' event — the first one wins and 400's everything else.
  // Workaround: noServer mode + one manual upgrade router below.
  const wss = new WebSocketServer({ noServer: true });

  // Wrap WS endpoint — each `miki claude` wrapper connects here and registers
  // its session. /send for a wrapped session goes through this socket instead
  // of spawning `claude -p`.
  const wrapWss = new WebSocketServer({ noServer: true });
  const wrapConnections = new Map<string, import("ws").WebSocket>(); // uuid → ws
  // Latest activity label per wrapped session ("Ideating" / "Using Bash" / "Replying").
  // Lives only in memory — purpose is to let dashboard pick up the badge after
  // browser refresh without waiting for the next activity event from wrap.
  const wrapActivity = new Map<string, string>();
  // Permission mode declared by each wrap at register time
  // ("default" | "acceptEdits" | "bypassPermissions" | "plan"). Locked for the
  // wrap session lifetime — SDK doesn't expose a mid-session toggle.
  const wrapPermissionMode = new Map<string, string>();
  // Active SDK model per wrapped session — sourced from wrap's `register`
  // (initial --model flag) and updated on `model_changed` (post-setModel).
  // Empty string sentinel reserved for "explicit default"; absence in the
  // map means "wrap didn't pass a model" (same effective state, distinguished
  // only for log clarity).
  const wrapModel = new Map<string, string>();
  // Active reasoning-effort per wrapped session. Sourced from wrap's
  // `register` (initial flag) and updated on `effort_changed` (post
  // applyFlagSettings). Empty string = "explicit SDK default"; absence in the
  // map = "wrap didn't pass an effort". UI treats both the same.
  const wrapEffort = new Map<string, string>();
  // Pending "downgrade to stale" timers per uuid. On wrap close we don't
  // immediately mark the session stale (because daemon hot-reload / network
  // blip causes transient closes that wrap auto-reconnects in 3s). Instead
  // we schedule a downgrade after a grace period; if wrap reconnects within
  // that window, bind() clears the timer.
  const wrapStaleTimers = new Map<string, NodeJS.Timeout>();
  const WRAP_STALE_GRACE_MS = 8_000;
  // Pending AskUserQuestion per wrapped session (so dashboard F5 can re-pick up).
  interface PendingAsk { question_id: string; questions: unknown[] }
  const wrapAsks = new Map<string, PendingAsk>();
  // Re-broadcast a session's row with the updated `wrapped` flag so dashboard
  // can repaint the badge live. Cheap (one JSON.stringify per client).
  function rebroadcastSession(uuid: string): void {
    const s = deps.store.get(uuid);
    if (!s) return;
    const enriched = {
      ...s,
      wrapped: wrapConnections.has(uuid),
      permission_mode: wrapPermissionMode.get(uuid) ?? null,
      current_model: wrapModel.get(uuid) ?? null,
      current_effort: wrapEffort.get(uuid) ?? null,
    };
    const msg = JSON.stringify({ type: "session_changed", session: enriched });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg, () => { /* noop */ });
    }
  }

  wrapWss.on("connection", (ws) => {
    let registeredUuid: string | null = null;
    let registeredCwd: string = "";
    let registeredPermissionMode: string | null = null;
    // Initial model declared by wrap.ts at register time. Buffered like
    // registeredPermissionMode so bind() can upsert wrapModel once the
    // session_uuid arrives (either at register or via late-bind message).
    let registeredModel: string | null = null;
    // Initial reasoning-effort declared by wrap.ts at register time. Same
    // buffering as registeredModel so bind() can populate wrapEffort once
    // the session_uuid arrives.
    let registeredEffort: string | null = null;
    // PID reported by wrap.ts at register-time. Buffered here for the
    // late-bind case (`register` arrives with session_uuid:null, then a
    // separate `session_uuid` message lands once SDK init completes).
    let registeredPid: number | null = null;
    deps.log?.info({ route: "/wrap" }, "wrap client connected");
    function bind(uuid: string): void {
      // Detached uuid (e.g. user typed /clear in CLI → SDK assigns a new
      // session id and we rebind). We must rebroadcast the OLD row so the
      // dashboard sees it's no longer wrapped — otherwise the old cell keeps
      // its wrapped badge, send goes to a dead WS, and falls through to the
      // VSCode URI handler which spawns a surprise panel.
      const detached = registeredUuid && registeredUuid !== uuid && wrapConnections.get(registeredUuid) === ws
        ? registeredUuid : null;
      if (detached) {
        wrapConnections.delete(detached);
        wrapPermissionMode.delete(detached);
        wrapModel.delete(detached);
        wrapEffort.delete(detached);
      }
      registeredUuid = uuid;
      wrapConnections.set(uuid, ws);
      if (registeredPermissionMode) wrapPermissionMode.set(uuid, registeredPermissionMode);
      if (registeredModel !== null) wrapModel.set(uuid, registeredModel);
      if (registeredEffort !== null) wrapEffort.set(uuid, registeredEffort);
      // Cancel any pending stale-downgrade — we're back online for this uuid.
      const pending = wrapStaleTimers.get(uuid);
      if (pending) { clearTimeout(pending); wrapStaleTimers.delete(uuid); }

      // Ensure the Session row exists AND reflects the wrap being live. Two
      // cases this handles:
      //   1. No row yet (daemon restart, or session created outside hooks):
      //      create it from scratch.
      //   2. Stale row exists (prior VSCode panel closed, status="stale"):
      //      force back to "active" so the dashboard treats this `miki claude
      //      -r <uuid>` takeover as a fresh live session — otherwise the
      //      dashboard cell looks dead until the user types something in the
      //      terminal and a hook fires.
      // We preserve existing fields (project_name, tokens, preview) by reading
      // them first when present; only revive status + last_event_at.
      if (registeredCwd) {
        const cwdNorm = normalizeCwd(registeredCwd);
        const existing = deps.store.get(uuid);
        deps.store.upsert({
          cwd: existing?.cwd ?? cwdNorm,
          session_uuid: uuid,
          agent: existing?.agent ?? "claude",
          project_name: existing?.project_name ?? path.basename(cwdNorm.replace(/\\/g, "/")),
          status: "active",
          last_event_at: Date.now(),
          last_message_preview: existing?.last_message_preview ?? "",
          tokens_in: existing?.tokens_in ?? 0,
          tokens_out: existing?.tokens_out ?? 0,
          vscode_pid: existing?.vscode_pid ?? null,
        });
        deps.log?.info({ route: "/wrap", session_uuid: uuid, cwd: cwdNorm, revived: !!existing }, "wrap upserted session row");
      }
      // If the wrap just swapped uuid (e.g. /clear in CLI), broadcast the OLD
      // row so the dashboard's old cell drops its wrapped badge — otherwise
      // sending to it routes through a dead WS, falls through to VSCode URI
      // handler and surprises the user with a fresh panel.
      if (detached) {
        deps.log?.info({ route: "/wrap", detached, new: uuid }, "wrap uuid swap — unmarking old cell as wrapped");
        rebroadcastSession(detached);
      }
      rebroadcastSession(uuid);
    }
    ws.on("message", (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.type === "register") {
        // Store cwd from register payload so bind() can upsert with it later.
        if (typeof m.cwd === "string") registeredCwd = m.cwd;
        // Wrap-declared permission mode. Stays on the connection regardless of
        // when the session_uuid is bound (could be at register or later via
        // "session_uuid" message after SDK init).
        if (typeof m.permission_mode === "string") {
          registeredPermissionMode = m.permission_mode;
        }
        // Wrap declared initial model (or null = SDK default). Stored as
        // string ("" for null) since the Map type is string-only.
        if (typeof m.model === "string") {
          registeredModel = m.model;
        } else if (m.model === null) {
          registeredModel = "";
        }
        // Effort follows the same null-vs-empty-string convention.
        if (typeof m.effort === "string") {
          registeredEffort = m.effort;
        } else if (m.effort === null) {
          registeredEffort = "";
        }
        // Capture node PID so wrap-process registry can tree-kill it on close
        // (Windows wt.exe doesn't propagate window-close to children).
        if (typeof m.pid === "number" && m.pid > 0) registeredPid = m.pid;
        if (typeof m.session_uuid === "string" && m.session_uuid) {
          bind(m.session_uuid);
          if (registeredPid) wrapProc.bindPid(m.session_uuid, registeredPid);
          deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid, permission_mode: registeredPermissionMode, pid: registeredPid }, "wrap registered");
        }
      } else if (m?.type === "session_uuid" && typeof m.session_uuid === "string" && m.session_uuid) {
        bind(m.session_uuid);
        if (registeredPid) wrapProc.bindPid(m.session_uuid, registeredPid);
        deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid, pid: registeredPid }, "wrap uuid late-bound");
      } else if (m?.type === "permission_mode_changed" && typeof m.session_uuid === "string" && typeof m.mode === "string") {
        // Wrap confirmed the mode switch completed. Update server-side map and
        // rebroadcast so all browser clients pick up the new badge.
        wrapPermissionMode.set(m.session_uuid, m.mode);
        deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid, mode: m.mode }, "wrap permission_mode changed");
        rebroadcastSession(m.session_uuid);
      } else if (m?.type === "model_changed" && typeof m.session_uuid === "string") {
        // Wrap confirmed q.setModel() resolved. m.model may be null (SDK
        // default), which we store as the empty-string sentinel.
        const modelStr: string = typeof m.model === "string" ? m.model : "";
        wrapModel.set(m.session_uuid, modelStr);
        deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid, model: modelStr || "(default)" }, "wrap model changed");
        rebroadcastSession(m.session_uuid);
      } else if (m?.type === "effort_changed" && typeof m.session_uuid === "string") {
        // Wrap confirmed applyFlagSettings({ effortLevel }) resolved. Same
        // null/empty-string convention as model_changed.
        const effortStr: string = typeof m.effort === "string" ? m.effort : "";
        wrapEffort.set(m.session_uuid, effortStr);
        deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid, effort: effortStr || "(default)" }, "wrap effort changed");
        rebroadcastSession(m.session_uuid);
      } else if (m?.type === "user_message" && typeof m.session_uuid === "string" && typeof m.text === "string") {
        // Optimistic user-text overlay. Wrap sends this the instant the user
        // hits Enter — broadcasted so dashboard cells can paint the new "user"
        // preview line without waiting for the next /sessions/previews poll
        // (~1-2s lag from JSONL flush). Browser drops the overlay as soon as
        // the canonical preview's last_user_ts catches up.
        const out = JSON.stringify({
          type: "user_message",
          session_uuid: m.session_uuid,
          text: m.text,
          ts: typeof m.ts === "number" ? m.ts : Date.now(),
        });
        for (const c of wss.clients) {
          if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
        }
      } else if ((m?.type === "assistant_delta" || m?.type === "assistant_delta_start" || m?.type === "assistant_delta_end") && typeof m.session_uuid === "string") {
        // Streaming text deltas from the SDK partial-message stream. Just
        // pass-through to all dashboard WS clients — they merge into the
        // streaming buffer keyed by session_uuid. Cheap, no caching needed
        // (late-joining browsers pick up the canonical text via /sessions/previews
        // poll within 2s).
        const pt = deps.perfTracker;
        if (pt) {
          if (m.type === "assistant_delta_start") pt.onDeltaStart(m.session_uuid);
          else if (m.type === "assistant_delta" && typeof m.text === "string") pt.onDelta(m.session_uuid, m.text);
          else if (m.type === "assistant_delta_end") pt.onDeltaEnd(m.session_uuid);
        }
        const out = JSON.stringify(m);
        for (const c of wss.clients) {
          if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
        }
      } else if (m?.type === "activity" && typeof m.session_uuid === "string") {
        // Live activity ping ("Ideating" / "Using Bash" / "Replying" / null).
        // Cache the latest so /sessions can include it (so browser refresh
        // doesn't blank the badge), AND broadcast for live updates.
        const label: string | null = typeof m.label === "string" ? m.label : null;
        if (label) wrapActivity.set(m.session_uuid, label);
        else wrapActivity.delete(m.session_uuid);
        const out = JSON.stringify({ type: "activity", session_uuid: m.session_uuid, label });
        for (const c of wss.clients) {
          if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
        }
      } else if (m?.type === "ask_question" && typeof m.session_uuid === "string" && typeof m.question_id === "string") {
        // Claude wants to ask a multi-choice question. Cache for late-joining
        // browser refresh + broadcast immediately to all dashboard clients.
        const entry = { question_id: m.question_id, questions: Array.isArray(m.questions) ? m.questions : [] };
        wrapAsks.set(m.session_uuid, entry);
        const out = JSON.stringify({ type: "ask_question", session_uuid: m.session_uuid, ...entry });
        for (const c of wss.clients) {
          if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
        }
      } else if (m?.type === "ask_question_done" && typeof m.session_uuid === "string") {
        // Wrap got the answer (from terminal or dashboard) — clear cache + tell dashboards to close pickers.
        wrapAsks.delete(m.session_uuid);
        const out = JSON.stringify({ type: "ask_question_done", session_uuid: m.session_uuid, question_id: m.question_id });
        for (const c of wss.clients) {
          if (c.readyState === c.OPEN) c.send(out, () => { /* noop */ });
        }
      } else if ((m?.type === "turn_start" || m?.type === "turn_end") && typeof m.session_uuid === "string") {
        // SDK-driven wrap sessions never fire Claude Code's UserPromptSubmit /
        // Stop hooks, so the dashboard's status column would freeze at whatever
        // value the last real hook left. Wrap reports turn boundaries via
        // turn_start / turn_end; we synthesize the equivalent hook events so
        // hook-handler flips status as if a hook had fired.
        const cwdForEvent = registeredCwd ?? deps.store.get(m.session_uuid)?.cwd ?? "";
        if (cwdForEvent) {
          void deps.handler.handle({
            event_type: m.type === "turn_start" ? "user_prompt" : "stop",
            cwd: cwdForEvent,
            session_uuid: m.session_uuid,
            timestamp: Date.now(),
          });
        }
      }
    });
    ws.on("close", () => {
      const uuid = registeredUuid;
      if (uuid && wrapConnections.get(uuid) === ws) {
        wrapConnections.delete(uuid);
        wrapActivity.delete(uuid);
        wrapPermissionMode.delete(uuid);
        wrapModel.delete(uuid);
        wrapEffort.delete(uuid);
        wrapAsks.delete(uuid);
        deps.log?.info({ route: "/wrap", session_uuid: uuid }, "wrap disconnected");

        // Reclaim ownership from the lifecycle registry. If the daemon spawned
        // this CLI via /wrap/start (i.e. spawnRec exists), it's our job to:
        //   1. Tree-kill the leftover node process (Windows wt close doesn't),
        //   2. If the session never produced a real turn (user opened CLI by
        //      mistake, closed without sending), evict the row so the
        //      dashboard doesn't carry a ghost card forever.
        // External wraps (user-launched `pnpm miki claude` from their own
        // terminal) don't have a spawn record; we leave them entirely alone.
        const spawnRec = wrapProc.takeOnClose(uuid);
        if (spawnRec?.pid) {
          void killProcessTree(spawnRec.pid, deps.log);
        }

        rebroadcastSession(uuid);

        // Replace any pending timer for this uuid (defensive — close can fire
        // twice in some edge cases).
        const prior = wrapStaleTimers.get(uuid);
        if (prior) clearTimeout(prior);

        // Auto-cleanup empty daemon-spawned sessions: if JSONL has zero
        // meaningful turns, evict the row entirely instead of marking stale.
        // Done async (file IO) — until it resolves the row sits at its current
        // status, which is fine because the dashboard already dropped the
        // "wrapped" badge via rebroadcastSession above.
        if (spawnRec) {
          void (async () => {
            try {
              const projectsRoot = path.join(os.homedir(), ".claude", "projects");
              const dirs = await fs.readdir(projectsRoot).catch(() => [] as string[]);
              let tpath: string | null = null;
              for (const d of dirs) {
                const candidate = path.join(projectsRoot, d, `${uuid}.jsonl`);
                try { await fs.access(candidate); tpath = candidate; break; }
                catch { /* keep looking */ }
              }
              const hasTurns = tpath ? await sessionHasAnyTurns(tpath) : false;
              if (!hasTurns) {
                // Don't race the stale timer below — cancel it first.
                const t = wrapStaleTimers.get(uuid);
                if (t) { clearTimeout(t); wrapStaleTimers.delete(uuid); }
                const removed = deps.store.remove(uuid);
                if (removed) {
                  deps.log?.info({ route: "/wrap", session_uuid: uuid, transcript_found: !!tpath }, "wrap closed with no turns — row evicted");
                }
              }
            } catch (err) {
              deps.log?.warn({ route: "/wrap", session_uuid: uuid, error: String(err) }, "empty-transcript check failed; row kept");
            }
          })();
        }

        const timer = setTimeout(() => {
          wrapStaleTimers.delete(uuid);
          // Reconnected in the meantime? bind() already cleared us, but check
          // again to be safe.
          if (wrapConnections.has(uuid)) return;
          const existing = deps.store.get(uuid);
          if (!existing) return;
          if (existing.status === "stale") return;
          deps.store.upsert({
            ...existing,
            status: "stale",
            last_event_at: Date.now(),
          });
          deps.log?.info({ route: "/wrap", session_uuid: uuid }, "wrap stayed disconnected — downgraded to stale");
          rebroadcastSession(uuid);
        }, WRAP_STALE_GRACE_MS);
        wrapStaleTimers.set(uuid, timer);
      }
    });
    ws.on("error", () => { /* swallow — close handler does cleanup */ });
  });

  // Expose check for /send to route through wrap when available
  (deps as any).__wrapConnections = wrapConnections;
  (deps as any).__wrapActivity = wrapActivity;
  (deps as any).__wrapPermissionMode = wrapPermissionMode;
  (deps as any).__wrapModel = wrapModel;
  (deps as any).__wrapEffort = wrapEffort;
  (deps as any).__wrapAsks = wrapAsks;

  const registry = new ExtRegistry();
  const wssExt = new WebSocketServer({ noServer: true });

  // Single upgrade router — dispatch by URL path so all three WSS get their share.
  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    if (url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else if (url === "/wrap") {
      wrapWss.handleUpgrade(req, socket, head, (ws) => wrapWss.emit("connection", ws, req));
    } else if (url === "/ws_ext") {
      wssExt.handleUpgrade(req, socket, head, (ws) => wssExt.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });
  const hb = deps.heartbeat ?? { pingMs: 30_000, pongTimeoutMs: 10_000 };
  const pendingPong = new WeakMap<any, { request_id: string; deadline: number }>();

  wssExt.on("connection", (ws) => {
    deps.log?.info({ route: "/ws_ext" }, "extension ws connected");

    ws.on("message", (raw) => {
      let msg: ExtMessage;
      try { msg = JSON.parse(String(raw)); } catch {
        deps.log?.warn({ route: "/ws_ext", raw: String(raw).slice(0, 200) }, "malformed json, ignoring");
        return;
      }
      if (msg.type === "register") {
        registry.add(ws, {
          workspace_root: msg.workspace_root,
          version: msg.helper_version,
          registered_at: Date.now(),
        });
        deps.log?.info({ route: "/ws_ext", workspace_root: msg.workspace_root, version: msg.helper_version }, "extension registered");
        return;
      }
      if (msg.type === "pong") {
        const pending = pendingPong.get(ws);
        if (pending && pending.request_id === msg.request_id) {
          pendingPong.delete(ws);
        }
        return;
      }
      // submit_ack handled by per-request listener in submitViaHelper.
    });

    // Heartbeat: fire ping every pingMs; if pendingPong unresolved past deadline, terminate.
    const pingTimer = setInterval(() => {
      const existing = pendingPong.get(ws);
      if (existing && Date.now() > existing.deadline) {
        deps.log?.warn({ route: "/ws_ext", request_id: existing.request_id }, "pong timeout, closing");
        try { ws.terminate(); } catch { /* ignore */ }
        clearInterval(pingTimer);
        return;
      }
      if (!existing) {
        const request_id = randomUUID();
        pendingPong.set(ws, { request_id, deadline: Date.now() + hb.pongTimeoutMs });
        try { ws.send(JSON.stringify({ type: "ping", request_id })); }
        catch { /* ws may be closing; let close handler clean up */ }
      }
    }, hb.pingMs);

    ws.on("close", () => {
      clearInterval(pingTimer);
      registry.remove(ws);
      deps.log?.info({ route: "/ws_ext" }, "extension ws disconnected");
    });
    ws.on("error", (err) => {
      deps.log?.warn({ route: "/ws_ext", error: String(err) }, "extension ws error");
    });
  });

  deps.store.on("session_changed", (session) => {
    const uuid = session.session_uuid ?? "";
    const enriched = {
      ...session,
      wrapped: wrapConnections.has(uuid),
      permission_mode: wrapPermissionMode.get(uuid) ?? null,
      current_model: wrapModel.get(uuid) ?? null,
      current_effort: wrapEffort.get(uuid) ?? null,
    };
    const msg = JSON.stringify({ type: "session_changed", session: enriched });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg, (_err) => { /* client may have raced disconnect; ignore */ });
      }
    }
  });

  // Auto-cleanup paths (wrap close with empty transcript, future manual
  // delete) end at session_store.remove() → "session_removed" event. Forward
  // it to dashboard clients so the cell vanishes live. Frontend already
  // handles the `session_removed` WS message type (see app.tsx).
  deps.store.on("session_removed", (sessionUuid) => {
    const msg = JSON.stringify({ type: "session_removed", session_uuid: sessionUuid });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg, (_err) => { /* ignore racing disconnects */ });
      }
    }
  });

  // Expose registry for tests / startup orphan kill driver (index.ts).
  (deps as any).__wrapProc = wrapProc;
  (app as any).__wrapProc = wrapProc;

  return { app, server, registry };
}

// Re-export for index.ts startup driver.
export { killOrphans };
