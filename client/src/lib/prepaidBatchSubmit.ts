/**
 * "הנפקת אצווה" exactly once — the dashboard side of POST /prepaid-vouchers/batches
 * (server: app/services/prepaid_batch_create.py).
 *
 * The owner's report: "הנפקנו 50 שוברים וזה הראה שגיאה, ניסינו שוב והסתדר" — the first request had
 * made the batch, its answer was lost, and the second click made a second batch. Now:
 *
 * - every form submission carries an `Idempotency-Key`: the same body keeps the same key until it
 *   succeeds (a retry, a second click, the dialog closed and reopened, even the page reloaded —
 *   the pending keys live in sessionStorage), so the server answers a retry with the SAME batch;
 * - no answer (a network error, a timeout) or a server error: "בודק אם האצווה נוצרה…" and the
 *   same request is sent again with the same key; when that does not help either, "נסה שוב"
 *   sends it once more — with the same key, never a new batch;
 * - a refusal (a 4xx: the form is wrong) is shown as it is and not retried;
 * - `idempotency_key_reused` (the key belongs to another request): a fresh key, sent once.
 *
 * Pure (no React, no axios): the dialog in app/dashboard/prepaid-vouchers/page.tsx uses it.
 */
import { isKeyReused, newKey, retryableSendError } from './deviceCommands';

/** What the dialog shows while it re-checks after a lost answer (also in messages/he.json). */
export const CHECKING_TEXT = 'בודק אם האצווה נוצרה…';
export const RETRY_TEXT = 'נסה שוב';
export const DUPLICATE_TEXT = 'נראה שאצווה זהה נוצרה לפני רגע — לבטל את הכפולה?';

/** One request's own time limit: past it the answer counts as lost and is asked for again. */
export const ATTEMPT_TIMEOUT_MS = 45_000;
/** The waits before the automatic re-sends (same key). */
export const RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000];
/** The server keeps a key for a day; the dashboard forgets an unresolved one sooner. */
export const KEY_TTL_MS = 12 * 60 * 60 * 1000;
export const STORAGE_NAME = 'prepaidBatchKeys';

export type SubmitPhase = 'idle' | 'sending' | 'checking' | 'failed';

export type SubmitResult<T> =
  | { ok: true; value: T; key: string; attempts: number }
  | { ok: false; error: unknown; key: string; attempts: number; retryable: boolean };

/** The HTTP status of a failed request; null when no answer came at all (network, timeout). */
export function errorStatus(err: unknown): number | null {
  const r = (err as { response?: { status?: number } } | null)?.response;
  return typeof r?.status === 'number' ? r.status : null;
}

/** Worth sending again with the same key: no answer, a timeout, a rate limit or a server error. */
export function isRetryable(err: unknown): boolean {
  return retryableSendError(errorStatus(err));
}

/** FNV-1a of the request: the storage holds a short id, not the whole body. */
export function requestId(request: unknown): string {
  const text = JSON.stringify(request ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${text.length}`;
}

interface StorageLike {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

type Stored = Record<string, { key: string; at: number }>;

/**
 * The key of each submission: the same request → the same key, until `forget` (after a success,
 * or when the server says the key belongs to another request). With [storage] the unresolved keys
 * survive a reload; storage that throws or is missing is simply not used.
 */
export interface BatchKeys {
  keyFor(request: unknown): string;
  forget(request: unknown): void;
}

export function batchKeys(
  storage: StorageLike | null = null,
  make: () => string = newKey,
  now: () => number = Date.now,
): BatchKeys {
  const memory = new Map<string, string>();
  const read = (): Stored => {
    if (!storage) return {};
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_NAME) || '{}') as Stored;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const write = (all: Stored) => {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_NAME, JSON.stringify(all));
    } catch {
      /* private mode / full: the in-memory key still holds for this page */
    }
  };
  const fresh = (all: Stored): Stored => {
    const t = now();
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v && typeof v.key === 'string' && t - v.at < KEY_TTL_MS));
  };
  return {
    keyFor(request) {
      const id = requestId(request);
      const all = fresh(read());
      const key = memory.get(id) ?? all[id]?.key ?? make();
      memory.set(id, key);
      write({ ...all, [id]: { key, at: all[id]?.at ?? now() } });
      return key;
    },
    forget(request) {
      const id = requestId(request);
      memory.delete(id);
      const all = fresh(read());
      delete all[id];
      write(all);
    },
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends [request] with its key, and again with the SAME key while the answer is lost or the server
 * failed (RETRY_DELAYS_MS); `onPhase('checking')` before each re-send. A refusal is not retried.
 * The key is forgotten after a success; on `idempotency_key_reused` a fresh one is sent once.
 */
export async function submitWithKey<T>(
  keys: BatchKeys,
  request: unknown,
  send: (key: string) => Promise<T>,
  opts: { delays?: readonly number[]; onPhase?: (phase: SubmitPhase) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SubmitResult<T>> {
  const delays = opts.delays ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? wait;
  let key = keys.keyFor(request);
  let attempts = 0;
  let renewed = false;
  opts.onPhase?.('sending');
  for (;;) {
    attempts++;
    try {
      const value = await send(key);
      keys.forget(request);
      opts.onPhase?.('idle');
      return { ok: true, value, key, attempts };
    } catch (error) {
      if (isKeyReused(error) && !renewed) {
        keys.forget(request);
        key = keys.keyFor(request);
        renewed = true;
        continue;
      }
      const retryable = isRetryable(error);
      const retriesUsed = attempts - 1 - (renewed ? 1 : 0);
      if (retryable && retriesUsed < delays.length) {
        opts.onPhase?.('checking');
        await sleep(delays[retriesUsed]);
        continue;
      }
      opts.onPhase?.('failed');
      return { ok: false, error, key, attempts, retryable };
    }
  }
}

/** The earlier identical batch the server names (`possibleDuplicate`), as the dialog shows it. */
export interface PrepaidDuplicateRef {
  id: string;
  name: string;
  customerName: string | null;
  count: number;
  createdAt: string | null;
  cancelReason: string;
}

export function duplicateOf(answer: { possibleDuplicate?: PrepaidDuplicateRef | null } | null | undefined): PrepaidDuplicateRef | null {
  const d = answer?.possibleDuplicate;
  return d && typeof d.id === 'string' && d.id ? d : null;
}

/** sessionStorage when there is one (the browser), else none. */
export function sessionStore(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
