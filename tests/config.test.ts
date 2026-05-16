import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// ── signing keypair migration tests ──────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `cc-hub-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const cfgPath = path.join(tmpDir, "config.json");

beforeEach(async () => { await fs.mkdir(tmpDir, { recursive: true }); });
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe("config signing keypair migration", () => {
  it("fresh config has both encryption + signing keypairs", async () => {
    const cfg = await loadOrInitConfig(cfgPath);
    expect(cfg.device.pubkey).toBeTruthy();
    expect(cfg.device.signing_pubkey).toBeTruthy();
    expect(cfg.device.signing_privkey).toBeTruthy();
    expect(cfg.device.signing_pubkey).not.toBe(cfg.device.pubkey);
  });

  it("legacy config without signing keys gets migrated on load", async () => {
    const legacy = {
      device: {
        name: "old-device",
        pubkey: "legacyPubBase64==",
        privkey: "legacyPrivBase64==",
        created_at: 1700000000000,
      },
      paired_peers: [],
    };
    await fs.writeFile(cfgPath, JSON.stringify(legacy));

    const cfg = await loadOrInitConfig(cfgPath);
    expect(cfg.device.signing_pubkey).toBeTruthy();
    expect(cfg.device.signing_privkey).toBeTruthy();
    expect(cfg.device.pubkey).toBe("legacyPubBase64==");
    expect(cfg.device.privkey).toBe("legacyPrivBase64==");
  });

  it("migration is persisted (next load reads new signing keys back)", async () => {
    const legacy = { device: { name: "x", pubkey: "p", privkey: "k", created_at: 1 }, paired_peers: [] };
    await fs.writeFile(cfgPath, JSON.stringify(legacy));
    const cfg1 = await loadOrInitConfig(cfgPath);
    const sigPub = cfg1.device.signing_pubkey;
    const cfg2 = await loadOrInitConfig(cfgPath);
    expect(cfg2.device.signing_pubkey).toBe(sigPub);
  });

  it("removes deprecated x_daemon_auth_token from remote on load", async () => {
    const legacy = {
      device: { name: "x", pubkey: "p", privkey: "k", created_at: 1 },
      remote: { worker_url: "wss://x", x_daemon_auth_token: "OBSOLETE_TOKEN" },
      paired_peers: [],
    };
    await fs.writeFile(cfgPath, JSON.stringify(legacy));
    const cfg = await loadOrInitConfig(cfgPath);
    expect(cfg.remote?.worker_url).toBe("wss://x");
    expect((cfg.remote as any)?.x_daemon_auth_token).toBeUndefined();
  });
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
