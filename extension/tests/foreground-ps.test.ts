import { describe, it, expect } from "vitest";
import { buildFocusAndEnterPS } from "../src/foreground-ps.js";

describe("buildFocusAndEnterPS", () => {
  it("contains the Win32 P/Invoke signature block", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).toContain("SetForegroundWindow");
    expect(ps).toContain("AttachThreadInput");
    expect(ps).toContain("SwitchToThisWindow");
    expect(ps).toContain("keybd_event");
  });

  it("does NOT fire a vscode:// URI — that's the extension's job", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).not.toContain("Start-Process");
    expect(ps).not.toContain("vscode://");
  });

  it("ends with SendKeys ENTER (so a successful run actually submits)", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).toContain("SendKeys");
    expect(ps).toContain("{ENTER}");
  });

  it("interpolates folderHint into the title-matching regex", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "my-special-workspace" });
    expect(ps).toContain("my-special-workspace");
  });

  it("escapes single quotes in folderHint", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "weird'name" });
    expect(ps).toContain("weird''name");
  });

  it("emits diagnostic Write-Output lines for stdout capture", () => {
    const ps = buildFocusAndEnterPS({ folderHint: "code" });
    expect(ps).toContain("candidates=");
    expect(ps).toContain("picked hwnd=");
    expect(ps).toContain("enter-sent");
  });
});
