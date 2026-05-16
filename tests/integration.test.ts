import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
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
