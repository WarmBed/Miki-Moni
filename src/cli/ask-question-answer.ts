// Pure helpers for converting AskUserQuestion user input into:
//   - a terminal-friendly `display` string (legacy "→ 回應：" echo)
//   - a `structured` map keyed by the question text, matching the SDK's
//     AskUserQuestionOutput.answers shape (multi-select values comma-joined).
//
// Both the dashboard WS path (already structured indices/labels) and the
// terminal stdin path (free-form "1,3" / "Yes") feed the same parser.
// Numeric labels are NOT re-parsed as indices when the literal string already
// matches a known option label.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface QOption { label: string; description: string }
export interface QQuestion { question: string; header: string; multiSelect?: boolean; options: QOption[] }

export interface ParsedAnswers {
  display: string;
  structured: Record<string, string>;
}

export function parseAnswers(
  indicesPerQuestion: string[][],
  questions: QQuestion[],
): ParsedAnswers {
  const displayLines: string[] = [];
  const structured: Record<string, string> = {};

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const inputs = indicesPerQuestion[qi] ?? [];
    if (inputs.length === 0) continue;

    const labels: string[] = inputs.map((raw) => {
      // Prefer literal-label match first — protects numeric labels like "3" / "5"
      // from being re-interpreted as the index "3" by parseInt.
      const literalHit = q.options.find((o) => o.label === raw);
      if (literalHit) return literalHit.label;

      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && String(n) === raw.trim() && n >= 1 && n <= q.options.length) {
        return q.options[n - 1]!.label;
      }
      return raw; // free-text fallback
    });

    displayLines.push(`${q.question} → ${labels.join(" / ")}`);
    structured[q.question] = labels.join(", ");
  }

  return { display: displayLines.join("\n"), structured };
}

export interface BuildToolResultArgs {
  toolUseId: string;            // the AskUserQuestion's tool_use.id
  parentToolUseId: string | null; // from the SDKAssistantMessage carrying the tool_use
  sessionId: string;
  questions: QQuestion[];
  structuredAnswers: Record<string, string>;
}

/**
 * Construct an SDKUserMessage whose content is a single tool_result block
 * pointing back at the AskUserQuestion's tool_use_id. The result content is
 * a JSON-stringified AskUserQuestionOutput ({ questions, answers }) so the
 * SDK / Claude can parse it as the structured tool response.
 *
 * Pushing this into the SDK's prompt iterable closes the tool_use loop and
 * Claude continues the turn instead of saying "I didn't see your answer".
 */
export function buildAskQuestionToolResultMessage(args: BuildToolResultArgs): SDKUserMessage {
  const { toolUseId, parentToolUseId, sessionId, questions, structuredAnswers } = args;
  const payload = { questions, answers: structuredAnswers };
  return {
    type: "user",
    parent_tool_use_id: parentToolUseId,
    session_id: sessionId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify(payload),
        },
      ],
    },
  } satisfies SDKUserMessage;
}
