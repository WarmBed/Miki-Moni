import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

// Central runtime-data location for the Miki-Moni daemon.
// Single source of truth — every component derives port file, config, sqlite,
// log file from here.
export const HUB_HOME = path.join(os.homedir(), ".miki-moni");
export const PORT_FILE = path.join(HUB_HOME, "port");
export const CONFIG_FILE = path.join(HUB_HOME, "config.json");
export const DB_FILE = path.join(HUB_HOME, "state.db");
export const LOG_FILE = path.join(HUB_HOME, "miki-moni.log");

// One-shot migration from the legacy `~/.cc-hub` directory that pre-2026-05-17
// installs used. If the legacy dir exists and the new one doesn't, rename
// (preserves pairing keys, sessions DB, port file). Safe to call repeatedly —
// after the first run the legacy dir is gone and this is a no-op.
//
// Must be invoked before any code reads or writes inside HUB_HOME.
export async function migrateLegacyHubHome(): Promise<{ migrated: boolean }> {
  const legacy = path.join(os.homedir(), ".cc-hub");
  const [legacyExists, currentExists] = await Promise.all([
    fs.access(legacy).then(() => true, () => false),
    fs.access(HUB_HOME).then(() => true, () => false),
  ]);
  if (legacyExists && !currentExists) {
    await fs.rename(legacy, HUB_HOME);
    return { migrated: true };
  }
  return { migrated: false };
}
