import { describe, it, expect } from "vitest";
import path from "node:path";
import { SessionResolver, encodeCwd } from "../src/session-resolver.js";

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
