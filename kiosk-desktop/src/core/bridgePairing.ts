/**
 * The bridge's pairing code (docs/SPEC_KIOSK.md §28.3): 6 digits shown in the bridge's window (or
 * handed to the browser the bridge opens itself, in the address's fragment), good for 10 minutes
 * and for ONE pairing. Five wrong codes lock the pairing for a minute and draw a new code, so a
 * page cannot guess its way in (1 in 200 000 per code at most). Pure: the clock and the random
 * digits are given.
 */

export const CODE_DIGITS = 6;
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_TRIES = 5;
export const LOCK_MS = 60_000;

export interface PairingCode {
  code: string;
  issuedAt: number;
  tries: number;
  lockedUntil: number;
}

/** A new code from random bytes (each byte → one digit, rejection-free bias is < 3%, fine for a 10-minute code). */
export function newCode(randomBytes: (n: number) => Uint8Array, now: number): PairingCode {
  const bytes = randomBytes(CODE_DIGITS);
  let code = '';
  for (let i = 0; i < CODE_DIGITS; i++) code += String(bytes[i] % 10);
  return { code, issuedAt: now, tries: 0, lockedUntil: 0 };
}

export function expired(c: PairingCode, now: number): boolean {
  return now - c.issuedAt >= CODE_TTL_MS;
}

export function secondsLeft(c: PairingCode, now: number): number {
  return Math.max(0, Math.ceil((c.issuedAt + CODE_TTL_MS - now) / 1000));
}

/** Constant-time string compare (same length only). */
export function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'locked' | 'wrong' | 'locked_out'; triesLeft: number; retryInMs: number };

/**
 * A code typed in the page, against the one shown. On a wrong code the state is updated in place;
 * the caller draws a new code on `locked_out` and `expired`, and drops the code on `ok` (one use).
 */
export function checkCode(c: PairingCode | null, entered: string, now: number): { result: CodeCheck; next: PairingCode | null } {
  if (!c) return { result: { ok: false, reason: 'no_code', triesLeft: 0, retryInMs: 0 }, next: null };
  if (c.lockedUntil > now) return { result: { ok: false, reason: 'locked', triesLeft: 0, retryInMs: c.lockedUntil - now }, next: c };
  if (expired(c, now)) return { result: { ok: false, reason: 'expired', triesLeft: 0, retryInMs: 0 }, next: c };
  const digits = entered.replace(/[\s-]+/g, '');
  if (/^[0-9]{6}$/.test(digits) && sameCode(digits, c.code)) return { result: { ok: true }, next: null };
  const tries = c.tries + 1;
  if (tries >= MAX_TRIES) {
    return { result: { ok: false, reason: 'locked_out', triesLeft: 0, retryInMs: LOCK_MS }, next: { ...c, tries, lockedUntil: now + LOCK_MS } };
  }
  return { result: { ok: false, reason: 'wrong', triesLeft: MAX_TRIES - tries, retryInMs: 0 }, next: { ...c, tries } };
}

/** The refusal in Hebrew, for the page to show as it is. */
export function codeRefusalText(r: Exclude<CodeCheck, { ok: true }>): string {
  if (r.reason === 'no_code') return 'אין קוד צימוד פעיל בגשר. פתחו את חלון הגשר ולחצו "קוד צימוד חדש".';
  if (r.reason === 'expired') return 'פג תוקף הקוד. בחלון הגשר מוצג עכשיו קוד חדש.';
  if (r.reason === 'locked' || r.reason === 'locked_out') return `יותר מדי ניסיונות. נסו שוב בעוד ${Math.max(1, Math.ceil(r.retryInMs / 1000))} שניות עם הקוד החדש שבחלון הגשר.`;
  return `קוד שגוי (נותרו ${r.triesLeft} ניסיונות)`;
}
