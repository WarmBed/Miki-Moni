import { describe, expect, it } from "vitest";
import { zhTW, zhCN, en } from "../shared/i18n.js";

describe("i18n locale parity", () => {
  it("zh-CN has every key that zh-TW has", () => {
    const tw = new Set(Object.keys(zhTW));
    const cn = new Set(Object.keys(zhCN));
    const missing = [...tw].filter(k => !cn.has(k));
    expect(missing, `zh-CN missing keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("en has every key that zh-TW has", () => {
    const tw = new Set(Object.keys(zhTW));
    const e = new Set(Object.keys(en));
    const missing = [...tw].filter(k => !e.has(k));
    expect(missing, `en missing keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("zh-TW has the X-close keys", () => {
    expect(zhTW["session.closeWrapped"]).toBeTypeOf("string");
    expect(zhTW["session.closeHidden"]).toBeTypeOf("string");
    expect(zhTW["session.unhide"]).toBeTypeOf("string");
    expect(zhTW["filter.hiddenLabel"]).toBeTypeOf("string");
    expect(zhTW["filter.hiddenTooltip"]).toBeTypeOf("string");
  });

  it("session.copyRestart has been removed", () => {
    expect(zhTW["session.copyRestart"]).toBeUndefined();
    expect(zhCN["session.copyRestart"]).toBeUndefined();
    expect(en["session.copyRestart"]).toBeUndefined();
  });
});
