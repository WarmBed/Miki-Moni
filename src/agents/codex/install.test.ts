import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { _installCodexHooksTo } from "./install.js";

describe("installCodexHooks", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `miki-codex-toml-${Date.now()}-${Math.random()}.toml`);
  });
  afterEach(async () => {
    await fs.rm(tmp, { force: true });
    await fs.rm(tmp + ".miki-moni.bak", { force: true });
  });

  it("writes notify into a fresh empty config", async () => {
    const r = await _installCodexHooksTo(tmp);
    expect(r.installed).toBe(true);
    const text = await fs.readFile(tmp, "utf8");
    expect(text).toMatch(/notify\s*=\s*\[/);
    expect(text).toMatch(/miki-emit-codex\.mjs/);
  });

  it("is idempotent — second call same notify, no spurious write", async () => {
    await _installCodexHooksTo(tmp);
    const text1 = await fs.readFile(tmp, "utf8");
    const r2 = await _installCodexHooksTo(tmp);
    expect(r2.installed).toBe(true);
    const text2 = await fs.readFile(tmp, "utf8");
    expect(text2).toBe(text1);
  });

  it("refuses to overwrite a user-defined notify and reports a warning", async () => {
    await fs.writeFile(tmp, `notify = ["echo", "user owns this"]\n`);
    const r = await _installCodexHooksTo(tmp);
    expect(r.installed).toBe(false);
    expect(r.warning).toMatch(/already defines notify/i);
    expect(await fs.readFile(tmp, "utf8")).toMatch(/echo/);
  });

  it("preserves unrelated [projects.'...'] tables across round-trip", async () => {
    await fs.writeFile(tmp,
      `model = "gpt-5.5"\n\n[projects.'d:\\\\code\\\\x']\ntrust_level = "trusted"\n`);
    await _installCodexHooksTo(tmp);
    const text = await fs.readFile(tmp, "utf8");
    // @iarna/toml may re-quote/escape; we only check that the project key + value survive somehow
    expect(text).toMatch(/projects\./);
    expect(text).toMatch(/trust_level = "trusted"/);
    expect(text).toMatch(/notify\s*=\s*\[/);
  });
});
