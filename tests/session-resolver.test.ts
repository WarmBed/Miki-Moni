import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  SessionResolver,
  encodeCwd,
  findCodexRolloutPath,
  findLatestCodexRolloutByCwd,
  parsePendingCodexCwd,
  parsePendingCodexLaunchMs,
  readCodexSessionPreview,
  readCodexTranscriptTail,
  readSessionPreview,
  readTranscriptTail,
} from "../src/session-resolver.js";

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

describe("Codex rollout transcript parsing", () => {
  async function writeCodexRollout(): Promise<{ dir: string; path: string; uuid: string }> {
    const uuid = "019e40b9-b1a5-7be1-bab7-52f4a14e67a4";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
    const nested = path.join(dir, "2026", "05", "19");
    await fs.mkdir(nested, { recursive: true });
    const tpath = path.join(nested, `rollout-2026-05-19T22-52-52-${uuid}.jsonl`);
    const entries = [
      { timestamp: "2026-05-19T14:53:04.325Z", type: "session_meta", payload: { id: uuid, cwd: "D:\\code\\cc-hub" } },
      { timestamp: "2026-05-19T14:53:04.331Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for D:\\code\\cc-hub\n\n<environment_context>...</environment_context>" }] } },
      { timestamp: "2026-05-19T14:53:04.332Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "open the dashboard" }] } },
      { timestamp: "2026-05-19T14:53:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I will inspect it." }] } },
      { timestamp: "2026-05-19T14:53:06.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "call_1", arguments: JSON.stringify({ command: "pnpm test", workdir: "D:\\code\\cc-hub" }) } },
      { timestamp: "2026-05-19T14:53:07.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "Exit code: 0\nPASS" } },
      { timestamp: "2026-05-19T14:53:08.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] } },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return { dir, path: tpath, uuid };
  }

  it("finds Codex rollout files recursively by session id", async () => {
    const { dir, path: tpath, uuid } = await writeCodexRollout();
    await expect(findCodexRolloutPath(dir, uuid)).resolves.toBe(tpath);
  });

  it("parses pending Codex cwd while preserving the drive colon", () => {
    expect(parsePendingCodexCwd("codex-pending:d:\\code\\cc-hub:5a552878-02e5-48df-b41a-3c90ee9c0e5a"))
      .toBe("d:\\code\\cc-hub");
    expect(parsePendingCodexCwd("codex-pending:d:\\code\\cc-hub:1779370339000-5a552878-02e5-48df-b41a-3c90ee9c0e5a"))
      .toBe("d:\\code\\cc-hub");
    expect(parsePendingCodexCwd("codex-pending:d:\\code\\cc-hub"))
      .toBe("d:\\code\\cc-hub");
  });

  it("parses pending Codex launch timestamps when present", () => {
    expect(parsePendingCodexLaunchMs("codex-pending:d:\\code\\cc-hub:1779370339000-5a552878-02e5-48df-b41a-3c90ee9c0e5a"))
      .toBe(1779370339000);
    expect(parsePendingCodexLaunchMs("codex-pending:d:\\code\\cc-hub:5a552878-02e5-48df-b41a-3c90ee9c0e5a"))
      .toBeNull();
  });

  it("finds latest Codex rollout by cwd for provisional pending sessions", async () => {
    const { dir, path: firstPath } = await writeCodexRollout();
    const nested = path.dirname(firstPath);
    const latestUuid = "019e45aa-6571-72a2-abfd-232caa24b907";
    const latestPath = path.join(nested, `rollout-2026-05-20T21-54-15-${latestUuid}.jsonl`);
    const vscodePath = path.join(nested, "rollout-2026-05-20T22-00-00-019e45ff-6571-72a2-abfd-232caa24b907.jsonl");
    const entries = [
      { timestamp: "2026-05-20T13:54:16.125Z", type: "session_meta", payload: { id: latestUuid, cwd: "d:/code/cc-hub", source: "exec" } },
      { timestamp: "2026-05-20T13:54:21.768Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] } },
      { timestamp: "2026-05-20T13:54:30.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
    ];
    await fs.writeFile(latestPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    await fs.writeFile(vscodePath, JSON.stringify({
      timestamp: "2026-05-20T14:00:00.000Z",
      type: "session_meta",
      payload: { id: "019e45ff-6571-72a2-abfd-232caa24b907", cwd: "D:\\code\\cc-hub", source: "vscode" },
    }) + "\n", "utf8");
    await fs.utimes(firstPath, new Date("2026-05-19T14:53:08.000Z"), new Date("2026-05-19T14:53:08.000Z"));
    await fs.utimes(latestPath, new Date("2026-05-20T13:54:30.000Z"), new Date("2026-05-20T13:54:30.000Z"));
    await fs.utimes(vscodePath, new Date("2026-05-20T14:00:00.000Z"), new Date("2026-05-20T14:00:00.000Z"));

    await expect(findLatestCodexRolloutByCwd(dir, "D:\\code\\cc-hub")).resolves.toBe(latestPath);
    await expect(findLatestCodexRolloutByCwd(dir, "D:\\code\\cc-hub", { minMtimeMs: Date.parse("2026-05-20T13:54:31.000Z") }))
      .resolves.toBeNull();
    await expect(findLatestCodexRolloutByCwd(dir, "D:\\code\\cc-hub", { maxMtimeMs: Date.parse("2026-05-19T14:53:09.000Z") }))
      .resolves.toBe(firstPath);
    const resolver = new SessionResolver(path.join(dir, "no-claude"), dir);
    await expect(resolver.findTranscript("codex-pending:d:\\code\\cc-hub:5a552878-02e5-48df-b41a-3c90ee9c0e5a"))
      .resolves.toEqual({ source: "codex", path: latestPath });
    await expect(resolver.findTranscript("codex-pending:d:\\code\\cc-hub:5a552878-02e5-48df-b41a-3c90ee9c0e5a", { minMtimeMs: Date.parse("2026-05-20T13:54:31.000Z") }))
      .resolves.toBeNull();
  });

  it("builds preview from real user, latest assistant, and latest tool", async () => {
    const { path: tpath, uuid } = await writeCodexRollout();
    const p = await readCodexSessionPreview(uuid, tpath);
    expect(p.last_user_text).toBe("open the dashboard");
    expect(p.last_assistant_text).toBe("Done.");
    expect(p.last_tool_use).toEqual({ name: "shell_command", description: "pnpm test" });
  });

  it("maps Codex response items into transcript turns", async () => {
    const { path: tpath } = await writeCodexRollout();
    const turns = await readCodexTranscriptTail(tpath, 20);
    const summary = turns.map((t) => `${t.role}:${t.text || t.tool_use?.name || t.tool_result?.content}`);
    expect(summary).toEqual([
      "user:open the dashboard",
      "assistant:I will inspect it.",
      "assistant:shell_command",
      "user:Exit code: 0\nPASS",
      "assistant:Done.",
    ]);
  });

  it("hides Codex bootstrap system and harness messages from transcript turns", async () => {
    const uuid = "019e4abc-996b-7c83-95e5-0580d9274dac";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bootstrap-"));
    const nested = path.join(dir, "2026", "05", "21");
    await fs.mkdir(nested, { recursive: true });
    const tpath = path.join(nested, `rollout-2026-05-21T23-12-28-${uuid}.jsonl`);
    const entries = [
      { timestamp: "2026-05-21T15:12:28.000Z", type: "session_meta", payload: { id: uuid, cwd: "D:\\code" } },
      { timestamp: "2026-05-21T15:12:28.100Z", type: "response_item", payload: { type: "message", role: "system", content: [{ type: "input_text", text: "Filesystem sandboxing defines which files can be read or written." }] } },
      { timestamp: "2026-05-21T15:12:28.200Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written.\n</permissions instructions>" }] } },
      { timestamp: "2026-05-21T15:12:28.300Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "internal developer policy" }] } },
      { timestamp: "2026-05-21T15:12:29.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "test" }] } },
      { timestamp: "2026-05-21T15:12:31.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "test received." }] } },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const turns = await readCodexTranscriptTail(tpath, 20);
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:test",
      "assistant:test received.",
    ]);
  });
});
