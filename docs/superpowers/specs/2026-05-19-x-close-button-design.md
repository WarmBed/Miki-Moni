# X-Close Button — Replace Card Copy Button

**Status**: Approved (brainstorming → spec, 2026-05-19)
**Owner**: mike
**Tracking commit / PR**: TBD after writing-plans

## Problem

The grid cell in `web/app.tsx` renders `CopyResumeButton` at the top-right, which
copies `pnpm --dir D:\code\cc-hub miki claude -r <uuid>` to the clipboard so the
user can re-arm a wrap after killing it. Two issues:

1. The path `D:\code\cc-hub` is **hardcoded** in source AND in three i18n locales
   (zh-TW / zh-CN / en). Anyone who `npm i -g miki-moni` and clicks the button
   gets a command pointing at a directory that doesn't exist on their machine.
2. There is **no in-UI way to stop a wrap** without going to the terminal that
   spawned it. Power users juggling many wraps in parallel resort to closing the
   spawning terminal window, which is heavy-handed.

## Decision

Replace the copy button with a single `X` button whose meaning depends on the
cell's state. The button slot, position, and compact sizing stay the same —
only the icon, tooltip, and click handler change.

| Cell state         | Icon | Tooltip                       | Click action                                          | After click                         |
|--------------------|------|-------------------------------|-------------------------------------------------------|-------------------------------------|
| `wrapped`          | `⊗`  | Stop wrap (keep session)      | `POST /wrap/stop { session_uuid }`                    | Cell flips to non-wrapped state     |
| Non-wrapped        | `✕`  | Hide on this device           | Add `uuid` to localStorage `miki-moni:hidden-sessions`| Cell disappears from default view   |
| Hidden (in filter) | `↩️` | Un-hide                       | Remove `uuid` from localStorage                       | Cell returns to default view        |

Confirm dialogs: **none**. Stopping a wrap leaves the underlying Claude Code
session alive; re-wrap via the existing `WrapStartButton` (the `🔌 CLI` icon).

Hiding semantics: **permanent until explicit un-hide** (no auto-un-hide on new
activity). Per-browser (localStorage), no cross-device sync.

Re-show affordance: a new header filter chip `🙈 (N)` appears whenever
`hiddenSet.size > 0`. Clicking switches the grid to "hidden-only" view; in that
view the X button becomes `↩️` un-hide.

## Out of scope (YAGNI)

- ❌ Confirm dialog before stopping wrap
- ❌ Daemon-side hidden list (cross-device sync)
- ❌ Auto-un-hide on new session activity
- ❌ Deleting the daemon's session record
- ❌ A separate "archived" tier (hide already serves that purpose)

## Architecture

### 1. Daemon — new endpoint `POST /wrap/stop`

**Location**: `src/server.ts`, alongside existing `/wrap/answer`, `/wrap/interrupt`,
`/wrap/model`, `/wrap/effort`, `/wrap/permission-mode`.

**Request**
```ts
POST /wrap/stop
Content-Type: application/json
{ "session_uuid": "<uuid>" }
```

**Response**
- `200 { stopped: true, pid: <number> }` — wrap process tree killed
- `404 { error: "no_wrap" }` — no active wrap for this uuid (already stopped or
  never wrapped)
- `400 { error: "missing_session_uuid" }` — malformed body

**Side effects (in order)**
1. `wrapRegistry.get(uuid)` → if absent, return 404
2. `killProcessTree(spawnRec.pid)` (reuses existing helper from `wrap-process.ts`)
3. `wrapRegistry.delete(uuid)`
4. `store.markUnwrapped(uuid)` — flips `wrapped=false` in the SQLite session row
5. WS broadcast `session_changed` with the updated row → all connected clients
   (dashboard + phone) flip the cell's wrap badge off

**Why no confirm**: The wrap subprocess only carries transient state (CWD,
model, effort, permission-mode). Killing it does NOT touch the Claude session
JSONL on disk, the wrap UUID, or any conversation history. Re-wrap via
`WrapStartButton` reconnects to the same session UUID with default settings.

### 2. Web — `CloseCardButton` component

**Location**: `web/app.tsx`, replaces `CopyResumeButton` at L1509-1530, called
from L2887.

**Props**
```ts
interface Props {
  sessionUuid: string;
  wrapped: boolean;        // s.wrapped — toggles 1st vs 2nd behavior
  isHiddenView: boolean;   // true when user is viewing the hidden-only filter
  onHide: (uuid: string) => void;       // adds to hiddenSet + localStorage
  onUnhide: (uuid: string) => void;     // removes from hiddenSet + localStorage
}
```

**Click handler** (pseudo)
```ts
if (isHiddenView) {
  onUnhide(sessionUuid);
} else if (wrapped) {
  await fetch("/wrap/stop", { method: "POST", body: JSON.stringify({ session_uuid: sessionUuid }) });
  // No optimistic UI: the WS session_changed will flip wrapped=false
} else {
  onHide(sessionUuid);
}
```

**Icon mapping** (existing icon helpers verified at `web/app.tsx` L124-306)
- `wrapped && !isHiddenView` → existing `IconStop` (L180) — already used elsewhere
- `!wrapped && !isHiddenView` → new tiny `IconX` (12px stroke=1.5, simple ✕)
- `isHiddenView` → new tiny `IconUndo` (12px curved-back-arrow, similar to IconRefresh)

**Disabled state**: when `pending` (after click, before WS confirms), grey out
to prevent double-click. Local `err: string | null` state mirrors the pattern in
`ModelChip` (L2004): on failure, show inline error tooltip + temporarily disable
the button. No global toast — keeps the change small and consistent with the
rest of the codebase.

### 3. Web — hidden-state plumbing (in `App` component)

**State additions**
```ts
const HIDDEN_KEY = "miki-moni:hidden-sessions";
const [hiddenSet, setHiddenSet] = useState<Set<string>>(() => {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
});
const [showHidden, setShowHidden] = useState(false);

function hideSession(uuid: string) {
  setHiddenSet(prev => {
    const next = new Set(prev); next.add(uuid);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    return next;
  });
}
function unhideSession(uuid: string) {
  setHiddenSet(prev => {
    const next = new Set(prev); next.delete(uuid);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
    return next;
  });
}
```

**Grid filter pipeline** (existing logic at L4559-4564, append one step)
```ts
sessions
  .filter(s => statusFilter matches)             // existing
  .filter(s => showHidden                         // new
    ? hiddenSet.has(s.session_uuid)
    : !hiddenSet.has(s.session_uuid));
```

**Cross-tab sync** (nice-to-have, low cost): `window.addEventListener("storage", ...)`
fires when another tab writes the same key. Update `hiddenSet` from the new
value. Two dashboard tabs on the same browser stay in sync.

### 4. Web — `🙈 (N)` filter chip in header

**Location**: `HeaderStats` row, alongside existing `all` / `live` / `active` /
`waiting` / `idle` / `stale` chips.

**Visibility**: only when `hiddenSet.size > 0`. Hide entirely when empty so the
chip row doesn't get visual noise.

**Behavior**: click toggles `showHidden`. When `showHidden=true`, all other
status filters still apply, but only against the hidden subset.

**Label format**: `🙈 N` where N is `hiddenSet.size`. Tooltip:
`t("filter.hiddenTooltip")` → "顯示已從本機隱藏的 N 張卡片".

### 5. i18n — `shared/i18n.ts`

**Remove** (three locales)
- `session.copyRestart`

**Add** (three locales, zh-TW shown as example)
```
"session.closeWrapped":    "停止 wrap（保留 session）"
"session.closeHidden":     "從本機隱藏這張卡"
"session.unhide":          "取消隱藏"
"filter.hiddenLabel":      "🙈 已隱藏"
"filter.hiddenTooltip":    "顯示已從本機隱藏的卡片（{n} 張）"
```

CLAUDE.md notes that all 10 locales must declare the same top-level sections.
This project has 3 (zh-TW / zh-CN / en) so the constraint is lighter, but each
of the 5 new keys must exist in all 3 locales — TypeScript will catch a missing
zh-TW key but **not** zh-CN / en, so the test suite must validate parity.

## Data model — no changes

The SQLite session row already has a `wrapped: boolean` column the daemon
toggles. The new `/wrap/stop` flips it to `false`; nothing else changes.

The hidden state lives **only** in browser localStorage. The daemon doesn't
know about it. A reinstall / new device starts with everything visible.

## Error handling

| Failure                                     | UX                                                                  |
|---------------------------------------------|---------------------------------------------------------------------|
| `/wrap/stop` returns 404 (already gone)     | Treat as success — let the WS `session_changed` flip wrapped off; no inline error |
| `/wrap/stop` returns 5xx / network error    | Set local `err` state, button shows red border + `title={err}` tooltip for 3s, then resets; wrapped stays true so user can retry |
| localStorage write fails (private mode etc) | Hide still works in-memory; on reload everything visible again; `console.warn` so a power user can see it in DevTools |
| WS disconnect mid-click                     | Treat like 5xx — inline error on the button, user can retry         |

## Testing

### Daemon — new `tests/wrap-stop.test.ts`

1. **happy path**: spawn a fake wrap (use existing test helper), POST `/wrap/stop`,
   assert (a) response 200 (b) `killProcessTree` was called with the right PID
   (c) registry no longer has the uuid (d) DB row has `wrapped=false` (e) a
   `session_changed` WS message was broadcast.
2. **no wrap**: POST for a uuid that was never wrapped → 404.
3. **double stop**: stop twice in a row → 2nd returns 404 cleanly.
4. **malformed body**: missing `session_uuid` → 400.

### Web — new `web-phone/hidden-store.test.ts` (or co-located vitest)

1. **persist roundtrip**: hide → reload (simulated) → uuid still in set.
2. **JSON parse failure**: corrupted localStorage value → falls back to empty set,
   no exception.
3. **storage event**: simulate `StorageEvent` from another tab → hiddenSet updates.

### Web — Playwright smoke `tools/smoke-x-close.py`

1. Start daemon with seeded fake session (wrapped=true)
2. Click X → POST `/wrap/stop` fires → cell loses wrap badge, X icon swaps to `✕`
3. Click X again on the now-non-wrapped cell → cell disappears, header shows
   `🙈 1` chip
4. Click `🙈 1` chip → cell reappears with `↩️` button
5. Click `↩️` → hiddenSet empties, `🙈` chip vanishes, cell returns to default view

### Manual gate before publish

Run `pnpm test` (must hit 142 + new tests) and `pnpm typecheck` (the i18n parity
check fires here for zh-TW types).

## Migration / Rollout

- No DB migration (no schema change).
- No breaking API change (only adds `/wrap/stop`).
- i18n key `session.copyRestart` removal is breaking for any user-customised
  translation override, but nobody has those in the wild — this is an internal
  app.
- Version bump: 0.3.10 → 0.3.11 (patch — UI tweak + one new safe endpoint).

## Open questions

None — all four decision points were resolved in the brainstorming session.
