import { describe, it, expect } from "vitest";
import { parseAnswers, type QQuestion, buildAskQuestionToolResultMessage } from "../src/cli/ask-question-answer.js";

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
