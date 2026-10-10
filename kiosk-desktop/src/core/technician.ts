/**
 * "בדיקות ומידע קיוסק" — the technician screen's gate, as the Android kiosk's
 * (pos-android domain/KioskTechnicianGate.kt): six taps within ~3 s in the physical top-left
 * corner (an L along the edges, where no screen draws anything), then the code (1995 unless the
 * cloud's parameter `technicianCode` says otherwise — it arrives only as a PBKDF2 hash salted
 * with the machine id); five wrong codes lock the pad for five minutes; never during a payment.
 */

export const TAPS = 6;
export const WINDOW_MS = 3_000;
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 5 * 60_000;
export const IDLE_CLOSE_MS = 5 * 60_000;
export const PAD_IDLE_MS = 45_000;
export const DEFAULT_CODE = '1995';
export const SCHEME = 'pbkdf2-sha256';
export const ITERATIONS = 10_000;
export const SALT_PREFIX = 'r2m-kiosk-technician:';

/** The zone, in dp (CSS px of the kiosk's layout) from the physical top-left corner. */
export const ZONE = { LEFT: 20, TOP: 12, REACH: 72 } as const;

export function inTechnicianZone(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && ((x < ZONE.LEFT && y < ZONE.REACH) || (y < ZONE.TOP && x < ZONE.REACH));
}

export class TapSequence {
  private times: number[] = [];

  constructor(
    private readonly needed = TAPS,
    private readonly windowMs = WINDOW_MS,
  ) {}

  /** A tap at `nowMs`: true when it completes the sequence (which then starts over). */
  tap(nowMs: number): boolean {
    this.times.push(nowMs);
    while (this.times.length > 0 && nowMs - this.times[0] > this.windowMs) this.times.shift();
    if (this.times.length >= this.needed) {
      this.times = [];
      return true;
    }
    return false;
  }

  reset() {
    this.times = [];
  }
}

export interface TechLock {
  failures: number;
  lockedUntilMs: number;
}

export const NO_LOCK: TechLock = { failures: 0, lockedUntilMs: 0 };

/** The lock as it stands now: run out → cleared; reaching too far (clock moved back) → cut. */
export function lockAt(lock: TechLock, nowMs: number): TechLock {
  if (lock.lockedUntilMs <= 0) return lock;
  if (lock.lockedUntilMs <= nowMs) return NO_LOCK;
  if (lock.lockedUntilMs - nowMs > LOCKOUT_MS) return { ...lock, lockedUntilMs: nowMs + LOCKOUT_MS };
  return lock;
}

export type CodeOutcome = 'granted' | 'wrong' | 'locked_out' | 'locked';

export function attempt(lock: TechLock, nowMs: number, check: () => boolean): { outcome: CodeOutcome; lock: TechLock; triesLeft: number } {
  const now = lockAt(lock, nowMs);
  if (now.lockedUntilMs > nowMs) return { outcome: 'locked', lock: now, triesLeft: 0 };
  if (check()) return { outcome: 'granted', lock: NO_LOCK, triesLeft: 0 };
  const failures = now.failures + 1;
  if (failures >= MAX_FAILURES) return { outcome: 'locked_out', lock: { failures, lockedUntilMs: nowMs + LOCKOUT_MS }, triesLeft: 0 };
  return { outcome: 'wrong', lock: { failures, lockedUntilMs: 0 }, triesLeft: MAX_FAILURES - failures };
}

/** May the taps open the pad: never on the pay screen, a payment held, or a card on the terminal. */
export function mayOpen(flow: { screen: string; busy: boolean }, cardInFlight: boolean): boolean {
  return !cardInFlight && !flow.busy && flow.screen !== 'pay';
}

/** PBKDF2-HMAC-SHA256 of the digits, salted with the prefix and the machine id ("pbkdf2-sha256$10000$<hex>"). */
export type Pbkdf2 = (password: string, salt: string, iterations: number, keyLen: number) => Uint8Array;

export function hashCode(code: string, machineId: string, pbkdf2: Pbkdf2, iterations = ITERATIONS): string {
  const salt = SALT_PREFIX + machineId.trim().toLowerCase();
  const bytes = pbkdf2(code.trim(), salt, iterations, 32);
  return `${SCHEME}$${iterations}$${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function iterationsOf(stored: string): number | null {
  const parts = stored.trim().split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return null;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
  return n >= 1_000 && n <= 1_000_000 ? n : null;
}

/** Whether `entered` is the code (the cloud's hash, or the default). */
export function codeMatches(entered: string, stored: string | null | undefined, machineId: string, pbkdf2: Pbkdf2): boolean {
  const digits = entered.trim();
  if (!/^[0-9]{4,8}$/.test(digits)) return false;
  const held = stored?.trim() || null;
  const expected = held ?? hashCode(DEFAULT_CODE, machineId, pbkdf2);
  const iterations = iterationsOf(expected);
  let actual: string;
  if (iterations !== null) actual = hashCode(digits, machineId, pbkdf2, iterations);
  else if (expected.startsWith(`${SCHEME}$`)) return false;
  else actual = digits;
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** TeamViewer QuickSupport on Windows: the usual install places, first found wins. */
export const QUICKSUPPORT_PATHS = [
  'C:\\Program Files\\TeamViewer\\TeamViewer.exe',
  'C:\\Program Files (x86)\\TeamViewer\\TeamViewer.exe',
  'C:\\TeamViewerQS\\TeamViewerQS.exe',
  'C:\\Program Files\\TeamViewer QS\\TeamViewerQS.exe',
];
