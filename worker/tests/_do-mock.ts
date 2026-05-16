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
