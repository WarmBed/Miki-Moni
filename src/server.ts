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
import { ExtRegistry } from "./ext-registry.js";
import type { ExtMessage } from "./protocol-ext.js";
import { randomUUID } from "node:crypto";

type Log = { info: (obj: Record<string, unknown>, msg?: string) => void; warn: (obj: Record<string, unknown>, msg?: string) => void; error: (obj: Record<string, unknown>, msg?: string) => void };

export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
  log?: Log;
  heartbeat?: { pingMs: number; pongTimeoutMs: number };  // default: { 30_000, 10_000 }
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

export function createApp(deps: ServerDeps): { app: Express; server: http.Server; registry: ExtRegistry } {
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
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const list = deps.store.list().map((s) => ({
      ...s,
      wrapped: wrapConns?.has(s.session_uuid ?? "") ?? false,
    }));
    res.json(list);
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

  // Lightweight poll endpoint: returns just file stat (no read of JSONL).
  // Client polls this every ~2s; if last_modified/file_size differ from cached,
  // re-fetch the full transcript. Cheap = fs.stat only.
  app.get("/sessions/:session_uuid/transcript-meta", async (req, res) => {
    const sessionUuid = decodeURIComponent(req.params.session_uuid!);
    const projectsRoot = path.join(os.homedir(), ".claude", "projects");
    try {
      const dirs = await fs.readdir(projectsRoot);
      for (const d of dirs) {
        const candidate = path.join(projectsRoot, d, `${sessionUuid}.jsonl`);
        try {
          const stat = await fs.stat(candidate);
          res.json({ session_uuid: sessionUuid, file_size: stat.size, last_modified: stat.mtime.toISOString() });
          return;
        } catch { /* keep looking */ }
      }
      res.status(404).json({ error: "transcript not found", session_uuid: sessionUuid });
    } catch {
      res.status(404).json({ error: "projects dir not found" });
    }
  });

  app.get("/sessions/:session_uuid/transcript", async (req, res) => {
    const sessionUuid = decodeURIComponent(req.params.session_uuid!);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 10000);
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
        let diag: string | null = null;
        if (autoEnter) {
          const r = await deps.bridge.prefillAndSubmit(session.session_uuid, prompt, { cwd: session.cwd });
          diag = r.diag;
        } else {
          await deps.bridge.send(session.session_uuid, prompt);
        }
        deps.log?.info({ route: "/send", mode, via, key, cwd: session.cwd, session_uuid: session.session_uuid, project: session.project_name, promptLength: prompt.length, url, diag }, autoEnter ? "URI prefilled + Enter sent to foreground" : "URI prefilled (not submitted)");
        res.status(200).json({ ok: true, mode, url, session_uuid: session.session_uuid, cwd: session.cwd, project: session.project_name, diag });
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

    // FAST PATH: if a `cch claude` wrapper is alive for this session, push
    // through its long-running query() — no spawn, no -p, no resume marker,
    // no extra cost. The wrapper is the host; we just hand it the prompt.
    const wrapConns: Map<string, import("ws").WebSocket> | undefined = (deps as any).__wrapConnections;
    const wrapWs = wrapConns?.get(session.session_uuid);
    if (wrapWs && wrapWs.readyState === wrapWs.OPEN) {
      try {
        wrapWs.send(JSON.stringify({ type: "push", prompt }));
        deps.log?.info({ route: "/send", mode: "wrap-push", session_uuid: session.session_uuid, project: session.project_name, promptLength: prompt.length }, "pushed via wrap WS");
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
        deps.log?.error({ route: "/send", mode: "wrap-push", session_uuid: session.session_uuid, error: String(err) }, "wrap push threw, falling back to -p spawn");
        // fall through to spawn fallback
      }
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
  // IMPORTANT: multiple WebSocketServer instances on the same http.Server fight
  // for the 'upgrade' event — the first one wins and 400's everything else.
  // Workaround: noServer mode + one manual upgrade router below.
  const wss = new WebSocketServer({ noServer: true });

  // Wrap WS endpoint — each `cch claude` wrapper connects here and registers
  // its session. /send for a wrapped session goes through this socket instead
  // of spawning `claude -p`.
  const wrapWss = new WebSocketServer({ noServer: true });
  const wrapConnections = new Map<string, import("ws").WebSocket>(); // uuid → ws
  // Re-broadcast a session's row with the updated `wrapped` flag so dashboard
  // can repaint the badge live. Cheap (one JSON.stringify per client).
  function rebroadcastSession(uuid: string): void {
    const s = deps.store.get(uuid);
    if (!s) return;
    const enriched = { ...s, wrapped: wrapConnections.has(uuid) };
    const msg = JSON.stringify({ type: "session_changed", session: enriched });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg, () => { /* noop */ });
    }
  }

  wrapWss.on("connection", (ws) => {
    let registeredUuid: string | null = null;
    deps.log?.info({ route: "/wrap" }, "wrap client connected");
    function bind(uuid: string): void {
      if (registeredUuid && registeredUuid !== uuid && wrapConnections.get(registeredUuid) === ws) {
        wrapConnections.delete(registeredUuid);
      }
      registeredUuid = uuid;
      wrapConnections.set(uuid, ws);
      rebroadcastSession(uuid);
    }
    ws.on("message", (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.type === "register" && typeof m.session_uuid === "string" && m.session_uuid) {
        bind(m.session_uuid);
        deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid }, "wrap registered");
      } else if (m?.type === "session_uuid" && typeof m.session_uuid === "string" && m.session_uuid) {
        bind(m.session_uuid);
        deps.log?.info({ route: "/wrap", session_uuid: m.session_uuid }, "wrap uuid late-bound");
      }
    });
    ws.on("close", () => {
      const uuid = registeredUuid;
      if (uuid && wrapConnections.get(uuid) === ws) {
        wrapConnections.delete(uuid);
        deps.log?.info({ route: "/wrap", session_uuid: uuid }, "wrap disconnected");
        rebroadcastSession(uuid);
      }
    });
    ws.on("error", () => { /* swallow — close handler does cleanup */ });
  });

  // Expose check for /send to route through wrap when available
  (deps as any).__wrapConnections = wrapConnections;

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
    const enriched = { ...session, wrapped: wrapConnections.has(session.session_uuid ?? "") };
    const msg = JSON.stringify({ type: "session_changed", session: enriched });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(msg, (_err) => { /* client may have raced disconnect; ignore */ });
      }
    }
  });

  return { app, server, registry };
}
