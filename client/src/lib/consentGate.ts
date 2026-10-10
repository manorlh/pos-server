/**
 * THE consent gate of the browser — the one object every public page (digital menu, online ordering,
 * business card, legal pages) asks before any analytics or marketing code runs:
 *
 * ```ts
 * import { consentGate } from '@/lib/consentGate';
 * consentGate.whenAllowed('analytics', () => sendDigitalEvent(...)); // queued until granted
 * if (consentGate.allows('marketing')) { ... }
 * ```
 *
 * `PublicPageShell` / `CookieConsent` (components/public-legal) configure it for the page's business
 * and its published cookie-policy version. Its decisions are logged to `POST /public/v1/consents`.
 * The logic is lib/consent.ts (tested); this module only wires the browser's storage, randomness and
 * network, and degrades to memory where storage is blocked.
 */
import { createConsentGate, memoryStorage, type ConsentLogEntry, type ConsentStorage } from './consent';

export type { ConsentCategory, ConsentChoices, ConsentState, ConsentSurface } from './consent';

function browserStorage(): ConsentStorage {
  const fallback = memoryStorage();
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return fallback.get(key);
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        fallback.set(key, value);
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        fallback.remove(key);
      }
    },
  };
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
}

/** Fire-and-forget: no credentials, no cookies; a failure never changes the visitor's choice. */
export function postConsentLog(entry: ConsentLogEntry): void {
  if (typeof fetch !== 'function') return;
  void fetch(`${apiBase()}/public/v1/consents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'omit',
    // No `keepalive`: a JSON POST needs a CORS preflight, which keepalive requests may not get.
    body: JSON.stringify(entry),
  }).catch(() => undefined);
}

const isBrowser = typeof window !== 'undefined';

export const consentGate = createConsentGate({
  storage: isBrowser ? browserStorage() : memoryStorage(),
  randomBytes,
  log: isBrowser ? postConsentLog : undefined,
});
