import { describe, it, expect, beforeEach } from "vitest";
import { PairingCoordinator } from "../src/pairing-coordinator.js";
import { makeMockState, makeMockEnv } from "./_do-mock.js";

async function callDO(do_instance: PairingCoordinator, method: string, body: unknown): Promise<any> {
  const res = await do_instance.fetch(new Request(`https://x/${method}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }));
  return res.json();
}

describe("PairingCoordinator", () => {
  let coord: PairingCoordinator;

  beforeEach(async () => {
    coord = new PairingCoordinator(makeMockState("coordinator"), makeMockEnv());
    // Allow blockConcurrencyWhile in constructor to settle
    await new Promise((r) => setTimeout(r, 0));
  });

  describe("register + claim happy path", () => {
    it("daemon registers a token, phone claims it, gets daemon_id", async () => {
      const reg = await callDO(coord, "register", { token: "ABC123XYZ4567890", daemon_id: "d-1" });
      expect(reg).toEqual({ ok: true });

      const claim = await callDO(coord, "claim", { token: "ABC123XYZ4567890" });
      expect(claim).toEqual({ ok: true, daemon_id: "d-1" });
    });

    it("token can only be claimed once", async () => {
      await callDO(coord, "register", { token: "ONCEONLY12345678", daemon_id: "d-2" });
      const first = await callDO(coord, "claim", { token: "ONCEONLY12345678" });
      expect(first.ok).toBe(true);

      const second = await callDO(coord, "claim", { token: "ONCEONLY12345678" });
      expect(second.ok).toBe(false);
      expect(second.reason).toMatch(/unknown|already_claimed/);
    });
  });

  describe("claim of unknown token", () => {
    it("returns reason=unknown", async () => {
      const res = await callDO(coord, "claim", { token: "NOTREGISTEREDXYZ" });
      expect(res).toEqual({ ok: false, reason: "unknown" });
    });
  });

  describe("revoke", () => {
    it("removes the token so claim fails", async () => {
      await callDO(coord, "register", { token: "REVOKEME12345678", daemon_id: "d-3" });
      await callDO(coord, "revoke", { token: "REVOKEME12345678" });
      const res = await callDO(coord, "claim", { token: "REVOKEME12345678" });
      expect(res.ok).toBe(false);
    });
  });

  describe("expiry via alarm", () => {
    it("alarm fires and removes expired tokens", async () => {
      // Use the test-only insert helper to bypass rate limit and inject expired entry
      await coord._test_insert("EXPIRED123456789", "d-4", Date.now() - 60_000);
      // Trigger alarm manually
      await coord.alarm();
      const res = await callDO(coord, "claim", { token: "EXPIRED123456789" });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("unknown");
    });
  });

  describe("rate limit on register (10/hour/daemon_id)", () => {
    it("11th register from same daemon_id within 1h returns rate_limited", async () => {
      const did = "d-spam";
      for (let i = 0; i < 10; i++) {
        const r = await callDO(coord, "register", { token: `SPAM${i.toString().padStart(12, "0")}`, daemon_id: did });
        expect(r.ok).toBe(true);
      }
      const r11 = await callDO(coord, "register", { token: "SPAMOVERFLOW1234", daemon_id: did });
      expect(r11).toEqual({ ok: false, reason: "rate_limited" });
    });
  });
});
