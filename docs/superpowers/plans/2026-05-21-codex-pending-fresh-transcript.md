# Codex Pending Fresh Transcript Plan

**Goal:** A newly launched Codex pending card must not borrow an older rollout from the same cwd before the new CLI has written its first turn.

## Tasks

- [x] Let pending Codex transcript resolution ignore cwd-matched rollout files older than the pending card's launch timestamp.
- [x] Apply the same freshness rule to previews, transcript meta, and full transcript endpoints.
- [x] Add regression coverage for stale cwd rollout suppression.
- [x] Run focused tests, typecheck, and rebuild web if needed.

## Non-goals

- Do not change direct Codex UUID lookup behavior.
- Do not change the existing "skip VSCode-sourced rollout" rule.
