/**
 * Incognito mode (T-incognito) — the user flips one header switch and the
 * app stops recording *anything* server-side and hides every user-data
 * affordance (bookmarks, ratings, tags, reading list, ...). Two fallbacks
 * live purely in the browser while the mode is on:
 *
 *  - Reading progress      → `panel-incognito:progress:v1`
 *  - Recently-viewed rail  → `panel-recently-viewed:v1` (existing store)
 *
 * The toggle state itself is browser-only (localStorage) so it is never
 * persisted server-side; the API client stamps every request with an
 * `X-Panel-Incognito: 1` header instead, which the server uses to refuse
 * user-data writes.
 *
 * Pure module (no React import) so the API layer can read the flag
 * synchronously; React components subscribe via `useIncognito()`, built on
 * `useSyncExternalStore`.
 */

const STORAGE_KEY = 'panel-incognito:v1';

let enabled = loadFlag();
const listeners = new Set<() => void>();

function loadFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Non-React read — used by the API client on every request. */
export function isIncognito(): boolean {
  return enabled;
}

/** Flip (or set) incognito mode. Persists to localStorage and notifies
 *  every `useSyncExternalStore` subscriber.
 *
 *  Only the ON state is persisted; disabling REMOVES the key, so the
 *  key's absence means "off". This avoids leaving a persistent `0`
 *  meta-trace that incognito mode exists / was used on the device —
 *  absence of the key is indistinguishable from never having used it. */
export function setIncognito(next: boolean): void {
  enabled = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked/full — the flag still applies for this session. Non-fatal.
  }
  for (const listener of listeners) listener();
}

export function toggleIncognito(): void {
  setIncognito(!enabled);
}

export function subscribeIncognito(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for `useSyncExternalStore` — stable reference between flips. */
export function incognitoSnapshot(): boolean {
  return enabled;
}
