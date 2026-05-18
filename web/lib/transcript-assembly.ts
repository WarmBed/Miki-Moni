/**
 * Pure render-time assembly: take canonical baseTurns from the JSONL plus the
 * optional optimistic user overlay (WS user_message) and assistant streaming
 * buffer (WS assistant_delta_*), produce a final ordered turn list for
 * <SingleColumnTranscript>.
 *
 * Why this exists as a standalone module:
 *
 * The naive implementation (`baseTurns.concat(extras)`) appended overlays at
 * the END regardless of their ts. That fell over when JSONL writes were
 * interleaved or when /sessions/previews polling lagged. Concrete failure:
 *
 *   user types at 15:34:26   → user_message WS  → userOverlay set
 *   claude replies at 15:34:49 → JSONL gets the assistant turn
 *   transcript fetch returns  → baseTurns includes claude_34:49
 *   /sessions/previews hasn't refreshed → userOverlay still alive
 *   render: [claude_32, claude_33, claude_34:49, user_34:26]   ← visually backwards
 *
 * Fix: stable-sort the merged list by ts ascending. Stable sort preserves
 * within-entry block order from readTranscriptTail (same ts, multiple
 * tool_use / text blocks).
 */

export type TranscriptTurnLike = {
  ts: string;
  role: "user" | "assistant" | "system";
  text: string;
  tool_use?: unknown;
  tool_result?: unknown;
  raw_type?: string;
};

export type UserOverlayInput = { text: string; ts: number } | undefined;
export type StreamingInput = { text: string; startTs: number } | undefined;
// Activity from the wrap session ("Ideating" / "Using Bash" / "Replying" / null).
// When the wrapper has a live activity AND no streaming text has arrived yet
// AND claude hasn't replied to the latest user message, we synthesise a
// "thinking" bubble so the user gets a blinking-cursor cue immediately on
// send (instead of staring at a static transcript while the SDK churns).
export type ActivityInput = string | null | undefined;

function tsMs(t: { ts: string }): number {
  const n = Date.parse(t.ts);
  return Number.isFinite(n) ? n : 0;
}

export function assembleRenderTurns<T extends TranscriptTurnLike>(
  baseTurns: T[],
  userOverlay: UserOverlayInput,
  streaming: StreamingInput,
  activity?: ActivityInput,
): T[] {
  const extras: TranscriptTurnLike[] = [];

  // Optimistic user overlay: only show when the latest canonical user turn
  // we have is older than the overlay's ts. Once JSONL catches up, this
  // suppresses itself; the polling loop in loadPreviews also drops it from
  // state. tool_result blocks carry role:"user" too — skip them, they're
  // not human input.
  if (userOverlay && userOverlay.text) {
    let latestUserTs = 0;
    for (const tn of baseTurns) {
      if (tn.role !== "user" || tn.tool_result) continue;
      const t = tsMs(tn);
      if (t > latestUserTs) latestUserTs = t;
    }
    if (latestUserTs < userOverlay.ts) {
      extras.push({
        ts: new Date(userOverlay.ts).toISOString(),
        role: "user",
        text: userOverlay.text,
        raw_type: "synthetic-user-overlay",
      });
    }
  }

  // Streaming assistant buffer: kept alive past assistant_delta_end to bridge
  // the gap until canonical JSONL lands. Stamped with the stream's startTs
  // so a chronological sort places it correctly relative to the user prompt
  // that triggered it.
  if (streaming && streaming.text) {
    let latestAssistantTs = 0;
    for (const tn of baseTurns) {
      if (tn.role !== "assistant" || tn.tool_use) continue;
      const t = tsMs(tn);
      if (t > latestAssistantTs) latestAssistantTs = t;
    }
    const canonicalCaughtUp = streaming.startTs > 0 && latestAssistantTs >= streaming.startTs;
    if (!canonicalCaughtUp) {
      const stampMs = streaming.startTs > 0 ? streaming.startTs : Date.now();
      extras.push({
        ts: new Date(stampMs).toISOString(),
        role: "assistant",
        text: streaming.text,
        raw_type: "synthetic-streaming",
      });
    }
  }

  // "Thinking" placeholder: only when activity is live, no streaming text yet,
  // and the most recent canonical (or overlay) user turn is NEWER than the
  // most recent canonical assistant turn — i.e. claude hasn't started typing
  // a reply yet. Stamped with Date.now() so it always sorts to the bottom.
  // Disappears the moment streaming starts OR a canonical assistant turn
  // catches up (which would shift latestAssistantTs above latestUserTs).
  if (activity && (!streaming || !streaming.text)) {
    let latestUserTs = 0;
    let latestAssistantTs = 0;
    for (const tn of baseTurns) {
      if (tn.role === "user" && !tn.tool_result) {
        const t = tsMs(tn);
        if (t > latestUserTs) latestUserTs = t;
      } else if (tn.role === "assistant" && !tn.tool_use) {
        const t = tsMs(tn);
        if (t > latestAssistantTs) latestAssistantTs = t;
      }
    }
    // Also consider the optimistic user overlay (may already be in extras).
    if (userOverlay && userOverlay.text && userOverlay.ts > latestUserTs) {
      latestUserTs = userOverlay.ts;
    }
    if (latestUserTs > latestAssistantTs) {
      extras.push({
        ts: new Date(Date.now()).toISOString(),
        role: "assistant",
        text: activity,
        raw_type: "synthetic-thinking",
      });
    }
  }

  if (extras.length === 0) return baseTurns;

  // V8/Chromium/Firefox/Safari all use a stable Array.prototype.sort since
  // ES2019, so blocks emitted from readTranscriptTail with identical ts
  // retain their forward order.
  const merged = [...baseTurns, ...(extras as T[])];
  merged.sort((a, b) => tsMs(a) - tsMs(b));
  return merged;
}
