import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadOrInitConfig,
  saveConfig,
  addPairedPeer,
  removePairedPeer,
  findPeerById,
  type Config,
  type PairedPeer,
} from "../src/config.js";

let tmpPath: string;

beforeEach(async () => {
  tmpPath = path.join(os.tmpdir(), `cc-hub-test-${Date.now()}-${Math.random()}.json`);
});

describe("config loadOrInitConfig", () => {
  it("creates default config with device keypair when file missing", async () => {
    const cfg = await loadOrInitConfig(tmpPath);
    expect(cfg.device.name).toBeTruthy();
    expect(cfg.device.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cfg.device.privkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(cfg.paired_peers).toEqual([]);
    expect(cfg.remote).toBeUndefined();
    // Persisted
    const reread = await loadOrInitConfig(tmpPath);
    expect(reread.device.pubkey).toBe(cfg.device.pubkey);
  });

  it("loads existing config without regenerating keys", async () => {
    const first = await loadOrInitConfig(tmpPath);
    const second = await loadOrInitConfig(tmpPath);
    expect(second.device.privkey).toBe(first.device.privkey);
  });

  it("throws clear error when file exists but is malformed JSON", async () => {
    await fs.writeFile(tmpPath, "{ not valid json");
    await expect(loadOrInitConfig(tmpPath)).rejects.toThrow(/parse/i);
  });
});

describe("config addPairedPeer / removePairedPeer / findPeerById", () => {
  it("addPairedPeer appends a peer immutably", async () => {
    const cfg = await loadOrInitConfig(tmpPath);
    const peer: PairedPeer = {
      peer_id: "abc123",
      peer_name: "iPhone",
      peer_pubkey: "pk==",
      shared_secret: "ss==",
      paired_at: 1715760000000,
      last_seen_at: null,
    };
    const next = addPairedPeer(cfg, peer);
    expect(cfg.paired_peers).toHaveLength(0);
    expect(next.paired_peers).toHaveLength(1);
    expect(next.paired_peers[0]?.peer_id).toBe("abc123");
  });

  it("removePairedPeer removes by id", async () => {
    let cfg = await loadOrInitConfig(tmpPath);
    cfg = addPairedPeer(cfg, { peer_id: "a", peer_name: "A", peer_pubkey: "1", shared_secret: "s1", paired_at: 1, last_seen_at: null });
    cfg = addPairedPeer(cfg, { peer_id: "b", peer_name: "B", peer_pubkey: "2", shared_secret: "s2", paired_at: 2, last_seen_at: null });
    cfg = removePairedPeer(cfg, "a");
    expect(cfg.paired_peers).toHaveLength(1);
    expect(cfg.paired_peers[0]?.peer_id).toBe("b");
  });

  it("findPeerById returns peer or null", async () => {
    let cfg = await loadOrInitConfig(tmpPath);
    cfg = addPairedPeer(cfg, { peer_id: "x", peer_name: "X", peer_pubkey: "p", shared_secret: "s", paired_at: 1, last_seen_at: null });
    expect(findPeerById(cfg, "x")?.peer_name).toBe("X");
    expect(findPeerById(cfg, "nope")).toBeNull();
  });
});

describe("config saveConfig", () => {
  it("persists changes through round-trip", async () => {
    let cfg = await loadOrInitConfig(tmpPath);
    cfg = addPairedPeer(cfg, { peer_id: "p1", peer_name: "P1", peer_pubkey: "pk", shared_secret: "ss", paired_at: 1, last_seen_at: null });
    await saveConfig(tmpPath, cfg);
    const reloaded = await loadOrInitConfig(tmpPath);
    expect(reloaded.paired_peers).toHaveLength(1);
    expect(reloaded.paired_peers[0]?.peer_id).toBe("p1");
  });
});
