import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { SessionResolver, encodeCwd, readSessionPreview, readTranscriptTail } from "../src/session-resolver.js";

const FIXTURES_ROOT = path.join(__dirname, "fixtures", "projects");

describe("encodeCwd", () => {
  it("replaces slashes and colons with dashes", () => {
    expect(encodeCwd("d:\\code\\dragonfly")).toBe("d--code-dragonfly");
    expect(encodeCwd("/home/user/proj")).toBe("-home-user-proj");
  });
});

describe("SessionResolver", () => {
  it("returns the most recently modified session UUID for a cwd", async () => {
    const r = new SessionResolver(FIXTURES_ROOT);
    // Assumes fixture dir contains at least one .jsonl named like <uuid>.jsonl
    const uuid = await r.resolveLatest("d:\\code\\cc-hub");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("returns null when no project directory exists for cwd", async () => {
    const r = new SessionResolver(FIXTURES_ROOT);
    expect(await r.resolveLatest("d:\\code\\nonexistent")).toBeNull();
  });

  it("returns null when project directory is empty", async () => {
    // Use a fixture dir with no .jsonl files; create one in fixtures if needed.
    const r = new SessionResolver(FIXTURES_ROOT);
    expect(await r.resolveLatest("d:\\code\\empty-project")).toBeNull();
  });
});

describe("readSessionPreview last_user_text", () => {
  it("ignores harness-injected meta user turns (skill content, tool-injected)", async () => {
    // Real-world bug: when Claude calls the Skill tool, the harness injects
    // the skill markdown as a user-role JSONL entry with isMeta:true and
    // sourceToolUseID set. The reverse scan was treating it as the latest
    // user message, shadowing the actual most-recent user input.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccpreview-"));
    const tpath = path.join(dir, "sess.jsonl");
    const uuid = "00000000-0000-0000-0000-000000000001";
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "first real message" }] }, timestamp: "2026-05-17T09:20:00.000Z" },
      // Harness-injected skill content (the bug trigger):
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: ..." }] }, isMeta: true, sourceToolUseID: "toolu_xyz", timestamp: "2026-05-17T09:20:17.000Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, timestamp: "2026-05-17T09:21:00.000Z" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "second real message" }] }, timestamp: "2026-05-17T09:25:00.000Z" },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const p = await readSessionPreview(uuid, tpath);
    expect(p.last_user_text).toBe("second real message");
    expect(p.last_user_ts).toBe("2026-05-17T09:25:00.000Z");
  });

  it("ignores task-notification injected turns (origin.kind, string content)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccpreview-"));
    const tpath = path.join(dir, "sess.jsonl");
    const uuid = "00000000-0000-0000-0000-000000000003";
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "deploy and tell me" }] }, timestamp: "2026-05-17T11:30:00.000Z" },
      // Background task notification — written as user-role w/ string content
      // and origin.kind="task-notification". This was leaking into the modal
      // as if the human had typed it.
      { type: "user", message: { role: "user", content: "<task-notification>completed</task-notification>" }, origin: { kind: "task-notification" }, timestamp: "2026-05-17T11:42:48.000Z" },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const p = await readSessionPreview(uuid, tpath);
    expect(p.last_user_text).toBe("deploy and tell me");
  });

  it("falls back through meta turns to find the prior real user message", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccpreview-"));
    const tpath = path.join(dir, "sess.jsonl");
    const uuid = "00000000-0000-0000-0000-000000000002";
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "only real message" }] }, timestamp: "2026-05-17T09:20:00.000Z" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "skill blob" }] }, isMeta: true, sourceToolUseID: "toolu_a", timestamp: "2026-05-17T09:20:30.000Z" },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const p = await readSessionPreview(uuid, tpath);
    expect(p.last_user_text).toBe("only real message");
  });
});

describe("readTranscriptTail role labelling", () => {
  it("labels harness-injected user turns as 'system' so the modal doesn't mislabel them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cctail-"));
    const tpath = path.join(dir, "sess.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, timestamp: "2026-05-17T11:30:00.000Z" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: ..." }] }, isMeta: true, sourceToolUseID: "toolu_a", timestamp: "2026-05-17T11:30:10.000Z" },
      { type: "user", message: { role: "user", content: "<task-notification>...</task-notification>" }, origin: { kind: "task-notification" }, timestamp: "2026-05-17T11:30:20.000Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, timestamp: "2026-05-17T11:30:30.000Z" },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const turns = await readTranscriptTail(tpath, 20);
    // Real user "hi" stays user; injected ones become "system"; assistant stays assistant.
    const summary = turns.map((t) => `${t.role}:${t.text || (t.tool_use ? "[tool_use]" : t.tool_result ? "[tool_result]" : "")}`);
    expect(summary).toEqual([
      "user:hi",
      "system:Base directory for this skill: ...",
      "system:<task-notification>...</task-notification>",
      "assistant:ok",
    ]);
  });

  it("keeps tool_result blocks on 'user' role (tool reply lane)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cctail-"));
    const tpath = path.join(dir, "sess.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "result" }] }, timestamp: "2026-05-17T11:30:00.000Z" },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const turns = await readTranscriptTail(tpath, 20);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.tool_result?.content).toBe("result");
  });
});
