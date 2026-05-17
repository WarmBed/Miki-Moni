import { describe, it, expect } from "vitest";
import { ExtRegistry, type ExtInfo } from "../src/ext-registry.js";

// Minimal "WebSocket" stand-in — registry doesn't call any methods on it
// during these tests, just uses it as a map key.
function fakeWs(name: string): any {
  return { _name: name };
}

const baseInfo = (root: string): ExtInfo => ({
  workspace_root: root,
  version: "0.1.0",
  registered_at: 1,
});

describe("ExtRegistry", () => {
  it("add + findForCwd returns the registered ws when cwd is the workspace itself", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("d:/code")).toBe(ws);
  });

  it("findForCwd returns the registered ws when cwd is a descendant of workspace", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("d:/code/miki-moni/src")).toBe(ws);
  });

  it("findForCwd returns null when no workspace covers the cwd", () => {
    const r = new ExtRegistry();
    r.add(fakeWs("a"), baseInfo("d:/code"));
    expect(r.findForCwd("d:/other/path")).toBeNull();
  });

  it("normalizes case (Windows) — uppercase cwd still matches lowercase root", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("D:\\Code\\sub")).toBe(ws);
  });

  it("longest-prefix-wins when multiple workspaces match", () => {
    const r = new ExtRegistry();
    const wsBroad = fakeWs("broad");
    const wsDeep = fakeWs("deep");
    r.add(wsBroad, baseInfo("d:/code"));
    r.add(wsDeep, baseInfo("d:/code/xianyu-assistant"));
    expect(r.findForCwd("d:/code/xianyu-assistant/lib")).toBe(wsDeep);
    expect(r.findForCwd("d:/code/other-project/lib")).toBe(wsBroad);
  });

  it("remove unregisters the ws", () => {
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    r.remove(ws);
    expect(r.findForCwd("d:/code")).toBeNull();
  });

  it("list returns all registered entries", () => {
    const r = new ExtRegistry();
    r.add(fakeWs("a"), baseInfo("d:/code"));
    r.add(fakeWs("b"), baseInfo("d:/other"));
    expect(r.list()).toHaveLength(2);
    expect(r.list().map((e) => e.info.workspace_root).sort()).toEqual(["d:/code", "d:/other"]);
  });

  it("does NOT match when cwd shares a prefix but isn't a path-descendant (false-positive guard)", () => {
    // "d:/codex" must NOT match workspace "d:/code"
    const r = new ExtRegistry();
    const ws = fakeWs("a");
    r.add(ws, baseInfo("d:/code"));
    expect(r.findForCwd("d:/codex/sub")).toBeNull();
  });
});
