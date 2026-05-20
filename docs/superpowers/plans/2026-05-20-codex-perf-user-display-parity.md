# Codex Perf + User Display Parity Plan

Goal: make Codex `/send` produce the same Monit UX as streaming wrapped sessions, and keep dashboard USER bubbles focused on the human request instead of Codex desktop browser context.

- [x] Add focused tests for non-streaming Codex metric recording.
- [x] Add focused tests for stripping Codex in-app browser preamble from displayed user text.
- [x] Implement a shared prompt display sanitizer used by backend transcript parsing and frontend optimistic overlay.
- [x] Wire Codex `/send` success into `PerfTracker`.
- [x] Run focused tests, typecheck, and web build.
