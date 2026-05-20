import { describe, expect, it } from "vitest";
import { stripCodexBrowserContext } from "../shared/codex-display.js";

describe("stripCodexBrowserContext", () => {
  it("keeps normal user text unchanged", () => {
    expect(stripCodexBrowserContext("hello codex")).toBe("hello codex");
  });

  it("strips Codex desktop in-app browser preamble", () => {
    const text = [
      "# In app browser:",
      "- The user has the in-app browser open.",
      "- Current URL: http://127.0.0.1:8765/",
      "",
      "## My request for Codex:",
      "OK 你說的對 我希望codex也有同樣的功能",
    ].join("\n");

    expect(stripCodexBrowserContext(text)).toBe("OK 你說的對 我希望codex也有同樣的功能");
  });

  it("strips compact one-line browser context", () => {
    const text = "In app browser: The user has the in-app browser open. · Current URL: http://127.0.0.1:8765/ · My request for Codex: test";

    expect(stripCodexBrowserContext(text)).toBe("test");
  });
});
