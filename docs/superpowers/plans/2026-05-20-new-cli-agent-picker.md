# New CLI Agent Picker

## Goal

Let the dashboard "新增 CLI" popover start either a Claude CLI or a Codex CLI from a chosen working directory.

## Scope

- Keep existing Claude behavior: `/wrap/start` launches `miki claude --fresh`, records the managed wrap spawn, and waits for the wrap websocket to register.
- Add Codex fresh-session behavior: `/wrap/start` accepts `agent: "codex"` and launches `cmd.exe /d /k codex` in Windows Terminal from the chosen cwd.
- Do not pretend Codex has Claude wrap controls yet. Existing Codex cards still appear through Codex notify/transcript ingestion.
- Existing session resume for Codex remains unsupported and returns the current 501.

## Tests

- [x] Add server tests for `/wrap/start` agent selection and spawned terminal command arguments.
- [x] Keep `/wrap/start` validation for unknown/unsupported agent values.
- [x] Run focused integration test, typecheck, web build, full test suite, and browser smoke.
