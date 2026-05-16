import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
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
    expect(store.get("d:\\code\\dragonfly")?.status).toBe("active");
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
