/**
 * "פעולות אשראי" — the card transmission ("שידור עסקאות אשראי", TRANSMIT) and the terminal's deferred mode ("מצב לא מקוון
 * (Deferred)") on the Windows till, and the §13 warning while the terminal works deferred (P:/specs/nayax-deferred-all.md
 * §10–§13; pos-android ui/reports/TransmissionScreen.kt, ui/common/TransmissionLine.kt, domain/Transmission.kt,
 * domain/TransmissionHistory.kt, domain/TerminalConfig.kt `offlineModeOf`, domain/TerminalOffline.kt,
 * domain/DeferredControl.kt `DeferredCardNotices`, `offlineRefusedCard`). Pure: the terminal's replies, the parameters and
 * the clock in; the words and the decisions out. Nayax only (SPICy `getConfig` / `setConfig` / `authorizePendingTransactions`
 * / `getReport x`); SynqPay has no deferred mode.
 */

/** The terminal's deferred mode as `getConfig ["device"]` says it. Limits: null — none set (-1). */
export interface OfflineModeStatus {
  allowed: boolean;
  working: boolean;
  amountLimit: number | null;
  amountLeft: number | null;
  txLimit: number | null;
  txLeft: number | null;
}

const longOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return t < 0 ? null : t;
};

const boolOf = (v: unknown): boolean => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');

function resultOf(raw: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = o && typeof o === 'object' ? (o as { result?: unknown }).result : null;
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
}

/** `getConfig ["device",{}]`'s reply: null when it names neither `allowedOfflineMode` nor `offlineModeWorking`. */
export function offlineModeOf(raw: string | Record<string, unknown> | null): OfflineModeStatus | null {
  const r = resultOf(raw);
  if (!r || (!('allowedOfflineMode' in r) && !('offlineModeWorking' in r))) return null;
  return {
    allowed: boolOf(r.allowedOfflineMode),
    working: boolOf(r.offlineModeWorking),
    amountLimit: longOf(r.deferredAmountLimit),
    amountLeft: longOf(r.deferredAmountLimitLeft),
    txLimit: longOf(r.deferredTransactionsLimit),
    txLeft: longOf(r.deferredTransactionsLimitLeft),
  };
}

/** What deferred sales the terminal holds by its limits (limit − left), or null when it cannot say. */
export function deferredPendingOnTerminal(s: Pick<OfflineModeStatus, 'txLimit' | 'txLeft'> | null): number | null {
  if (!s || s.txLimit === null || s.txLeft === null || s.txLimit <= 0 || s.txLeft < 0 || s.txLeft > s.txLimit) return null;
  return s.txLimit - s.txLeft;
}

/** `authorizePendingTransactions`'s answer. */
export interface Authorization {
  ok: boolean;
  statusCode: number | null;
  approved: string[];
  declined: string[];
  totalAmountAgorot: number | null;
  totalCount: number | null;
}

export function authorizationOf(raw: string | Record<string, unknown> | null): Authorization | null {
  const r = resultOf(raw);
  if (!r) return null;
  const code = typeof r.statusCode === 'number' ? Math.trunc(r.statusCode) : typeof r.statusCode === 'string' && /^-?\d+$/.test(r.statusCode.trim()) ? Number(r.statusCode.trim()) : null;
  const ids = (v: unknown) =>
    Array.isArray(v)
      ? v
          .map((x) => (x && typeof x === 'object' ? ((x as Record<string, unknown>).uid ?? (x as Record<string, unknown>).transactionId ?? (x as Record<string, unknown>).id) : x))
          .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
          .map((x) => String(x))
      : [];
  return { ok: code === 0, statusCode: code, approved: ids(r.approvedTransactions), declined: ids(r.declinedTransactions), totalAmountAgorot: longOf(r.totalAmount), totalCount: longOf(r.totalCount) };
}

/** `getReport x`: the current batch's count and amount (agorot), looked for as the till looks for them. */
export function batchReportOf(raw: string | Record<string, unknown> | null): { count: number | null; amountAgorot: number | null } | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = resultOf(raw);
  if (!r) return null;
  if (typeof r.statusCode === 'number' && r.statusCode !== 0) return null;
  void o;
  const places = [r, r.report, r.summary, r.totals].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
  const first = (keys: string[]) => {
    for (const p of places) for (const k of keys) if (p[k] !== undefined && p[k] !== null) return longOf(p[k]);
    return null;
  };
  let count = first(['transactionCount', 'transactionsCount', 'numOfTransactions', 'totalTransactions', 'count', 'totalCount']);
  if (count === null) for (const p of places) if (Array.isArray(p.transactions)) count = p.transactions.length;
  return { count, amountAgorot: first(['totalAmount', 'amount', 'total', 'sum', 'totalSum']) };
}

/* ------------------------------------------------------------------ the pending line */

export type IndicatorTone = 'hidden' | 'green' | 'orange' | 'red';

const DAY = 86_400_000;

/** The line's colour (indicatorTone): over a day orange, over four days red; nothing pending — hidden for a day after a success. */
export function indicatorTone(pending: number, oldestPendingAtMs: number | null, lastSuccessAtMs: number | null, now: number): IndicatorTone {
  if (pending <= 0) return lastSuccessAtMs === null || now - lastSuccessAtMs < DAY ? 'hidden' : 'green';
  const since = oldestPendingAtMs ?? lastSuccessAtMs;
  if (since === null) return 'green';
  const age = now - since;
  if (age > 4 * DAY) return 'red';
  if (age > DAY) return 'orange';
  return 'green';
}

/** "%d דק׳" under an hour, "%d שע׳" under two days, else "%d ימים". */
export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} שע׳`;
  return `${Math.floor(h / 24)} ימים`;
}

/** The pending line of the screen (TransmissionLine full): running, waiting deals, or nothing waiting. */
export function pendingLine(o: { running: boolean; pending: number; amountText: string; lastSuccessAtMs: number | null; now: number; full: boolean }): string | null {
  if (o.running) return TX_TEXT.running;
  const tone = indicatorTone(o.pending, null, o.lastSuccessAtMs, o.now);
  const last = o.lastSuccessAtMs !== null ? ageText(o.now - o.lastSuccessAtMs) : null;
  if (o.pending > 0) return last ? TX_TEXT.pending(o.pending, o.amountText, last) : TX_TEXT.pendingNever(o.pending, o.amountText);
  if (tone === 'hidden') return o.full && last ? TX_TEXT.lastAgo(last) : null;
  return last ? TX_TEXT.idle(last) : null;
}

/* ------------------------------------------------------------------ results in words */

export interface TransmitWords {
  outcome: 'success' | 'failed' | 'busy' | 'unknown' | 'skipped';
  batchNumber: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  error: string | null;
}

/** "שדר עכשיו"'s answer in words (transmitResultMessage). */
export function transmitResultMessage(r: TransmitWords | null, training = false): string {
  if (training) return TX_TEXT.training;
  if (!r) return TX_TEXT.unknown;
  switch (r.outcome) {
    case 'success':
      return r.batchNumber && !r.batchNumber.startsWith('assumed:') ? TX_TEXT.successBatch(r.batchNumber) : TX_TEXT.success;
    case 'busy':
      return TX_TEXT.busy;
    case 'unknown':
      return TX_TEXT.unknown;
    case 'skipped':
      return TX_TEXT.success;
    default:
      return TX_TEXT.failed(r.statusMessage ?? r.error ?? (r.statusCode !== null ? String(r.statusCode) : null) ?? '—');
  }
}

/** The authorisation of the deferred sales in words. */
export function authorizationText(a: Authorization | null, amountText: (agorot: number) => string): string {
  if (!a) return TX_TEXT.noAnswer;
  if (!a.ok) return TX_TEXT.authFailed(a.statusCode ?? -1);
  if (a.declined.length > 0) return TX_TEXT.authDeclined(a.declined.length, a.approved.length);
  const n = a.approved.length || a.totalCount || 0;
  if (n <= 0) return TX_TEXT.authNone;
  return TX_TEXT.authOk(n, amountText(a.totalAmountAgorot ?? 0));
}

/* ------------------------------------------------------------------ the history */

export interface TransmissionRow {
  id: string;
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  batchNumber: string | null;
  transactionCount: number | null;
  /** Shekels as the cloud or the till wrote it ("12.50"). */
  amount: string | null;
  error: string | null;
  /** This till's row not in the cloud yet. */
  unsynced?: boolean;
}

export function rowOf(o: unknown): TransmissionRow | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  if (!id) return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const amount = typeof r.amount === 'number' ? r.amount.toFixed(2) : s(r.amount);
  return {
    id,
    trigger: s(r.trigger),
    startedAt: s(r.startedAt),
    finishedAt: s(r.finishedAt),
    status: s(r.status),
    statusCode: typeof r.statusCode === 'number' ? r.statusCode : null,
    statusMessage: s(r.statusMessage),
    batchNumber: s(r.batchNumber),
    transactionCount: typeof r.transactionCount === 'number' ? r.transactionCount : null,
    amount,
    error: s(r.error),
  };
}

/** This till's rows not yet in the cloud first, then the cloud's; the cloud's copy wins; newest first. */
export function mergeHistory(local: readonly TransmissionRow[], cloud: readonly TransmissionRow[]): TransmissionRow[] {
  const byId = new Map<string, TransmissionRow>();
  for (const r of local) if (r.unsynced) byId.set(r.id, r);
  for (const r of cloud) byId.set(r.id, { ...r, unsynced: false });
  const at = (r: TransmissionRow) => Date.parse(r.startedAt ?? r.finishedAt ?? '') || 0;
  return [...byId.values()].sort((a, b) => at(b) - at(a));
}

/** A row in words: its status, what started it, its batch / count / amount, its error. */
export function rowWords(r: TransmissionRow): { status: string; tone: 'ok' | 'error' | 'muted'; trigger: string; facts: string[]; detail: string | null } {
  const status = r.status === 'success' ? TX_TEXT.rowOk : r.status === 'failed' ? TX_TEXT.rowFailed : TX_TEXT.rowUnknown;
  const tone = r.status === 'success' ? 'ok' : r.status === 'failed' ? 'error' : 'muted';
  const trigger = r.trigger === 'shift_close' ? 'בסגירת משמרת' : r.trigger === 'daily' ? 'שידור יומי אוטומטי' : r.trigger === 'remote' ? 'מהענן' : 'ידני';
  const facts: string[] = [];
  if (r.batchNumber && !r.batchNumber.startsWith('assumed:')) facts.push(`אצווה ${r.batchNumber}`);
  if (r.transactionCount !== null) facts.push(`${r.transactionCount} עסקאות`);
  if (r.amount !== null) facts.push(`₪${r.amount}`);
  const detail = r.error ?? (r.status !== 'success' ? r.statusMessage : null);
  return { status, tone, trigger, facts, detail };
}

/* ------------------------------------------------------------------ §13 */

/** The §13 warning's default (DEFERRED_CARD_NOTICE_DEFAULT; "חו״ל" with the gershayim U+05F4). */
export const DEFERRED_CARD_NOTICE_DEFAULT = '⚠ מצב לא מקוון: כרטיסי תייר (חו״ל), כרטיסי דיירקט וכרטיסי דביט לא יעברו. בקשו כרטיס אשראי רגיל או אמצעי תשלום אחר.';
/** On the customer display (DEFERRED_CUSTOMER_NOTICE). */
export const DEFERRED_CUSTOMER_NOTICE = 'בתשלום באשראי: לא ניתן לשלם בכרטיס דביט / דיירקט / כרטיס זר כרגע';

/** DeferredCardNotices.of: nothing while the terminal works online; else the cashier's (`deferredCardNotice`) and the customer's. */
export function deferredCardNotices(offlineOn: boolean, params: Record<string, unknown>): { cashier: string | null; customer: string | null } {
  if (!offlineOn) return { cashier: null, customer: null };
  const custom = typeof params.deferredCardNotice === 'string' ? params.deferredCardNotice.trim() : '';
  const off = ['false', '0', 'no', 'off'].includes(String(params.deferredCustomerNotice ?? '').trim().toLowerCase());
  return { cashier: custom || DEFERRED_CARD_NOTICE_DEFAULT, customer: off ? null : DEFERRED_CUSTOMER_NOTICE };
}

export type RefusedOffline = 'debit' | 'direct' | 'foreign';

/** A card the terminal refused while deferred, named by its words (offlineRefusedCard) — only declined / unknown, only offline. */
export function offlineRefusedCard(statusMessage: string | null | undefined, offlineOn: boolean, declined: boolean): RefusedOffline | null {
  if (!offlineOn || !declined) return null;
  const w = (statusMessage ?? '').toLowerCase();
  if (w.includes('דביט') || w.includes('debit')) return 'debit';
  if (w.includes('דיירקט') || w.includes('דירקט') || w.includes('direct')) return 'direct';
  if (['תייר', 'חו"ל', 'חו״ל', 'כרטיס זר', 'foreign', 'tourist', 'international'].some((x) => w.includes(x))) return 'foreign';
  return null;
}

export const REFUSED_OFFLINE_TEXT: Record<RefusedOffline, string> = {
  debit: 'כרטיס דביט — לא נתמך במצב לא מקוון. בחרו אמצעי תשלום אחר.',
  direct: 'כרטיס דיירקט — לא נתמך במצב לא מקוון. בחרו אמצעי תשלום אחר.',
  foreign: 'כרטיס זר (תייר) — לא נתמך במצב לא מקוון. בחרו אמצעי תשלום אחר.',
};

/** The sell screen's amber banner while deferred (TerminalOfflineChip), and the reminder when it is off with sales waiting. */
export function offlineBanner(o: { on: boolean; pending: number; online: boolean }): { text: string; tone: 'amber' } | null {
  if (o.on) return { text: `${o.pending > 0 ? TX_TEXT.chipPending(o.pending) : TX_TEXT.chip}\n${TX_TEXT.chipCards}`, tone: 'amber' };
  if (o.pending > 0 && o.online) return { text: TX_TEXT.waitingApproval(o.pending), tone: 'amber' };
  return null;
}

/** Android's words (strings.xml transmission_*, strings_deferred_all.xml). */
export const TX_TEXT = {
  title: 'פעולות אשראי',
  offlineTitle: 'מצב לא מקוון (Deferred)',
  reading: 'קורא את מצב המסוף…',
  readFailed: 'לא ניתן היה לקרוא את מצב המסוף (ייתכן שהוא עסוק).',
  retry: 'נסה שוב',
  notAllowed: 'המסוף אינו מורשה לעבוד במצב לא מקוון. ההרשאה ניתנת על ידי Nayax.',
  stateOn: 'פעיל — עסקאות אשראי מאושרות במסוף בלבד ונשלחות לחברת האשראי מאוחר יותר.',
  stateOff: 'כבוי — עסקאות אשראי מאושרות מול חברת האשראי באופן מקוון.',
  limitAmount: (left: string, limit: string) => `יתרת סכום: ${left} מתוך ${limit}`,
  limitTx: (left: number, limit: number) => `יתרת עסקאות: ${left} מתוך ${limit}`,
  noLimits: 'לא הוגדרה תקרת סכום או מספר עסקאות.',
  switching: 'מעדכן את המסוף…',
  turnOff: 'כבה מצב לא מקוון ואשר עסקאות',
  turnOn: 'הפעל מצב לא מקוון',
  authorize: 'אשר עסקאות ממתינות',
  confirmTitle: 'להפעיל מצב לא מקוון?',
  confirmBody:
    'במצב לא מקוון המסוף מאשר כרטיסים בעצמו, בלי לפנות לחברת האשראי. העסקאות נשלחות לאישור רק כשמכבים את המצב — ועסקה שתידחה אז לא תיגבה, אחרי שהלקוח כבר יצא עם הסחורה. השתמשו בזה רק כשאין חיבור, וכבו מיד כשהחיבור חוזר.',
  cancel: 'ביטול',
  busy: 'המסוף עסוק בעסקה. השידור יתבצע כשיתפנה.',
  switchFailed: (why: string) => `המסוף לא עבר מצב: ${why}`,
  turnedOn: 'מצב לא מקוון הופעל.',
  turnedOff: 'מצב לא מקוון כובה.',
  noAnswer: 'המסוף לא ענה. נסו שוב.',
  authFailed: (code: number) => `אישור העסקאות הממתינות נכשל (קוד ${code}). ינסה שוב בכיבוי הבא או בלחיצה על "אשר עסקאות ממתינות".`,
  authDeclined: (declined: number, approved: number) => `⚠ ${declined} עסקאות נדחו על ידי חברת האשראי (אושרו ${approved}). הסכום לא ייגבה — יש לטפל מול הלקוח.`,
  authNone: 'אין עסקאות ממתינות לאישור.',
  authOk: (n: number, amount: string) => `אושרו ${n} עסקאות ממתינות, ${amount}.`,
  neverTransmitted: 'טרם שודר מהקופה הזו',
  lastFailed: (why: string) => `ניסיון אחרון נכשל: ${why}`,
  transmitNow: 'שדר עסקאות עכשיו',
  running: 'משדר עסקאות לשב״א…',
  pending: (n: number, amount: string, last: string) => `ממתינות לשידור: ${n} עסקאות · ${amount} · שידור אחרון לפני ${last}`,
  pendingNever: (n: number, amount: string) => `ממתינות לשידור: ${n} עסקאות · ${amount} · טרם שודר`,
  idle: (last: string) => `אין עסקאות ממתינות לשידור · שידור אחרון לפני ${last}`,
  lastAgo: (last: string) => `שודר לאחרונה לפני ${last}`,
  training: 'אין שידור עסקאות במצב הדרכה',
  success: 'השידור הצליח',
  successBatch: (batch: string) => `השידור הצליח · אצווה ${batch}`,
  unknown: 'לא התקבלה תשובה מהמסוף. התוצאה תיבדק לפני ניסיון נוסף.',
  failed: (why: string) => `השידור נכשל: ${why}. ינוסה שוב אוטומטית.`,
  historyTitle: 'היסטוריית שידורים',
  refresh: 'רענן',
  cloudCount: (n: number) => `${n} שידורים בענן למכשיר הזה`,
  historyNotPaired: 'המכשיר אינו מקושר לענן. מוצגים רק השידורים השמורים בקופה.',
  historyOffline: 'אין חיבור לשרת. מוצגים רק השידורים השמורים בקופה.',
  historyServer: 'השרת לא החזיר את ההיסטוריה. מוצגים רק השידורים השמורים בקופה.',
  loading: 'טוען…',
  empty: 'לא בוצעו שידורים מהמכשיר הזה.',
  rowOk: 'שודר בהצלחה',
  rowFailed: 'השידור נכשל',
  rowUnknown: 'לא ידוע',
  unsynced: 'ממתין לסנכרון לענן',
  more: 'טען עוד',
  noTerminal: 'אין מסופון שמשדר עסקאות בקופה הזו',
  chip: 'מסופון במצב לא מקוון',
  chipPending: (n: number) => `מסופון במצב לא מקוון · ${n} ממתינות לאישור`,
  chipCards: 'תייר / דיירקט / דביט לא עוברים',
  waitingApproval: (n: number) => `${n} עסקאות אשראי אושרו במסופון במצב לא מקוון וממתינות לאישור חברת האשראי.`,
  approvePending: 'אישור עסקאות ממתינות',
  reasonTransmit: 'שידור עסקאות ידני',
  reasonOffline: 'מצב לא מקוון (Deferred)',
} as const;
