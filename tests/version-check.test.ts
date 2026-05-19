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
