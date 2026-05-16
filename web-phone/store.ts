/**
 * store.ts — LocalStorage CRUD for phone paired state.
 */

const STORAGE_KEY = "cc-hub-phone-state";

export interface PhoneState {
  worker_url: string;        // ws:// or wss://
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
