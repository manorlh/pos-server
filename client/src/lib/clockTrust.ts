/**
 * "שעון המכשיר" (pos-server app/services/clock_trust.py): whether a device stamps its documents with the server's time
 * (it does from 90 s of skew, measured over TLS), whether it can fix its own clock (`clockAutoFix`: an Android device
 * owner, a Windows app running as administrator) and how its last fix went.
 *
 * The server sends `clockTrust` on each device (the devices list and page, "תקינות מכשירים"):
 * `{source: device | server, offsetMs, autoFix: device_owner | elevated | none, autoFixEnabled, autoTime, pending,
 * pendingReason, lastFix: {at, action, result, fromMs} | null, reportedAt}`, or null while the device never reported
 * (an older build: the skew alone, as before).
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own. The texts are here (Hebrew), with the
 * rules, so the tests pin both.
 */

export interface ClockTrustStatus {
  source: 'device' | 'server' | string;
  reason?: string | null;
  offsetMs?: number | null;
  autoFix?: 'device_owner' | 'elevated' | 'none' | string | null;
  autoFixEnabled?: boolean | null;
  autoTime?: boolean | null;
  pending?: string | null;
  pendingReason?: string | null;
  lastFix?: { at: string; action?: string | null; result?: string | null; fromMs?: number | null } | null;
  reportedAt?: string | null;
}

export type ClockTrustTone = 'ok' | 'warn' | 'muted';

export interface ClockTrustView {
  /** "מסמכים לפי שעון השרת" / "מסמכים לפי שעון המכשיר". */
  documents: string;
  tone: ClockTrustTone;
  /** "תיקון אוטומטי: בעלות מכשיר" / "תיקון אוטומטי: ידני (בהגדרות המכשיר)" / "תיקון אוטומטי: כבוי". */
  fix: string;
  /** "תיקון אחרון: הצליח" etc.; null: never fixed. */
  lastFix: string | null;
  hint: string;
}

/** The device's threshold: from 90 s of skew documents follow the server's clock. */
export const CLOCK_TRUST_MS = 90_000;

const CAPABILITY_TEXT: Record<string, string> = {
  device_owner: 'בעלות מכשיר — מתקן לבד',
  elevated: 'הרשאות מנהל ב-Windows — מתקן לבד',
  none: 'ידני',
};

const RESULT_TEXT: Record<string, string> = { ok: 'הצליח', failed: 'נכשל', refused: 'לא אושר' };
const ACTION_TEXT: Record<string, string> = { enable_auto_time: 'הפעלת שעה אוטומטית', set_time: 'כיוון לפי השרת' };

/** What the dashboard says about a device's clock; null when it never reported (or nothing worth saying). */
export function clockTrustView(status: ClockTrustStatus | null | undefined, skewMs: number | null | undefined): ClockTrustView | null {
  if (!status || typeof status !== 'object') return null;
  const off = typeof skewMs === 'number' && Math.abs(skewMs) >= CLOCK_TRUST_MS;
  const server = status.source === 'server';
  const documents = server ? 'מסמכים לפי שעון השרת' : 'מסמכים לפי שעון המכשיר';
  const tone: ClockTrustTone = server ? 'warn' : off ? 'warn' : 'ok';
  const capability = status.autoFix ?? 'none';
  const fix =
    status.autoFixEnabled === false
      ? 'תיקון אוטומטי: כבוי'
      : `תיקון אוטומטי: ${CAPABILITY_TEXT[capability] ?? CAPABILITY_TEXT.none}`;
  const last = status.lastFix;
  const lastFix = last?.at
    ? `תיקון אחרון: ${[last.action ? ACTION_TEXT[last.action] : null, last.result ? RESULT_TEXT[last.result] ?? last.result : null]
        .filter(Boolean)
        .join(' — ')}`
    : null;
  const hint = server
    ? 'שעון המכשיר רחוק משעון השרת, ולכן המסמכים, המשמרות וה-Z נחתמים לפי שעון השרת. כדאי לתקן את שעון המכשיר.'
    : off
      ? 'שעון המכשיר רחוק משעון השרת והמסמכים עדיין נחתמים לפי שעון המכשיר (אין תשובה מאומתת מהשרת). יש לתקן את שעון המכשיר.'
      : 'שעון המכשיר תקין מול השרת.';
  return { documents, tone, fix, lastFix, hint };
}
