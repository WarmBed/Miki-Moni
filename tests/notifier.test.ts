import { describe, it, expect, vi } from "vitest";
import { Notifier } from "../src/notifier.js";

describe("Notifier", () => {
  it("calls the underlying notify with composed title", async () => {
    const sendImpl = vi.fn();
    const n = new Notifier(sendImpl);
    await n.notify({ project: "dragonfly", message: "Claude is waiting" });
    expect(sendImpl).toHaveBeenCalledWith({
      title: "cc-hub · dragonfly",
      message: "Claude is waiting",
    });
  });
});
