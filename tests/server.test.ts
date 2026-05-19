import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { Notifier } from "../src/notifier.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import type { VersionChecker } from "../src/version-check.js";
import path from "node:path";

const fixturesRoot = path.join(__dirname, "fixtures", "projects");

const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

function buildApp(overrides?: { versionChecker?: VersionChecker }) {
  const store = new SessionStore(":memory:");
  const resolver = new SessionResolver(fixturesRoot);
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  return createApp({ store, handler, bridge, notifier, webDir: "/tmp", log, ...overrides });
}

describe("GET /admin/version-check", () => {
  it("returns 200 with shape", async () => {
    const fakeChecker = {
      get: async () => ({
        current: "0.3.13",
        latest: "0.3.14",
        hasUpdate: true,
        fetchedAt: 1779180000000,
        error: null as null,
      }),
    } as unknown as VersionChecker;

    const { app } = buildApp({ versionChecker: fakeChecker });
    const r = await request(app).get("/admin/version-check");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      current: "0.3.13",
      latest: "0.3.14",
      hasUpdate: true,
      fetchedAt: 1779180000000,
      error: null,
    });
  });
});
