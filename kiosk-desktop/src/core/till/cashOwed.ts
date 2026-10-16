/**
 * "עודף חייב ללקוח" on a till (P:/specs/cash-paylink.md §9א, §11.8 — pos-android domain/CashDevice.kt `CashOwedNotice`,
 * `CashOwedTexts`): the change a cash station could not give, and the credits it held, routed by the cloud to the tills of
 * `cashAlertTills` — each named by its station. "שולם ללקוח" pays it out of this till's drawer (main/till/tillCash.ts).
 * Pure: the cloud's list in, the till's words out.
 */

/** §11.8 `kind`: change the device could not give, or money it kept. */
export type CashNoticeKind = 'change_owed' | 'held_credit';

export interface CashOwedNotice {
  id: string;
  kind: CashNoticeKind;
  txId: string;
  amountAgorot: number;
  stationId: string | null;
  stationName: string | null;
  slipCode: string | null;
  orderLabel: string | null;
  /** The kiosk it was paid at. */
  clientName: string | null;
  createdAt: string | null;
}

const s = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null);

export function parseOwedNotice(o: unknown): CashOwedNotice | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const id = s(r, 'id');
  if (!id) return null;
  const amount = typeof r.amountAgorot === 'number' && Number.isFinite(r.amountAgorot) ? Math.trunc(r.amountAgorot) : 0;
  if (amount <= 0) return null;
  const kind = s(r, 'kind')?.trim().toLowerCase();
  // An unknown kind: never paid out as if it were known (§11.11).
  if (kind !== 'change_owed' && kind !== 'held_credit') return null;
  return {
    id,
    kind,
    txId: s(r, 'txId') ?? id,
    amountAgorot: amount,
    stationId: s(r, 'stationId'),
    stationName: s(r, 'stationName'),
    slipCode: s(r, 'slipCode'),
    orderLabel: s(r, 'orderLabel'),
    clientName: s(r, 'clientName'),
    createdAt: s(r, 'createdAt'),
  };
}

/** `GET /sync/{m}/cash/owed` → its items, those the till may offer. */
export function parseOwedList(body: unknown): CashOwedNotice[] {
  const arr = body && typeof body === 'object' ? (body as { items?: unknown }).items : null;
  if (!Array.isArray(arr)) return [];
  return arr.map(parseOwedNotice).filter((n): n is CashOwedNotice => n !== null);
}

/** "13 ₪" / "13.50 ₪" (Android CashMoney.text). */
export function cashMoneyText(agorot: number): string {
  const abs = Math.abs(agorot);
  const body = abs % 100 === 0 ? `${Math.trunc(abs / 100)}` : `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return `${agorot < 0 ? '-' : ''}${body} ₪`;
}

/** A transaction on a slip and a screen (§11.6 6, `txShort`): its id's first 8 characters, no dashes, upper case. */
export const shortCode = (txId: string): string => txId.replace(/-/g, '').slice(0, 8).toUpperCase();

export const OWED_TEXT = {
  owed: 'עודף חייב ללקוח',
  held: 'זיכוי מוחזק',
  order: 'הזמנה',
  pay: 'שולם ללקוח',
  paid: (s: string) => `נרשמה הוצאת מזומן של ${s} מהמגירה`,
  failed: (why: string) => `לא נרשם: ${why}`,
  noShift: 'אין משמרת פתוחה בקופה — פתחו משמרת ונסו שוב',
  already: (by: string) => `כבר שולם (${by})`,
  offline: 'אין חיבור לענן — "שולם ללקוח" רק בקופה מחוברת',
  notApproved: 'לא אושר — לא נרשם דבר',
} as const;

/** "עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪" (the station first when named). */
export function owedLine(n: CashOwedNotice): string {
  const what = n.kind === 'change_owed' ? OWED_TEXT.owed : OWED_TEXT.held;
  const order = n.orderLabel?.trim() ? ` — ${OWED_TEXT.order} ${n.orderLabel}` : '';
  const body = `${what}${order}: ${cashMoneyText(n.amountAgorot)}`;
  return n.stationName?.trim() ? `${n.stationName} · ${body}` : body;
}

/** The cash out's reason in the drawer (§11.8 2): "עודף חייב ללקוח · הזמנה 57 · C-XXXXXX". */
export function owedCashOutReason(n: CashOwedNotice): string {
  return [n.kind === 'change_owed' ? OWED_TEXT.owed : OWED_TEXT.held, n.orderLabel?.trim() ? `${OWED_TEXT.order} ${n.orderLabel}` : null, n.slipCode?.trim() || shortCode(n.txId)]
    .filter((x): x is string => !!x)
    .join(' · ');
}

/* ------------------------------------------------------------ cash credits */

/** What taking a cash credit came to (§11.15א, Android `CashCreditRedeem`). */
export type CreditRefusal = 'not_a_code' | 'not_found' | 'used' | 'written_off' | 'nothing_due' | 'in_sale' | 'offline' | 'failed';

export const CREDIT_TEXT: Record<CreditRefusal, string> & { method: string; line: (code: string) => string } = {
  not_a_code: 'קוד הזיכוי לא נמצא',
  not_found: 'קוד הזיכוי לא נמצא',
  used: 'הזיכוי כבר נוצל',
  written_off: 'הזיכוי בוטל',
  nothing_due: 'אין מה לשלם בזיכוי — זיכוי משלם על מוצרים בלבד',
  in_sale: 'הזיכוי כבר בהזמנה הזו',
  offline: 'זיכוי מזומן ממומש רק כשיש חיבור לרשת',
  failed: 'לא ניתן לממש את הזיכוי כרגע',
  method: 'זיכוי מזומן',
  line: (code: string) => `זיכוי ${code}`,
};

/** A cloud refusal's code → why (Android `CashCreditService.whyOf`). */
export function creditWhyOf(code: string | null, status: number): CreditRefusal {
  if (code === 'credit_not_found') return 'not_found';
  if (code === 'credit_used') return 'used';
  if (code === 'credit_written_off' || code === 'written_off') return 'written_off';
  return status === 404 ? 'not_found' : 'failed';
}

/** How much of a credit pays now: what is left on it, never more than is left of the goods. */
export const creditTake = (remainingAgorot: number, goodsDueAgorot: number): number => Math.max(0, Math.min(remainingAgorot, goodsDueAgorot));
