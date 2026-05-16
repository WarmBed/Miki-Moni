import { describe, it, expect, vi } from "vitest";
import { VscodeBridge } from "../src/vscode-bridge.js";

describe("VscodeBridge", () => {
  it("focuses by sessionUuid only — no prompt encoded", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.focus("uuid-1234");
    expect(launch).toHaveBeenCalledWith("vscode://anthropic.claude-code/open?session=uuid-1234");
  });

  it("falls back to plain open when sessionUuid is null", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.focus(null);
    expect(launch).toHaveBeenCalledWith("vscode://anthropic.claude-code/open");
  });

  it("send encodes the prompt", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.send("uuid-1234", "跑 npm test");
    const expectedPrompt = encodeURIComponent("跑 npm test");
    expect(launch).toHaveBeenCalledWith(
      `vscode://anthropic.claude-code/open?session=uuid-1234&prompt=${expectedPrompt}`
    );
  });

  it("send works without sessionUuid (no session param)", async () => {
    const launch = vi.fn();
    const b = new VscodeBridge(launch);
    await b.send(null, "hello");
    expect(launch).toHaveBeenCalledWith(
      `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent("hello")}`
    );
  });
});
