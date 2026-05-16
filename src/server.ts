import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { SessionStore } from "./session-store.js";
import type { HookHandler } from "./hook-handler.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Notifier } from "./notifier.js";
import type { HookEvent, Session } from "./types.js";
import { normalizeCwd } from "./hook-handler.js";
import { readTranscriptTail, readSessionPreview, type SessionPreview } from "./session-resolver.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

type Log = { info: (obj: Record<string, unknown>, msg?: string) => void; warn: (obj: Record<string, unknown>, msg?: string) => void; error: (obj: Record<string, unknown>, msg?: string) => void };

export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
  log?: Log;
}

function parseHookEvent(body: unknown): HookEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.event_type !== "string") return null;
  if (typeof b.cwd !== "string") return null;
  if (typeof b.timestamp !== "number") return null;
  const validTypes = ["session_start", "stop", "user_prompt", "pre_tool_use", "post_tool_use"];
  if (!validTypes.includes(b.event_type)) return null;
  return {
    event_type: b.event_type as HookEvent["event_type"],
    cwd: b.cwd,
    session_uuid: typeof b.session_uuid === "string" ? b.session_uuid : null,
    timestamp: b.timestamp,
    extra: (b.extra as Record<string, unknown>) ?? undefined,
  };
}

export function createApp(deps: ServerDeps): { app: Express; server: http.Server } {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/event", async (req: Request, res: Response) => {
    const ev = parseHookEvent(req.body);
    if (!ev) { deps.log?.warn({ route: "/event", body: req.body }, "invalid hook event"); res.status(400).json({ error: "invalid hook event" }); return; }
    deps.log?.info({ route: "/event", event_type: ev.event_type, cwd: ev.cwd, session_uuid: ev.session_uuid }, "hook event in");
    await deps.handler.handle(ev);
    res.status(204).end();
  });

  app.get("/sessions", (_req, res) => {
    res.json(deps.store.list());
  });

  // /sessions/previews MUST come before /sessions/:session_uuid (Express order)
  app.get("/sessions/previews", async (_req, res) => {
    const sessions = deps.store.list();
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");

    // Cache transcript lookup per request
    let dirs: string[] = [];
    try { dirs = await fs.readdir(projectsRoot); } catch { /* no dir */ }

    async function findPath(uuid: string): Promise<string | null> {
      for (const d of dirs) {
        const candidate = path.join(projectsRoot, d, `${uuid}.jsonl`);
        try { await fs.access(candidate); return candidate; } catch { /* keep looking */ }
      }
      return null;
    }

    const previews: SessionPreview[] = [];
    await Promise.all(sessions.map(async (s) => {
      if (!s.session_uuid) return;
      const tpath = await findPath(s.session_uuid);
      if (!tpath) return;
      try {
        const p = await readSessionPreview(s.session_uuid, tpath);
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

  app.get("/sessions/:session_uuid/transcript", async (req, res) => {
    const sessionUuid = decodeURIComponent(req.params.session_uuid!);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 200);
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    // Find which projects dir contains <uuid>.jsonl
    let transcriptPath: string | null = null;
    try {
      const dirs = await fs.readdir(projectsRoot);
      for (const d of dirs) {
        const candidate = path.join(projectsRoot, d, `${sessionUuid}.jsonl`);
        try { await fs.access(candidate); transcriptPath = candidate; break; }
        catch { /* keep looking */ }
      }
    } catch { /* no projects dir */ }
    if (!transcriptPath) {
      deps.log?.warn({ route: "/sessions/:id/transcript", sessionUuid }, "transcript not found");
      res.status(404).json({ error: "transcript not found", session_uuid: sessionUuid });
      return;
    }
    try {
      const turns = await readTranscriptTail(transcriptPath, limit);
      const stat = await fs.stat(transcriptPath);
      deps.log?.info({ route: "/sessions/:id/transcript", sessionUuid, returned: turns.length, fileSize: stat.size }, "transcript served");
      res.json({
        session_uuid: sessionUuid,
        transcript_path: transcriptPath,
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

  app.post("/send", async (req: Request, res: Response) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : null;
    const submitFlag = req.body?.submit === true;  // false (default) = prefill via URI
    // auto_enter (only meaningful with submit=false): after prefilling via URI,
    // send {ENTER} keystroke to foreground window so the panel's live session
    // submits — no -p spawn, no cache rebuild, uses panel's hot context.
    // Default true (= zero-friction one-click). Set false to leave prompt in
    // input box for manual review/edit before Enter.
    const autoEnter = req.body?.auto_enter !== false;
    const maxBudgetUsd = typeof req.body?.max_budget_usd === "number" ? req.body.max_budget_usd : 5;
    const { session, key, via } = resolveSession(req.body);
    if (!via || !prompt) { deps.log?.warn({ route: "/send", hasKey: !!via, hasPrompt: !!prompt, submit: submitFlag }, "missing session_uuid/cwd or prompt"); res.status(400).json({ error: "missing session_uuid or cwd, or missing prompt" }); return; }
    if (!session) { deps.log?.warn({ route: "/send", via, key, submit: submitFlag }, "session not found"); res.status(404).json({ error: "session not found", lookup: { via, key } }); return; }

    if (!submitFlag) {
      // PREFILL mode — vscode:// URI handler. Optionally auto-press Enter.
      const url = buildSendUrl(session.session_uuid, prompt);
      const mode = autoEnter ? "prefill+enter" : "prefill";
      try {
        if (autoEnter) {
          await deps.bridge.prefillAndSubmit(session.session_uuid, prompt);
        } else {
          await deps.bridge.send(session.session_uuid, prompt);
        }
        deps.log?.info({ route: "/send", mode, via, key, cwd: session.cwd, session_uuid: session.session_uuid, project: session.project_name, promptLength: prompt.length, url }, autoEnter ? "URI prefilled + Enter sent to foreground" : "URI prefilled (not submitted)");
        res.status(200).json({ ok: true, mode, url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name });
      } catch (err) {
        deps.log?.error({ route: "/send", mode, via, key, url, error: String(err) }, "bridge prefill threw");
        res.status(500).json({ error: String(err), url });
      }
      return;
    }

    // SUBMIT mode (real API cost) — spawn `claude -r <uuid> -p "..."`
    if (!session.session_uuid) {
      res.status(400).json({ error: "submit mode requires session_uuid (got null)" });
      return;
    }
    deps.log?.info({ route: "/send", mode: "submit", session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name, promptLength: prompt.length, maxBudgetUsd }, "spawning headless claude...");
    const start = Date.now();
    try {
      const result = await deps.bridge.submit({
        sessionUuid: session.session_uuid,
        cwd: session.cwd,
        prompt,
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
  const wss = new WebSocketServer({ server, path: "/ws" });

  deps.store.on("session_changed", (session) => {
    const msg = JSON.stringify({ type: "session_changed", session });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg, (_err) => { /* client may have raced disconnect; ignore */ });
      }
    }
  });

  return { app, server };
}
