import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { Notifier } from "../src/notifier.js";
import type { HookEvent } from "../src/types.js";

/** Shorthand: create a HookEvent with agent defaulted to "claude". */
function ev(partial: Omit<HookEvent, "agent"> & Partial<Pick<HookEvent, "agent">>): HookEvent {
  return { agent: "claude", ...partial };
}

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
    await handler.handle(ev({
      event_type: "session_start",
      cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123",
      timestamp: 1715760000000,
    }));
    const s = store.get("abc-123");
    expect(s?.status).toBe("active");
    expect(s?.project_name).toBe("dragonfly");
    expect(s?.session_uuid).toBe("abc-123");
    expect(s?.cwd).toBe("d:\\code\\dragonfly");
  });

  it("stop → status=waiting", async () => {
    await handler.handle(ev({
      event_type: "session_start", cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123", timestamp: 1000,
    }));
    await handler.handle(ev({
      event_type: "stop", cwd: "d:\\code\\dragonfly",
      session_uuid: "abc-123", timestamp: 2000,
    }));
    expect(store.get("abc-123")?.status).toBe("waiting");
  });

  it("user_prompt → status=active (user came back)", async () => {
    await handler.handle(ev({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 1,
    }));
    await handler.handle(ev({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 2,
    }));
    await handler.handle(ev({
      event_type: "user_prompt", cwd: "x", session_uuid: "u1", timestamp: 3,
    }));
    expect(store.get("u1")?.status).toBe("active");
  });

  it("resolves session_uuid via resolver when event omits it", async () => {
    await handler.handle(ev({
      event_type: "session_start", cwd: "x",
      session_uuid: null, timestamp: 1,
    }));
    expect(resolver.resolveLatest).toHaveBeenCalledWith("x");
    expect(store.get("stub-uuid-1234")?.session_uuid).toBe("stub-uuid-1234");
  });

  it("drops event silently when session_uuid is null AND resolver returns null", async () => {
    resolver.resolveLatest.mockResolvedValueOnce(null);
    await handler.handle(ev({
      event_type: "session_start", cwd: "x",
      session_uuid: null, timestamp: 1,
    }));
    expect(store.list()).toHaveLength(0);
  });

  it("multiple sessions in the same cwd create multiple rows", async () => {
    await handler.handle(ev({ event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 1 }));
    await handler.handle(ev({ event_type: "session_start", cwd: "x", session_uuid: "u2", timestamp: 2 }));
    await handler.handle(ev({ event_type: "session_start", cwd: "x", session_uuid: "u3", timestamp: 3 }));
    expect(store.list()).toHaveLength(3);
    expect(store.getByCwd("x")).toHaveLength(3);
  });

  it("last-write-wins by timestamp (older event ignored)", async () => {
    await handler.handle(ev({
      event_type: "session_start", cwd: "x", session_uuid: "u1", timestamp: 100,
    }));
    await handler.handle(ev({
      event_type: "stop", cwd: "x", session_uuid: "u1", timestamp: 50,  // older
    }));
    expect(store.get("u1")?.status).toBe("active");
  });

  it("cwd is immutable after first set — subsequent hook events don't overwrite", async () => {
    // Bug repro: agent at session_start in d:\code cd's into d:\code\cc-hub,
    // later hooks fire with the new cwd. DB.cwd used to flip to the
    // subdirectory, but the SDK's projects-dir encoding is keyed on the
    // ORIGINAL cwd. /wrap/start would then look in the wrong projects
    // folder → "No conversation found with session ID" crash.
    await handler.handle(ev({
      event_type: "session_start", cwd: "d:\\code", session_uuid: "u-shift", timestamp: 1,
    }));
    expect(store.get("u-shift")?.cwd).toBe("d:\\code");
    expect(store.get("u-shift")?.project_name).toBe("code");
    // Subsequent event from a subdirectory should NOT overwrite cwd.
    await handler.handle(ev({
      event_type: "pre_tool_use", cwd: "d:\\code\\cc-hub", session_uuid: "u-shift", timestamp: 2,
    }));
    expect(store.get("u-shift")?.cwd).toBe("d:\\code");
    expect(store.get("u-shift")?.project_name).toBe("code");
    // Status / last_event_at DO update normally.
    expect(store.get("u-shift")?.status).toBe("active");
    expect(store.get("u-shift")?.last_event_at).toBe(2);
  });

  it("project_name uses basename of cwd; normalizes drive letter and slashes", async () => {
    await handler.handle(ev({
      event_type: "session_start",
      cwd: "C:\\Users\\mike\\proj-x",
      session_uuid: "u1", timestamp: 1,
    }));
    // Stored cwd is normalized to lowercase drive
    expect(store.get("u1")?.project_name).toBe("proj-x");
    expect(store.get("u1")?.cwd).toBe("c:\\Users\\mike\\proj-x");
    // Same path with forward slashes for the SAME session updates same row (not a new one)
    await handler.handle(ev({
      event_type: "user_prompt",
      cwd: "C:/Users/mike/proj-x",
      session_uuid: "u1", timestamp: 2,
    }));
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

    await handler.handle(ev({ event_type: "session_start", cwd: "x", session_uuid: "u-x", timestamp: 1 }));
    expect(sends).toHaveLength(0);

    // Separate session (different uuid) starts in waiting status — should notify
    await handler.handle(ev({ event_type: "stop", cwd: "d:\\code\\dragonfly", session_uuid: "u-dragon", timestamp: 2 }));
    expect(sends).toHaveLength(1);
    expect(sends[0].title).toContain("dragonfly");
  });

  it("does NOT notify if already waiting (no transition)", async () => {
    const store = new SessionStore(":memory:");
    const resolver = new StubResolver();
    const sends: any[] = [];
    const notifier = new Notifier((opts) => sends.push(opts));
    const handler = new HookHandler(store, resolver as any, notifier);

    await handler.handle(ev({ event_type: "stop", cwd: "x", session_uuid: "u", timestamp: 1 }));
    await handler.handle(ev({ event_type: "stop", cwd: "x", session_uuid: "u", timestamp: 2 }));
    expect(sends).toHaveLength(1);
  });
});
