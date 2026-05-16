import { describe, it, expect } from "vitest";
import { buildFocusAndEnterPS } from "../src/foreground-ps.js";

describe("buildFocusAndEnterPS", () => {
  it("contains all required Win32 P/Invoke methods", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt: "x" });
    const required = [
      "SetForegroundWindow", "BringWindowToTop", "ShowWindow", "IsIconic",
      "IsWindowVisible", "AttachThreadInput", "GetWindowThreadProcessId",
      "GetForegroundWindow", "GetCurrentThreadId", "GetWindowText", "EnumWindowsProc",
      "EnumWindows", "keybd_event", "SwitchToThisWindow", "LockSetForegroundWindow",
      "AllowSetForegroundWindow",
    ];
    for (const method of required) {
      expect(ps).toContain(method);
    }
  });

  it("does NOT fire a vscode:// URI — that's the extension's job", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt: "x" });
    expect(ps).not.toContain("Start-Process");
    expect(ps).not.toContain("vscode://");
  });

  it("uses clipboard paste + Enter to submit (clears leftover then pastes)", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt: "x" });
    expect(ps).toContain("Set-Clipboard");
    expect(ps).toContain("'^a'");
    expect(ps).toContain("'{DELETE}'");
    expect(ps).toContain("'^v'");
    expect(ps).toContain("'{ENTER}'");
  });

  it("base64-encodes the prompt to avoid quoting bugs", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt: "hello world" });
    const expectedB64 = Buffer.from("hello world", "utf8").toString("base64");
    expect(ps).toContain(expectedB64);
    // The raw prompt should NOT appear unescaped in the PS source.
    expect(ps).not.toContain("'hello world'");
  });

  it("base64 handles Unicode prompts correctly", () => {
    const prompt = "你好世界 💩";
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt });
    const expectedB64 = Buffer.from(prompt, "utf8").toString("base64");
    expect(ps).toContain(expectedB64);
  });

  it("interpolates folderHint into the title-matching regex", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "my-special-workspace", prompt: "x" });
    expect(ps).toContain("my-special-workspace");
  });

  it("escapes single quotes in folderHint", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "weird'name", prompt: "x" });
    expect(ps).toContain("weird''name");
  });

  it("emits diagnostic Write-Output lines for stdout capture", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt: "x" });
    expect(ps).toContain("candidates=");
    expect(ps).toContain("picked hwnd=");
    expect(ps).toContain("enter-sent");
  });

  it("restores prior clipboard contents (best-effort)", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code", prompt: "x" });
    expect(ps).toContain("Get-Clipboard");
    expect(ps).toContain("savedClip");
  });
});
