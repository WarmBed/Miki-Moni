# Codex Transcript Parity Plan

**Goal:** Make Codex sessions render with the same dashboard content coverage as Claude sessions: card previews, transcript modal, tool calls/results, and transcript-meta polling, without rewriting the frontend.

**Current gap:** `/sessions` already includes Codex sessions from hooks, but `/sessions/previews`, `/sessions/:uuid/transcript-meta`, and `/sessions/:uuid/transcript` only scan `~/.claude/projects`. Codex rollout files live under `~/.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl` and use a different event schema.

**Approach:** Keep the existing frontend contract. Add a source-aware transcript resolver that finds Claude or Codex files and dispatches to source-specific parsers, both returning the existing `SessionPreview` and `TranscriptTurn` shapes.

## Tasks

- [x] Add Codex rollout discovery by session UUID under `~/.codex/sessions`, while preserving the current Claude projects lookup.
- [x] Add a Codex rollout parser for `response_item.message`, `response_item.function_call`, and `response_item.function_call_output`.
- [x] Preserve existing Claude parser behavior and endpoint responses.
- [x] Update server endpoints to use the source-aware resolver for previews, transcript meta, and transcripts.
- [x] Add focused tests for Codex preview, transcript tail, resolver lookup, and server endpoint behavior.
- [x] Add minimal agent metadata support so Codex content is labeled as Codex in cards and transcript bubbles.
- [x] Add Codex notify hook emission so future Codex turns can enter `/event` with `agent: "codex"`.
- [x] Run focused tests, then `pnpm test` and `pnpm typecheck`.
- [x] Restart or refresh the daemon/build as needed and verify `http://127.0.0.1:8765/` shows Codex content.

## Non-goals

- Do not solve Codex send/focus/interrupt parity in this pass. Those are control-plane features and need a Codex-specific bridge; transcript parity is the content-plane foundation.
- Do not change the dashboard UI unless a small compatibility adjustment is required.
