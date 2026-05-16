/**
 * store.ts — LocalStorage CRUD for phone paired state,
 *            plus IndexedDB persistence for dual keypair identity.
 */

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

// ─── LocalStorage: paired phone state ────────────────────────────────────────

const STORAGE_KEY = "cc-hub-phone-state";

export interface PhoneState {
  /** Legacy field: direct worker WebSocket URL (ws:// or wss://) */
  worker_url?: string;
  /** Relay HTTPS URL used for new-style pairing (e.g. https://relay.f1telemetrystationpro.org) */
  relay_url?: string;
  daemon_id: string;
  daemon_name: string;
  daemon_pk_b64: string;
  shared_secret_b64: string;
  phone_pk_b64: string;
  phone_privkey_b64: string;
  paired_at: number;
}

export function loadState(): PhoneState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PhoneState;
  } catch {
    return null;
  }
}

export function saveState(s: PhoneState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function clearState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ─── IndexedDB: dual keypair identity ────────────────────────────────────────

const DB_NAME = "cc-hub-phone";
const DB_VERSION = 1;
const STORE = "identity";
const KEY = "self";

export interface Identity {
  encryption_pubkey: string;   // X25519 box pub (base64)
  encryption_privkey: string;  // X25519 box priv (base64)
  signing_pubkey: string;      // Ed25519 sign pub (base64)
  signing_privkey: string;     // Ed25519 sign priv (base64)
  created_at: number;
}

// Replaceable IDBFactory — override in tests via resetDbForTesting()
let idbFactory: IDBFactory =
  typeof indexedDB !== "undefined" ? indexedDB : (undefined as unknown as IDBFactory);

/** Replace the IDBFactory used by this module (test-only). */
export function resetDbForTesting(factory: IDBFactory): void {
  idbFactory = factory;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadIdentity(): Promise<Identity | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveIdentity(id: Identity): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(id, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadOrCreateIdentity(): Promise<Identity> {
  const existing = await loadIdentity();
  if (existing) return existing;
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  const id: Identity = {
    encryption_pubkey: naclUtil.encodeBase64(box.publicKey),
    encryption_privkey: naclUtil.encodeBase64(box.secretKey),
    signing_pubkey: naclUtil.encodeBase64(sign.publicKey),
    signing_privkey: naclUtil.encodeBase64(sign.secretKey),
    created_at: Date.now(),
  };
  await saveIdentity(id);
  return id;
}
