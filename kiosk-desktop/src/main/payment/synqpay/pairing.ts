/**
 * "צימוד מסוף SynqPay" on the Windows kiosk (pos-server docs/SPEC_SYNQPAY.md §2.2) — as the
 * Android till's SynqPayPairing.kt, so nobody types an API key:
 *
 *  1. `pair` with the terminal's serial number (the one configured; without one the terminal is
 *     asked — `getDeviceInfo`, which SynqPay does not document as key-free, so a refusal means the
 *     manager types it). The terminal shows a 6-digit code, valid 30 seconds.
 *  2. The code, typed on the kiosk's admin screen, goes back in `authenticate`; the answer is the key.
 *  3. The key is kept on the kiosk (sealed like the machine token) and used at once, then sent to
 *     the cloud (`POST /sync/{m}/synqpay/pairing`, on the manager's authority), which keeps it
 *     encrypted for this machine. Until the cloud has it, the kiosk's own key wins over the
 *     settings sync's ([mergeLocalKey]).
 *
 * Pure: the terminal is passed in (SynqPayClient in the app, a fake in the tests).
 */

import { ERR, errorHebrew, type Reply } from './protocol';

export const OTP_VALID_MS = 30_000;
export const OTP_LENGTH = 6;
export const SERIAL_RE = /^[A-Za-z0-9-]{4,32}$/;
export const API_KEY_RE = /^[A-Za-z0-9]{1,64}$/;

/** The words of the pairing (the same as the Android till's SynqPairingText). */
export const PAIRING_TEXT = {
  notPaired: 'המסוף דורש צימוד — טרם בוצע צימוד בקיוסק',
  tillBusy: 'יש תשלום בתהליך בקיוסק — נסו שוב בסיומו',
  notSynqPay: 'הקיוסק אינו מוגדר למסוף SynqPay חיצוני — אין מה לצמד',
  serialNeeded: 'הקלידו את המספר הסידורי של המסוף (על גב המסוף, על האריזה או בתפריט המסוף)',
  serialInvalid: 'מספר סידורי לא תקין — 4 עד 32 אותיות באנגלית, ספרות או מקף',
  serialMismatch: 'המספר הסידורי אינו של המסוף המחובר — בדקו אותו במסוף והקלידו שוב',
  terminalBusy: 'המסוף עסוק — החזירו אותו למסך הראשי ונסו שוב',
  codeDigits: 'יש להקליד את 6 הספרות שבמסך המסוף',
  wrongCode: 'הקוד שגוי — הקלידו את הקוד שמופיע עכשיו במסך המסוף',
  codeExpired: 'הקוד פג תוקף — לחצו "שלח קוד חדש"',
  noKey: 'המסוף לא החזיר מפתח — שלחו קוד חדש ונסו שוב',
  unreachable: (detail: string | null) => `המסוף לא זמין — בדקו שהוא דולק ומחובר${detail ? ` (${detail})` : ''}`,
  refused: (r: NonNullable<Reply['error']>) => `המסוף סירב: ${errorHebrew(r)}`,
} as const;

export type PairingPhase = 'idle' | 'need_serial' | 'awaiting_code' | 'expired' | 'paired' | 'failed';
export type PairingUpload = 'uploaded' | 'needs_approval' | 'offline' | 'refused';

export interface PairingStatus {
  phase: PairingPhase;
  serial: string | null;
  /** awaiting_code: when the code on the terminal runs out (epoch ms). */
  expiresAtMs: number;
  error: string | null;
  /** paired: where the cloud copy went. */
  upload: PairingUpload | null;
}

/** What the pairing needs of the terminal. */
export interface PairingTerminal {
  pair(serial: string): Promise<Reply>;
  authenticateReply(otp: string): Promise<Reply>;
  /** The terminal's serial number without the key, or null when it will not say. */
  serialWithoutKey(): Promise<string | null>;
}

const IDLE: PairingStatus = { phase: 'idle', serial: null, expiresAtMs: 0, error: null, upload: null };

export class PairingSession {
  status: PairingStatus = IDLE;

  constructor(private readonly now: () => number = () => Date.now()) {}

  reset() {
    this.status = IDLE;
  }

  /** Open the pairing (or "שלח קוד חדש"): [serial] given or configured, else asked of the terminal. */
  async start(t: PairingTerminal, serial: string | null): Promise<PairingStatus> {
    let s = serial?.trim() || null;
    if (!s) {
      s = await t.serialWithoutKey().catch(() => null);
      if (!s || !SERIAL_RE.test(s)) return this.set({ ...IDLE, phase: 'need_serial' });
    }
    if (!SERIAL_RE.test(s)) return this.set({ ...IDLE, phase: 'need_serial', serial: s, error: PAIRING_TEXT.serialInvalid });
    let reply: Reply;
    try {
      reply = await t.pair(s);
    } catch (e) {
      return this.set({ ...IDLE, phase: 'failed', serial: s, error: PAIRING_TEXT.unreachable(e instanceof Error ? e.message : String(e)) });
    }
    if (reply.error) {
      const code = reply.error.code;
      if (code === ERR.INVALID_PARAM || code === ERR.MISSING_PARAM) {
        return this.set({ ...IDLE, phase: 'need_serial', serial: s, error: PAIRING_TEXT.serialMismatch });
      }
      if (code === ERR.ILLEGAL_STATE || code === ERR.SCREEN_NOT_READY) {
        return this.set({ ...IDLE, phase: 'failed', serial: s, error: PAIRING_TEXT.terminalBusy });
      }
      return this.set({ ...IDLE, phase: 'failed', serial: s, error: PAIRING_TEXT.refused(reply.error) });
    }
    return this.set({ ...IDLE, phase: 'awaiting_code', serial: s, expiresAtMs: this.now() + OTP_VALID_MS });
  }

  /** The 6 digits from the terminal's screen: the key, or why not. */
  async code(t: PairingTerminal, otp: string): Promise<{ status: PairingStatus; apiKey: string | null }> {
    const s = this.status;
    const none = (status: PairingStatus) => ({ status: this.set(status), apiKey: null });
    if (s.phase !== 'awaiting_code') return none(s);
    const code = otp.trim();
    if (!/^[0-9]{6}$/.test(code)) return none({ ...s, error: PAIRING_TEXT.codeDigits });
    if (this.now() >= s.expiresAtMs) return none({ ...s, phase: 'expired', error: PAIRING_TEXT.codeExpired });
    let reply: Reply;
    try {
      reply = await t.authenticateReply(code);
    } catch (e) {
      return none({ ...IDLE, phase: 'failed', serial: s.serial, error: PAIRING_TEXT.unreachable(e instanceof Error ? e.message : String(e)) });
    }
    if (reply.error) {
      const c = reply.error.code;
      if (c === ERR.INVALID_PARAM || c === ERR.MISSING_PARAM) return none({ ...s, error: PAIRING_TEXT.wrongCode });
      if (c === ERR.ILLEGAL_STATE) return none({ ...s, phase: 'expired', error: PAIRING_TEXT.codeExpired });
      if (c === ERR.SCREEN_NOT_READY) return none({ ...IDLE, phase: 'failed', serial: s.serial, error: PAIRING_TEXT.terminalBusy });
      return none({ ...IDLE, phase: 'failed', serial: s.serial, error: PAIRING_TEXT.refused(reply.error) });
    }
    const raw = (reply.result as { apiKey?: unknown } | null)?.apiKey;
    const key = typeof raw === 'string' && API_KEY_RE.test(raw.trim()) ? raw.trim() : null;
    if (!key) return none({ ...IDLE, phase: 'failed', serial: s.serial, error: PAIRING_TEXT.noKey });
    return { status: this.set({ ...IDLE, phase: 'paired', serial: s.serial }), apiKey: key };
  }

  /** The code ran out on the kiosk's own clock. */
  expireIfDue(): PairingStatus {
    if (this.status.phase === 'awaiting_code' && this.now() >= this.status.expiresAtMs) {
      this.set({ ...this.status, phase: 'expired', error: PAIRING_TEXT.codeExpired });
    }
    return this.status;
  }

  uploaded(upload: PairingUpload) {
    if (this.status.phase === 'paired') this.set({ ...this.status, upload });
  }

  private set(s: PairingStatus): PairingStatus {
    this.status = s;
    return s;
  }
}

/** A key paired at this kiosk (kept sealed), and whether the cloud has it yet. */
export interface LocalSynqKey {
  apiKey: string;
  /** Not in the cloud yet: it wins over the settings sync's (an older key, or none). */
  pending: boolean;
  /** The manager who approved the pairing (their till user id), for sending it again. */
  approver: string | null;
  serial: string | null;
}

/**
 * The cloud settings with the kiosk's own paired key in them: while it is pending it wins (the
 * cloud may hold an older key, or none); the cloud sending this very key settles it (`settled`).
 * Once settled, the cloud's key is the kiosk's, as for any setting.
 */
export function mergeLocalKey(settings: Record<string, unknown>, local: LocalSynqKey | null): { settings: Record<string, unknown>; settled: boolean } {
  if (!local) return { settings, settled: false };
  const cloud = typeof settings.synqpayApiKey === 'string' ? settings.synqpayApiKey.trim() : null;
  if (cloud === local.apiKey) return { settings, settled: local.pending };
  if (!local.pending) return { settings, settled: false };
  return { settings: { ...settings, synqpayApiKey: local.apiKey }, settled: false };
}

/** `POST /sync/{m}/synqpay/pairing`'s answer as a [PairingUpload]. */
export function uploadOutcome(reply: { kind: 'ok' } | { kind: 'refused'; status: number } | { kind: 'offline' }): PairingUpload {
  if (reply.kind === 'ok') return 'uploaded';
  if (reply.kind === 'offline') return 'offline';
  return reply.status === 401 || reply.status === 403 ? 'needs_approval' : 'refused';
}
