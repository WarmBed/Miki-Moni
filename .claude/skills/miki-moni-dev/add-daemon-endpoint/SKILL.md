---
name: miki-moni-dev-add-daemon-endpoint
description: Use when adding a new HTTP route, WebSocket handler, or `/admin/*` endpoint to the miki-moni daemon (src/server.ts). Triggers on "新增 daemon endpoint", "add route to miki", "new express route", "add admin endpoint", "expose new API on 8765". Covers the DNS-rebind-guard interaction, logging conventions, error format, and where similar endpoints live as templates.
---

# Adding a Daemon HTTP Endpoint

The miki-moni daemon serves a small HTTP/WS API on `127.0.0.1:8765` that the dashboard, helper extension, and CLI consume. Adding a route requires touching `src/server.ts` plus possibly the dashboard's `web/api.ts` if the dashboard needs to call it.

## Where things go in `src/server.ts`

```
createApp(deps):
  1. express() + body limit
  2. DNS-rebind guard middleware    ← must stay first
  3. WrapProcessRegistry init
  4. /event                          ← hook intake
  5. /admin/*                        ← system tray + restart
  6. /sessions/*                     ← transcript reads
  7. /send                           ← prompt push (wrap-push fast path)
  8. /wrap/*                         ← per-session control (mode, model, start)
  9. WS upgrade handlers
 10. server.listen / WSServer init
```

Pick a section that matches your endpoint's purpose. Add your route adjacent to similar ones.

## Three templates

### A. Plain GET/POST returning JSON

Use this for simple state reads / writes. Example: `/admin/pid`.

```ts
app.post("/admin/your-new-thing", async (req: Request, res: Response) => {
  // 1. Validate input
  const foo = typeof req.body?.foo === "string" ? req.body.foo : null;
  if (!foo) { res.status(400).json({ error: "missing foo" }); return; }

  // 2. Do the thing
  try {
    const result = await someAction(foo);
    deps.log?.info({ route: "/admin/your-new-thing", foo }, "did the thing");
    res.json({ ok: true, ...result });
  } catch (err) {
    deps.log?.error({ route: "/admin/your-new-thing", error: String(err) }, "failed");
    res.status(500).json({ error: String(err) });
  }
});
```

### B. Session-scoped endpoint (resolves session UUID/cwd)

For anything that takes "which session?" as input. Example: `/send`, `/wrap/permission-mode`.

```ts
app.post("/your-route", async (req: Request, res: Response) => {
  const { session, key, via } = resolveSession(req.body);   // helper in server.ts
  if (!via) { res.status(400).json({ error: "missing session_uuid or cwd" }); return; }
  if (!session) { res.status(404).json({ error: "session not found", lookup: { via, key } }); return; }
  // ... work with `session` object
});
```

### C. WebSocket route

Use the existing `wss` / `wssExt` patterns. Don't add new WS servers — extend dispatch logic in the existing ones.

## DNS-rebind guard interaction

The middleware at the top of `createApp` rejects requests whose `Host` header isn't a loopback form. Your new route gets this protection **automatically** — you don't need to add per-route checks.

**BUT**: if your endpoint is called from a non-browser context (e.g. the system tray script, hook PowerShell), the caller must still send `Host: 127.0.0.1:<port>` (it will by default with localhost URLs). Just don't construct requests like `curl -H "Host: something-else" ...`.

**If your endpoint needs to accept calls from a specific extra hostname** (rare — e.g. unusual reverse proxy setup): document the `MIKI_TRUSTED_HOSTS=...` env workaround; do NOT bypass the middleware.

## Logging conventions

Use the structured `deps.log` (pino):

```ts
deps.log?.info({ route: "/X", session_uuid, key1, key2 }, "short message");
deps.log?.warn({ ... }, "...");
deps.log?.error({ route, error: String(err) }, "...");
```

Always include `route` so log filtering by endpoint works. Never log secrets (`pair_token`, `shared_secret`, `signing_privkey`, `data` of image blocks).

## Error response format

```ts
res.status(NNN).json({ error: "snake_case_code", detail?: "optional human msg" });
```

Status codes:
- `400` malformed input (missing required field, wrong type)
- `403` rejected by policy (DNS-rebind middleware uses this; reserve for similar)
- `404` resource not found (session, JSONL, etc)
- `500` unexpected internal error
- `503` daemon is shutting down / not ready

## If the dashboard needs to call your new endpoint

1. Add a typed wrapper in `web/api.ts`:
   ```ts
   export async function yourNewCall(body: { foo: string }): Promise<{ ok: boolean }> {
     const r = await apiFetch("/admin/your-new-thing", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
     return await r.json();
   }
   ```
2. Call from `web/app.tsx`. `apiFetch` is wired through `TunnelTransport` for remote/Pages users — DON'T hand-roll `fetch("http://127.0.0.1:8765/...")` or it'll break for phone users.

## If the helper extension calls it

`extension/` registers WS handlers on `/ws_ext`. For most new daemon→helper signals, extend `protocol-ext.ts` (`ExtMessage` union) and the dispatcher in `src/server.ts`, NOT a new HTTP route.

## Required testing

```
1. pnpm typecheck
2. pnpm vitest run tests/integration.test.ts    (covers most server routes)
3. Manual smoke from curl with right Host header:
     curl -X POST -H "Host: 127.0.0.1:8765" -H "Content-Type: application/json" \
       --data '{"foo":"bar"}' http://127.0.0.1:8765/admin/your-new-thing
4. If dashboard calls it: hard reload dashboard + try the UI path
```

## Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Adding `app.use(express.json())` again inside your handler | "stream already read" or `req.body` undefined | The top-level `app.use(express.json({limit:"20mb"}))` already runs — don't re-add |
| Calling `fetch("http://127.0.0.1:8765/...")` from `web/app.tsx` | Works on dashboard, broken for phone PWA users | Always use `apiFetch` from `web/api.ts` |
| Putting middleware AFTER routes | Routes don't get the middleware | Middleware in `createApp` runs in declaration order; add yours next to the DNS-rebind block |
| Logging the full request body | Secrets in `~/.miki-moni/miki-moni.log` | Log only specific fields you need |
| Forgetting `return` after `res.status(NNN).json(...)` | Falls through to next code, sometimes double-sends | Always `return` after a `res.status().json()` |
| Adding a new WS server | Two servers fighting for upgrade | Extend `wssExt` or `wss` dispatch in `createApp` |

## Related skills

- `miki-moni-dev:locate-code` — `src/server.ts` route table
- `miki-moni-dev:change-pair-flow` — if the endpoint is pair-related, also follow that checklist
- `miki-moni-dev:release-flow` — new daemon endpoint = `npm publish` needed (daemon ships via npm)
