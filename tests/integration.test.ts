import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import path from "node:path";

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
    expect(store.get("u-1")?.cwd).toBe("d:\\code\\dragonfly");
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
      cwd: "d:\\code\\x", session_uuid: "uuid-xyz", project_name: "x",
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
      cwd: "d:\\code\\x", session_uuid: "uuid-xyz", project_name: "x",
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
});
