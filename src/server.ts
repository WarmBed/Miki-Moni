import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { SessionStore } from "./session-store.js";
import type { HookHandler } from "./hook-handler.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Notifier } from "./notifier.js";
import type { HookEvent } from "./types.js";

export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
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
    if (!ev) { res.status(400).json({ error: "invalid hook event" }); return; }
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
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
    if (!cwd) { res.status(400).json({ error: "missing cwd" }); return; }
    const session = deps.store.get(cwd);
    if (!session) { res.status(404).end(); return; }
    await deps.bridge.focus(session.session_uuid);
    res.status(204).end();
  });

  app.post("/send", async (req: Request, res: Response) => {
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : null;
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : null;
    if (!cwd || !prompt) { res.status(400).json({ error: "missing cwd or prompt" }); return; }
    const session = deps.store.get(cwd);
    if (!session) { res.status(404).end(); return; }
    await deps.bridge.send(session.session_uuid, prompt);
    res.status(204).end();
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
