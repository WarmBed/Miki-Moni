import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { Notifier } from "../src/notifier.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import type { VersionChecker } from "../src/version-check.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const fixturesRoot = path.join(__dirname, "fixtures", "projects");

const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

function buildApp(overrides?: {
  versionChecker?: VersionChecker;
  transcriptRoots?: { claudeProjectsRoot?: string; codexSessionsRoot?: string };
}) {
  const store = new SessionStore(":memory:");
  const resolver = new SessionResolver(fixturesRoot);
  const notifier = new Notifier();
  const handler = new HookHandler(store, resolver, notifier);
  const bridge = new VscodeBridge();
  return { store, ...createApp({ store, handler, bridge, notifier, webDir: "/tmp", log, ...overrides }) };
}

describe("GET /admin/version-check", () => {
  it("returns 200 with shape", async () => {
    const fakeChecker = {
      get: async () => ({
        current: "0.3.13",
        latest: "0.3.14",
        hasUpdate: true,
        fetchedAt: 1779180000000,
        error: null as null,
      }),
    } as unknown as VersionChecker;

    const { app } = buildApp({ versionChecker: fakeChecker });
    const r = await request(app).get("/admin/version-check");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      current: "0.3.13",
      latest: "0.3.14",
      hasUpdate: true,
      fetchedAt: 1779180000000,
      error: null,
    });
  });
});

describe("Codex transcript endpoints", () => {
  async function makeCodexRoot(uuid: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-server-"));
    const nested = path.join(root, "2026", "05", "19");
    await fs.mkdir(nested, { recursive: true });
    const tpath = path.join(nested, `rollout-2026-05-19T22-52-52-${uuid}.jsonl`);
    const entries = [
      { timestamp: "2026-05-19T14:53:04.331Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<environment_context>...</environment_context>" }] } },
      { timestamp: "2026-05-19T14:53:04.332Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "check dashboard" }] } },
      { timestamp: "2026-05-19T14:53:06.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "call_1", arguments: JSON.stringify({ command: "pnpm test" }) } },
      { timestamp: "2026-05-19T14:53:07.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "PASS" } },
      { timestamp: "2026-05-19T14:53:08.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Looks good." }] } },
    ];
    await fs.writeFile(tpath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return root;
  }

  it("includes Codex rollout data in /sessions/previews and /transcript", async () => {
    const uuid = "019e40b9-b1a5-7be1-bab7-52f4a14e67a4";
    const codexRoot = await makeCodexRoot(uuid);
    const { app, store } = buildApp({
      transcriptRoots: {
        claudeProjectsRoot: path.join(os.tmpdir(), "missing-claude-projects"),
        codexSessionsRoot: codexRoot,
      },
    });
    store.upsert({
      cwd: "d:\\code\\cc-hub",
      session_uuid: uuid,
      agent: "codex",
      project_name: "cc-hub",
      status: "active",
      last_event_at: 1779202385731,
      last_message_preview: "",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });

    const previews = await request(app).get("/sessions/previews");
    expect(previews.status).toBe(200);
    expect(previews.body).toHaveLength(1);
    expect(previews.body[0].last_user_text).toBe("check dashboard");
    expect(previews.body[0].last_assistant_text).toBe("Looks good.");
    expect(previews.body[0].last_tool_use).toEqual({ name: "shell_command", description: "pnpm test" });

    const transcript = await request(app).get(`/sessions/${uuid}/transcript?limit=20`);
    expect(transcript.status).toBe(200);
    expect(transcript.body.turns.map((t: any) => t.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(transcript.body.turns[1].text).toBe("check dashboard");
    expect(transcript.body.turns[2].tool_use.name).toBe("shell_command");
    expect(transcript.body.turns[3].tool_result.content).toBe("PASS");
  });
});
