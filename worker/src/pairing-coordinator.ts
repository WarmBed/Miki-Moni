import type { Env } from "./env.js";

export const PAIRING_TTL_MS = 10 * 60 * 1000;   // 10 min
const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const REGISTER_RATE_LIMIT = 100;
const ALARM_INTERVAL_MS = 60_000;               // sweep every 60s

interface PendingEntry {
  daemon_id: string;
  expires_at_ms: number;
  /** Persistent tokens never expire (sweep skips them) and are not consumed on
   *  claim — multiple phones can use the same QR over time, until the user
   *  rotates via `pnpm pair --rotate`. Default false = legacy ephemeral. */
  persistent?: boolean;
}

interface RateEntry {
  count: number;
  window_started_at_ms: number;
}

export class PairingCoordinator implements DurableObject {
  private pending = new Map<string, PendingEntry>();
  private rateLimits = new Map<string, RateEntry>();

  constructor(private state: DurableObjectState, private env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Map<string, PendingEntry>>("pending");
      if (stored) this.pending = stored;
      const rates = await this.state.storage.get<Map<string, RateEntry>>("rates");
      if (rates) this.rateLimits = rates;
      const next = await this.state.storage.getAlarm();
      if (!next) await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\//, "");
    if (req.method !== "POST") return new Response("method", { status: 405 });
    const body = await req.json() as Record<string, unknown>;

    if (path === "register") {
      const token = String(body.token ?? "");
      const daemon_id = String(body.daemon_id ?? "");
      const persistent = body.persistent === true;
      return this.json(await this.register(token, daemon_id, persistent));
    }
    if (path === "claim") {
      const token = String(body.token ?? "");
      return this.json(await this.claim(token));
    }
    if (path === "revoke") {
      const token = String(body.token ?? "");
      await this.revoke(token);
      return this.json({ ok: true });
    }
    return new Response("not_found", { status: 404 });
  }

  private json(o: unknown): Response {
    return new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
  }

  async register(
    token: string,
    daemon_id: string,
    persistent: boolean = false,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!token || !daemon_id) return { ok: false, reason: "bad_input" };
    if (this.pending.size > 10000) return { ok: false, reason: "coordinator_full" };

    const now = Date.now();
    const r = this.rateLimits.get(daemon_id);
    if (r && now - r.window_started_at_ms < REGISTER_RATE_WINDOW_MS) {
      if (r.count >= REGISTER_RATE_LIMIT) return { ok: false, reason: "rate_limited" };
      r.count++;
    } else {
      this.rateLimits.set(daemon_id, { count: 1, window_started_at_ms: now });
    }
    await this.state.storage.put("rates", this.rateLimits);

    // Persistent: never expires. Sentinel via Number.MAX_SAFE_INTEGER so the
    // existing `Date.now() > expires_at_ms` checks naturally fail.
    const expires_at_ms = persistent ? Number.MAX_SAFE_INTEGER : now + PAIRING_TTL_MS;
    this.pending.set(token, { daemon_id, expires_at_ms, persistent: persistent || undefined });
    await this.state.storage.put("pending", this.pending);
    return { ok: true };
  }

  async claim(token: string): Promise<{ ok: true; daemon_id: string } | { ok: false; reason: string }> {
    const entry = this.pending.get(token);
    if (!entry) return { ok: false, reason: "unknown" };
    if (Date.now() > entry.expires_at_ms) {
      this.pending.delete(token);
      await this.state.storage.put("pending", this.pending);
      return { ok: false, reason: "expired" };
    }
    // Persistent tokens stay in the map — same QR keeps working for the next
    // device. Ephemeral tokens are consumed once.
    if (!entry.persistent) {
      this.pending.delete(token);
      await this.state.storage.put("pending", this.pending);
    }
    return { ok: true, daemon_id: entry.daemon_id };
  }

  async revoke(token: string): Promise<void> {
    if (this.pending.delete(token)) {
      await this.state.storage.put("pending", this.pending);
    }
  }

  /** Test-only — inserts a token bypassing rate limit. Not used in production paths. */
  async _test_insert(token: string, daemon_id: string, expires_at_ms: number): Promise<void> {
    this.pending.set(token, { daemon_id, expires_at_ms });
    await this.state.storage.put("pending", this.pending);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [token, entry] of this.pending) {
      // Persistent tokens never expire (they have expires_at_ms set to
      // Number.MAX_SAFE_INTEGER, but check the flag too in case of legacy data).
      if (entry.persistent) continue;
      if (entry.expires_at_ms < now) {
        this.pending.delete(token);
        changed = true;
      }
    }
    if (changed) await this.state.storage.put("pending", this.pending);

    let rateChanged = false;
    for (const [did, r] of this.rateLimits) {
      if (now - r.window_started_at_ms > REGISTER_RATE_WINDOW_MS) {
        this.rateLimits.delete(did);
        rateChanged = true;
      }
    }
    if (rateChanged) await this.state.storage.put("rates", this.rateLimits);

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}
