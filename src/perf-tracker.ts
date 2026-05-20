import type { PerfStore } from "./perf-store.js";

interface TurnState {
  promptTs: number | null;
  deltaStartTs: number | null;
  charCount: number;
}

const RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours

export class PerfTracker {
  private turns = new Map<string, TurnState>();

  constructor(private store: PerfStore) {}

  onUserPrompt(sessionUuid: string, ts: number): void {
    this.turns.set(sessionUuid, { promptTs: ts, deltaStartTs: null, charCount: 0 });
  }

  onDeltaStart(sessionUuid: string): void {
    const state = this.turns.get(sessionUuid);
    if (state) {
      state.deltaStartTs = Date.now();
    } else {
      this.turns.set(sessionUuid, { promptTs: null, deltaStartTs: Date.now(), charCount: 0 });
    }
  }

  onDelta(sessionUuid: string, text: string): void {
    const state = this.turns.get(sessionUuid);
    if (state) state.charCount += text.length;
  }

  onDeltaEnd(sessionUuid: string): void {
    const state = this.turns.get(sessionUuid);
    if (!state || state.deltaStartTs === null) return;

    const now = Date.now();
    const duration_ms = now - state.deltaStartTs;
    const ttft_ms = state.promptTs !== null && state.deltaStartTs !== null
      ? state.deltaStartTs - state.promptTs
      : null;
    const tps = duration_ms > 0 ? (state.charCount / duration_ms) * 1000 : null;

    this.store.insert({
      session_uuid: sessionUuid,
      ts: now,
      ttft_ms,
      tps,
      char_count: state.charCount,
      duration_ms,
    });

    // Reset: keep entry but clear timing so next turn starts fresh
    this.turns.set(sessionUuid, { promptTs: null, deltaStartTs: null, charCount: 0 });

    // Rolling cleanup — fire and forget
    this.store.deleteOlderThan(now - RETENTION_MS);
  }
}
