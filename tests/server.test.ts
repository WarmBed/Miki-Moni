import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildCodexExecArgs, createApp } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import { HookHandler } from "../src/hook-handler.js";
import { SessionResolver } from "../src/session-resolver.js";
import { Notifier } from "../src/notifier.js";
import { VscodeBridge } from "../src/vscode-bridge.js";
import type { VersionChecker } from "../src/version-check.js";
import type { PerfStore } from "../src/perf-store.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const fixturesRoot = path.join(__dirname, "fixtures", "projects");

const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

describe("buildCodexExecArgs", () => {
  it("adds skip-git-repo-check for fresh pending Codex exec", () => {
    expect(buildCodexExecArgs({ sessionUuid: "codex-pending:d:\\code:launch", cwd: "d:\\code" }))
      .toEqual(["exec", "--skip-git-repo-check", "-C", "d:\\code", "-"]);
  });

  it("adds skip-git-repo-check for resumed Codex exec with images", () => {
    expect(buildCodexExecArgs({ sessionUuid: "019e40b9-b1a5-7be1-bab7-52f4a14e67a4", cwd: "d:\\code", imageFiles: ["a.png"] }))
      .toEqual(["exec", "--skip-git-repo-check", "resume", "--image", "a.png", "019e40b9-b1a5-7be1-bab7-52f4a14e67a4", "-"]);
  });
});

function buildApp(overrides?: {
  versionChecker?: VersionChecker;
  transcriptRoots?: { claudeProjectsRoot?: string; codexSessionsRoot?: string };
  perfStore?: PerfStore;
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

describe("GET /metrics", () => {
  it("annotates metric rows with agent and filters by agent", async () => {
    const now = Date.now();
    const perfStore = {
      query: () => [
        { session_uuid: "claude-1", ts: now - 100, ttft_ms: 100, tps: 20, char_count: 20, duration_ms: 1000 },
        { session_uuid: "codex-1", ts: now - 50, ttft_ms: 300, tps: 10, char_count: 30, duration_ms: 3000 },
      ],
      fleetAvg: () => ({ avg_ttft: null, avg_tps: null }),
    } as unknown as PerfStore;
    const { app, store } = buildApp({ perfStore });
    store.upsert({
      cwd: "d:\\code\\claude",
      session_uuid: "claude-1",
      agent: "claude",
      project_name: "claude-proj",
      status: "active",
      last_event_at: now + 5_000,
      last_message_preview: "",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });
    store.upsert({
      cwd: "d:\\code\\codex",
      session_uuid: "codex-1",
      agent: "codex",
      project_name: "codex-proj",
      status: "active",
      last_event_at: now,
      last_message_preview: "",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });

    const all = await request(app).get("/metrics?window=1h");
    expect(all.status).toBe(200);
    expect(all.body.metrics.map((m: any) => m.agent)).toEqual(["claude", "codex"]);
    expect(all.body.fleet_avg_ttft).toBe(200);
    expect(all.body.fleet_avg_tps).toBe(15);

    const codex = await request(app).get("/metrics?window=1h&agent=codex");
    expect(codex.status).toBe(200);
    expect(codex.body.agent).toBe("codex");
    expect(codex.body.metrics).toHaveLength(1);
    expect(codex.body.metrics[0].session_uuid).toBe("codex-1");
    expect(codex.body.fleet_avg_ttft).toBe(300);
    expect(codex.body.fleet_avg_tps).toBe(10);
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
    expect(transcript.body.turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(transcript.body.turns[0].text).toBe("check dashboard");
    expect(transcript.body.turns[1].tool_use.name).toBe("shell_command");
    expect(transcript.body.turns[2].tool_result.content).toBe("PASS");
  });

  it("does not attach an older cwd rollout to a fresh pending Codex card", async () => {
    const uuid = "019e40b9-b1a5-7be1-bab7-52f4a14e67a4";
    const codexRoot = await makeCodexRoot(uuid);
    const { app, store } = buildApp({
      transcriptRoots: {
        claudeProjectsRoot: path.join(os.tmpdir(), "missing-claude-projects"),
        codexSessionsRoot: codexRoot,
      },
    });
    const pendingUuid = "codex-pending:d:\\code\\cc-hub:fresh-launch";
    store.upsert({
      cwd: "d:\\code\\cc-hub",
      session_uuid: pendingUuid,
      agent: "codex",
      project_name: "cc-hub",
      status: "active",
      last_event_at: Date.parse("2026-05-20T00:00:00.000Z"),
      last_message_preview: "Codex CLI launched - waiting for first turn",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });

    const previews = await request(app).get("/sessions/previews");
    expect(previews.status).toBe(200);
    expect(previews.body).toHaveLength(0);

    const meta = await request(app).get(`/sessions/${encodeURIComponent(pendingUuid)}/transcript-meta`);
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ session_uuid: pendingUuid, file_size: 0, last_modified: null, pending: true });

    const transcript = await request(app).get(`/sessions/${encodeURIComponent(pendingUuid)}/transcript?limit=20`);
    expect(transcript.status).toBe(200);
    expect(transcript.body).toMatchObject({ session_uuid: pendingUuid, transcript_path: null, turn_count: 0, turns: [], pending: true });
  });

  it("does not fan one pending Codex rollout out to every pending card in the same cwd", async () => {
    const uuid = "019e40b9-b1a5-7be1-bab7-52f4a14e67a4";
    const codexRoot = await makeCodexRoot(uuid);
    const { app, store } = buildApp({
      transcriptRoots: {
        claudeProjectsRoot: path.join(os.tmpdir(), "missing-claude-projects"),
        codexSessionsRoot: codexRoot,
      },
    });
    const olderPending = "codex-pending:d:\\code\\cc-hub:11111111-1111-4111-8111-111111111111";
    const targetPending = "codex-pending:d:\\code\\cc-hub:22222222-2222-4222-8222-222222222222";
    const now = Date.now();
    store.upsert({
      cwd: "d:\\code\\cc-hub",
      session_uuid: olderPending,
      agent: "codex",
      project_name: "cc-hub",
      status: "active",
      last_event_at: now - 120_000,
      last_message_preview: "Codex CLI launched - waiting for first turn",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });
    store.upsert({
      cwd: "d:\\code\\cc-hub",
      session_uuid: targetPending,
      agent: "codex",
      project_name: "cc-hub",
      status: "active",
      last_event_at: now,
      last_message_preview: "Codex CLI launched - waiting for first turn",
      tokens_in: 0,
      tokens_out: 0,
      vscode_pid: null,
    });

    const previews = await request(app).get("/sessions/previews");
    expect(previews.status).toBe(200);
    expect(previews.body.map((p: any) => p.session_uuid)).not.toContain(olderPending);

    const olderTranscript = await request(app).get(`/sessions/${encodeURIComponent(olderPending)}/transcript?limit=20`);
    expect(olderTranscript.status).toBe(200);
    expect(olderTranscript.body).toMatchObject({ session_uuid: olderPending, transcript_path: null, turn_count: 0, turns: [], pending: true });
  });
});
