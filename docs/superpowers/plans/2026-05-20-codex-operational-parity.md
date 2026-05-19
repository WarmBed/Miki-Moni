# Codex Operational Parity Plan

**Goal:** Continue Codex support beyond transcript rendering so real Codex sessions keep appearing correctly after restart and hook installation.

## Tasks

- [x] Make the v2 -> v3 session DB migration preserve existing rows while adding `agent = "claude"`.
- [x] Make hook installation testable without touching the user's real `~/.claude` or `~/.codex` files.
- [x] Add coverage for Codex `notify` install cases: empty config, matching existing config, conflicting existing notify.
- [x] Run `pnpm install:hooks` after tests so this machine can emit future Codex session events automatically.
- [x] Add a dashboard agent filter if the current UI needs it for mixed Claude/Codex work.
- [x] Block unsupported Codex focus/send/wrap routes from falling through to Claude control paths.
- [x] Re-run focused tests, `pnpm test`, `pnpm typecheck`, and browser sanity checks.

## Non-goals

- Do not fake unsupported Codex VSCode deep links. If focus/send parity needs an undocumented scheme, block or route it through a documented CLI path instead.
- Do not rewrite the whole agent adapter architecture in this pass; keep changes incremental and compatible with existing Claude behavior.
