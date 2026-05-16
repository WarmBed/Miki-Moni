import express, { type Express, type Request, type Response } from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { SessionStore } from "./session-store.js";
import type { HookHandler } from "./hook-handler.js";
import type { VscodeBridge } from "./vscode-bridge.js";
import type { Notifier } from "./notifier.js";
import type { HookEvent, Session } from "./types.js";
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

  app.get("/sessions/:session_uuid", (req, res) => {
    const session = deps.store.get(decodeURIComponent(req.params.session_uuid!));
    if (!session) { res.status(404).end(); return; }
    res.json(session);
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
    const { session, key, via } = resolveSession(req.body);
    if (!via || !prompt) { deps.log?.warn({ route: "/send", hasKey: !!via, hasPrompt: !!prompt }, "missing session_uuid/cwd or prompt"); res.status(400).json({ error: "missing session_uuid or cwd, or missing prompt" }); return; }
    if (!session) { deps.log?.warn({ route: "/send", via, key }, "session not found"); res.status(404).json({ error: "session not found", lookup: { via, key } }); return; }
    const url = buildSendUrl(session.session_uuid, prompt);
    try {
      await deps.bridge.send(session.session_uuid, prompt);
      deps.log?.info({ route: "/send", via, key, cwd: session.cwd, session_uuid: session.session_uuid, project: session.project_name, promptLength: prompt.length, url }, "URI launched (prompt prefilled)");
      res.status(200).json({ ok: true, url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name });
    } catch (err) {
      deps.log?.error({ route: "/send", via, key, url, error: String(err) }, "bridge.send threw");
      res.status(500).json({ error: String(err), url });
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
