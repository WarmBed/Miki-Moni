import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeypair, toBase64 } from "./crypto.js";

export interface PairedPeer {
  peer_id: string;
  peer_name: string;
  peer_pubkey: string;     // base64
  shared_secret: string;   // base64 (32 bytes)
  paired_at: number;
  last_seen_at: number | null;
}

export interface RemoteEndpoint {
  worker_url: string;          // wss://...
  x_daemon_auth_token: string;
}

export interface Config {
  device: {
    name: string;
    pubkey: string;   // base64
    privkey: string;  // base64
    created_at: number;
  };
  remote?: RemoteEndpoint;
  paired_peers: PairedPeer[];
}

function defaultDeviceName(): string {
  return os.hostname() || `device-${Date.now()}`;
}

function makeDefaultConfig(): Config {
  const kp = generateKeypair();
  return {
    device: {
      name: defaultDeviceName(),
      pubkey: toBase64(kp.pubkey),
      privkey: toBase64(kp.privkey),
      created_at: Date.now(),
    },
    paired_peers: [],
  };
}

export async function loadOrInitConfig(filePath: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const cfg = makeDefaultConfig();
      await saveConfig(filePath, cfg);
      return cfg;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    throw new Error(`Failed to parse config at ${filePath}: ${(err as Error).message}`);
  }
}

export async function saveConfig(filePath: string, cfg: Config): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, filePath);
}

export function addPairedPeer(cfg: Config, peer: PairedPeer): Config {
  return { ...cfg, paired_peers: [...cfg.paired_peers, peer] };
}

export function removePairedPeer(cfg: Config, peerId: string): Config {
  return { ...cfg, paired_peers: cfg.paired_peers.filter((p) => p.peer_id !== peerId) };
}

export function findPeerById(cfg: Config, peerId: string): PairedPeer | null {
  return cfg.paired_peers.find((p) => p.peer_id === peerId) ?? null;
}
