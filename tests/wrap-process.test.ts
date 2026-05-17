import { describe, it, expect } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { WrapProcessRegistry, killProcessTree } from "../src/wrap-process.js";
import { sessionHasAnyTurns, readOriginalCwd } from "../src/session-resolver.js";

const FIXTURES_TRANSCRIPTS = path.join(__dirname, "fixtures", "transcripts");

describe("WrapProcessRegistry", () => {
  it("records a -r spawn and binds the PID later", () => {
    const reg = new WrapProcessRegistry();
    reg.recordSpawn({ sessionUuid: "uuid-1", cwd: "d:\\x" });
    expect(reg.size()).toBe(1);
    reg.bindPid("uuid-1", 12345);
    const list = reg.list();
    expect(list[0]?.pid).toBe(12345);
  });

  it("promotes a --fresh spawn to a uuid on bindPid", () => {
    const reg = new WrapProcessRegistry();
    reg.recordSpawn({ sessionUuid: null, cwd: "d:\\x" });
    reg.bindPid("uuid-fresh", 999);
    expect(reg.size()).toBe(1);
    const rec = reg.list()[0]!;
    expect(rec.sessionUuid).toBe("uuid-fresh");
    expect(rec.pid).toBe(999);
  });

  it("ignores bindPid for sessions we never spawned (external wrap)", () => {
    const reg = new WrapProcessRegistry();
    reg.bindPid("never-recorded", 1234);
    expect(reg.size()).toBe(0);
  });

  it("takeOnClose returns the record and removes it from the registry", () => {
    const reg = new WrapProcessRegistry();
    reg.recordSpawn({ sessionUuid: "u-2", cwd: "d:\\y" });
    reg.bindPid("u-2", 4242);
    const rec = reg.takeOnClose("u-2");
    expect(rec?.pid).toBe(4242);
    expect(reg.size()).toBe(0);
    expect(reg.takeOnClose("u-2")).toBeNull();
  });

  it("FIFO: oldest pending fresh record is promoted first", () => {
    const reg = new WrapProcessRegistry();
    reg.recordSpawn({ sessionUuid: null, cwd: "d:\\a" });
    reg.recordSpawn({ sessionUuid: null, cwd: "d:\\b" });
    reg.bindPid("first", 1);
    reg.bindPid("second", 2);
    const list = reg.list();
    const byUuid = Object.fromEntries(list.map((r) => [r.sessionUuid, r]));
    expect(byUuid["first"]?.cwd).toBe("d:\\a");
    expect(byUuid["second"]?.cwd).toBe("d:\\b");
  });
});

describe("killProcessTree", () => {
  it("resolves silently for a non-existent PID", async () => {
    // Picking a PID that's astronomically unlikely to exist.
    await expect(killProcessTree(999_999_999)).resolves.toBeUndefined();
  });

  it("ignores invalid PIDs without throwing", async () => {
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
    await expect(killProcessTree(NaN)).resolves.toBeUndefined();
  });

  it("actually kills a live process tree", async () => {
    // Spawn a short-lived child that would otherwise sleep for ~60s, then
    // confirm killProcessTree terminates it. Cross-platform via node itself.
    const child = spawn(process.execPath, [
      "-e", "setTimeout(()=>{}, 60_000)",
    ], { detached: false, stdio: "ignore" });
    expect(child.pid).toBeTypeOf("number");
    // Allow the OS a moment to fully spawn the process.
    await new Promise((r) => setTimeout(r, 100));
    await killProcessTree(child.pid!);
    // Wait for the exit event with a short timeout.
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    expect(exited).toBe(true);
  });
});

describe("sessionHasAnyTurns", () => {
  it("returns false when the transcript file doesn't exist", async () => {
    const fake = path.join(os.tmpdir(), "miki-test-does-not-exist.jsonl");
    expect(await sessionHasAnyTurns(fake)).toBe(false);
  });

  it("returns false when transcript only has tool_result + synthetic messages", async () => {
    const fp = path.join(FIXTURES_TRANSCRIPTS, "no-real-turns.jsonl");
    expect(await sessionHasAnyTurns(fp)).toBe(false);
  });

  it("returns true when there's a real user text message", async () => {
    const fp = path.join(FIXTURES_TRANSCRIPTS, "with-user-turn.jsonl");
    expect(await sessionHasAnyTurns(fp)).toBe(true);
  });

  it("returns true when there's an assistant text block", async () => {
    const fp = path.join(FIXTURES_TRANSCRIPTS, "with-assistant-text.jsonl");
    expect(await sessionHasAnyTurns(fp)).toBe(true);
  });

  it("returns false for an empty file", async () => {
    const tmp = path.join(os.tmpdir(), `miki-test-empty-${Date.now()}.jsonl`);
    await fs.writeFile(tmp, "", "utf8");
    try {
      expect(await sessionHasAnyTurns(tmp)).toBe(false);
    } finally {
      await fs.unlink(tmp).catch(() => { /* ignore */ });
    }
  });
});

describe("readOriginalCwd", () => {
  it("returns the FIRST cwd encountered, ignoring later drift", async () => {
    // Fixture has cwd:d:\code\dragonfly on line 3, then d:\code\dragonfly\subdir
    // on line 4. We must return the first one — that's what the SDK encodes
    // its projects-dir lookup from.
    const fp = path.join(FIXTURES_TRANSCRIPTS, "with-cwd.jsonl");
    expect(await readOriginalCwd(fp)).toBe("d:\\code\\dragonfly");
  });

  it("returns null when no JSONL entries carry a cwd field", async () => {
    const fp = path.join(FIXTURES_TRANSCRIPTS, "no-cwd.jsonl");
    expect(await readOriginalCwd(fp)).toBeNull();
  });

  it("returns null when transcript file doesn't exist", async () => {
    const fake = path.join(os.tmpdir(), "miki-test-cwd-missing.jsonl");
    expect(await readOriginalCwd(fake)).toBeNull();
  });
});
