import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeypair, generateSigningKeypair, toBase64 } from "./crypto.js";

export interface PairedPeer {
  peer_id: string;
  peer_name: string;
  peer_pubkey: string;          // X25519 encryption pubkey (base64) — for shared secret
  peer_sign_pubkey?: string;    // Ed25519 signing pubkey (base64) — keys the relay's
                                // paired_phones map; required for revoke_phone RPC
  shared_secret: string;        // base64 (32 bytes)
  paired_at: number;
  last_seen_at: number | null;
}

export interface RemoteEndpoint {
  worker_url: string;          // wss://...
  /** Where the QR points. Defaults to the hosted PWA (https://miki-moni.pages.dev/);
   *  self-hosters get their own *.pages.dev written here by the setup wizard. */
  phone_pwa_url?: string;
  /** Persistent pairing token. Once set, the daemon registers this same token
   *  with the relay coordinator every restart, so the QR is permanent until
   *  the user explicitly rotates it with `pnpm pair --rotate`. 16-char
   *  Crockford base32. Optional for back-compat with old configs and for users
   *  who prefer ephemeral pair tokens via `pnpm pair --new`. */
  pair_token?: string;
}

/** UI language for setup wizard, CLI banner, dashboard. Persisted across runs. */
export type Locale = "en" | "zh-CN" | "zh-TW";

export interface Config {
  device: {
    name: string;
    pubkey: string;             // X25519 box pub, base64
    privkey: string;            // X25519 box priv, base64
    signing_pubkey: string;     // Ed25519 sign pub, base64
    signing_privkey: string;    // Ed25519 sign priv (64B), base64
    created_at: number;
  };
  /** Preferred UI language. Set by the setup wizard's first step; can be
   *  overridden anytime by editing config.json or via a future `miki locale`
   *  command. Defaults to "en" if missing (e.g. older configs). */
  locale?: Locale;
  remote?: RemoteEndpoint;
  paired_peers: PairedPeer[];
}

function defaultDeviceName(): string {
  return os.hostname() || `device-${Date.now()}`;
}

function makeDefaultConfig(): Config {
  const box = generateKeypair();
  const sign = generateSigningKeypair();
  return {
    device: {
      name: defaultDeviceName(),
      pubkey: toBase64(box.pubkey),
      privkey: toBase64(box.privkey),
      signing_pubkey: toBase64(sign.pubkey),
      signing_privkey: toBase64(sign.privkey),
      created_at: Date.now(),
    },
    paired_peers: [],
  };
}

/** Load config; migrate older configs lacking signing keys; return final. */
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
  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch (err) {
    throw new Error(`Failed to parse config at ${filePath}: ${(err as Error).message}`);
  }
  // Migrate: add signing keys if missing
  if (!parsed.device.signing_pubkey || !parsed.device.signing_privkey) {
    const sign = generateSigningKeypair();
    parsed.device.signing_pubkey = toBase64(sign.pubkey);
    parsed.device.signing_privkey = toBase64(sign.privkey);
    await saveConfig(filePath, parsed);
  }
  // Migrate: remove deprecated x_daemon_auth_token from remote if present
  if (parsed.remote && (parsed.remote as any).x_daemon_auth_token) {
    delete (parsed.remote as any).x_daemon_auth_token;
    await saveConfig(filePath, parsed);
  }
  return parsed;
}

export async function saveConfig(filePath: string, cfg: Config): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.rename(tmp, filePath);
}

/** Max peers to keep on disk. Beyond this we LRU-evict by last_seen_at
 *  (null treated as oldest). Each peer is ~250 bytes so the cap is generous;
 *  the goal is to prevent unbounded growth from PWA reinstalls (each one
 *  generates a fresh IndexedDB identity → new peer_id row even though it's
 *  the same physical device).
 *
 *  Override via env MIKI_PAIRED_PEERS_CAP for self-hosters with fleets.
 */
const PAIRED_PEERS_CAP_DEFAULT = 20;
function pairedPeersCap(): number {
  const env = Number.parseInt(process.env.MIKI_PAIRED_PEERS_CAP ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : PAIRED_PEERS_CAP_DEFAULT;
}

/** Days after which a peer with null last_seen_at gets pruned on add. */
const PEER_STALE_DAYS = 30;
const PEER_STALE_MS = PEER_STALE_DAYS * 24 * 60 * 60 * 1000;

export function addPairedPeer(cfg: Config, peer: PairedPeer): Config {
  // Dedupe by encryption pubkey: same physical key = same peer, refresh in place.
  const withoutDupe = cfg.paired_peers.filter((p) => p.peer_pubkey !== peer.peer_pubkey);
  const next = [...withoutDupe, peer];
  // Prune stale-and-never-seen peers (likely orphaned PWA installs).
  const now = Date.now();
  const pruned = next.filter((p) => {
    if (p === peer) return true;  // never drop the one we're adding
    if (p.last_seen_at !== null) return true;  // active peer, keep
    return now - p.paired_at < PEER_STALE_MS;
  });
  // Cap total: LRU-evict by last_seen_at (null = oldest), then by paired_at.
  const cap = pairedPeersCap();
  if (pruned.length <= cap) return { ...cfg, paired_peers: pruned };
  const sortedNewest = [...pruned].sort((a, b) => {
    const aLast = a.last_seen_at ?? 0;
    const bLast = b.last_seen_at ?? 0;
    if (aLast !== bLast) return bLast - aLast;
    return b.paired_at - a.paired_at;
  });
  return { ...cfg, paired_peers: sortedNewest.slice(0, cap) };
}

export function removePairedPeer(cfg: Config, peerId: string): Config {
  return { ...cfg, paired_peers: cfg.paired_peers.filter((p) => p.peer_id !== peerId) };
}

export function findPeerById(cfg: Config, peerId: string): PairedPeer | null {
  return cfg.paired_peers.find((p) => p.peer_id === peerId) ?? null;
}

/** Stamp last_seen_at on the matching peer. Returns a new Config (immutable
 *  pattern, same as the other helpers) or null if the peer isn't found —
 *  callers can skip the saveConfig in that case. */
export function touchPeerLastSeen(cfg: Config, peerId: string, ts: number = Date.now()): Config | null {
  let found = false;
  const next = cfg.paired_peers.map((p) => {
    if (p.peer_id !== peerId) return p;
    found = true;
    return { ...p, last_seen_at: ts };
  });
  return found ? { ...cfg, paired_peers: next } : null;
}
