import { describe, expect, it } from "vitest";
import { assembleRenderTurns, type TranscriptTurnLike } from "../web/lib/transcript-assembly.js";

const turn = (
  role: TranscriptTurnLike["role"],
  iso: string,
  text: string,
  extra: Partial<TranscriptTurnLike> = {},
): TranscriptTurnLike => ({ ts: iso, role, text, ...extra });

describe("assembleRenderTurns", () => {
  it("returns baseTurns untouched when no overlays are present", () => {
    const base = [
      turn("user", "2026-05-18T07:32:00Z", "hi"),
      turn("assistant", "2026-05-18T07:32:10Z", "hello"),
    ];
    const out = assembleRenderTurns(base, undefined, undefined);
    expect(out).toBe(base);
  });

  it("appends user overlay when JSONL has not caught up yet", () => {
    const base = [turn("assistant", "2026-05-18T07:30:00Z", "old reply")];
    const out = assembleRenderTurns(
      base,
      { text: "new prompt", ts: Date.parse("2026-05-18T07:34:26Z") },
      undefined,
    );
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe("user");
    expect(out[1]!.text).toBe("new prompt");
  });

  it("suppresses user overlay once canonical user turn has caught up", () => {
    const overlayTs = Date.parse("2026-05-18T07:34:26Z");
    const base = [
      turn("user", new Date(overlayTs).toISOString(), "new prompt"),
    ];
    const out = assembleRenderTurns(
      base,
      { text: "new prompt", ts: overlayTs },
      undefined,
    );
    expect(out).toEqual(base);
  });

  it("interleaves overlay BEFORE a newer canonical assistant turn (the original bug)", () => {
    // Concrete scenario from the dashboard screenshot:
    //   user typed at 15:34:26 (overlay)
    //   claude replied at 15:34:49 (canonical, already in JSONL)
    //   /sessions/previews has not refreshed yet → overlay still alive
    // Naive concat appends overlay LAST → assistant rendered before user.
    // Correct: chronological order.
    const base = [
      turn("assistant", "2026-05-18T07:32:43Z", "first"),
      turn("assistant", "2026-05-18T07:33:08Z", "second"),
      turn("assistant", "2026-05-18T07:34:49Z", "third — reply to the new prompt"),
    ];
    const out = assembleRenderTurns(
      base,
      { text: "new prompt", ts: Date.parse("2026-05-18T07:34:26Z") },
      undefined,
    );

    expect(out.map((t) => `${t.role}@${t.ts}`)).toEqual([
      "assistant@2026-05-18T07:32:43Z",
      "assistant@2026-05-18T07:33:08Z",
      "user@2026-05-18T07:34:26.000Z",
      "assistant@2026-05-18T07:34:49Z",
    ]);
  });

  it("stamps streaming overlay with startTs so it sorts after the user prompt", () => {
    const userTs = Date.parse("2026-05-18T07:34:26Z");
    const streamStart = Date.parse("2026-05-18T07:34:30Z");
    const base = [turn("user", new Date(userTs).toISOString(), "hi")];
    const out = assembleRenderTurns(
      base,
      undefined,
      { text: "I'm starting…", startTs: streamStart },
    );

    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe("user");
    expect(out[1]!.role).toBe("assistant");
    expect(out[1]!.raw_type).toBe("synthetic-streaming");
    expect(out[1]!.ts).toBe(new Date(streamStart).toISOString());
  });

  it("suppresses streaming overlay once canonical assistant turn is at or after startTs", () => {
    const streamStart = Date.parse("2026-05-18T07:34:30Z");
    const base = [
      turn("assistant", new Date(streamStart + 5_000).toISOString(), "canonical reply"),
    ];
    const out = assembleRenderTurns(
      base,
      undefined,
      { text: "old stream buffer", startTs: streamStart },
    );
    expect(out).toEqual(base);
  });

  it("places both overlays in chronological order when both are active", () => {
    const userTs = Date.parse("2026-05-18T07:34:26Z");
    const streamStart = Date.parse("2026-05-18T07:34:30Z");
    const base = [turn("assistant", "2026-05-18T07:33:00Z", "earlier reply")];
    const out = assembleRenderTurns(
      base,
      { text: "new prompt", ts: userTs },
      { text: "streaming…", startTs: streamStart },
    );

    expect(out.map((t) => t.role)).toEqual(["assistant", "user", "assistant"]);
    expect(out[1]!.text).toBe("new prompt");
    expect(out[2]!.raw_type).toBe("synthetic-streaming");
  });

  it("preserves within-entry block order via stable sort (same ts)", () => {
    const sharedTs = "2026-05-18T07:34:00Z";
    const base = [
      turn("assistant", sharedTs, "text block 1"),
      turn("assistant", sharedTs, "", { tool_use: { id: "t1" } }),
      turn("assistant", sharedTs, "text block 2"),
    ];
    const out = assembleRenderTurns(
      base,
      { text: "later prompt", ts: Date.parse("2026-05-18T07:34:30Z") },
      undefined,
    );
    expect(out.slice(0, 3)).toEqual(base);
    expect(out[3]!.role).toBe("user");
  });

  it("treats role:user tool_result blocks as non-human when deciding overlay visibility", () => {
    const overlayTs = Date.parse("2026-05-18T07:34:26Z");
    // A tool_result block lands in JSONL with role:"user" and the tool's
    // completion ts — that should NOT count as canonical user input.
    const base = [
      turn("user", new Date(overlayTs + 10_000).toISOString(), "", {
        tool_result: { tool_use_id: "x", content: "ok", truncated: false, is_error: false },
      }),
    ];
    const out = assembleRenderTurns(
      base,
      { text: "new prompt", ts: overlayTs },
      undefined,
    );
    expect(out.some((t) => t.raw_type === "synthetic-user-overlay")).toBe(true);
  });

  it("survives malformed ts (empty / unparseable) without throwing", () => {
    const base = [
      turn("user", "", "no-ts user"),
      turn("assistant", "not-a-date", "no-ts assistant"),
      turn("user", "2026-05-18T07:34:00Z", "real user"),
    ];
    const out = assembleRenderTurns(
      base,
      { text: "overlay", ts: Date.parse("2026-05-18T07:34:30Z") },
      undefined,
    );
    // Real user (07:34:00) is older than overlay (07:34:30) — overlay IS
    // pushed. Bad-ts turns coerce to 0 so they end up first; the
    // 07:34:00 real-user turn precedes the 07:34:30 overlay.
    expect(out.length).toBe(4);
    expect(out[out.length - 2]!.text).toBe("real user");
    expect(out[out.length - 1]!.raw_type).toBe("synthetic-user-overlay");
  });
});
