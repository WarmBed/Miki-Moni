import { PairingCoordinator } from "./pairing-coordinator.js";
import { DaemonRelay } from "./daemon-relay.js";
import { deriveDaemonId, fromBase64 } from "./handshake.js";
import type { Env } from "./env.js";

export { PairingCoordinator, DaemonRelay };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/v1/health") {
      return new Response("ok", { status: 200 });
    }

    // Per-IP rate limit (skip in tests where RATE_LIMITER returns success synthetically)
    if (env.RATE_LIMITER && (url.pathname === "/v1/daemon" || url.pathname === "/v1/phone")) {
      const ip = req.headers.get("CF-Connecting-IP") ?? "test-ip";
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) return new Response("rate limited", { status: 429 });
      } catch { /* binding may be unavailable in some test envs */ }
    }

    if (url.pathname === "/v1/daemon") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pubkey_b64 = req.headers.get("X-Daemon-Pubkey");
      if (!pubkey_b64) return new Response("missing X-Daemon-Pubkey", { status: 400 });
      let pubkey: Uint8Array;
      try {
        pubkey = fromBase64(pubkey_b64);
        if (pubkey.length !== 32) throw new Error("bad length");
      } catch {
        return new Response("bad X-Daemon-Pubkey", { status: 400 });
      }
      const daemon_id = await deriveDaemonId(pubkey);
      const id = env.RELAY.idFromName(daemon_id);
      const stub = env.RELAY.get(id);
      return stub.fetch(req);
    }

    if (url.pathname === "/v1/phone") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pairing_token = req.headers.get("X-Pairing-Token");
      const daemon_id_hdr = req.headers.get("X-Daemon-Id");

      let target_daemon_id: string | null = null;
      if (pairing_token) {
        const coordId = env.PAIRING.idFromName("coordinator");
        const coordStub = env.PAIRING.get(coordId);
        const claimRes = await coordStub.fetch(new Request("https://x/claim", {
          method: "POST",
          body: JSON.stringify({ token: pairing_token }),
          headers: { "content-type": "application/json" },
        }));
        const claim = await claimRes.json() as { ok: boolean; daemon_id?: string; reason?: string };
        if (!claim.ok || !claim.daemon_id) {
          return new Response("invalid_pairing_token", { status: 404 });
        }
        target_daemon_id = claim.daemon_id;
      } else if (daemon_id_hdr) {
        target_daemon_id = daemon_id_hdr;
      } else {
        return new Response("missing X-Pairing-Token or X-Daemon-Id", { status: 400 });
      }

      const id = env.RELAY.idFromName(target_daemon_id);
      const stub = env.RELAY.get(id);
      return stub.fetch(req);
    }

    return new Response("not_found", { status: 404 });
  },
};
