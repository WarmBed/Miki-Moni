# Update Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the npm-latest version of miki-moni in three places (`miki start` banner, desktop dashboard settings popover, phone PWA via TunnelTransport) so neither the author nor external users keep running an outdated build.

**Architecture:** New pure module `src/version-check.ts` exports a `compareSemver` helper and a `VersionChecker` class that holds a 24h memory cache and fetches `registry.npmjs.org/miki-moni/latest`. `src/index.ts` constructs one `VersionChecker` at daemon startup and passes it via `ServerDeps` into `createApp`; a new `GET /admin/version-check` endpoint reads from that single instance. `src/cli/miki.ts` extends the existing pair banner with a one-line update notice; `web/app.tsx` adds an `<UpdateBadge>` next to the version label in the settings popover footer (phone PWA reuses the same component for free because it dynamic-imports `web/app.tsx` through TunnelTransport).

**Tech Stack:** Node 20+, TypeScript NodeNext ESM, Express, vitest for unit tests, Preact for UI, native `fetch` + `AbortController` for the npm round trip.

**Spec source:** `docs/superpowers/specs/2026-05-19-update-notification-design.md` (committed in 28e221f).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/version-check.ts` | **Create** | `VersionInfo` type, `compareSemver(a, b)`, `VersionChecker` class. Pure module — no Express, no globals. |
| `tests/version-check.test.ts` | **Create** | Unit tests for `compareSemver` (edge cases, malformed input throws). |
| `tests/version-checker.test.ts` | **Create** | Unit tests for `VersionChecker`: cache freshness, TTL expiry refresh, fetch failure → error state, 5s timeout, HTTP non-200 handling. |
| `src/server.ts` | **Modify** | Extend `ServerDeps` with `versionChecker`; add `app.get("/admin/version-check", ...)` reading from it. |
| `tests/server.test.ts` | **Modify** | Add one case: `GET /admin/version-check` returns 200 + valid shape. |
| `src/index.ts` | **Modify** | Construct `VersionChecker` after config load; fire-and-forget `refresh()` to warm the cache; pass into `createApp({ ..., versionChecker })`. |
| `shared/i18n.ts` | **Modify** | Add 3 keys × 3 locales: `settings.updateAvailable`, `settings.updateInstall`, `settings.updateCopy`. |
| `src/cli/i18n-cli.ts` | **Modify** | Add 2 keys × 3 locales: `banner.updateAvailable`, `banner.updateInstall`. |
| `src/cli/miki.ts` | **Modify** | Add `printUpdateLine()` called after `printPairBanner()` — reads from the daemon-side VersionChecker via in-process import (CLI lives in the same process as daemon at startup). |
| `web/app.tsx` | **Modify** | Add `<UpdateBadge>` inline component, `useEffect` on App mount to fetch `/admin/version-check`, render inside settings popover footer next to `v{__APP_VERSION__}`. |

Boundary check: `version-check.ts` has zero dependencies on Express, the SDK, or any session store — it's a self-contained pure module that can be tested in isolation. The server file gains 1 endpoint (~12 lines). The CLI file gains 1 function (~15 lines). The web file gains 1 component (~80 lines) and 1 hook call.

---

## Task 1: `compareSemver` helper + type

**Files:**
- Create: `tests/version-check.test.ts`
- Create: `src/version-check.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/version-check.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compareSemver } from "../src/version-check.js";

describe("compareSemver", () => {
  it("returns -1 when a < b (patch)", () => {
    expect(compareSemver("0.3.13", "0.3.14")).toBe(-1);
  });

  it("returns 1 when a > b (patch)", () => {
    expect(compareSemver("0.3.14", "0.3.13")).toBe(1);
  });

  it("returns 0 when equal", () => {
    expect(compareSemver("0.3.13", "0.3.13")).toBe(0);
  });

  it("treats minor bump as bigger than max patch", () => {
    expect(compareSemver("0.3.99", "0.4.0")).toBe(-1);
  });

  it("treats major bump as bigger than max minor", () => {
    expect(compareSemver("0.99.0", "1.0.0")).toBe(-1);
  });

  it("compares numerically, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
  });

  it("treats prerelease as less than release of same MAJOR.MINOR.PATCH", () => {
    expect(compareSemver("0.3.0-phase2", "0.3.0")).toBe(-1);
    expect(compareSemver("0.3.0", "0.3.0-phase2")).toBe(1);
  });

  it("compares two prereleases lexically by suffix", () => {
    expect(compareSemver("0.3.0-alpha", "0.3.0-beta")).toBe(-1);
    expect(compareSemver("0.3.0-phase2", "0.3.0-phase1")).toBe(1);
  });

  it("throws on malformed input", () => {
    expect(() => compareSemver("not-a-version", "0.3.0")).toThrow();
    expect(() => compareSemver("0.3", "0.3.0")).toThrow();
    expect(() => compareSemver("", "0.3.0")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/version-check.test.ts`
Expected: FAIL — `Cannot find module '../src/version-check.js'`

- [ ] **Step 3: Create the minimal implementation**

Create `src/version-check.ts`:

```ts
// Pure helpers + version checker for surfacing the latest npm release of
// miki-moni in the CLI banner and the dashboard settings popover. No
// Express / DB / SDK deps — exists so the network logic is testable in
// isolation with an injected `fetch`.

export interface VersionInfo {
  current:   string;
  latest:    string | null;
  hasUpdate: boolean;
  fetchedAt: number;
  error:     "npm_unreachable" | "timeout" | null;
}

// Parse "MAJOR.MINOR.PATCH" with optional "-prerelease" suffix. Throws on
// anything we can't make sense of so callers don't silently compare junk.
function parse(v: string): { major: number; minor: number; patch: number; pre: string | null } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new Error(`compareSemver: not a version: ${JSON.stringify(v)}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre:   m[4] ?? null,
  };
}

/**
 * Compare two version strings.
 *
 * Returns -1 if a<b, 0 if equal, 1 if a>b.
 *
 * Semver-lite: MAJOR.MINOR.PATCH numeric; prerelease (anything after `-`)
 * orders LESS than the same MAJOR.MINOR.PATCH without a prerelease (per
 * semver §11). Two prereleases compare lexically on the suffix string —
 * good enough for our `0.3.0-phase2` style; we don't ship build metadata.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // Same X.Y.Z. Release > prerelease.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/version-check.test.ts`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/version-check.ts tests/version-check.test.ts
git commit -m "feat(version-check): compareSemver helper + VersionInfo type"
```

---

## Task 2: `VersionChecker` class with cache + fetch + timeout

**Files:**
- Create: `tests/version-checker.test.ts`
- Modify: `src/version-check.ts` (append `VersionChecker` class)

- [ ] **Step 1: Write the failing tests**

Create `tests/version-checker.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { VersionChecker } from "../src/version-check.js";

function makeFetchOk(latestVersion: string): typeof fetch {
  return vi.fn(async () => new Response(
    JSON.stringify({ version: latestVersion }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
}

describe("VersionChecker", () => {
  it("first .get() fetches and returns hasUpdate=true when remote > current", async () => {
    const fetchFn = makeFetchOk("0.3.14");
    const vc = new VersionChecker({ current: "0.3.13", fetchFn, nowFn: () => 1000 });
    const info = await vc.get();
    expect(info.current).toBe("0.3.13");
    expect(info.latest).toBe("0.3.14");
    expect(info.hasUpdate).toBe(true);
    expect(info.fetchedAt).toBe(1000);
    expect(info.error).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("first .get() returns hasUpdate=false when remote = current", async () => {
    const vc = new VersionChecker({
      current: "0.3.13",
      fetchFn: makeFetchOk("0.3.13"),
      nowFn: () => 1000,
    });
    const info = await vc.get();
    expect(info.hasUpdate).toBe(false);
  });

  it("second .get() within TTL returns cached value without re-fetching", async () => {
    const fetchFn = makeFetchOk("0.3.14");
    let t = 1000;
    const vc = new VersionChecker({
      current: "0.3.13",
      fetchFn,
      nowFn: () => t,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    await vc.get();
    t = 1000 + 12 * 60 * 60 * 1000;  // 12h later, still within 24h TTL
    await vc.get();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("second .get() past TTL triggers refresh", async () => {
    const fetchFn = makeFetchOk("0.3.14");
    let t = 1000;
    const vc = new VersionChecker({
      current: "0.3.13",
      fetchFn,
      nowFn: () => t,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    await vc.get();
    t = 1000 + 25 * 60 * 60 * 1000;  // 25h later, past TTL
    await vc.get();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("HTTP non-200 → error=npm_unreachable, hasUpdate=false", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const vc = new VersionChecker({ current: "0.3.13", fetchFn, nowFn: () => 1000 });
    const info = await vc.get();
    expect(info.latest).toBeNull();
    expect(info.hasUpdate).toBe(false);
    expect(info.error).toBe("npm_unreachable");
  });

  it("network throw → error=npm_unreachable", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    const vc = new VersionChecker({ current: "0.3.13", fetchFn, nowFn: () => 1000 });
    const info = await vc.get();
    expect(info.error).toBe("npm_unreachable");
  });

  it("AbortError → error=timeout", async () => {
    const fetchFn = vi.fn(async () => {
      const e = new Error("aborted");
      (e as Error & { name: string }).name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const vc = new VersionChecker({ current: "0.3.13", fetchFn, nowFn: () => 1000 });
    const info = await vc.get();
    expect(info.error).toBe("timeout");
  });

  it(".refresh() bypasses cache", async () => {
    const fetchFn = makeFetchOk("0.3.14");
    const vc = new VersionChecker({ current: "0.3.13", fetchFn, nowFn: () => 1000 });
    await vc.get();
    await vc.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses npm registry URL by default", async () => {
    const fetchFn = makeFetchOk("0.3.14");
    const vc = new VersionChecker({ current: "0.3.13", fetchFn, nowFn: () => 1000 });
    await vc.get();
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(url).toBe("https://registry.npmjs.org/miki-moni/latest");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/version-checker.test.ts`
Expected: FAIL — `VersionChecker is not a constructor` (the class doesn't exist yet).

- [ ] **Step 3: Implement the `VersionChecker` class**

Append to `src/version-check.ts`:

```ts
// ──────────────────────────────────────────────────────────────────────
// VersionChecker: holds a memory cache of the npm-latest version and
// refreshes on TTL expiry. The daemon constructs one at startup and the
// /admin/version-check endpoint reads through it — no consumer should
// hit npm directly.

const NPM_REGISTRY_LATEST_URL = "https://registry.npmjs.org/miki-moni/latest";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export interface VersionCheckerOptions {
  current: string;
  ttlMs?:  number;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to Date.now. */
  nowFn?:  () => number;
  /** URL override — almost only useful for tests pointing at a local mock. */
  url?:    string;
  /** AbortController timeout for the fetch. Defaults to 5s. */
  fetchTimeoutMs?: number;
}

export class VersionChecker {
  private cache: VersionInfo | null = null;
  private readonly current: string;
  private readonly ttlMs:   number;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn:   () => number;
  private readonly url:     string;
  private readonly timeoutMs: number;

  constructor(opts: VersionCheckerOptions) {
    this.current   = opts.current;
    this.ttlMs     = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchFn   = opts.fetchFn ?? fetch;
    this.nowFn     = opts.nowFn ?? Date.now;
    this.url       = opts.url ?? NPM_REGISTRY_LATEST_URL;
    this.timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  /** Returns cached value if fresh; otherwise refreshes synchronously. */
  async get(): Promise<VersionInfo> {
    if (this.cache && this.nowFn() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache;
    }
    return this.refresh();
  }

  /** Always hits the network; bypasses cache. Stores the result either way
   *  (success OR error) so we don't hammer npm if it's down. */
  async refresh(): Promise<VersionInfo> {
    const fetchedAt = this.nowFn();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchFn(this.url, { signal: ctl.signal });
      if (!r.ok) {
        this.cache = {
          current: this.current,
          latest:  null,
          hasUpdate: false,
          fetchedAt,
          error: "npm_unreachable",
        };
        return this.cache;
      }
      const json = (await r.json()) as { version?: string };
      const latest = typeof json.version === "string" ? json.version : null;
      if (!latest) {
        this.cache = {
          current: this.current,
          latest: null,
          hasUpdate: false,
          fetchedAt,
          error: "npm_unreachable",
        };
        return this.cache;
      }
      let hasUpdate = false;
      try {
        hasUpdate = compareSemver(this.current, latest) < 0;
      } catch {
        // Malformed version on either side: treat as no-update.
        hasUpdate = false;
      }
      this.cache = { current: this.current, latest, hasUpdate, fetchedAt, error: null };
      return this.cache;
    } catch (e: unknown) {
      const isAbort = (e as { name?: string })?.name === "AbortError";
      this.cache = {
        current: this.current,
        latest:  null,
        hasUpdate: false,
        fetchedAt,
        error: isAbort ? "timeout" : "npm_unreachable",
      };
      return this.cache;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/version-checker.test.ts`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Run full test suite to verify no regression**

Run: `pnpm test`
Expected: All previously-passing tests still pass; total = previous + 18 new (9 in `version-check.test.ts` + 9 in `version-checker.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/version-check.ts tests/version-checker.test.ts
git commit -m "feat(version-check): VersionChecker class — 24h cache + 5s timeout + npm fetch"
```

---

## Task 3: i18n keys — web + CLI

**Files:**
- Modify: `shared/i18n.ts`
- Modify: `src/cli/i18n-cli.ts`

- [ ] **Step 1: Add web i18n keys**

In `shared/i18n.ts`, locate the `settings.*` block in the zh-TW bundle (around line 287 where `settings.pinWaitingTitle` lives). Add **at the end of each locale's settings.* group** (after `settings.close`, before the next section, in all three bundles):

**zh-TW:**
```
"settings.updateAvailable":   "新版本可用",
"settings.updateInstall":     "在終端機執行：",
"settings.updateCopy":        "複製",
```

**zh-CN:**
```
"settings.updateAvailable":   "新版本可用",
"settings.updateInstall":     "在终端执行：",
"settings.updateCopy":        "复制",
```

**en:**
```
"settings.updateAvailable":   "Update available",
"settings.updateInstall":     "Run in terminal:",
"settings.updateCopy":        "Copy",
```

- [ ] **Step 2: Run the i18n parity test**

Run: `pnpm vitest run tests/i18n-parity.test.ts`
Expected: PASS — confirms all 3 locales declare the same top-level sections (the parity test catches drift between locales).

- [ ] **Step 3: Add CLI i18n keys**

In `src/cli/i18n-cli.ts`, find the `LOCALES` block. Add at the bottom of each locale bundle (before the closing `}`):

**en:**
```ts
"banner.updateAvailable": "Update available: {current} → {latest}",
"banner.updateInstall":   "run",
```

**zh-TW:**
```ts
"banner.updateAvailable": "新版本可用：{current} → {latest}",
"banner.updateInstall":   "在終端機跑",
```

**zh-CN:**
```ts
"banner.updateAvailable": "新版本可用：{current} → {latest}",
"banner.updateInstall":   "在终端跑",
```

- [ ] **Step 4: Verify TypeScript compile**

Run: `pnpm typecheck`
Expected: PASS — no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/i18n.ts src/cli/i18n-cli.ts
git commit -m "i18n: add update-notification keys (web + CLI, 3 locales)"
```

---

## Task 4: Daemon `/admin/version-check` endpoint

**Files:**
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Modify: `tests/server.test.ts` (extend with one case)

- [ ] **Step 1: Write the failing endpoint test**

In `tests/server.test.ts`, add a new test inside the existing `describe(...)` block (after the last `it(...)`, before the closing `})`):

```ts
  it("GET /admin/version-check returns 200 with shape", async () => {
    // Build a minimal app with a fake VersionChecker so we don't hit npm.
    const fakeChecker = {
      get: async () => ({
        current: "0.3.13",
        latest:  "0.3.14",
        hasUpdate: true,
        fetchedAt: 1779180000000,
        error: null,
      }),
    };
    const app = buildAppWithVersionChecker(fakeChecker);   // helper added below
    const r = await request(app).get("/admin/version-check");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      current: "0.3.13",
      latest:  "0.3.14",
      hasUpdate: true,
      fetchedAt: 1779180000000,
      error: null,
    });
  });
```

Look at the existing test file's helper for building an app with mocked deps. If it's called `buildApp` or `makeApp`, use that name and extend it to accept a `versionChecker` field. If you have to introduce a new helper, name it `buildAppWithVersionChecker` and have it call the existing helper with `{ ...defaults, versionChecker }`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/server.test.ts`
Expected: FAIL — `Cannot GET /admin/version-check` (404) OR `versionChecker not a valid option`.

- [ ] **Step 3: Extend `ServerDeps` and add the endpoint**

In `src/server.ts`:

1. Add the import at the top:
```ts
import type { VersionChecker } from "./version-check.js";
```

2. Extend `ServerDeps` (currently around line 59):
```ts
export interface ServerDeps {
  store: SessionStore;
  handler: HookHandler;
  bridge: VscodeBridge;
  notifier: Notifier;
  webDir: string;
  log?: Log;
  heartbeat?: { pingMs: number; pongTimeoutMs: number };
  versionChecker: VersionChecker;   // NEW
}
```

3. Add the endpoint inside `createApp`, immediately after the existing `app.get("/admin/pid", ...)` definition (around line 197):

```ts
  // Read-only — surfaces the cached npm-latest version of miki-moni so
  // the CLI banner and dashboard settings popover can show an update
  // hint. Daemon's VersionChecker owns the 24h cache + fetch; consumers
  // never talk to npm directly. Always 200; failure modes encoded in
  // `error`. No auth (matches /admin/pid).
  app.get("/admin/version-check", async (_req, res) => {
    const info = await deps.versionChecker.get();
    res.json(info);
  });
```

- [ ] **Step 4: Wire VersionChecker into `src/index.ts`**

In `src/index.ts`, locate the `createApp({ ... })` call (around line 148 based on the import path resolution code). Above it, construct the checker:

```ts
import { VersionChecker } from "./version-check.js";

// ... existing constructor calls (HookHandler, VscodeBridge, etc.) ...

// __APP_VERSION__ is injected by vite for the web bundle; in the daemon
// runtime we read it from the same package.json that vite reads, so the
// CLI and dashboard show the exact same `current` string.
const pkg = JSON.parse(
  readFileSync(path.resolve(_moduleDir, "..", "package.json"), "utf8"),
) as { version: string };

const versionChecker = new VersionChecker({ current: pkg.version });
// Fire-and-forget: warm the cache so the first /admin/version-check hit
// (CLI banner or dashboard mount) is already resolved.
void versionChecker.refresh();

const { app, server } = createApp({
  store, handler, bridge, notifier, webDir, log,
  versionChecker,
});
```

If `readFileSync` isn't already imported, add `import { readFileSync } from "node:fs";` at the top.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/server.test.ts`
Expected: PASS — including the new `version-check` case.

- [ ] **Step 6: Run typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: All green.

- [ ] **Step 7: Manual smoke — daemon endpoint live**

Run: `pnpm start` in one terminal (or restart the running daemon via `curl -X POST http://127.0.0.1:8765/admin/restart`).
In another: `curl -s http://127.0.0.1:8765/admin/version-check | jq`
Expected:
```json
{ "current": "0.3.13", "latest": "0.3.14", "hasUpdate": true, "fetchedAt": <ms>, "error": null }
```
(`latest` may equal `current` if no newer published version exists at the moment.)

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/index.ts tests/server.test.ts
git commit -m "feat(daemon): GET /admin/version-check endpoint + wire VersionChecker"
```

---

## Task 5: CLI banner — `miki start` prints update line

**Files:**
- Modify: `src/cli/miki.ts`

- [ ] **Step 1: Read existing banner code**

Locate `printPairBanner` in `src/cli/miki.ts` (around line 42-80). Note where it ends so the new line goes right after the existing console output block.

- [ ] **Step 2: Add `printUpdateLine` and call it after the pair banner**

In `src/cli/miki.ts`, add a new function and call it from `main()` right after `printPairBanner()`:

```ts
import { VersionChecker } from "../version-check.js";

/** Best-effort one-liner: if a newer miki-moni exists on npm, tell the
 *  user how to grab it. Silent on failure / no-update. The daemon will
 *  also surface this in the dashboard, but `miki start` users live in
 *  the terminal — they shouldn't have to open the UI to see the hint. */
async function printUpdateLine(): Promise<void> {
  try {
    const cfg = await loadOrInitConfig(CONFIG_FILE);
    const current = (await import("../version-check.js")).VersionChecker
      ? // We can't read the daemon's VersionChecker from here (separate
        // process when CLI invoked standalone). Re-read package.json and
        // do a one-shot check.
        (await readCurrentVersion())
      : "0.0.0";
    const checker = new VersionChecker({ current });
    const info = await checker.refresh();
    if (!info.hasUpdate || !info.latest) return;
    console.log("");
    console.log(
      `✨ ${t("banner.updateAvailable", { current: info.current, latest: info.latest })}`,
    );
    console.log("   " + t("banner.updateInstall") + " `npm i -g miki-moni`");
  } catch {
    // Network / file IO failure — never break daemon startup on banner.
  }
}

async function readCurrentVersion(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}
```

Then in `main()`, after the existing `await printPairBanner();` call, add:

```ts
await printUpdateLine();
```

- [ ] **Step 3: Verify TypeScript compile**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke — banner prints**

Stop the running daemon (`curl -X POST http://127.0.0.1:8765/admin/quit`), then run:
```powershell
miki start
```
Expected output (after the QR / URL / Code block):
```
✨ Update available: 0.3.13 → 0.3.14
   run `npm i -g miki-moni`
```
(Or nothing if `current === latest`.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/miki.ts
git commit -m "feat(cli): miki start prints update-available line after pair banner"
```

---

## Task 6: Dashboard `<UpdateBadge>` component

**Files:**
- Modify: `web/app.tsx`

- [ ] **Step 1: Add the `UpdateInfo` interface and fetch hook**

In `web/app.tsx`, somewhere near the existing type definitions block (around line 12-50 where `Session` lives), add:

```ts
// Mirrors VersionInfo from src/version-check.ts. Settings popover shows
// the badge whenever `hasUpdate` is true; we never act on the `error`
// field beyond hiding the badge (failure = silent).
interface UpdateInfo {
  current:   string;
  latest:    string | null;
  hasUpdate: boolean;
  fetchedAt: number;
  error:     "npm_unreachable" | "timeout" | null;
}
```

- [ ] **Step 2: Add the `<UpdateBadge>` component**

Add this component near the other small components (above `App`, near where `CloseCardButton` lives — search for `function CloseCardButton`):

```tsx
function UpdateBadge({ latest }: { latest: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied]     = useState(false);
  const cmd = "npm i -g miki-moni@latest";

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (insecure context, permission denied) —
      // silent fallback; the command is still visible inline.
    }
  }

  return (
    <>
      <button
        class="btn-ghost"
        style={{
          fontSize: 10,
          padding: "0 4px",
          marginLeft: 4,
          color: "var(--accent, #4f6dff)",
          fontVariantNumeric: "tabular-nums",
        }}
        onClick={() => setExpanded((v) => !v)}
        title={t("settings.updateAvailable")}
      >→ v{latest}</button>
      {expanded && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            borderRadius: 4,
            background: "var(--sl3)",
            fontSize: 10,
            color: "var(--fg)",
            lineHeight: 1.4,
          }}
        >
          <div style={{ marginBottom: 4 }}>{t("settings.updateAvailable")}: <strong>{latest}</strong></div>
          <div style={{ marginBottom: 4 }}>{t("settings.updateInstall")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <code style={{
              flex: 1,
              padding: "2px 4px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              fontFamily: "monospace",
              fontSize: 10,
            }}>{cmd}</code>
            <button
              class="btn-ghost"
              style={{ fontSize: 10, padding: "1px 6px" }}
              onClick={() => { void copy(); }}
            >{copied ? "✓" : t("settings.updateCopy")}</button>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Fetch on App mount + render badge in popover**

Inside `App` (search for `function App(`), near the other `useState` declarations, add:

```ts
const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

useEffect(() => {
  void apiFetch("/admin/version-check")
    .then((r) => r.ok ? r.json() : null)
    .then((info) => { if (info) setUpdateInfo(info as UpdateInfo); })
    .catch(() => { /* silent — badge just won't render */ });
}, []);
```

Then locate the settings popover footer (search for `v{__APP_VERSION__}` — should be inside the `{showSettings && ...}` block, near the "Close" button). It currently looks like:

```tsx
<span
  style={{ ... }}
  title={`miki-moni v${__APP_VERSION__}`}
>v{__APP_VERSION__}</span>
```

Change to:

```tsx
<span style={{ display: "inline-flex", alignItems: "center" }}>
  <span
    style={{ ... existing style ... }}
    title={`miki-moni v${__APP_VERSION__}`}
  >v{__APP_VERSION__}</span>
  {updateInfo?.hasUpdate && updateInfo.latest && (
    <UpdateBadge latest={updateInfo.latest} />
  )}
</span>
```

Note: leave the wrapper `<div style={{ marginTop:10, display: "flex", ... }}>` intact — only restructure the version span.

- [ ] **Step 4: Build + typecheck**

Run: `pnpm typecheck && pnpm build:web`
Expected: Both pass; new bundle hash in `dist/web/assets/`.

- [ ] **Step 5: Manual smoke — desktop dashboard**

1. Overwrite global install with new bundle:
   ```powershell
   cp -rfv dist/web/* "C:/Users/mike2/AppData/Roaming/npm/node_modules/miki-moni/dist/web/"
   ```
2. Hard refresh `http://127.0.0.1:8765` (Ctrl+Shift+R).
3. Click the gear icon → scroll to footer.

Expected: If `npm view miki-moni version` is greater than `__APP_VERSION__`, see `v0.3.13 → v0.3.14` (the `→ v0.3.14` part is the clickable accent-colored badge). Click it → expands tooltip with copyable command. Click "Copy" → button shows ✓ for 1.5s.

- [ ] **Step 6: Commit**

```bash
git add web/app.tsx
git commit -m "feat(web): UpdateBadge in settings popover footer"
```

---

## Task 7: Release as 0.3.14 + verify phone PWA badge

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump version**

Edit `package.json`:
```json
"version": "0.3.14",
```

- [ ] **Step 2: Run full release pipeline**

```powershell
git add package.json
git commit -m "chore(release): 0.3.14 — surface npm-latest in CLI + dashboard"
git push origin main
pnpm release
```

The `pnpm release` macro runs test + typecheck + build:all + publish + Pages deploy in one go (defined in commit 978f804).

- [ ] **Step 3: Verify all three surfaces**

| Surface | Verification |
|---|---|
| `miki start` banner | Stop and restart daemon; banner should print `✨ Update available: ...` IF an even newer version exists. (Right after publish, current = latest, so no banner — that's expected.) |
| Desktop dashboard | Hard refresh `127.0.0.1:8765` → settings popover shows `v0.3.14`. No `→ vX.Y.Z` badge (you're on latest). |
| Phone PWA | Open `miki-moni.pages.dev` (hard-refresh / private window) → settings shows `v0.3.14`, no badge. |

- [ ] **Step 4: Cross-version smoke (optional, validates the actual notification path)**

Hand-edit `package.json` back to `0.3.13` locally **without committing**, restart daemon, refresh dashboard. Badge SHOULD appear because:
- Daemon reports `current: "0.3.13"`
- npm registry has `latest: "0.3.14"`
- `hasUpdate: true`

Then revert `package.json` to `0.3.14` (commit was already pushed, just clean working tree).

- [ ] **Step 5: Commit final state**

If the cross-version smoke left any working-tree changes, ensure they're reverted:
```bash
git status   # should be clean
```

No further commit needed — release commit pushed in Step 2.

---

## Notes for the implementer

- **Don't open npm from the browser**: every `/admin/version-check` request goes through the daemon's `VersionChecker`. The web bundle never calls `registry.npmjs.org`.
- **Phone PWA gets it for free**: `web/app.tsx` is dynamically imported by `web-phone/main-tunnel.tsx`; the same `<UpdateBadge>` renders, the same `apiFetch` call routes through `TunnelTransport` to the daemon, which then hits npm. No phone-specific code.
- **CLI vs daemon double-fetch**: when the CLI standalone path (`miki start`) creates its own `VersionChecker`, it duplicates the work the daemon's VersionChecker does at startup. Acceptable — both are at startup, neither happens during a hot path. If this becomes a concern later, refactor `miki.ts` to wait for the daemon to come up and call `/admin/version-check`, but that's premature.
- **CRLF warning**: git may warn `LF will be replaced by CRLF` on Windows. Ignore — `.gitattributes` controls line endings; the warning is harmless.
- **No browser polling**: the dashboard fetches `/admin/version-check` exactly once on mount. If the user keeps a tab open for 48h, they won't see an updated badge until they refresh. Acceptable — the alternative (setInterval polling) burns connections for a low-value signal.

---

## Self-Review (writing-plans skill)

- [x] **Spec coverage**: Each spec section maps to a task. Architecture → Tasks 1-4. CLI UX → Task 5. Dashboard UX → Task 6. Phone PWA → automatic (Task 6, "Notes" + Task 7 verification). i18n → Task 3. Cache strategy → Task 2. Test plan → covered across Tasks 1-2-4 with the exact test files the spec named.
- [x] **Placeholder scan**: No TBD / TODO / "handle appropriately". Every step shows exact code, exact files, exact commands.
- [x] **Type consistency**: `VersionInfo` exported in Task 1, consumed in Task 2 (`VersionChecker.get()` returns `VersionInfo`), consumed in Task 4 (`ServerDeps.versionChecker: VersionChecker`), mirrored in Task 6 (`UpdateInfo` interface on the web side — name differs from the daemon side intentionally to avoid the temptation to share types across the daemon/web boundary; the wire format is the contract).
- [x] **Scope check**: Single subsystem (version notification). One implementation plan covers it.
