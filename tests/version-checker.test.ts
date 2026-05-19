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
