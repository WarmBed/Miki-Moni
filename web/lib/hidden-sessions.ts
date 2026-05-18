/**
 * Per-browser hidden-card store. Lives only in localStorage; the daemon
 * doesn't know about it. Cross-tab sync is handled by the consumer via
 * the `storage` event.
 *
 * Why a separate file: keeping it pure (no Preact, no DOM hooks) means
 * we can vitest the whole thing in isolation against a FakeStorage stub.
 * The Preact `useState`/`useEffect` wiring lives in app.tsx and just
 * delegates to these four functions.
 */

export const HIDDEN_KEY = "miki-moni:hidden-sessions";

export function loadHiddenSet(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveHiddenSet(s: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...s]));
  } catch (err) {
    console.warn("miki-moni: failed to persist hidden-sessions:", err);
  }
}

export function addHidden(current: Set<string>, uuid: string): Set<string> {
  const next = new Set(current);
  next.add(uuid);
  saveHiddenSet(next);
  return next;
}

export function removeHidden(current: Set<string>, uuid: string): Set<string> {
  const next = new Set(current);
  next.delete(uuid);
  saveHiddenSet(next);
  return next;
}
