import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SeenUuids } from "./seen-uuids.js";

const TMP = path.join(os.tmpdir(), `miki-seen-${Date.now()}-${Math.random()}.json`);

describe("SeenUuids", () => {
  beforeEach(async () => { await fs.rm(TMP, { force: true }); });

  it("first call is firstSight=true, subsequent calls false", async () => {
    const s = new SeenUuids(TMP, 10);
    expect(await s.recordAndCheck("u1")).toBe(true);
    expect(await s.recordAndCheck("u1")).toBe(false);
    expect(await s.recordAndCheck("u2")).toBe(true);
  });

  it("evicts LRU when over capacity", async () => {
    const s = new SeenUuids(TMP, 3);
    await s.recordAndCheck("a");
    await s.recordAndCheck("b");
    await s.recordAndCheck("c");
    await s.recordAndCheck("d"); // evicts "a"
    expect(await s.recordAndCheck("a")).toBe(true);  // a was forgotten
    expect(await s.recordAndCheck("d")).toBe(false);
  });

  it("survives across instances via file persistence", async () => {
    const s1 = new SeenUuids(TMP, 10);
    await s1.recordAndCheck("x");
    const s2 = new SeenUuids(TMP, 10);
    expect(await s2.recordAndCheck("x")).toBe(false);
  });
});
