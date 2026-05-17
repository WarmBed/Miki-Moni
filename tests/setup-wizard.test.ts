import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  runSetupWizard,
  HOSTED_RELAY_URL,
  HOSTED_PHONE_PWA_URL,
} from "../src/cli/setup-wizard.js";
import type { Config } from "../src/config.js";

function emptyCfg(): Config {
  return {
    device: {
      name: "test",
      pubkey: "p",
      privkey: "pp",
      signing_pubkey: "sp",
      signing_privkey: "spp",
      created_at: 0,
    },
    paired_peers: [],
  };
}

describe("setup wizard", () => {
  it("hosted choice writes the well-known relay + PWA URLs", async () => {
    const cfg = emptyCfg();
    const next = await runSetupWizard(cfg, { forceChoice: "hosted" });
    expect(next.remote?.worker_url).toBe(HOSTED_RELAY_URL);
    expect(next.remote?.phone_pwa_url).toBe(HOSTED_PHONE_PWA_URL);
  });

  it("local-only choice strips remote AND writes the wizard sentinel file", async () => {
    const cfg = emptyCfg();
    const next = await runSetupWizard(cfg, { forceChoice: "local-only" });
    expect(next.remote).toBeUndefined();

    // Sentinel exists so the wizard doesn't re-trigger on next start.
    const marker = path.join(os.homedir(), ".miki-moni", "wizard-local-only");
    await expect(fs.access(marker)).resolves.toBeUndefined();
    // Clean up so the test is repeatable.
    await fs.unlink(marker);
  });

  it("preserves unrelated config fields (paired_peers etc.) across the wizard", async () => {
    const cfg = emptyCfg();
    cfg.paired_peers = [{
      peer_id: "X", peer_name: "p", peer_pubkey: "p",
      shared_secret: "s", paired_at: 1, last_seen_at: null,
    }];
    const next = await runSetupWizard(cfg, { forceChoice: "hosted" });
    expect(next.paired_peers).toHaveLength(1);
    expect(next.device.name).toBe("test");
  });
});
