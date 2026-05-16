import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { Notifier } from "../src/notifier.js";
import type { HookEvent } from "../src/types.js";

class StubResolver {
  resolveLatest = vi.fn<(cwd: string) => Promise<string | null>>(async (_cwd: string) => "stub-uuid-1234");
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
    const s = store.get("abc-123");
    expect(s?.status).toBe("active");
    expect(s?.project_name).toBe("dragonfly");
    expect(s?.session_uuid).toBe("abc-123");
    expect(s?.cwd).toBe("d:\\code\\dragonfly");
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
    expect(store.get("abc-123")?.status).toBe("waiting");
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
    expect(store.get("u1")?.status).toBe("active");
  });

  it("resolves session_uuid via resolver when event omits it", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x",
      session_uuid: null, timestamp: 1,
    });
    expect(resolver.resolveLatest).toHaveBeenCalledWith("x");
    expect(store.get("stub-uuid-1234")?.session_uuid).toBe("stub-uuid-1234");
  });

  it("drops event silently when session_uuid is null AND resolver returns null", async () => {
    resolver.resolveLatest.mockResolvedValueOnce(null);
    await handler.handle({
      event_type: "session_start", cwd: "x",
      session_uuid: null, timestamp: 1,
    });
    expect(store.list()).toHaveLength(0);
  });

  it("multiple sessions in the same cwd create multiple rows", async () => {
    await handler.handle({ event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 1 });
    await handler.handle({ event_type: "session_start", cwd: "x", session_uuid: "u2", timestamp: 2 });
    await handler.handle({ event_type: "session_start", cwd: "x", session_uuid: "u3", timestamp: 3 });
    expect(store.list()).toHaveLength(3);
    expect(store.getByCwd("x")).toHaveLength(3);
  });

  it("last-write-wins by timestamp (older event ignored)", async () => {
    await handler.handle({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 100,
    });
    await handler.handle({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 50,  // older
    });
    expect(store.get("u1")?.status).toBe("active");
  });

  it("project_name uses basename of cwd; normalizes drive letter and slashes", async () => {
    await handler.handle({
      event_type: "session_start",
      cwd: "C:\\Users\\mike\\proj-x",
      session_uuid: "u1", timestamp: 1,
    });
    // Stored cwd is normalized to lowercase drive
    expect(store.get("u1")?.project_name).toBe("proj-x");
    expect(store.get("u1")?.cwd).toBe("c:\\Users\\mike\\proj-x");
    // Same path with forward slashes for the SAME session updates same row (not a new one)
    await handler.handle({
      event_type: "user_prompt",
      cwd: "C:/Users/mike/proj-x",
      session_uuid: "u1", timestamp: 2,
    });
    expect(store.list()).toHaveLength(1);
  });
});

describe("HookHandler + Notifier", () => {
  it("notifies when session transitions to waiting", async () => {
    const store = new SessionStore(":memory:");
    const resolver = new StubResolver();
    const sends: any[] = [];
    const notifier = new Notifier((opts) => sends.push(opts));
    const handler = new HookHandler(store, resolver as any, notifier);

    await handler.handle({ event_type: "session_start", cwd: "x", session_uuid: "u-x", timestamp: 1 });
    expect(sends).toHaveLength(0);

    // Separate session (different uuid) starts in waiting status — should notify
    await handler.handle({ event_type: "stop", cwd: "d:\\code\\dragonfly", session_uuid: "u-dragon", timestamp: 2 });
    expect(sends).toHaveLength(1);
    expect(sends[0].title).toContain("dragonfly");
  });

  it("does NOT notify if already waiting (no transition)", async () => {
    const store = new SessionStore(":memory:");
    const resolver = new StubResolver();
    const sends: any[] = [];
    const notifier = new Notifier((opts) => sends.push(opts));
    const handler = new HookHandler(store, resolver as any, notifier);

    await handler.handle({ event_type: "stop", cwd: "x", session_uuid: "u", timestamp: 1 });
    await handler.handle({ event_type: "stop", cwd: "x", session_uuid: "u", timestamp: 2 });
    expect(sends).toHaveLength(1);
  });
});
