import { describe, it, expect, vi } from "vitest";
import { submit, type SubmitterDeps } from "../src/submitter.js";

function makeDeps(overrides: Partial<SubmitterDeps> = {}): SubmitterDeps {
  return {
    openExternal: vi.fn().mockResolvedValue(true),
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

  it("calls openExternal with correctly-encoded vscode:// URI", async () => {
    const deps = makeDeps();
    await submit({ request_id: "r1", session_uuid: "uuid-x", prompt: "hello world" }, deps);
    const [uri] = (deps.openExternal as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(uri).toBe("vscode://anthropic.claude-code/open?session=uuid-x&prompt=hello%20world");
  });

  it("sleeps prefillDelayMs between URI fire and focus command", async () => {
    const deps = makeDeps({ prefillDelayMs: 750 });
    await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(deps.sleep).toHaveBeenCalledWith(750);
  });

  it("calls executeCommand('claude-vscode.focus') after URI + sleep", async () => {
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

  it("returns ok=false when openExternal returns false", async () => {
    const deps = makeDeps({ openExternal: vi.fn().mockResolvedValue(false) });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/URI dispatch refused/);
  });

  it("returns ok=false when executeCommand throws", async () => {
    const deps = makeDeps({
      executeCommand: vi.fn().mockRejectedValue(new Error("cmd not found")),
    });
    const ack = await submit({ request_id: "r1", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/cmd not found/);
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
    const deps = makeDeps({ openExternal: vi.fn().mockResolvedValue(false) });
    const ack = await submit({ request_id: "abc-xyz-123", session_uuid: "u", prompt: "p" }, deps);
    expect(ack.request_id).toBe("abc-xyz-123");
  });
});
