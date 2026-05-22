# Codex Client Badge Plan

**Goal:** Make Codex sessions visibly distinct from Claude VSCode/wrapped sessions in every dashboard entry point.

## Tasks

- [x] Replace the VSCode/CLI toggle with a fixed Codex CLI/exec badge for Codex sessions.
- [x] Keep Claude behavior unchanged: unwrapped Claude can still toggle VSCode/CLI, wrapped Claude still shows wrapped.
- [x] Add localized badge labels/tooltips for Codex.
- [x] Build and typecheck the dashboard, then verify the running UI no longer shows VSCode on Codex cards.

## Non-goals

- Do not change Codex send/resume internals in this pass.
- Do not reintroduce Codex VSCode focus or wrap behavior.
