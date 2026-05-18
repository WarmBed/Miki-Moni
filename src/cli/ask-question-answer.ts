// Pure helpers for converting AskUserQuestion user input into:
//   - a terminal-friendly `display` string (legacy "→ 回應：" echo)
//   - a `structured` map keyed by the question text, matching the SDK's
//     AskUserQuestionOutput.answers shape (multi-select values comma-joined).
//
// Both the dashboard WS path (already structured indices/labels) and the
// terminal stdin path (free-form "1,3" / "Yes") feed the same parser.
// Numeric labels are NOT re-parsed as indices when the literal string already
// matches a known option label.

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
