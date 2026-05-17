import type { HookEventType } from "../../types.js";

export interface AgentTurnComplete {
  type: "agent-turn-complete";
  turnId: string;
  inputMessages: string[];
  lastAssistantMessage: string;
}

export type NotifyPayload = AgentTurnComplete;

export interface CodexEventOut {
  event_type: HookEventType;
}

export function parseNotifyPayload(raw: unknown): NotifyPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === "agent-turn-complete") {
    return {
      type: "agent-turn-complete",
      turnId: typeof obj["turn-id"] === "string" ? (obj["turn-id"] as string) : "",
      inputMessages: Array.isArray(obj["input-messages"])
        ? (obj["input-messages"] as string[])
        : [],
      lastAssistantMessage: typeof obj["last-assistant-message"] === "string"
        ? (obj["last-assistant-message"] as string)
        : "",
    };
  }
  return null;
}

export function eventsFromPayload(
  _p: NotifyPayload,
  opts: { isFirstSight: boolean },
): CodexEventOut[] {
  const out: CodexEventOut[] = [];
  if (opts.isFirstSight) out.push({ event_type: "session_start" });
  out.push({ event_type: "user_prompt" });
  out.push({ event_type: "stop" });
  return out;
}
