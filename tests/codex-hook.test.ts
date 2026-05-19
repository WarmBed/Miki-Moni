import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const hookPath = path.resolve(__dirname, "..", "hooks", "miki-emit-codex.mjs");

function runHook(payload: unknown, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("miki-emit-codex", () => {
  it("emits first-sight session_start, user_prompt, and stop with agent=codex", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "miki-codex-hook-"));
    const sessionsRoot = path.join(tmp, "sessions");
    const rolloutDir = path.join(sessionsRoot, "2026", "05", "19");
    await mkdir(rolloutDir, { recursive: true });
    const uuid = "019e40b9-b1a5-7be1-bab7-52f4a14e67a4";
    await writeFile(
      path.join(rolloutDir, `rollout-2026-05-19T22-52-52-${uuid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: "D:\\code\\cc-hub" } }) + "\n",
    );

    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const result = await runHook(
      { type: "agent-turn-complete", session_id: uuid },
      {
        MIKI_PORT: String(port),
        MIKI_CODEX_SESSIONS_ROOT: sessionsRoot,
        MIKI_CODEX_SEEN_PATH: path.join(tmp, "seen.json"),
      },
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(received.map((x) => x.event_type)).toEqual(["session_start", "user_prompt", "stop"]);
    expect(received.every((x) => x.agent === "codex")).toBe(true);
    expect(received.every((x) => x.cwd === "D:\\code\\cc-hub")).toBe(true);
    expect(JSON.parse(await readFile(path.join(tmp, "seen.json"), "utf8"))).toEqual([uuid]);
  });
});
