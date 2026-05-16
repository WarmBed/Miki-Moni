# Worker Skeleton (Cloudflare Worker example)

This is a starter for the user's Cloudflare Worker. The Worker MUST adhere to `relay-protocol.md` and `pairing-protocol.md`. Implementation choices (Durable Objects vs Hibernation API, KV state) are up to you.

## Minimal contract

```ts
// worker.ts (Cloudflare Worker with Durable Objects)
// This is illustrative — not production-ready

interface Env {
  X_DAEMON_AUTH_TOKEN: string;
  ROUTER: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("OK", { status: 200 });
    }

    // Auth checks
    const path = url.pathname;
    if (path === "/v1/daemon") {
      if (req.headers.get("X-Daemon-Auth") !== env.X_DAEMON_AUTH_TOKEN) {
        return new Response("auth", { status: 401 });
      }
    } else if (path === "/v1/phone") {
      // CF Access populates these headers when SSO is enforced
      const email = req.headers.get("CF-Access-Authenticated-User-Email");
      if (!email) return new Response("sso", { status: 401 });
    } else {
      return new Response("not found", { status: 404 });
    }

    const daemonId = req.headers.get("X-Daemon-Id");
    const pairingToken = req.headers.get("X-Pairing-Token");
    const id = pairingToken ?? daemonId;
    if (!id) return new Response("missing id", { status: 400 });

    // Route to a Durable Object keyed by daemon_id (or pairing_token during pairing)
    const stub = env.ROUTER.get(env.ROUTER.idFromName(id));
    return stub.fetch(req);
  },
};

export class RouterDO {
  private daemonWs: WebSocket | null = null;
  private phoneWss: Set<WebSocket> = new Set();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const role = url.pathname === "/v1/daemon" ? "daemon" : "phone";
    if (role === "daemon") {
      this.daemonWs = server;
    } else {
      this.phoneWss.add(server);
    }

    server.addEventListener("message", (ev) => {
      const data = ev.data;
      if (role === "daemon") {
        for (const phone of this.phoneWss) phone.send(data);
      } else if (this.daemonWs) {
        this.daemonWs.send(data);
      }
    });

    server.addEventListener("close", () => {
      if (role === "daemon" && this.daemonWs === server) this.daemonWs = null;
      else this.phoneWss.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
```

## Notes

- This skeleton uses one DurableObject per daemon_id (or per pairing_token). Pairing-mode and relay-mode use the SAME id space; differentiation is by whether `X-Pairing-Token` was set on connect.
- For pairing, the same DO instance receives both daemon and phone via the shared `pairing_token` — natural rendezvous.
- After pairing, daemon reconnects in relay mode keyed by `X-Daemon-Id` and is matched with phones that connect later with the same `X-Daemon-Id`.
- You can use the **Cloudflare Hibernation API** to avoid keeping the DO alive when idle. Implementation detail.
- **wrangler.toml** needs to declare the DO binding. See Cloudflare docs.

## Local mock-Worker for development

A Node.js mock-Worker is provided at `tools/mock-worker/` in this repo for local dev (no Cloudflare account needed). See `tools/mock-worker/README.md`.

## What you still need to add

- CF Access setup on the Worker route (so `/v1/phone` requires SSO)
- Optional rate-limiting on `/v1/daemon` (Worker-side, beyond X-Daemon-Auth)
- Worker logging that excludes message bodies
- Phone web client (a starter exists at `web-phone/` in this repo for local dev; productionise as needed)
