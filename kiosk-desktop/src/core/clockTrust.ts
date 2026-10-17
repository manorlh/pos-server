/**
 * Trusted time and the clock auto-fix (the owner, 17.10.2026: "האם יש דרך לתקן את השעה באנדרואיד כשהתוכנה מזהה בעיה
 * בשעה, וגם בווינדוס אוטומטית?"). A fiscal document must carry the right time, and a till's clock is often wrong.
 *
 * * **Trusted time** ({@link trustedNow}): every heartbeat measures the device clock against the server's `Date`
 *   (`skewMs`, device minus server). From {@link TRUST_MS} (90 s) of skew the app stamps documents, shifts, Zs and
 *   the business date with the server-corrected time (`wall − skew`) instead of the device clock. Only from an
 *   answer over TLS (or the loopback of a developer's machine) — never from a plain-HTTP one — and only while the
 *   wall clock has not been stepped since the measurement (`bootWallMs` = wall − monotonic at the measurement: a
 *   step, or a restart, moves it): someone fixing the clock, or the device restarting, falls back to the device clock
 *   until the next beat measures again. A sale is never blocked by any of this.
 * * **The auto-fix** ({@link fixAction}): what the device may do about its own clock — on Android as the device owner
 *   (automatic time first, then the server's time), on Windows only when the app already runs elevated (never a UAC
 *   prompt by itself — the technician's "תיקון שעון" asks for it). Otherwise `prompt`: the staff are told.
 *
 * One rule with pos-android domain/ClockTrust.kt, pinned by `clock_trust_golden.json` (same bytes in pos-android's
 * app/src/test/resources and pos-server's tests/fixtures). Pure: no clock is read here.
 */

export const TRUST_MS = 90_000;
/** How far `wall − monotonic` may move (NTP slewing) before the measurement is taken as stepped. */
export const STEP_TOLERANCE_MS = 120_000;
/** A fix uses only a measurement this fresh (monotonic age). */
export const FRESH_MS = 10 * 60_000;
/** One clock change per half hour at most. */
export const COOLDOWN_MS = 30 * 60_000;
/** Android: after turning automatic time on, how long network time gets before the server's time is set. */
export const AUTO_TIME_GRACE_MS = 3 * 60_000;
/** `DevicePolicyManager.setTime`: Android 9. */
export const SET_TIME_MIN_SDK = 28;

export type TimeSource = 'device' | 'server';
export type TrustReason = 'none' | 'insecure' | 'small' | 'stepped' | 'applied';
export type FixCapability = 'device_owner' | 'elevated' | 'none';
export type FixAction = 'none' | 'enable_auto_time' | 'set_time' | 'prompt';
export type FixReason =
  | 'unknown'
  | 'ok'
  | 'insecure'
  | 'stale'
  | 'off'
  | 'manual'
  | 'busy'
  | 'auto_time_off'
  | 'waiting_network_time'
  | 'sdk'
  | 'cooldown'
  | 'fix';
export type FixResult = 'ok' | 'failed' | 'refused';

/** One measurement against the server. */
export interface ClockMeasurement {
  skewMs: number;
  /** Wall clock minus the monotonic clock at the measurement. */
  bootWallMs: number;
  /** The answer came over TLS (or the loopback). */
  secure: boolean;
}

export interface Trusted {
  nowMs: number;
  source: TimeSource;
  reason: TrustReason;
}

/** The time to stamp with now: the server-corrected one when the device is off by {@link TRUST_MS} or more. */
export function trustedNow(wallMs: number, monoMs: number, m: ClockMeasurement | null | undefined): Trusted {
  if (!m || !Number.isFinite(m.skewMs)) return { nowMs: wallMs, source: 'device', reason: 'none' };
  if (!m.secure) return { nowMs: wallMs, source: 'device', reason: 'insecure' };
  if (Math.abs(m.skewMs) < TRUST_MS) return { nowMs: wallMs, source: 'device', reason: 'small' };
  if (Math.abs(wallMs - monoMs - m.bootWallMs) > STEP_TOLERANCE_MS) return { nowMs: wallMs, source: 'device', reason: 'stepped' };
  return { nowMs: wallMs - m.skewMs, source: 'server', reason: 'applied' };
}

export interface FixFacts {
  skewMs: number | null;
  /** Monotonic age of the measurement; null: none. */
  ageMs: number | null;
  secure: boolean;
  /** The till parameter `clockAutoFix` (on by default). */
  enabled: boolean;
  capability: FixCapability;
  /** Android's automatic time (null: not readable / not Android). */
  autoTimeOn: boolean | null;
  sdk: number | null;
  /** A sale, a payment or a card operation is open. */
  busy: boolean;
  /** Since this app turned automatic time on (monotonic); null: never (this boot). */
  sinceAutoTimeMs: number | null;
  /** Since this app last set the clock (monotonic); null: never (this boot). */
  sinceSetTimeMs: number | null;
}

/** What to do about the device clock now. */
export function fixAction(f: FixFacts): { action: FixAction; reason: FixReason } {
  if (f.skewMs === null || !Number.isFinite(f.skewMs)) return { action: 'none', reason: 'unknown' };
  if (Math.abs(f.skewMs) < TRUST_MS) return { action: 'none', reason: 'ok' };
  if (!f.secure) return { action: 'prompt', reason: 'insecure' };
  if (f.ageMs === null || f.ageMs > FRESH_MS) return { action: 'none', reason: 'stale' };
  if (!f.enabled) return { action: 'prompt', reason: 'off' };
  if (f.capability === 'none') return { action: 'prompt', reason: 'manual' };
  if (f.busy) return { action: 'none', reason: 'busy' };
  if (f.capability === 'device_owner') {
    if (f.autoTimeOn !== true) {
      if (f.sinceAutoTimeMs === null || f.sinceAutoTimeMs >= COOLDOWN_MS) return { action: 'enable_auto_time', reason: 'auto_time_off' };
      // Turned on lately and off again (or not readable): the server's time below.
    } else if (f.sinceAutoTimeMs !== null && f.sinceAutoTimeMs < AUTO_TIME_GRACE_MS) {
      return { action: 'none', reason: 'waiting_network_time' };
    }
    if (f.sdk !== null && f.sdk < SET_TIME_MIN_SDK) return { action: 'prompt', reason: 'sdk' };
  }
  if (f.sinceSetTimeMs !== null && f.sinceSetTimeMs < COOLDOWN_MS) return { action: 'none', reason: 'cooldown' };
  return { action: 'set_time', reason: 'fix' };
}

/** Whether an API base may serve as a time source: TLS, or the loopback of a developer's machine. */
export function secureTimeSource(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** "מקדים ב-7 דקות" / "מאחר ב-40 שניות" — the skew in words, for the technician's screen. */
export function skewWords(skewMs: number): string {
  const abs = Math.abs(skewMs);
  const dir = skewMs > 0 ? 'מקדים' : 'מאחר';
  if (abs < 120_000) return `${dir} ב-${Math.round(abs / 1000)} שניות`;
  if (abs < 2 * 3_600_000) return `${dir} ב-${Math.round(abs / 60_000)} דקות`;
  if (abs < 2 * 86_400_000) return `${dir} ב-${Math.round(abs / 3_600_000)} שעות`;
  return `${dir} ב-${Math.round(abs / 86_400_000)} ימים`;
}

/** The heartbeat's `clockTrust` block (pos-server app/services/clock_trust.py `clean_report`). */
export interface ClockTrustReport {
  source: TimeSource;
  reason: TrustReason;
  /** The correction applied to the device clock now (server − device; 0 when on the device clock). */
  offsetMs: number;
  autoFix: FixCapability;
  autoFixEnabled: boolean;
  autoTime?: boolean | null;
  pending?: FixAction;
  pendingReason?: FixReason;
  lastFixAt?: string | null;
  lastFixAction?: FixAction | null;
  lastFixResult?: FixResult | null;
  lastFixFromMs?: number | null;
}

/** The technician's "שעון מול השרת" row and its "תיקון שעון" (renderer/technician/TechnicianScreen.tsx). */
export interface ClockRowView {
  text: string;
  light: 'ok' | 'bad' | null;
  /** Documents are stamped with the server's time now. */
  corrected: boolean;
  /** Offer "תיקון שעון": off by 90 s or more, or a fix the rule cannot do by itself. */
  offerFix: boolean;
  lastFix: string | null;
}

const FIX_RESULT_TEXT: Record<FixResult, string> = { ok: 'הצליח', failed: 'נכשל', refused: 'לא אושר' };

export function clockRowView(skewMs: number | null, report: ClockTrustReport | null | undefined): ClockRowView {
  const lastFix = report?.lastFixAt && report.lastFixResult ? `תיקון אחרון: ${FIX_RESULT_TEXT[report.lastFixResult] ?? report.lastFixResult}` : null;
  if (skewMs === null) return { text: 'לא נמדד', light: null, corrected: false, offerFix: false, lastFix };
  const corrected = report?.source === 'server';
  if (Math.abs(skewMs) < 2_000) return { text: 'תקין', light: 'ok', corrected: false, offerFix: false, lastFix };
  const text = skewWords(skewMs) + (corrected ? ' · המסמכים נחתמים לפי שעון השרת' : '');
  return { text, light: Math.abs(skewMs) < 60_000 ? 'ok' : 'bad', corrected, offerFix: Math.abs(skewMs) >= TRUST_MS, lastFix };
}
