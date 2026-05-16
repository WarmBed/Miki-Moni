# cc-hub Phase 1 Autonomous Smoke Test — 2026-05-15

**Tester:** Claude Code (autonomous agent, Task 18)
**Branch:** feature/phase1-impl
**Base commit:** a94e82e (Task 17 — Vite web UI build)
**Daemon port:** 8765 (confirmed via `~/.cc-hub/port`)

---

## Step 1 — Build Artifacts PASS

| Artifact | Present |
|---|---|
| `dist/web/index.html` | YES |
| `dist/web/assets/index-CKd2Qfn9.css` | YES |
| `dist/web/assets/index-XJEAJcKc.js` | YES |

All three artifacts from Task 17 Vite build are present.

---

## Step 2 — Daemon Start PASS

- Command: `pnpm start` (via Bash `run_in_background`)
- `~/.cc-hub/port` file appeared with value `8765` within 4 seconds
- `~/.cc-hub/cc-hub.log` contains: `{"level":30,"time":...,"msg":"cc-hub listening"}`
- Daemon PID: 36412

---

## Step 3 — HTTP Endpoints

### 3a — GET /sessions (initial) PASS

```
GET http://127.0.0.1:8765/sessions
Response: [] (empty array)
```

### 3b — POST /event session_start PASS

```
POST http://127.0.0.1:8765/event
Body: { event_type: "session_start", cwd: "d:/code/smoke-test-fake", session_uuid: "smoke-uuid-1", timestamp: ... }
HTTP 204 No Content
```

Note: Windows backslash `d:\code\smoke-test-fake` in JSON caused a JSON parse error (400) from body-parser — forward slashes `d:/code/smoke-test-fake` worked correctly. This is expected behavior from the JSON spec (backslash is escape character); the hook payload from Claude Code uses OS paths, so the event schema or pre-processing should normalize backslashes before JSON serialization.

### 3c — GET /sessions (after start) PASS

```json
[
  {
    "cwd": "d:/code/smoke-test-fake",
    "session_uuid": "smoke-uuid-1",
    "project_name": "smoke-test-fake",
    "status": "active",
    ...
  }
]
```

Session correctly registered with `status: "active"` and `project_name` derived from the last path segment.

### 3d — POST /event stop PASS

```
POST http://127.0.0.1:8765/event
Body: { event_type: "stop", cwd: "d:/code/smoke-test-fake", session_uuid: "smoke-uuid-1", ... }
HTTP 204 No Content
```

Session transitioned to `status: "waiting"` as confirmed by follow-up GET /sessions.

**Windows toast notification:** The HTTP call returned 204 without error, meaning the notification dispatch code ran without throwing. Cannot confirm visual appearance in autonomous mode (no display access from agent). Manual verification required.

### 3e — GET /sessions/:cwd PASS

```
GET http://127.0.0.1:8765/sessions/d:%2Fcode%2Fsmoke-test-fake
Response: single session object with status "waiting"
```

Path-specific endpoint returns the correct session.

---

## Step 4 — WebSocket Broadcast PASS

Connected a `ws` client, triggered `user_prompt` event via HTTP POST on `ws.on('open')`, received within < 1 second:

```json
GOT: {"type":"session_changed","session":{"cwd":"d:/code/smoke-test-fake","session_uuid":"smoke-uuid-1","project_name":"smoke-test-fake","status":"active","last_event_at":...,"last_message_preview":"","tokens_in":0,"tokens_out":0,"vscode_pid":null}}
```

Real-time broadcast over WebSocket confirmed working.

---

## Step 5 — Static Web UI Serves PASS

| Check | Result |
|---|---|
| `GET /` returns HTML with `<title>cc-hub</title>` | YES |
| `GET /assets/index-CKd2Qfn9.css` → HTTP 200 | YES |
| `GET /assets/index-XJEAJcKc.js` → HTTP 200 | YES |

---

## Step 6 — Daemon Shutdown PASS

- Sent `Stop-Process -Id 36412 -Force`
- `GET http://127.0.0.1:8765/` timed out → port released
- Clean shutdown confirmed

---

## Issues Found

### JSON Backslash Escaping in Windows Paths

When the `cwd` field contains Windows backslashes (e.g., `d:\code\smoke-test-fake`), the body-parser returns HTTP 400 because `\c`, `\s` etc. are invalid JSON escape sequences. The hook script that posts to `/event` must either:

1. Double-escape backslashes (`d:\\code\\smoke-test-fake`), OR
2. Normalize to forward slashes before POSTing

This affects real Claude hooks on Windows since `$CLAUDE_CWD` will contain backslashes. The event schema or the hook script should handle this.

---

## Outstanding — Requires Manual User Verification

1. **Hook installation:** `pnpm install:hooks` was NOT run (would modify `~/.claude/settings.json` while other Claude agents are active). User must run this in a safe window to register the Stop/session hooks with real Claude.

2. **Real Claude session trigger:** Post hook-installation, start a real Claude Code session, let it stop naturally, and verify the desktop notification appears with the project name.

3. **Windows toast notification visual:** The daemon's notification dispatch returned 204 with no error, but the agent cannot confirm a toast visually appeared. User should verify one pops up after a real `stop` event.

4. **VSCode URI handler:** The `vscode://` deep-link that the web UI "Focus" button composes was not exercised. User should click Focus in the web UI after a real session and confirm VSCode raises the correct window.

5. **Multiple concurrent sessions:** Only one synthetic session was tested. Multi-session display in the web UI requires a browser.

6. **Web UI in browser:** Open `http://127.0.0.1:8765/` in a browser and confirm the React UI renders the session list, status badges, and Focus button correctly.

---

## Summary

| Step | Result |
|---|---|
| 1. Build artifacts present | PASS |
| 2. Daemon starts and writes port file | PASS |
| 3a. GET /sessions empty | PASS |
| 3b. POST session_start → 204 | PASS |
| 3c. GET /sessions shows active session | PASS |
| 3d. POST stop → 204, status→waiting | PASS |
| 3e. GET /sessions/:cwd | PASS |
| 4. WebSocket broadcast | PASS |
| 5. Static web UI served | PASS |
| 6. Daemon shutdown | PASS |

**Overall: DONE_WITH_CONCERNS**

All automated checks pass. One concern: Windows backslash in JSON paths causes 400 from the event endpoint — the hook script or event schema must normalize paths before POSTing.
