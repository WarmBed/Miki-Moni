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
