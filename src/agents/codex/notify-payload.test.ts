import { describe, it, expect } from "vitest";
import { parseNotifyPayload, eventsFromPayload } from "./notify-payload.js";

describe("parseNotifyPayload", () => {
  it("accepts agent-turn-complete shape", () => {
    const p = parseNotifyPayload({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["hello"],
      "last-assistant-message": "hi",
    });
    expect(p?.type).toBe("agent-turn-complete");
    expect(p?.inputMessages).toEqual(["hello"]);
  });

  it("returns null for unknown type", () => {
    expect(parseNotifyPayload({ type: "something-else" })).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseNotifyPayload(null)).toBeNull();
    expect(parseNotifyPayload("x")).toBeNull();
  });
});

describe("eventsFromPayload", () => {
  it("emits user_prompt then stop for agent-turn-complete", () => {
    const p = parseNotifyPayload({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["hello"],
      "last-assistant-message": "hi",
    })!;
    const evs = eventsFromPayload(p, { isFirstSight: false });
    expect(evs.map(e => e.event_type)).toEqual(["user_prompt", "stop"]);
  });

  it("prepends session_start when isFirstSight", () => {
    const p = parseNotifyPayload({
      type: "agent-turn-complete",
      "turn-id": "t1",
      "input-messages": ["hi"],
      "last-assistant-message": "yo",
    })!;
    const evs = eventsFromPayload(p, { isFirstSight: true });
    expect(evs.map(e => e.event_type)).toEqual(["session_start", "user_prompt", "stop"]);
  });
});
