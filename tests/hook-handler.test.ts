import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import type { HookEvent } from "../src/types.js";

class StubResolver {
  resolveLatest = vi.fn(async (_cwd: string) => "stub-uuid-1234");
}

describe("HookHandler", () => {
  let store: SessionStore;
  let resolver: StubResolver;
  let handler: HookHandler;

  beforeEach(() => {
    store = new SessionStore(":memory:");
    resolver = new StubResolver();
    handler = new HookHandler(store, resolver as any);
  });

  it("session_start → status=active, project_name from path basename", async () => {
    const ev: HookEvent = {
      event_type: "session_start",
      cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123",
      timestamp: 1715760000000,
    };
    await handler.handle(ev);
    const s = store.get("d:\\code\\dragonfly");
    expect(s?.status).toBe("active");
    expect(s?.project_name).toBe("dragonfly");
    expect(s?.session_uuid).toBe("abc-123");
  });

  it("stop → status=waiting", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123", timestamp: 1000,
    });
    await handler.handle({
      event_type: "stop", cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123", timestamp: 2000,
    });
    expect(store.get("d:\\code\\dragonfly")?.status).toBe("waiting");
  });

  it("user_prompt → status=active (user came back)", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 1,
    });
    await handler.handle({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 2,
    });
    await handler.handle({
      event_type: "user_prompt", cwd: "x", session_uuid: "u1", timestamp: 3,
    });
    expect(store.get("x")?.status).toBe("active");
  });

  it("backfills session_uuid via resolver when event omits it", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x",
      session_uuid: null, timestamp: 1,
    });
    // resolver is async fire-and-forget; await microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(resolver.resolveLatest).toHaveBeenCalledWith("x");
    expect(store.get("x")?.session_uuid).toBe("stub-uuid-1234");
  });

  it("last-write-wins by timestamp (older event ignored)", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 100,
    });
    await handler.handle({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 50,  // older
    });
    expect(store.get("x")?.status).toBe("active");
  });

  it("project_name uses basename of cwd (handles Windows backslash)", async () => {
    await handler.handle({
      event_type: "session_start",
      cwd: "C:\\Users\\mike\\proj-x",
      session_uuid: "u1", timestamp: 1,
    });
    expect(store.get("C:\\Users\\mike\\proj-x")?.project_name).toBe("proj-x");
  });
});
