import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import { ExtRegistry } from "../src/ext-registry.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

const fixturesRoot = path.join(__dirname, "fixtures", "projects");

describe("server POST /event", () => {
  let store: SessionStore;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({ store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none" }));
  });
  afterEach(() => store.close());

  it("ingests a session_start event", async () => {
    const res = await request(app).post("/event").send({
      event_type: "session_start",
      cwd: "d:\\code\\dragonfly",
      session_uuid: "u-1",
      timestamp: Date.now(),
    });
    expect(res.status).toBe(204);
    expect(store.get("u-1")?.status).toBe("active");
    expect(store.get("u-1")?.agent).toBe("claude");
    expect(store.get("u-1")?.cwd).toBe("d:\\code\\dragonfly");
  });

  it("ingests a Codex event with agent metadata", async () => {
    const res = await request(app).post("/event").send({
      event_type: "user_prompt",
      agent: "codex",
      cwd: "d:\\code\\cc-hub",
      session_uuid: "u-codex",
      timestamp: Date.now(),
    });
    expect(res.status).toBe(204);
    expect(store.get("u-codex")?.agent).toBe("codex");
  });

  it("rejects malformed payload with 400", async () => {
    const res = await request(app).post("/event").send({ garbage: true });
    expect(res.status).toBe(400);
  });
});

describe("server GET /sessions", () => {
  let store: SessionStore;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({ store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none" }));
  });
  afterEach(() => store.close());

  it("returns empty array initially", async () => {
    const res = await request(app).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns all sessions after events", async () => {
    await request(app).post("/event").send({
      event_type: "session_start", cwd: "d:\\code\\a", session_uuid: "u1", timestamp: 1,
    });
    await request(app).post("/event").send({
      event_type: "session_start", cwd: "d:\\code\\b", session_uuid: "u2", timestamp: 2,
    });
    const res = await request(app).get("/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("server POST /wrap/start agent selection", () => {
  let store: SessionStore;
  let app: ReturnType<typeof createApp>["app"];
  let tmpDir: string;
  let spawned: string[][];

  beforeEach(async () => {
    store = new SessionStore(":memory:");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "miki-wrap-start-"));
    spawned = [];
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({
      store,
      handler,
      bridge: null as any,
      notifier: null as any,
      webDir: "/tmp/none",
      terminalSpawner: (args) => {
        spawned.push(args);
        return { on: () => undefined, unref: () => undefined };
      },
    }));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("fresh Claude defaults to managed miki claude --fresh", async () => {
    const res = await request(app).post("/wrap/start").send({ cwd: tmpDir });

    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("claude");
    expect(res.body.managed_wrap).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("new-tab");
    expect(spawned[0]).toContain(tmpDir);
    expect(spawned[0]).toContain("claude");
    expect(spawned[0]).toContain("--fresh");
  });

  it("fresh Codex opens unmanaged codex terminal", async () => {
    const res = await request(app).post("/wrap/start").send({ cwd: tmpDir, agent: "codex" });

    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("codex");
    expect(res.body.managed_wrap).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(["-w", "new", "new-tab", "-d", tmpDir, "--", "cmd.exe", "/d", "/k", "codex"]);
    const pending = store.list().find((s) => s.agent === "codex");
    expect(pending?.session_uuid).toMatch(/^codex-pending:/);
    expect(pending?.status).toBe("active");
    expect(pending?.cwd.toLowerCase()).toBe(tmpDir.toLowerCase());
    expect(res.body.session_uuid).toBe(pending?.session_uuid);
  });

  it("fresh Codex creates a new pending card for each launch in the same cwd", async () => {
    const first = await request(app).post("/wrap/start").send({ cwd: tmpDir, agent: "codex" });
    const second = await request(app).post("/wrap/start").send({ cwd: tmpDir, agent: "codex" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.session_uuid).not.toBe(second.body.session_uuid);
    const pending = store.list().filter((s) => s.agent === "codex" && s.cwd.toLowerCase() === tmpDir.toLowerCase());
    expect(pending).toHaveLength(2);
    expect(pending.map((s) => s.session_uuid)).toEqual(expect.arrayContaining([first.body.session_uuid, second.body.session_uuid]));
  });

  it("pending Codex row sends via codex exec", async () => {
    const codexCalls: any[] = [];
    store.close();
    store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({
      store,
      handler,
      bridge: null as any,
      notifier: null as any,
      webDir: "/tmp/none",
      terminalSpawner: (args) => {
        spawned.push(args);
        return { on: () => undefined, unref: () => undefined };
      },
      codexRunner: async (opts) => {
        codexCalls.push(opts);
        return { reply: "pending-ok", durationMs: 34 };
      },
    }));

    await request(app).post("/wrap/start").send({ cwd: tmpDir, agent: "codex" });
    const pending = store.list().find((s) => s.agent === "codex");
    const res = await request(app).post("/send").send({ session_uuid: pending?.session_uuid, prompt: "hello pending" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("codex-exec");
    expect(res.body.reply).toBe("pending-ok");
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]).toMatchObject({ sessionUuid: pending?.session_uuid, cwd: pending?.cwd, prompt: "hello pending" });
    expect(store.get(pending!.session_uuid!)?.status).toBe("active");
    expect(store.get(pending!.session_uuid!)?.last_message_preview).toBe("pending-ok");
  });

  it("pending Codex row sends images via codex exec", async () => {
    const codexCalls: any[] = [];
    store.close();
    store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    ({ app } = createApp({
      store,
      handler,
      bridge: null as any,
      notifier: null as any,
      webDir: "/tmp/none",
      terminalSpawner: (args) => {
        spawned.push(args);
        return { on: () => undefined, unref: () => undefined };
      },
      codexRunner: async (opts) => {
        codexCalls.push(opts);
        return { reply: "image-ok", durationMs: 45 };
      },
    }));

    await request(app).post("/wrap/start").send({ cwd: tmpDir, agent: "codex" });
    const pending = store.list().find((s) => s.agent === "codex");
    const images = [{ media_type: "image/png", data: Buffer.from("png").toString("base64") }];
    const res = await request(app).post("/send").send({ session_uuid: pending?.session_uuid, prompt: "describe this", images });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("codex-exec");
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]).toMatchObject({ sessionUuid: pending?.session_uuid, cwd: pending?.cwd, prompt: "describe this", images });
  });

  it("rejects invalid agent", async () => {
    const res = await request(app).post("/wrap/start").send({ cwd: tmpDir, agent: "gpt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_agent");
    expect(spawned).toHaveLength(0);
  });
});

describe("server WS /ws", () => {
  it("broadcasts session_changed to connected clients", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app, server } = createApp({ store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: any[] = [];
    ws.on("message", (m) => received.push(JSON.parse(m.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));

    await request(app).post("/event").send({
      event_type: "session_start", cwd: "d:\\code\\x", session_uuid: "u", timestamp: 1,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received.some((m) => m.type === "session_changed" && m.session?.cwd === "d:\\code\\x")).toBe(true);

    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});

describe("server POST /focus + /send", () => {
  it("focus calls bridge.focus with session_uuid from store", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\x", session_uuid: "uuid-xyz", agent: "claude", project_name: "x",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/focus").send({ cwd: "d:\\code\\x" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toBe("vscode://anthropic.claude-code/open?session=uuid-xyz");
    expect(launches).toContain("vscode://anthropic.claude-code/open?session=uuid-xyz");
    store.close();
  });

  it("send calls bridge.send with encoded prompt", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\x", session_uuid: "uuid-xyz", agent: "claude", project_name: "x",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    // auto_enter:false → bare prefill path (vscode-bridge.send) so we can assert on launches[]
    const res = await request(app).post("/send").send({ cwd: "d:\\code\\x", prompt: "run tests", auto_enter: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toMatch(/session=uuid-xyz/);
    expect(res.body.url).toMatch(/prompt=run\+tests|prompt=run%20tests/);
    expect(launches[0]).toMatch(/session=uuid-xyz/);
    expect(launches[0]).toMatch(/prompt=run\+tests|prompt=run%20tests/);
    store.close();
  });

  it("focus returns 404 for unknown cwd", async () => {
    const store = new SessionStore(":memory:");
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/focus").send({ cwd: "d:\\code\\nope" });
    expect(res.status).toBe(404);
    store.close();
  });
});

describe("daemon /ws_ext extension registry", () => {
  it("accepts ws connection, processes register, adds to registry", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none",
    }) as any;  // registry is a new exported property — Task 7 adds it
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({
      type: "register", workspace_root: "d:/code", helper_version: "0.1.0",
    }));
    // Give server a tick to process
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].info.workspace_root).toBe("d:/code");

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.list()).toHaveLength(0);

    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("ignores non-register messages on a not-yet-registered ws (graceful)", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none",
    }) as any;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "submit_ack", request_id: "x", ok: true }));
    await new Promise((r) => setTimeout(r, 50));

    // Server should not crash, registry should remain empty
    expect(registry.list()).toHaveLength(0);

    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("does not route Codex focus through Claude bridge paths and sends via codex exec", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\cc-hub", session_uuid: "uuid-codex", agent: "codex", project_name: "cc-hub",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const launches: string[] = [];
    const bridge = new VscodeBridge(async (url) => { launches.push(url); });
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const codexCalls: any[] = [];
    const { app } = createApp({
      store,
      handler,
      bridge,
      notifier: null as any,
      webDir: "/tmp/none",
      codexRunner: async (opts) => {
        codexCalls.push(opts);
        return { reply: "codex-send-ok", durationMs: 12 };
      },
    });

    const focus = await request(app).post("/focus").send({ session_uuid: "uuid-codex" });
    expect(focus.status).toBe(501);
    expect(focus.body.error).toBe("codex_focus_unsupported");

    const send = await request(app).post("/send").send({ session_uuid: "uuid-codex", prompt: "hello", auto_enter: false });
    expect(send.status).toBe(200);
    expect(send.body.mode).toBe("codex-exec");
    expect(send.body.reply).toBe("codex-send-ok");
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]).toMatchObject({ sessionUuid: "uuid-codex", cwd: "d:\\code\\cc-hub", prompt: "hello" });
    expect(launches).toEqual([]);
    store.close();
  });

  it("interrupts an in-flight Codex exec", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\cc-hub", session_uuid: "uuid-codex", agent: "codex", project_name: "cc-hub",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const { app } = createApp({
      store,
      handler,
      bridge: null as any,
      notifier: null as any,
      webDir: "/tmp/none",
      codexRunner: async (opts) => {
        started();
        return await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });

    const sendPromise = request(app).post("/send").send({ session_uuid: "uuid-codex", prompt: "long task" }).then((r) => r);
    await startedPromise;
    const interrupt = await request(app).post("/wrap/interrupt").send({ session_uuid: "uuid-codex" });
    const send = await sendPromise;

    expect(interrupt.status).toBe(200);
    expect(interrupt.body.mode).toBe("codex-exec");
    expect(send.status).toBe(499);
    expect(send.body.interrupted).toBe(true);
    store.close();
  });

  it("does not start a Claude wrapper for a Codex session", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\cc-hub", session_uuid: "uuid-codex", agent: "codex", project_name: "cc-hub",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/wrap/start").send({ session_uuid: "uuid-codex" });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("codex_wrap_unsupported");
    store.close();
  });
});

describe("daemon /ws_ext heartbeat", () => {
  it("drops connection when no pong arrives within timeout", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    // Fast intervals for tests: pingMs=50, pongTimeoutMs=30
    const { server, registry } = createApp({
      store, handler, bridge: null as any, notifier: null as any, webDir: "/tmp/none",
      heartbeat: { pingMs: 50, pongTimeoutMs: 30 },
    } as any);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    // Connect a deliberately-silent client (never responds to ping)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(registry.list()).toHaveLength(1);

    // Wait: 50ms ping fires, 30ms pong timeout → connection dropped by daemon
    await new Promise((r) => setTimeout(r, 200));
    expect(registry.list()).toHaveLength(0);

    ws.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});

describe("VscodeBridge.submitViaHelper", () => {
  it("sends submit message over ws and resolves on matching submit_ack", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: new VscodeBridge(async () => {}), notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    // Fake extension connects, registers, echoes a successful ack for any submit
    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: true, diag: "test-ok",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "uuid-1", prompt: "hi", cwd: "d:/code", registry, timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: true, diag: "test-ok" });

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("returns {ok:false} when no extension registered for cwd", async () => {
    const registry = new ExtRegistry();
    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "u", prompt: "p", cwd: "d:/code", registry, timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no miki-helper.*registered/i);
  });

  it("returns {ok:false} after timeoutMs when extension doesn't ack", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: new VscodeBridge(async () => {}), notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    // Deliberately don't ack
    await new Promise((r) => setTimeout(r, 50));

    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "u", prompt: "p", cwd: "d:/code", registry, timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("propagates {ok:false, error} from submit_ack to caller", async () => {
    const store = new SessionStore(":memory:");
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { server, registry } = createApp({
      store, handler, bridge: new VscodeBridge(async () => {}), notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: false, error: "URI dispatch refused", diag: "x",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const bridge = new VscodeBridge(async () => {});
    const result = await bridge.submitViaHelper({
      sessionUuid: "u", prompt: "p", cwd: "d:/code", registry, timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, error: "URI dispatch refused", diag: "x" });

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});

describe("server POST /send routing (helper path)", () => {
  it("returns 503 with helpful message when no helper registered for cwd", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code\\xianyu-assistant", session_uuid: "uuid-y", agent: "claude", project_name: "xianyu",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app } = createApp({ store, handler, bridge, notifier: null as any, webDir: "/tmp/none" });

    const res = await request(app).post("/send").send({
      session_uuid: "uuid-y", prompt: "hi",  // auto_enter:true (default), submit:false (default)
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/no miki-helper.*registered/i);
    expect(res.body.error).toMatch(/install the VSIX/i);
    store.close();
  });

  it("returns 200 with ok=true when helper acks success", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code", session_uuid: "uuid-z", agent: "claude", project_name: "code",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app, server, registry } = createApp({
      store, handler, bridge, notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: true, diag: "all-good",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(app).post("/send").send({ session_uuid: "uuid-z", prompt: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe("helper");
    expect(res.body.diag).toBe("all-good");

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  it("returns 200 with ok=false when helper acks error (propagates message)", async () => {
    const store = new SessionStore(":memory:");
    store.upsert({
      cwd: "d:\\code", session_uuid: "uuid-w", agent: "claude", project_name: "code",
      status: "waiting", last_event_at: 1, last_message_preview: "",
      tokens_in: 0, tokens_out: 0, vscode_pid: null,
    });
    const bridge = new VscodeBridge(async () => {});
    const handler = new HookHandler(store, new SessionResolver(fixturesRoot));
    const { app, server } = createApp({
      store, handler, bridge, notifier: null as any, webDir: "/tmp/none",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const extWs = new WebSocket(`ws://127.0.0.1:${port}/ws_ext`);
    await new Promise<void>((r) => extWs.on("open", () => r()));
    extWs.send(JSON.stringify({ type: "register", workspace_root: "d:/code", helper_version: "test" }));
    extWs.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "submit") {
        extWs.send(JSON.stringify({
          type: "submit_ack", request_id: m.request_id, ok: false, error: "claude-vscode.focus not found",
        }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await request(app).post("/send").send({ session_uuid: "uuid-w", prompt: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/claude-vscode.focus not found/);

    extWs.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});
