// Minimal in-memory mock of DurableObjectState satisfying what our DO classes use:
// - storage.get/put/delete (Map-backed)
// - storage.setAlarm / getAlarm
// - blockConcurrencyWhile (just runs the callback)
// - id.name
// Tests use this to instantiate DOs directly without workerd.

import type { Env } from "../src/env.js";

export interface MockEnv extends Partial<Env> {}

export function makeMockState(name: string = "test"): DurableObjectState {
  const data = new Map<string, unknown>();
  let alarmAt: number | null = null;

  const storage = {
    async get<T>(key: string): Promise<T | undefined> { return data.get(key) as T | undefined; },
    async put<T>(key: string, value: T): Promise<void> { data.set(key, value); },
    async delete(key: string): Promise<boolean> { return data.delete(key); },
    async list(): Promise<Map<string, unknown>> { return new Map(data); },
    async setAlarm(scheduled: number): Promise<void> { alarmAt = scheduled; },
    async getAlarm(): Promise<number | null> { return alarmAt; },
    async deleteAlarm(): Promise<void> { alarmAt = null; },
  } as unknown as DurableObjectStorage;

  const state = {
    id: { name, toString: () => name },
    storage,
    blockConcurrencyWhile: async <T>(cb: () => Promise<T>): Promise<T> => cb(),
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    getTags: () => [],
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponse: () => null,
  } as unknown as DurableObjectState;

  return state;
}

export function makeMockEnv(): Env {
  // Minimal env — sub-DO stubs not needed for coordinator tests.
  return {
    PAIRING: undefined as any,
    RELAY: undefined as any,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as Env;
}

// ── WebSocket mock helpers ─────────────────────────────────────────────────

export interface FakeWebSocket {
  readyState: number;
  sent: string[];
  closed: { code: number; reason: string } | null;
  attachment: unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  addEventListener(): void;
}

export function makeFakeWs(): FakeWebSocket {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    attachment: undefined,
    send(data: string) { this.sent.push(data); },
    close(code = 1000, reason = "") { this.closed = { code, reason }; this.readyState = 3; },
    serializeAttachment(v: unknown) { this.attachment = v; },
    deserializeAttachment() { return this.attachment; },
    addEventListener() {},
  };
}

/**
 * Augment a DurableObjectState mock with a tagged WS registry that satisfies
 * acceptWebSocket / getWebSockets / getTags.
 */
export function makeMockStateWithWs(name: string = "test"): DurableObjectState & {
  _wsRegistry: Map<FakeWebSocket, string[]>;
} {
  const base = makeMockState(name);
  const registry = new Map<FakeWebSocket, string[]>();

  (base as any).acceptWebSocket = (ws: FakeWebSocket, tags: string[] = []) => {
    registry.set(ws, tags);
  };
  (base as any).getWebSockets = (tag?: string): FakeWebSocket[] => {
    if (!tag) return Array.from(registry.keys());
    return Array.from(registry.entries())
      .filter(([_, tags]) => tags.includes(tag))
      .map(([ws]) => ws);
  };
  (base as any).getTags = (ws: FakeWebSocket): string[] => {
    return registry.get(ws) ?? [];
  };

  (base as any)._wsRegistry = registry;
  return base as any;
}

/** Globally stub WebSocketPair so fetch() can construct one. */
export function stubWebSocketPair(): void {
  (globalThis as any).WebSocketPair = class {
    constructor() {
      const client = makeFakeWs();
      const server = makeFakeWs();
      return { 0: client, 1: server };
    }
  };

  // Node's native Response rejects status 101 (only 200-599 allowed).
  // Wrap it so WS-upgrade responses get status mapped to 101 via the
  // `webSocket` property presence, but actually construct as 200.
  const OriginalResponse = globalThis.Response;
  (globalThis as any).Response = class extends OriginalResponse {
    readonly _status101: boolean;
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const status = init?.status ?? 200;
      const is101 = status === 101;
      super(body, is101 ? { ...init, status: 200 } : init);
      this._status101 = is101;
    }
    get status(): number {
      return this._status101 ? 101 : super.status;
    }
  };
}
