# Codex Pending Transcript Resolution

## Problem

Codex sessions launched from the dashboard start as provisional rows with IDs like
`codex-pending:<cwd>:<launch-id>`. If Codex hooks do not later report the real
rollout UUID, the row remains provisional. The modal transcript endpoint then
cannot find a matching `~/.codex/sessions/**/rollout-...<uuid>.jsonl` file and
returns an empty pending transcript. The UI falls back to one assistant preview,
so user turns such as "say hi" disappear from the big card.

## Plan

- [x] Add resolver support for provisional Codex IDs by extracting cwd from
      `codex-pending:*`.
- [x] Find the latest Codex rollout whose `session_meta.payload.cwd` matches
      that cwd.
- [x] Reuse the existing Codex transcript parser once a concrete rollout file is
      found.
- [x] Cover the resolver behavior with focused tests.
- [x] Run focused tests, typecheck, build web, and verify the live endpoint.
