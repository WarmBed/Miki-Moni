# Update Notification — npm Latest Surfaced in CLI + Dashboard + Phone PWA

**Status**: Approved (brainstorming → spec, 2026-05-19)
**Owner**: mike
**Tracking commit / PR**: TBD after writing-plans

## Problem

After publishing a new miki-moni version to npm, two cohorts have no signal
that the upgrade exists:

1. **Self-host author** — installs locally via `npm i -g miki-moni`, but
   after a `pnpm release` may forget the local daemon is still on the old
   version because the daemon doesn't print or surface npm-latest.
2. **External npm users** — never reach for the terminal once their daemon
   is running. They open the dashboard / phone PWA, see a working UI, and
   stay on an old release indefinitely.

There is no in-app or CLI signal telling either cohort that a newer version
is available.

## Decision

Add a single daemon endpoint that compares the running build's
`__APP_VERSION__` against `registry.npmjs.org/miki-moni/latest`. Surface
the result in three places, all driven by the same endpoint:

| Surface       | Trigger                          | Visual                                  |
|---------------|----------------------------------|-----------------------------------------|
| `miki start`  | daemon startup                   | One-line banner: `✨ Update available…` |
| Desktop UI    | `App` mount + settings popover   | Badge next to `v0.3.x` in popover footer |
| Phone PWA UI  | same component, same endpoint    | Same badge — phone shares `web/app.tsx` |

Result: every consumer sees the same source of truth without coordinating
extra requests or shipping a separate phone codebase change.

## Out of scope (YAGNI)

- ❌ Auto-update (`npm i -g miki-moni@latest` invoked from daemon) — supply-chain
  risk, write permission to global `node_modules`, daemon-killing-itself.
- ❌ Toast notification on dashboard load — too noisy; settings-popover badge
  is the agreed surface.
- ❌ Tray icon badge — Windows-only, larger surface area for the value it adds.
- ❌ Changelog rendering — link out to npmjs.com is enough; we don't host or
  parse CHANGELOG.md inside the bundle.
- ❌ Persisted cache to disk — 24h memory cache is sufficient; restart re-fetches.
- ❌ "Dismiss" / "ignore this version" affordance — badge is passive, not blocking;
  no dismiss state needed.

## Architecture

### 1. Daemon — new endpoint `GET /admin/version-check`

**Location**: `src/server.ts`, alongside existing `/admin/pid`,
`/admin/restart`, `/admin/quit`.

**Request**: no body, no query.

**Response (success path)**:
```ts
GET /admin/version-check  →  200
{
  current:   "0.3.13",
  latest:    "0.3.14",
  hasUpdate: true,
  fetchedAt: 1779180000000,  // ms epoch when daemon last hit npm
  error:     null
}
```

**Response (npm unreachable / cache miss + fetch failed)**:
```ts
200
{
  current:   "0.3.13",
  latest:    null,
  hasUpdate: false,
  fetchedAt: 0,
  error:     "npm_unreachable"  // or "timeout"
}
```

Always returns 200 — the endpoint never fails the request itself; failure
modes are encoded in `error`. UI uses `hasUpdate` as the sole rendering gate.

No auth — matches `/admin/pid` (read-only, no side effects).

### 2. Version-check module — `src/version-check.ts` (new)

Pure module owning the npm fetch + cache + semver compare. Lives outside
`server.ts` so it's vitest-friendly.

```ts
// src/version-check.ts

export interface VersionInfo {
  current:   string;
  latest:    string | null;
  hasUpdate: boolean;
  fetchedAt: number;
  error:     "npm_unreachable" | "timeout" | null;
}

export interface VersionCheckOptions {
  current:    string;            // __APP_VERSION__
  ttlMs?:     number;            // default 24 * 60 * 60 * 1000
  fetchFn?:   typeof fetch;      // injectable for tests
  nowFn?:     () => number;      // injectable for tests
}

export class VersionChecker {
  private cache: VersionInfo | null = null;
  constructor(private opts: VersionCheckOptions);
  async get(): Promise<VersionInfo>;        // returns cached if fresh; else refreshes
  async refresh(): Promise<VersionInfo>;    // bypass cache
}

// Helpers exported for test:
export function compareSemver(a: string, b: string): -1 | 0 | 1;
```

`compareSemver` only needs to handle the project's actual version format —
`MAJOR.MINOR.PATCH` plus optional `-prefix.N` (e.g., `0.3.0-phase2`). No
build metadata. Throws on unparseable input.

**Cache rule**: `get()` returns cache if `now - fetchedAt < ttlMs`. Otherwise
calls `refresh()` and returns the fresh value. `refresh()` invokes
`fetchFn("https://registry.npmjs.org/miki-moni/latest")` with a 5s timeout;
on failure, stores `{ ..., latest: null, hasUpdate: false, error }` so we
don't hammer npm on every request after a failure.

### 3. Daemon wiring — `src/index.ts`

Construct one `VersionChecker` at startup. Trigger a fire-and-forget
`refresh()` so the cache is warm before the first UI request. Pass into
`createApp` so `/admin/version-check` reads from the same instance.

The startup print (Section 4) awaits the same `refresh()` so the banner
shows the freshest data without adding a second network call.

### 4. CLI banner — `src/cli/miki.ts`

`printPairBanner()` runs after daemon is listening. Extend with:

```ts
async function printUpdateLine(): Promise<void> {
  const info = await versionChecker.get();
  if (!info.hasUpdate) return;
  console.log("");
  console.log(
    `✨ ${t("banner.updateAvailable", { current: info.current, latest: info.latest! })}`
  );
  console.log("   " + t("banner.updateInstall") + " npm i -g miki-moni");
}
```

i18n keys (CLI-side, not web):
- `banner.updateAvailable` = `"Update available: {current} → {latest}"` / 「新版本可用：{current} → {latest}」
- `banner.updateInstall`   = `"run"` / 「在終端機跑」

Skip silently if `info.error` is set — we don't surface "couldn't reach npm"
on startup; that's noise.

### 5. Dashboard badge — `web/app.tsx`

Add a small `<UpdateBadge>` component in the settings popover footer,
inline with the version label:

```tsx
<span>v{__APP_VERSION__}</span>
{updateInfo?.hasUpdate && <UpdateBadge latest={updateInfo.latest} />}
```

`UpdateBadge`:
- Renders `→ v{latest}` in `var(--accent)` colour, same size as the version
  label (10px, tabular-nums)
- Click expands an inline tooltip beneath the footer row:
  ```
  Update available: 0.3.14
  Run in terminal:
  [ npm i -g miki-moni@latest ]  [Copy]
  ```
- Copy button uses `navigator.clipboard.writeText(...)` — same pattern as
  `web/public/pair-info.html`. Falls back silently if the clipboard API
  is unavailable.

Fetching: `App` mounts → `useEffect(() => { apiFetch("/admin/version-check").then(setUpdateInfo) }, [])` once. No polling; the daemon does the polling internally.

For phone PWA: `apiFetch` is wired to `TunnelTransport` so the request
travels relay → daemon → npm → back. No code difference between desktop
and phone — same component, same endpoint, same behaviour.

### 6. i18n — `shared/i18n.ts`

Three new web-side keys × three locales (zh-TW / zh-CN / en):

```
settings.updateAvailable  「新版本可用」 /「新版本可用」/ "Update available"
settings.updateInstall    「在終端機執行：」/「在终端执行：」/ "Run in terminal:"
settings.updateCopy        「複製」 /「复制」 / "Copy"
```

CLI-side i18n (`src/cli/i18n-cli.ts`) gains the two `banner.update*` keys.

## Cache behaviour table

| Scenario                                  | Behaviour                                       |
|-------------------------------------------|-------------------------------------------------|
| Daemon startup                            | Background `refresh()` fires; cache warm in <1s |
| GET /admin/version-check, cache <24h old  | Returns cached value (sync)                     |
| GET /admin/version-check, cache ≥24h old  | Refreshes synchronously, returns fresh value    |
| npm unreachable / timeout                 | Returns `{ ..., error: "npm_unreachable" }`, UI hides badge |
| Daemon restart (`/admin/restart`)         | New process; cache resets; refresh on next call |

## Testing

| Test file                       | Coverage                                                  |
|---------------------------------|-----------------------------------------------------------|
| `tests/version-check.test.ts`   | `compareSemver` correctness (edge cases: `0.3.13` vs `0.3.14`, `0.3.99` vs `1.0.0`, prerelease `0.3.0-phase2`); throws on malformed input |
| `tests/version-checker.test.ts` | `VersionChecker.get()` returns cache when fresh; refreshes after TTL; uses injected `fetchFn` mock; handles 5s timeout; handles HTTP non-200 |
| `tests/server.test.ts` (extend) | `GET /admin/version-check` 200 + response shape valid     |
| Manual smoke                    | `miki start` prints update line; dashboard shows badge; phone PWA shows badge via TunnelTransport |

Total: ~15 new unit tests; existing 168 should remain green.

## Implementation order

1. `src/version-check.ts` + `tests/version-check.test.ts` (TDD: write tests first)
2. `tests/version-checker.test.ts` + `VersionChecker` class
3. Wire `VersionChecker` into `src/index.ts` + `src/server.ts` endpoint
4. CLI banner extension (`src/cli/miki.ts`)
5. i18n keys (`shared/i18n.ts` + `src/cli/i18n-cli.ts`)
6. `web/app.tsx` — `UpdateBadge` component + fetch on mount
7. Manual smoke verification
8. release as 0.3.14 via `pnpm release`

Each step is independently committable; the chain breaks gracefully if a
later step is paused — e.g., shipping just steps 1-4 already gets the CLI
banner working, UI badge follows in a later commit.

## Open questions resolved during brainstorming

- **TTL?** → 24h memory cache, restart re-fetches.
- **Copy action?** → Copy the `npm i -g miki-moni@latest` command only; no
  changelog link (link-out felt redundant with how rarely the user reads CHANGELOG.md).
- **Current version source?** → `__APP_VERSION__` (build-time), not runtime
  `package.json` — keeps the bundle and CLI on the exact same identity even
  if someone manually edits the installed file.
- **Phone PWA support?** → Yes; achieved for free since phone uses the same
  `web/app.tsx` via TunnelTransport.

## Success criteria

1. After `pnpm release` bumps npm to `0.3.X+1` while the local daemon
   still runs `0.3.X`, running `miki start` in a fresh terminal prints
   the update line within 5 seconds.
2. Opening the desktop dashboard at `127.0.0.1:8765`, clicking the gear
   icon, and scrolling to the footer shows `v0.3.X → v0.3.X+1` in accent
   colour, clickable, copy works.
3. Same flow on `miki-moni.pages.dev` from a phone yields the same badge.
4. With network disconnected, none of the three surfaces show stale
   badges — they degrade silently to "no update".
5. `pnpm test` still passes (168 → ~183 with new test files).
