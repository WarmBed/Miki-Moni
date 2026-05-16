import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { SessionStore } from "./session-store.js";
import type { HookHandler } from "./hook-handler.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Notifier } from "./notifier.js";
import type { HookEvent } from "./types.js";
import { normalizeCwd } from "./hook-handler.js";

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

  app.get("/sessions/:cwd", (req, res) => {
    const session = deps.store.get(decodeURIComponent(req.params.cwd!));
    if (!session) { res.status(404).end(); return; }
    res.json(session);
  });

  app.post("/focus", async (req: Request, res: Response) => {
    const rawCwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
    if (!rawCwd) { deps.log?.warn({ route: "/focus" }, "missing cwd"); res.status(400).json({ error: "missing cwd" }); return; }
    const cwd = normalizeCwd(rawCwd);
    const session = deps.store.get(cwd);
    if (!session) { deps.log?.warn({ route: "/focus", cwd, rawCwd }, "session not found"); res.status(404).json({ error: "session not found", cwd }); return; }
    try {
      await deps.bridge.focus(session.session_uuid);
      deps.log?.info({ route: "/focus", cwd, session_uuid: session.session_uuid, project: session.project_name }, "URI launched");
      res.status(204).end();
    } catch (err) {
      deps.log?.error({ route: "/focus", cwd, error: String(err) }, "bridge.focus threw");
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/send", async (req: Request, res: Response) => {
    const rawCwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : null;
    if (!rawCwd || !prompt) { deps.log?.warn({ route: "/send", hasCwd: !!rawCwd, hasPrompt: !!prompt }, "missing cwd or prompt"); res.status(400).json({ error: "missing cwd or prompt" }); return; }
    const cwd = normalizeCwd(rawCwd);
    const session = deps.store.get(cwd);
    if (!session) { deps.log?.warn({ route: "/send", cwd, rawCwd }, "session not found"); res.status(404).json({ error: "session not found", cwd }); return; }
    try {
      await deps.bridge.send(session.session_uuid, prompt);
      deps.log?.info({ route: "/send", cwd, session_uuid: session.session_uuid, project: session.project_name, promptLength: prompt.length }, "URI launched (prompt prefilled)");
      res.status(204).end();
    } catch (err) {
      deps.log?.error({ route: "/send", cwd, error: String(err) }, "bridge.send threw");
      res.status(500).json({ error: String(err) });
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
