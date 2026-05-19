# AskUserQuestion Tool-Result Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the dashboard / terminal answers Claude's `AskUserQuestion`, push the answer into the SDK query stream as a properly-formed `tool_result` block (matching the tool_use_id) instead of a plain text user message, so Claude actually links the answer to the question and continues the turn.

**Architecture:** Extract `formatAnswerFromIndices` + a new tool-result builder into a pure module `src/cli/ask-question-answer.ts` (vitest-friendly). Extend `PendingAsk` to remember the AskUserQuestion's `tool_use.id` AND the parent assistant message's `parent_tool_use_id` (captured in `emitAskQuestion`). Rewrite `answerAsk` to call the builder and push a `tool_result` `SDKUserMessage` into `messages`. Both call paths (terminal stdin reader + WS dashboard `ask_question_answer`) reuse the same helpers, so terminal answers also get fixed for free.

**Tech Stack:** Node 20+, TypeScript (NodeNext ESM), `@anthropic-ai/claude-agent-sdk` 0.3.x (`SDKUserMessage`, `tool_result` content block), `vitest` for unit tests.

**Spec source:** Conversation `2026-05-18` debug session — root cause locked to "wrap pushes plain-text user message instead of tool_result block, Claude never resolves the AskUserQuestion tool_use → reports '沒看到你的選擇'". SDK schema reference: `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:2620` (`AskUserQuestionOutput`).

---

## File Structure

**Created**
- `src/cli/ask-question-answer.ts` — pure helpers: `parseAnswers(indicesPerQuestion, questions)` returns `{ display, structured }`; `buildAskQuestionToolResultMessage(args)` returns an `SDKUserMessage` containing a single `tool_result` block.
- `tests/ask-question-answer.test.ts` — vitest unit tests covering single-select, multi-select, free-text fallback, numeric-label collision (bug #2), multi-question joining, and tool-result message shape (parent_tool_use_id propagation, JSON-stringified content matching SDK schema).

**Modified**
- `src/cli/wrap.ts`
  - L486-491: extend `PendingAsk` interface with `parentToolUseId: string | null`.
  - L490: `emitAskQuestion` signature gains `parentToolUseId: string | null`.
  - L514-527: delete the local `formatAnswerFromIndices` (moved to new module).
  - L529-541: rewrite `answerAsk` to take `{ display: string; structured: Record<string, string> }` and push a tool_result `SDKUserMessage` via the new builder.
  - L351-357: dashboard WS handler — build `{display, structured}` from incoming indices and call `answerAsk`.
  - L659-667: terminal stdin handler — same refactor.
  - L734-739: `emitAskQuestion(...)` callsite — also pass `m.parent_tool_use_id ?? null` from the assistant SDKAssistantMessage.

---

## Task 1: Pure parsing helper — `parseAnswers`

**Files:**
- Create: `src/cli/ask-question-answer.ts`
- Test: `tests/ask-question-answer.test.ts`

- [ ] **Step 1: Write failing tests for `parseAnswers`**

Create `tests/ask-question-answer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAnswers, type QQuestion } from "../src/cli/ask-question-answer.js";

function q(question: string, options: string[], multiSelect = false): QQuestion {
  return {
    question,
    header: question.slice(0, 10),
    multiSelect,
    options: options.map((label) => ({ label, description: "" })),
  };
}

describe("parseAnswers", () => {
  it("resolves a single-select pick via dashboard label", () => {
    const questions = [q("Use TypeScript?", ["Yes", "No"])];
    const r = parseAnswers([["Yes"]], questions);
    expect(r.display).toBe("Use TypeScript? → Yes");
    expect(r.structured).toEqual({ "Use TypeScript?": "Yes" });
  });

  it("resolves a terminal numeric index to its label", () => {
    const questions = [q("Use TypeScript?", ["Yes", "No"])];
    const r = parseAnswers([["1"]], questions);
    expect(r.display).toBe("Use TypeScript? → Yes");
    expect(r.structured).toEqual({ "Use TypeScript?": "Yes" });
  });

  it("treats a pure-numeric LABEL as the literal label, not a re-index (bug #2)", () => {
    // Options "3" / "5" / "10" — picking "3" must answer "3", not options[2].label
    const questions = [q("Years of experience?", ["3", "5", "10"])];
    const r = parseAnswers([["3"]], questions);
    expect(r.structured).toEqual({ "Years of experience?": "3" });
    expect(r.display).toBe("Years of experience? → 3");
  });

  it("joins multi-select picks with comma in structured (SDK schema), slash in display", () => {
    const questions = [q("Features?", ["A", "B", "C"], true)];
    const r = parseAnswers([["A", "C"]], questions);
    expect(r.structured).toEqual({ "Features?": "A, C" });
    expect(r.display).toBe("Features? → A / C");
  });

  it("falls back to free text when the input is not a valid index and not a label", () => {
    const questions = [q("Notes?", ["Skip", "Add"])];
    const r = parseAnswers([["custom remark"]], questions);
    expect(r.structured).toEqual({ "Notes?": "custom remark" });
    expect(r.display).toBe("Notes? → custom remark");
  });

  it("supports multiple questions; structured keyed by question text", () => {
    const questions = [
      q("Q1?", ["a", "b"]),
      q("Q2?", ["x", "y"], true),
    ];
    const r = parseAnswers([["a"], ["x", "y"]], questions);
    expect(r.structured).toEqual({ "Q1?": "a", "Q2?": "x, y" });
    expect(r.display).toBe("Q1? → a\nQ2? → x / y");
  });

  it("returns empty structured map and empty display when no picks", () => {
    const questions = [q("Q?", ["a", "b"])];
    const r = parseAnswers([[]], questions);
    expect(r.structured).toEqual({});
    expect(r.display).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ask-question-answer.test.ts`
Expected: FAIL — `Cannot find module '../src/cli/ask-question-answer.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/cli/ask-question-answer.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ask-question-answer.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ask-question-answer.ts tests/ask-question-answer.test.ts
git commit -m "feat(wrap): pure parseAnswers helper with structured output + numeric-label guard"
```

---

## Task 2: Tool-result message builder — `buildAskQuestionToolResultMessage`

**Files:**
- Modify: `src/cli/ask-question-answer.ts` (append builder)
- Modify: `tests/ask-question-answer.test.ts` (append describe block)

- [ ] **Step 1: Write failing tests for the builder**

Append to `tests/ask-question-answer.test.ts`:

```ts
import { buildAskQuestionToolResultMessage } from "../src/cli/ask-question-answer.js";

describe("buildAskQuestionToolResultMessage", () => {
  const questions = [
    {
      question: "Use TypeScript?",
      header: "TS",
      options: [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ],
    },
  ];

  it("returns an SDKUserMessage with one tool_result block matching the tool_use_id", () => {
    const msg = buildAskQuestionToolResultMessage({
      toolUseId: "toolu_abc",
      parentToolUseId: null,
      sessionId: "session-1",
      questions,
      structuredAnswers: { "Use TypeScript?": "Yes" },
    });
    expect(msg.type).toBe("user");
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.session_id).toBe("session-1");
    const content = (msg.message as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_abc" });
  });

  it("serializes the content as JSON matching the SDK AskUserQuestionOutput schema", () => {
    const msg = buildAskQuestionToolResultMessage({
      toolUseId: "toolu_xyz",
      parentToolUseId: null,
      sessionId: "session-1",
      questions,
      structuredAnswers: { "Use TypeScript?": "Yes" },
    });
    const block = (msg.message as { content: Array<{ type: string; content: string }> }).content[0]!;
    const parsed = JSON.parse(block.content);
    expect(parsed.questions).toEqual(questions);
    expect(parsed.answers).toEqual({ "Use TypeScript?": "Yes" });
  });

  it("propagates parent_tool_use_id for subagent-spawned questions", () => {
    const msg = buildAskQuestionToolResultMessage({
      toolUseId: "toolu_inner",
      parentToolUseId: "toolu_outer_task",
      sessionId: "session-2",
      questions,
      structuredAnswers: { "Use TypeScript?": "No" },
    });
    expect(msg.parent_tool_use_id).toBe("toolu_outer_task");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/ask-question-answer.test.ts`
Expected: FAIL — `buildAskQuestionToolResultMessage is not exported`.

- [ ] **Step 3: Implement the builder**

Append to `src/cli/ask-question-answer.ts`:

```ts
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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
  } as SDKUserMessage;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/ask-question-answer.test.ts`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ask-question-answer.ts tests/ask-question-answer.test.ts
git commit -m "feat(wrap): tool_result message builder for AskUserQuestion answers"
```

---

## Task 3: Wire builder into `wrap.ts` — extend `PendingAsk` and `emitAskQuestion`

**Files:**
- Modify: `src/cli/wrap.ts` L479-509 (PendingAsk + emitAskQuestion) and L727-744 (callsite in the stream loop)

- [ ] **Step 1: Update `PendingAsk` interface and `emitAskQuestion` signature**

In `src/cli/wrap.ts`, replace L486-509 (the existing `interface PendingAsk` + `emitAskQuestion` block):

```ts
  interface QQuestion { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }
  interface PendingAsk { id: string; parentToolUseId: string | null; questions: QQuestion[] }
  let pendingAsk: PendingAsk | null = null;

  function emitAskQuestion(id: string, parentToolUseId: string | null, questions: QQuestion[]): void {
    pendingAsk = { id, parentToolUseId, questions };
    // 1. Daemon broadcast
    const liveWs = getWs();
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "ask_question", session_uuid: resumeUuid, question_id: id, questions })); }
      catch { /* ignore */ }
    }
    // 2. Terminal fallback render
    process.stdout.write(`\n${yellow(bold("❓ Claude 在問你問題："))}\n`);
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]!;
      process.stdout.write(`\n${bold(`Q${qi + 1}. ${q.question}`)}\n`);
      q.options.forEach((opt, i) => {
        process.stdout.write(`  ${cyan(String(i + 1))}. ${opt.label}${opt.description ? dim(` — ${opt.description}`) : ""}\n`);
      });
    }
    process.stdout.write(`\n${dim("→ 在 dashboard 點選 OR terminal 直接輸入答案文字 / 編號 (如 1 或 1,3)")}\n`);
    printPrompt();
  }
```

- [ ] **Step 2: Update the assistant-stream callsite**

In `src/cli/wrap.ts` L727-739, replace the AskUserQuestion detection block. Find:

```ts
              if (block.name === "AskUserQuestion" && block.input && typeof block.input === "object") {
                const qs = (block.input as any).questions;
                if (Array.isArray(qs) && qs.length > 0) {
                  emitAskQuestion(block.id || `q-${Date.now()}`, qs as QQuestion[]);
                }
              }
```

Replace with:

```ts
              if (block.name === "AskUserQuestion" && block.input && typeof block.input === "object") {
                const qs = (block.input as any).questions;
                if (Array.isArray(qs) && qs.length > 0) {
                  // Capture parent_tool_use_id from the SDKAssistantMessage so
                  // the tool_result we push back has the right parent context
                  // (null for top-level Claude; the Task tool's id for subagents).
                  const parentToolUseId = (m as any).parent_tool_use_id ?? null;
                  emitAskQuestion(block.id || `q-${Date.now()}`, parentToolUseId, qs as QQuestion[]);
                }
              }
```

- [ ] **Step 3: Run typecheck to confirm signatures align**

Run: `pnpm typecheck`
Expected: PASS. The only consumers of `emitAskQuestion` and `PendingAsk` are inside `wrap.ts` (none external), so no other file should fail.

- [ ] **Step 4: Run the existing test suite to confirm no regression**

Run: `pnpm vitest run`
Expected: PASS — `tests/ask-question-answer.test.ts` still green; all other tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/cli/wrap.ts
git commit -m "refactor(wrap): track parent_tool_use_id for pending AskUserQuestion"
```

---

## Task 4: Rewrite `answerAsk` + both input paths to push tool_result

**Files:**
- Modify: `src/cli/wrap.ts` — delete local `formatAnswerFromIndices` (L514-527), rewrite `answerAsk` (L529-541), update WS handler (L351-357), update readline handler (L659-667), add import.

- [ ] **Step 1: Add the import**

In `src/cli/wrap.ts` near the existing imports (around L40), add:

```ts
import { parseAnswers, buildAskQuestionToolResultMessage, type QQuestion as QQuestionPure } from "./ask-question-answer.js";
```

(Use the alias `QQuestionPure` to avoid colliding with the local `QQuestion` declared inside the same function scope. We'll keep the local for now — both have identical shape.)

- [ ] **Step 2: Delete the local `formatAnswerFromIndices`**

In `src/cli/wrap.ts`, remove lines 511-527 (the `// Convert raw user input...` comment block plus the function body). The replacement lives in `ask-question-answer.ts`.

- [ ] **Step 3: Rewrite `answerAsk` to push a tool_result message**

Replace lines 529-541 with:

```ts
  function answerAsk(display: string, structured: Record<string, string>): void {
    if (!pendingAsk) return;
    const { id, parentToolUseId, questions } = pendingAsk;
    pendingAsk = null;
    // Tell daemon to dismiss any open picker for this question
    const liveWs = getWs();
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "ask_question_done", session_uuid: resumeUuid, question_id: id })); }
      catch { /* ignore */ }
    }
    process.stdout.write(`${cyan("→ 回應：")}${display}\n`);

    // Push a real tool_result so Claude links the answer to the original
    // AskUserQuestion tool_use. Plain text user messages do NOT close the
    // tool_use loop; Claude would report "didn't see your choice".
    messages.push(buildAskQuestionToolResultMessage({
      toolUseId: id,
      parentToolUseId,
      sessionId: resumeUuid ?? "",
      questions,
      structuredAnswers: structured,
    }));
    setActivity("Ideating");

    // Mirror to daemon so the dashboard cell flips "active" + shows the
    // optimistic user line — same convention as sendUser() at L572-595.
    if (liveWs && liveWs.readyState === liveWs.OPEN && resumeUuid) {
      try { liveWs.send(JSON.stringify({ type: "turn_start", session_uuid: resumeUuid })); }
      catch { /* ignore */ }
      try {
        liveWs.send(JSON.stringify({
          type: "user_message",
          session_uuid: resumeUuid,
          text: display,
          ts: Date.now(),
        }));
      } catch { /* ignore */ }
    }
  }
```

- [ ] **Step 4: Update the WS handler (dashboard answer)**

In `src/cli/wrap.ts` L351-357, replace:

```ts
        } else if (m?.type === "ask_question_answer" && typeof m.question_id === "string") {
          // Dashboard answered an open AskUserQuestion. Format indices to a
          // readable answer string and push as a user message.
          if (!pendingAsk || pendingAsk.id !== m.question_id) return;  // stale
          const indices: string[][] = Array.isArray(m.answers) ? m.answers : [];
          const answer = formatAnswerFromIndices(indices);
          if (answer.trim()) answerAsk(answer);
        }
```

with:

```ts
        } else if (m?.type === "ask_question_answer" && typeof m.question_id === "string") {
          // Dashboard answered an open AskUserQuestion. Build the structured
          // answers map and push a tool_result block via answerAsk().
          if (!pendingAsk || pendingAsk.id !== m.question_id) return;  // stale
          const indices: string[][] = Array.isArray(m.answers) ? m.answers : [];
          const { display, structured } = parseAnswers(indices, pendingAsk.questions as QQuestionPure[]);
          if (display.trim()) answerAsk(display, structured);
        }
```

- [ ] **Step 5: Update the readline (terminal) handler**

In `src/cli/wrap.ts` L659-667, replace:

```ts
    if (pendingAsk) {
      const segs = trimmed.includes(";") ? trimmed.split(";").map((s) => s.trim()) : [trimmed];
      const idxPerQ: string[][] = pendingAsk.questions.map((_, qi) => {
        const seg = segs[qi] ?? "";
        return seg.split(",").map((s) => s.trim()).filter(Boolean);
      });
      const answer = formatAnswerFromIndices(idxPerQ);
      if (answer.trim()) { answerAsk(answer); return; }
    }
```

with:

```ts
    if (pendingAsk) {
      const segs = trimmed.includes(";") ? trimmed.split(";").map((s) => s.trim()) : [trimmed];
      const idxPerQ: string[][] = pendingAsk.questions.map((_, qi) => {
        const seg = segs[qi] ?? "";
        return seg.split(",").map((s) => s.trim()).filter(Boolean);
      });
      const { display, structured } = parseAnswers(idxPerQ, pendingAsk.questions as QQuestionPure[]);
      if (display.trim()) { answerAsk(display, structured); return; }
    }
```

- [ ] **Step 6: Typecheck + run full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS for both. Coverage so far is purely positive — we added tests and refactored existing wrap.ts logic to delegate to the tested helpers.

- [ ] **Step 7: Commit**

```bash
git add src/cli/wrap.ts
git commit -m "fix(wrap): push tool_result for AskUserQuestion answers (was plain text → Claude ignored)"
```

---

## Task 5: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild + restart**

Run: `pnpm build:all` (rebuilds web/web-phone so dashboard picks up any state via fresh assets — even though we did not modify the dashboard, an old cached SPA could theoretically diverge from `/sessions` responses).

Then start daemon: `pnpm start` (in a dedicated terminal).

- [ ] **Step 2: Wrap a fresh Claude session**

In a NEW terminal: `cd <any repo>` then `pnpm miki claude --fresh` (or whichever invocation you use — see `bin/miki.mjs`).

Wait for the `[wrap]` banner + `session uuid will appear` line.

- [ ] **Step 3: Trigger an AskUserQuestion**

Send Claude the prompt:

```
請用 AskUserQuestion 工具問我一個是非題：「要不要繼續？」，選項是「繼續」和「停止」。
```

Wait for the wrap terminal to print `❓ Claude 在問你問題：` plus the option list.

- [ ] **Step 4: Answer from the dashboard, observe Claude's reply**

Open the dashboard (`http://127.0.0.1:8765` or whatever port). Click the AskQuestionModal picker → pick "繼續" → Submit.

Expected (after fix):
- wrap terminal prints `→ 回應：要不要繼續？ → 繼續`
- Claude's next message acknowledges "繼續" and proceeds. **It must NOT say "沒看到你的選擇" / "I don't see your answer"**.

Failure → restart from Task 1 step 1 with a new hypothesis. Do NOT layer more fixes on top.

- [ ] **Step 5: Repeat from terminal stdin to confirm the parallel path also works**

In the wrap terminal, trigger another AskUserQuestion, but this time type `1` + Enter at the wrap prompt instead of clicking dashboard.

Expected: same successful continuation. Both paths go through `parseAnswers` + `buildAskQuestionToolResultMessage` so this is a free sanity check.

- [ ] **Step 6: Tag the fix commit and update CHANGELOG (if present)**

```bash
# Optional: if CHANGELOG.md exists, prepend an entry under Unreleased.
git log --oneline -5  # confirm the 4 commits are stacked
```

No commit at this step unless CHANGELOG was modified.

---

## Out of Scope (intentionally deferred — separate plans)

The previous debug session surfaced four sub-bugs in the AskUserQuestion flow. This plan resolves the primary failure mode (#C tool_result missing). The remaining three are tracked but NOT fixed here:

- **Sub-bug #1** (dashboard `<AskQuestionModal>` missing `key={askUuid}` → cross-session picks leak): own plan, `web/app.tsx` only.
- **Sub-bug #3** (single-select + custom text both submitted): own plan, dashboard submit logic.
- **Sub-bug #4** (modal title shows no project name): own plan, UX-only.

Sub-bug #2 (numeric-label re-parse) IS resolved here as a side effect of `parseAnswers`'s literal-match-first rule (verified by the dedicated test).

---

## Self-Review Checklist (performed before saving)

1. **Spec coverage** — Spec is the root-cause analysis from the debug conversation. Coverage:
   - "wrap pushes plain text instead of tool_result" → Task 4 step 3 (`answerAsk` rewrite).
   - "tool_use_id must match" → Task 2 builder test #1 + Task 3 PendingAsk extension.
   - "parent_tool_use_id propagation (subagent case)" → Task 2 test #3 + Task 3 step 2 callsite.
   - "structured AskUserQuestionOutput format" → Task 2 test #2.
   - "both terminal and dashboard paths" → Task 4 steps 4 & 5.
   - "no regression" → Task 4 step 6 (typecheck + full vitest run).
   ✓ Covered.

2. **Placeholder scan** — No "TBD", no "appropriate error handling", no "similar to Task N". Every code block is concrete. ✓

3. **Type consistency** — `parseAnswers` returns `{ display, structured }` everywhere it appears (helper, both callsites, `answerAsk` signature). `buildAskQuestionToolResultMessage` arg names (`toolUseId`, `parentToolUseId`, `sessionId`, `questions`, `structuredAnswers`) match between builder definition and the call in `answerAsk`. `PendingAsk` field `parentToolUseId` matches between interface, `emitAskQuestion`, and destructuring in `answerAsk`. ✓
