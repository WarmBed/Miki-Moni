import { describe, it, expect, vi } from "vitest";
import { submit, type SubmitterDeps } from "../src/submitter.js";

function makeDeps(overrides: Partial<SubmitterDeps> = {}): SubmitterDeps {
  return {
    revealClaudePanel: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
    spawnPS: vi.fn().mockResolvedValue({ ok: true, stdout: "enter-sent", stderr: "" }),
    sleep: vi.fn().mockResolvedValue(undefined),
    prefillDelayMs: 500,
    workspaceFolderName: "code",
    ...overrides,
  };
}

describe("submit", () => {
  it("returns ok=true with diag when whole flow succeeds", async () => {
    const deps = makeDeps();
    const ack = await submit({ request_id: "r1", session_uuid: "uuid-x", prompt: "hi" }, deps);
    expect(ack).toEqual({ type: "submit_ack", request_id: "r1", ok: true, diag: "enter-sent" });
  });

  it("calls revealClaudePanel with only sessionUuid (no prompt — see comment)", async () => {
    const deps = makeDeps();
    await submit({ request_id: "r1", session_uuid: "uuid-x", prompt: "hello world" }, deps);
    expect(deps.revealClaudePanel).toHaveBeenCalledWith("uuid-x");
    expect(deps.revealClaudePanel).toHaveBeenCalledTimes(1);
  });

  it("sleeps prefillDelayMs between reveal and focus command", async () => {
    const deps = makeDeps({ prefillDelayMs: 750 });
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(deps.sleep).toHaveBeenCalledWith(750);
  });

  it("calls executeCommand('claude-vscode.focus') after reveal + sleep", async () => {
    const deps = makeDeps();
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(deps.executeCommand).toHaveBeenCalledWith("claude-vscode.focus");
  });

  it("calls spawnPS with a script that includes workspaceFolderName as hint", async () => {
    const deps = makeDeps({ workspaceFolderName: "my-ws" });
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    const [script] = (deps.spawnPS as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(script).toContain("my-ws");
  });

  it("passes prompt to spawnPS (base64-encoded inside the script)", async () => {
    const deps = makeDeps();
    await submit({ request_id: "r1", session_uuid: "u", prompt: "hello world" }, deps);
    const [script] = (deps.spawnPS as ReturnType<typeof vi.fn>).mock.calls[0];
    // The script base64-encodes the prompt for safe interpolation.
    const expectedB64 = Buffer.from("hello world", "utf8").toString("base64");
    expect(script).toContain(expectedB64);
  });

  it("returns ok=false when revealClaudePanel throws", async () => {
    const deps = makeDeps({
      revealClaudePanel: vi.fn().mockRejectedValue(new Error("command not found")),
    });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/primaryEditor\.open failed/);
    expect(ack.error).toMatch(/command not found/);
  });

  it("returns ok=false when executeCommand (focus) throws", async () => {
    const deps = makeDeps({
      executeCommand: vi.fn().mockRejectedValue(new Error("focus cmd not found")),
    });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/focus cmd not found/);
  });

  it("returns ok=false with diag when PS exits non-zero", async () => {
    const deps = makeDeps({
      spawnPS: vi.fn().mockResolvedValue({ ok: false, stdout: "candidates=0", stderr: "No VSCode window found" }),
    });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/No VSCode window/);
    expect(ack.diag).toContain("candidates=0");
  });

  it("preserves request_id in ack regardless of outcome", async () => {
    const deps = makeDeps({ revealClaudePanel: vi.fn().mockRejectedValue(new Error("nope")) });
    const ack = await submit({ request_id: "abc-xyz-123", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.request_id).toBe("abc-xyz-123");
  });
});
