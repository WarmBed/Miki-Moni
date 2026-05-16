import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsClient, type WsClientOptions } from "../src/ws-client.js";
import type { ExtMessage, DaemonMessage } from "../src/protocol.js";

// Fake WebSocket factory — captures sent messages, allows test to drive
// open/message/close events from outside.
class FakeWs {
  static instances: FakeWs[] = [];
  sent: string[] = [];
  listeners: Record<string, ((arg?: any) => void)[]> = {};
  readyState = 0;  // CONNECTING
  static OPEN = 1; static CLOSED = 3;
  constructor(public url: string) { FakeWs.instances.push(this); }
  on(ev: string, fn: (arg?: any) => void) { (this.listeners[ev] ??= []).push(fn); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = FakeWs.CLOSED; this.fire("close"); }
  // Drive from tests
  fire(ev: string, arg?: any) { (this.listeners[ev] ?? []).forEach((f) => f(arg)); }
  simulateOpen() { this.readyState = FakeWs.OPEN; this.fire("open"); }
  simulateServerMessage(msg: DaemonMessage) { this.fire("message", JSON.stringify(msg)); }
}

function makeOpts(overrides: Partial<WsClientOptions> = {}): WsClientOptions {
  return {
    url: "ws://test/ws_ext",
    registerInfo: () => ({ workspace_root: "d:/code", helper_version: "0.1.0" }),
    onSubmit: vi.fn().mockResolvedValue({
      type: "submit_ack", request_id: "stub", ok: true,
    }),
    WebSocketCtor: FakeWs as any,
    backoffMs: () => 10,   // fast for tests
    ...overrides,
  };
}

beforeEach(() => { FakeWs.instances.length = 0; });

describe("WsClient", () => {
  it("creates a WebSocket pointed at the configured URL on start()", () => {
    const c = new WsClient(makeOpts());
    c.start();
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0]!.url).toBe("ws://test/ws_ext");
    c.stop();
  });

  it("sends register message immediately on open", () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    expect(FakeWs.instances[0]!.sent).toHaveLength(1);
    const msg = JSON.parse(FakeWs.instances[0]!.sent[0]!) as ExtMessage;
    expect(msg).toEqual({
      type: "register", workspace_root: "d:/code", helper_version: "0.1.0",
    });
    c.stop();
  });

  it("dispatches incoming submit message to onSubmit and sends ack back", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      type: "submit_ack", request_id: "r1", ok: true, diag: "ok",
    });
    const c = new WsClient(makeOpts({ onSubmit }));
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.simulateServerMessage({
      type: "submit", request_id: "r1", session_uuid: "u", prompt: "p",
    });
    // Yield so async ack send completes
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).toHaveBeenCalledWith({
      type: "submit", request_id: "r1", session_uuid: "u", prompt: "p",
    });
    // sent[0] = register, sent[1] = submit_ack
    const ack = JSON.parse(FakeWs.instances[0]!.sent[1]!) as ExtMessage;
    expect(ack).toMatchObject({ type: "submit_ack", request_id: "r1", ok: true });
    c.stop();
  });

  it("responds to ping with pong (same request_id)", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.simulateServerMessage({ type: "ping", request_id: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    // sent[0] = register, sent[1] = pong
    expect(JSON.parse(FakeWs.instances[0]!.sent[1]!)).toEqual({ type: "pong", request_id: "p1" });
    c.stop();
  });

  it("reconnects on close (calls WebSocketCtor again)", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    expect(FakeWs.instances).toHaveLength(1);
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 20)); // wait > backoffMs (10ms)
    expect(FakeWs.instances).toHaveLength(2);
    c.stop();
  });

  it("re-sends register after reconnect", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 20));
    FakeWs.instances[1]!.simulateOpen();
    const msg = JSON.parse(FakeWs.instances[1]!.sent[0]!);
    expect(msg.type).toBe("register");
    c.stop();
  });

  it("stop() prevents further reconnects", async () => {
    const c = new WsClient(makeOpts());
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    c.stop();
    FakeWs.instances[0]!.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWs.instances).toHaveLength(1);  // no new instance
  });

  it("ignores malformed JSON messages without crashing", async () => {
    const onSubmit = vi.fn();
    const c = new WsClient(makeOpts({ onSubmit }));
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.fire("message", "not-valid-json{");
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).not.toHaveBeenCalled();
    c.stop();
  });

  it("serializes parallel submit messages (one runs at a time, in arrival order)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const onSubmit = vi.fn(async (req: any) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      order.push(`start:${req.request_id}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${req.request_id}`);
      inFlight--;
      return { type: "submit_ack", request_id: req.request_id, ok: true };
    });

    const c = new WsClient(makeOpts({ onSubmit }));
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    // Fire 3 submits back-to-back; the client must NOT run them in parallel.
    FakeWs.instances[0]!.simulateServerMessage({ type: "submit", request_id: "a", session_uuid: "u", prompt: "p1" });
    FakeWs.instances[0]!.simulateServerMessage({ type: "submit", request_id: "b", session_uuid: "u", prompt: "p2" });
    FakeWs.instances[0]!.simulateServerMessage({ type: "submit", request_id: "c", session_uuid: "u", prompt: "p3" });
    await new Promise((r) => setTimeout(r, 150));

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([
      "start:a", "end:a", "start:b", "end:b", "start:c", "end:c",
    ]);
    c.stop();
  });

  it("keeps the submit chain alive even when onSubmit rejects", async () => {
    let calls = 0;
    const onSubmit = vi.fn(async (req: any) => {
      calls++;
      if (calls === 1) throw new Error("first one fails");
      return { type: "submit_ack", request_id: req.request_id, ok: true };
    });

    const c = new WsClient(makeOpts({ onSubmit }));
    c.start();
    FakeWs.instances[0]!.simulateOpen();
    FakeWs.instances[0]!.simulateServerMessage({ type: "submit", request_id: "a", session_uuid: "u", prompt: "p1" });
    FakeWs.instances[0]!.simulateServerMessage({ type: "submit", request_id: "b", session_uuid: "u", prompt: "p2" });
    await new Promise((r) => setTimeout(r, 50));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    // Second submit's ack should still have been sent (chain didn't deadlock).
    const sentAcks = FakeWs.instances[0]!.sent
      .map((s) => JSON.parse(s))
      .filter((m: any) => m.type === "submit_ack");
    expect(sentAcks.find((a: any) => a.request_id === "b")?.ok).toBe(true);
    c.stop();
  });
});
