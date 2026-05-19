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
