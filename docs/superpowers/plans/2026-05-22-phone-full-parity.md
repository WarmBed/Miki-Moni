# Phone dashboard full coverage

## Goal

Make the phone PWA cover the same daily-use surface as the desktop dashboard for Claude and Codex sessions:

- session identity by `session_uuid`, not just `cwd`
- agent badges and wrapper metadata
- full transcript modal with user/assistant/system/tool turns
- image attachment send path
- interrupt support
- performance metrics with `All / Claude / Codex` filtering
- pending AskQuestion answers where daemon exposes them

## Approach

Use the daemon's existing HTTP APIs through the already-supported relay `http_proxy` envelope instead of adding new relay protocol commands. This keeps desktop, phone, Claude, and Codex behavior on the same server code path.

Primary phone calls:

- `GET /sessions`
- `POST /focus`
- `POST /send`
- `POST /wrap/interrupt`
- `GET /sessions/:uuid/transcript`
- `GET /sessions/:uuid/transcript-meta`
- `GET /metrics?window=...&agent=...`
- `POST /wrap/answer`

## Tests / validation

- Build phone client with `pnpm build:phone`
- Run TypeScript check with `pnpm typecheck`
- Run Vitest with `pnpm test`

