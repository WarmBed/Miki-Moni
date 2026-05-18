import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { Notifier } from "../src/notifier.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import * as wrapProc from "../src/wrap-process.js";

const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

function makeApp() {
  const store = new SessionStore(":memory:");
  const resolver = new SessionResolver("/tmp/nonexistent");
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  return createApp({ store, handler, bridge, notifier, webDir: "/tmp", log });
}

describe("POST /wrap/stop", () => {
  beforeEach(() => {
    vi.spyOn(wrapProc, "killProcessTree").mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns 400 when body has no session_uuid", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/wrap/stop").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_session_uuid");
  });

  it("returns 404 when uuid has no active wrap", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-no-wrap" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_wrap");
  });

  it("kills the wrap process tree and returns 200 when a daemon-spawned wrap is active", async () => {
    const { app } = makeApp();
    const wrapRegistry = (app as any).__wrapProc;
    expect(wrapRegistry, "test harness must expose __wrapProc — see Task 1 step 3").toBeDefined();
    wrapRegistry.recordSpawn({ sessionUuid: "uuid-1", cwd: "/tmp" });
    wrapRegistry.bindPid("uuid-1", 12345);

    const res = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-1" });
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);
    expect(res.body.pid).toBe(12345);
    expect(wrapProc.killProcessTree).toHaveBeenCalledWith(12345, expect.anything());
    expect(wrapRegistry.size()).toBe(0);
  });

  it("double-stop returns 404 on the second call", async () => {
    const { app } = makeApp();
    const wrapRegistry = (app as any).__wrapProc;
    wrapRegistry.recordSpawn({ sessionUuid: "uuid-2", cwd: "/tmp" });
    wrapRegistry.bindPid("uuid-2", 22222);

    const first = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-2" });
    expect(first.status).toBe(200);
    const second = await request(app).post("/wrap/stop").send({ session_uuid: "uuid-2" });
    expect(second.status).toBe(404);
  });
});
