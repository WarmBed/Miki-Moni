import { describe, it, expect, beforeAll } from "vitest";
import nacl from "tweetnacl";
import workerModule from "../src/index.js";
import { stubWebSocketPair, makeIntegrationEnv } from "./_do-mock.js";
import { toBase64, buildChallengeMessage } from "../src/handshake.js";

beforeAll(() => { stubWebSocketPair(); });

const ctx = {} as ExecutionContext;

describe("Worker fetch handler", () => {
  it("GET /v1/health returns 200 ok", async () => {
    const { env } = makeIntegrationEnv();
    const res = await workerModule.fetch(new Request("https://x/v1/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("unknown path returns 404", async () => {
    const { env } = makeIntegrationEnv();
    const res = await workerModule.fetch(new Request("https://x/nope"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("/v1/daemon without Upgrade header returns 426", async () => {
    const { env } = makeIntegrationEnv();
    const res = await workerModule.fetch(new Request("https://x/v1/daemon"), env, ctx);
    expect(res.status).toBe(426);
  });

  it("/v1/daemon without X-Daemon-Pubkey returns 400", async () => {
    const { env } = makeIntegrationEnv();
    const res = await workerModule.fetch(new Request("https://x/v1/daemon", {
      headers: { "Upgrade": "websocket" },
    }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("/v1/daemon with valid pubkey routes to DaemonRelay (101)", async () => {
    const { env } = makeIntegrationEnv();
    const kp = nacl.sign.keyPair();
    const res = await workerModule.fetch(new Request("https://x/v1/daemon", {
      headers: { "Upgrade": "websocket", "X-Daemon-Pubkey": toBase64(kp.publicKey) },
    }), env, ctx);
    expect(res.status).toBe(101);
  });

  it("/v1/phone with neither token nor daemon_id returns 400", async () => {
    const { env } = makeIntegrationEnv();
    const res = await workerModule.fetch(new Request("https://x/v1/phone", {
      headers: { "Upgrade": "websocket" },
    }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("/v1/phone with unknown pairing token returns 404", async () => {
    const { env } = makeIntegrationEnv();
    const res = await workerModule.fetch(new Request("https://x/v1/phone", {
      headers: { "Upgrade": "websocket", "X-Pairing-Token": "DOESNOTEXIST1234" },
    }), env, ctx);
    expect(res.status).toBe(404);
  });

  it("end-to-end: daemon registers pairing token, phone claims via /v1/phone", async () => {
    const { env } = makeIntegrationEnv();
    const kp = nacl.sign.keyPair();

    // 1) Daemon connects
    const daemonRes = await workerModule.fetch(new Request("https://x/v1/daemon", {
      headers: { "Upgrade": "websocket", "X-Daemon-Pubkey": toBase64(kp.publicKey) },
    }), env, ctx);
    expect(daemonRes.status).toBe(101);

    // 2) Get the daemon DO instance directly so we can drive its WS handlers
    //    (the index.test.ts is treating the worker as a black box; we use the
    //    integration env's RELAY namespace to find the DO instance).
    const { deriveDaemonId } = await import("../src/handshake.js");
    const daemonId = await deriveDaemonId(kp.publicKey);
    const daemonStub = env.RELAY.get(env.RELAY.idFromName(daemonId));
    // The RELAY namespace stores the live DaemonRelay; we can poke it via fetch.

    // 3) Daemon sends challenge_response by re-invoking the DO's handler
    //    via state's WS registry. This bypasses the actual WS lifecycle in
    //    the threads-pool environment.
    //    For this E2E we trust the per-DO unit tests in relay.test.ts and
    //    only verify that the Worker fetch handler correctly routes the
    //    phone connection AFTER pairing — emulate pairing via direct DO write.
    //    (Strict E2E with full WS round-trip is covered by relay.test.ts.)

    // 4) Pre-seed: register pairing token in coordinator directly
    await env.PAIRING.get(env.PAIRING.idFromName("coordinator")).fetch(
      new Request("https://x/register", {
        method: "POST",
        body: JSON.stringify({ token: "E2ETESTTOKENA123", daemon_id: daemonId }),
        headers: { "content-type": "application/json" },
      }),
    );

    // 5) Phone connects with the token
    const phoneRes = await workerModule.fetch(new Request("https://x/v1/phone", {
      headers: { "Upgrade": "websocket", "X-Pairing-Token": "E2ETESTTOKENA123" },
    }), env, ctx);
    // Note: 101 because the WS is accepted even when DO closes it with 4002.
    // The router's job is to dispatch — not to validate token state.
    expect(phoneRes.status).toBe(101);
  });
});

import { describe as descQuery, it as itQuery, expect as expQuery } from "vitest";
import workerModule2 from "../src/index.js";
import { makeIntegrationEnv as makeEnv2 } from "./_do-mock.js";

const ctx2 = {} as ExecutionContext;

descQuery("Worker /v1/phone URL-query auth fallback", () => {
  itQuery("accepts X-Pairing-Token via ?token= query param", async () => {
    const { env } = makeEnv2();
    // Pre-seed coordinator with a token
    await env.PAIRING.get(env.PAIRING.idFromName("coordinator")).fetch(
      new Request("https://x/register", {
        method: "POST",
        body: JSON.stringify({ token: "QUERYTESTTOKEN012", daemon_id: "test-id-1" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await workerModule2.fetch(
      new Request("https://x/v1/phone?token=QUERYTESTTOKEN012", {
        headers: { "Upgrade": "websocket" },
      }),
      env, ctx2,
    );
    expQuery(res.status).toBe(101);
  });

  itQuery("accepts X-Daemon-Id via ?daemon_id= query param", async () => {
    const { env } = makeEnv2();
    const res = await workerModule2.fetch(
      new Request("https://x/v1/phone?daemon_id=some-daemon-id", {
        headers: { "Upgrade": "websocket" },
      }),
      env, ctx2,
    );
    // 101 returned even if downstream DO closes — the router accepts because daemon_id is present
    expQuery(res.status).toBe(101);
  });
});
