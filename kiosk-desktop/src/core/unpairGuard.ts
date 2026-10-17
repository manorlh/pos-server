/**
 * "ניתוק הקיוסק מהענן" while the outbox still holds rows (the technician's screen).
 *
 * A plain unpair is refused while anything waits for the cloud — but rows for a server that is gone (a dev server, a
 * machine deleted in the dashboard) never drain, and the device could never be unpaired. The rules:
 *
 *  - nothing pending → unpair at once;
 *  - pending → refused, with what waits (per kind: money vs. events) and why;
 *  - "ניתוק בכל זאת" is offered when the server cannot be reached (or does not know this device any more), or when
 *    only events are pending (a till's audit, acks, kitchen releases — no document, shift or money record);
 *  - money records pending (documents, shifts, card transmissions, cash movements) with the server reachable: never
 *    forced — they are on their way; sync and try again;
 *  - forcing needs the technician's code again and a confirmation; money records also an explicit second one. Before
 *    the pairing is forgotten everything pending is exported (main/service.ts unpairBackup); money rows stay in the
 *    outbox (never deleted), event rows are dropped (they are in the backup).
 */

/** The rows that are money: documents, shifts, card transmissions, cash movements. */
export const MONEY_OUTBOX_KINDS: ReadonlySet<string> = new Set(['transaction', 'shift_open', 'shift_close', 'transmission', 'cash_movement']);

/** What each outbox kind is, in the technician's words. */
export const OUTBOX_KIND_LABEL: Readonly<Record<string, string>> = {
  transaction: 'מסמכים (חשבוניות / קבלות)',
  shift_open: 'פתיחות משמרת',
  shift_close: 'סגירות משמרת',
  transmission: 'שידורי אשראי',
  cash_movement: 'תנועות מזומן',
  till_event: 'אירועי קופה (יומן)',
  drawer_event: 'אירועי מגירה',
  kds_release: 'שחרורי מטבח',
  shift_close_ack: 'אישורי סגירת משמרת',
  till_z_ack: 'אישורי Z',
};

export interface PendingSummary {
  total: number;
  /** Documents, shifts, card transmissions, cash movements. */
  money: number;
  /** Everything else (audit events, acks, kitchen releases). */
  events: number;
  byKind: Record<string, number>;
}

export function pendingSummary(rows: ReadonlyArray<{ kind: string; n: number }>): PendingSummary {
  const byKind: Record<string, number> = {};
  for (const r of rows) if (r.n > 0) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
  let money = 0;
  let events = 0;
  for (const [kind, n] of Object.entries(byKind)) {
    if (MONEY_OUTBOX_KINDS.has(kind)) money += n;
    else events += n;
  }
  return { total: money + events, money, events, byKind };
}

/** One line per kind: money first, then events ("5 × אירועי קופה (יומן)"). */
export function pendingLines(s: PendingSummary): string[] {
  const kinds = Object.keys(s.byKind).sort((a, b) => Number(MONEY_OUTBOX_KINDS.has(b)) - Number(MONEY_OUTBOX_KINDS.has(a)) || a.localeCompare(b));
  return kinds.map((k) => `${s.byKind[k]} × ${OUTBOX_KIND_LABEL[k] ?? k}`);
}

/** The server, as the unpair sees it: answers this device / cannot be reached or does not know it. */
export type ServerReach = 'reachable' | 'unreachable';

export interface UnpairCheck {
  /** Why it was refused (the first line of the message). */
  reason: string;
  pending: string[];
  money: number;
  events: number;
  server: ServerReach;
  serverUrl: string | null;
  /** "ניתוק בכל זאת" may be offered. */
  canForce: boolean;
  /** Forcing needs the explicit second confirmation (money records pending). */
  needsMoneyConfirm: boolean;
}

export const UNPAIR_TEXT = {
  refused: 'יש נתונים שטרם נשלחו לענן — לא ניתן לנתק',
  unreachable: (url: string | null) => `השרת${url ? ` ${url}` : ''} לא זמין או לא מכיר את המכשיר — הנתונים לא יוכלו להישלח אליו`,
  eventsOnly: 'ממתינים רק אירועים (לא מסמכים ולא כסף)',
  moneyWait: 'השרת זמין ויש מסמכים / נתונים כספיים בדרך — המתינו לסנכרון ונסו שוב',
  force: 'ניתוק בכל זאת',
  forceHint: 'כל מה שממתין יישמר לקובץ גיבוי (וגם עותק של מסד הנתונים) לפני הניתוק',
  moneyWarn: (n: number) => `${n} רשומות כספיות (מסמכים / משמרות / אשראי / מזומן) לא הגיעו לענן. הן יישמרו בגיבוי ויישארו במכשיר — לא יימחקו.`,
  codeNeeded: 'נדרש קוד טכנאי לניתוק בכל זאת',
  confirmNeeded: 'נדרש אישור לניתוק בכל זאת',
  moneyConfirmNeeded: 'יש רשומות כספיות שלא נשלחו — נדרש אישור שני מפורש',
  notForceable: 'לא ניתן לנתק בכל זאת: השרת זמין ויש נתונים כספיים בדרך',
  backupFailed: (e: string) => `הגיבוי נכשל — הקיוסק לא נותק: ${e}`,
  done: (file: string) => `הקיוסק נותק מהענן. הגיבוי נשמר: ${file}`,
} as const;

/** The refusal for a plain unpair (null: nothing pending — go). */
export function unpairCheck(s: PendingSummary, server: ServerReach, serverUrl: string | null): UnpairCheck | null {
  if (s.total === 0) return null;
  const canForce = server === 'unreachable' || s.money === 0;
  const reason = server === 'unreachable' ? UNPAIR_TEXT.unreachable(serverUrl) : s.money === 0 ? UNPAIR_TEXT.eventsOnly : UNPAIR_TEXT.moneyWait;
  return { reason, pending: pendingLines(s), money: s.money, events: s.events, server, serverUrl, canForce, needsMoneyConfirm: canForce && s.money > 0 };
}

/** The message a refusal shows (several lines). */
export function unpairMessage(c: UnpairCheck): string {
  return [UNPAIR_TEXT.refused, c.reason, ...c.pending].join('\n');
}

export interface ForceRequest {
  codeOk: boolean;
  confirm: boolean;
  confirmMoney: boolean;
}

/** May "ניתוק בכל זאת" go now? (null: yes; else why not). */
export function forceRefusal(c: UnpairCheck, r: ForceRequest): string | null {
  if (!c.canForce) return UNPAIR_TEXT.notForceable;
  if (!r.codeOk) return UNPAIR_TEXT.codeNeeded;
  if (!r.confirm) return UNPAIR_TEXT.confirmNeeded;
  if (c.needsMoneyConfirm && !r.confirmMoney) return UNPAIR_TEXT.moneyConfirmNeeded;
  return null;
}

/** The backup's file name: `unpair-2026-10-17T21-04-05-123Z` (+ `.json` / `.kiosk.db`). */
export function backupStem(nowMs: number): string {
  return `unpair-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}`;
}
