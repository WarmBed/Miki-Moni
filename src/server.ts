import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
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

  const server = http.createServer(app);
  return { app, server };
}
