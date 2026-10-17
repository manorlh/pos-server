/**
 * "מזומן במכשיר" on the Windows till — the money's rules (pos-android ui/checkout/CheckoutViewModel.kt `payOnCashMag` /
 * `recordDeviceCash`, ui/checkout/CashDeviceTender.kt `cashDeviceSale`, domain/CashDevice.kt `CashLegMeta`; the contracts are
 * P:/specs/cashmag.md §3 and P:/specs/cash-paylink.md §11.6–§11.7, §11.15א):
 *
 *  - which device takes the cash: a CashMag recycler when the cloud turned `cashmagEnabled` on for this till, else the
 *    shop's PayLink cash station when the cloud assigned this till one (`GET /sync/{m}/cash`); else none — no button;
 *  - the sale is closed by ONE cash leg for exactly what was left of the goods, that leg carrying the device's transaction
 *    (`cashDevice`): what went in, the change it gave and the change it could not give ("עודף חייב"), the rounding;
 *  - change owed: a slip (always), a credit for the next order (online, and for CashMag only while the cloud says it makes
 *    one — `cashmagOwedCredit`), a tip (only where the sale takes a cash tip — never on the Windows till today);
 *  - the money is in the device, never in the drawer: no drawer opens for it, and the drawer's expected cash leaves it out
 *    (core/sale.ts `buildXTill`, "מזומן במכשיר").
 *
 * Pure: agorot in, agorot out.
 */

import type { OwedChoice, TxView } from '../cash/tx';
import { cashMoneyText, shortCode } from './cashOwed';
import { handedTotal, type TenderLeg } from './tender';

export type DeviceKind = 'cashmag' | 'paylink';

/** The cash leg's `cashDevice` (§11.7) — the ledger's DocCashLeg, the same fields. */
export interface DeviceLegMeta {
  txId: string;
  stationId: string;
  hostId: string;
  receivedAgorot: number;
  changeAgorot: number;
  changeOwedAgorot: number;
  roundingAgorot: number;
  slipCode: string | null;
  changeOwedAs?: OwedChoice | null;
}

/**
 * A till's payment at a cash device is journaled under `till:<document id>` (the kiosk's under its order's id): the kiosk's
 * recovery leaves these alone — the till settles its own.
 */
export const TILL_CASH_PREFIX = 'till:';
export const tillCashRef = (docId: string): string => `${TILL_CASH_PREFIX}${docId}`;
export const isTillCashRef = (ref: string | null | undefined): boolean => typeof ref === 'string' && ref.startsWith(TILL_CASH_PREFIX);

/** Which device takes this till's cash now (CashMag first: the cloud turned it on for this till). */
export function deviceKindOf(f: { cashmagEnabled: boolean; paylinkConfigured: boolean }): DeviceKind | null {
  if (f.cashmagEnabled) return 'cashmag';
  if (f.paylinkConfigured) return 'paylink';
  return null;
}

/** A device transaction's leg record, with the customer's choice for the change owed (none owed: no choice). */
export function deviceLegOf(tx: TxView, owedAs: OwedChoice | null): DeviceLegMeta {
  return {
    txId: tx.txId,
    stationId: tx.stationId,
    hostId: tx.hostId,
    receivedAgorot: tx.insertedAgorot,
    changeAgorot: tx.changePaidAgorot,
    changeOwedAgorot: tx.changeOwedAgorot,
    roundingAgorot: tx.roundingAgorot,
    slipCode: tx.slipCode,
    ...(tx.changeOwedAgorot > 0 && owedAs ? { changeOwedAs: owedAs } : {}),
  };
}

/** Left as a tip (§11.15א): the document's tip grows by it, and it is no change at all. */
export const owedAsTip = (m: DeviceLegMeta): boolean => m.changeOwedAs === 'tip' && m.changeOwedAgorot > 0;

export interface DeviceSettle {
  /** The legs as the document keeps them: the earlier ones, then the device's for exactly what was left (its tip in it). */
  legs: TenderLeg[];
  /** All the cash handed over: the earlier notes at the counter and what went into the device. */
  tenderedAgorot: number;
  /** The document's change: given and owed — less what became the tip (`documentChangeAgorot`). */
  changeAgorot: number;
  /** What the change owed added to the tip (0 unless the customer left it). */
  tipAgorot: number;
}

/**
 * The sale the device paid (`cashDeviceSale`): the earlier legs as they are, closed by one cash leg for exactly the goods
 * left; null when the legs would not settle (nothing is written then).
 */
export function deviceSettle(totalAgorot: number, earlier: readonly TenderLeg[], meta: DeviceLegMeta): DeviceSettle | null {
  const paid = earlier.reduce((s, l) => s + l.amountAgorot, 0);
  const due = totalAgorot - paid;
  if (due < 1) return null;
  const tip = owedAsTip(meta) ? meta.changeOwedAgorot : 0;
  const leg: TenderLeg = { method: 'cash', amountAgorot: due + tip, handedAgorot: meta.receivedAgorot };
  const legs = [...earlier, leg];
  return {
    legs,
    tenderedAgorot: handedTotal(legs),
    changeAgorot: tip > 0 ? meta.changeAgorot : meta.changeAgorot + meta.changeOwedAgorot,
    tipAgorot: tip,
  };
}

/**
 * "חסר עודף במכשיר": what the cashier may choose — a slip always; a credit online (CashMag: only while the cloud makes
 * CashMag credits, `cashmagOwedCredit`); a tip where the sale takes a cash tip. One choice only: nothing is asked.
 */
export function deviceOwedChoices(f: { kind: DeviceKind; online: boolean; cashmagOwedCredit: boolean; tipOk: boolean }): OwedChoice[] {
  const credit = f.online && (f.kind === 'paylink' || f.cashmagOwedCredit);
  return (['slip', 'credit', 'tip'] as const).filter((c) => c === 'slip' || (c === 'credit' && credit) || (c === 'tip' && f.tipOk));
}

/* ------------------------------------------------------------------ what the screens show */

export type DeviceCashStage = 'connecting' | 'busy' | 'insert' | 'question' | 'settling' | 'owed' | 'unknown' | 'done';

/** The payment's look on the checkout (`CheckoutState.deviceCash`). */
export interface DeviceCashView {
  kind: DeviceKind;
  name: string;
  stage: DeviceCashStage;
  message: string;
  insertedAgorot: number;
  dueAgorot: number;
  canCancel: boolean;
  /** "חזרה" while waiting for the machine, "ביטול" once it takes money. */
  cancelLabel: string;
  question: { title: string; text: string } | null;
  position: number | null;
  longWait: boolean;
  txShort: string | null;
  /** The sale is done: what the device gave and owes, and what to do about it. */
  done: { notice: string | null; owedAgorot: number; owedFromDrawer: boolean; owedPaid: boolean } | null;
}

/** "מכשיר מזומן" — the device's screen. */
export interface DeviceCashScreen {
  rows: Array<{ label: string; value: string; ltr?: boolean }>;
  usable: boolean;
  reason: string | null;
  unresolved: Array<{ txId: string; txShort: string; amountAgorot: number; startedAt: number; outcome: string | null; heldAgorot: number; reason: string | null }>;
  pending: Array<{ txShort: string; amountAgorot: number; startedAt: number }>;
}

/** `TillState.deviceCash`. */
export interface DeviceCashState {
  kind: DeviceKind | null;
  name: string;
  /** The "מזומן במכשיר" button may be pressed now. */
  available: boolean;
  reason: string | null;
  unresolvedCount: number;
  screen: DeviceCashScreen | null;
}

/** The till's own words (pos-android strings `cashmag_*`, `kcash_*`). */
export const DEVICE_CASH_TEXT = {
  button: 'מזומן במכשיר',
  cashmagName: 'CashMag',
  connecting: 'מתחבר למכשיר המזומן…',
  insert: 'הכנס מזומן במכשיר',
  inserted: (inAgorot: number, dueAgorot: number) => `הוכנסו ${cashMoneyText(inAgorot)} מתוך ${cashMoneyText(dueAgorot)}`,
  busyHint: 'התשלום יתחיל לבד כשהמכשיר יתפנה',
  back: 'חזרה',
  cancel: 'ביטול',
  cancelling: 'מבטלים — קחו את הכסף מהמכשיר',
  settling: 'מסיים את התשלום במכשיר…',
  owedTitle: (s: string) => `חסר עודף במכשיר: ${s}`,
  owedBody: 'מה עושים עם העודף שהמכשיר לא נתן?',
  owedSlip: 'פתק עודף חייב — לתת מהמגירה',
  owedCredit: 'זיכוי להזמנה הבאה',
  owedTip: 'להשאיר כטיפ',
  owedSlipBanner: (s: string) => `המכשיר חייב ללקוח עודף של ${s} — יש לתת מהמגירה`,
  owedSlipPaylink: (s: string) => `המכשיר חייב ללקוח עודף של ${s} — מופיע ב"עודף חייב ללקוח"`,
  owedPaidFromDrawer: 'נתתי מהמגירה',
  owedPaidDone: 'נרשמה הוצאת העודף מהמגירה',
  owedCreditDone: (s: string, code: string) => `נוצר זיכוי להזמנה הבאה: ${s} · קוד ${code}`,
  owedTipDone: (s: string) => `העודף החסר (${s}) נרשם כטיפ`,
  gave: (s: string) => `המכשיר נתן עודף ${s}`,
  cancelledRefunded: (s: string) => `התשלום בוטל — הכסף הוחזר (${s})`,
  cancelled: 'התשלום בוטל — לא נגבה דבר',
  fault: (tx: string, s: string) => `תקלה בתשלום במכשיר המזומן (עסקה ${tx}, הוכנסו ${s}) — לא נכתב מסמך. מנהל צריך לבדוק במכשיר ולסמן "טופל".`,
  lost: (tx: string) => `אין תשובה ממכשיר המזומן (עסקה ${tx}) — לא ידוע אם שולם. "בדוק שוב" כשהמכשיר עונה.`,
  recheck: 'בדוק שוב',
  markNotPaid: 'סמן כלא שולם',
  markedNotPaid: 'התשלום במכשיר סומן כלא שולם באישור מנהל',
  documentFailed: (tx: string) => `התשלום במכשיר הצליח אבל המסמך לא נכתב (עסקה ${tx}) — פנו למנהל`,
  inBasket: 'מזומן במכשיר לא זמין בסל עם החזרות',
  notConfigured: 'לא הוגדר מכשיר מזומן לקופה',
  busyHere: 'תשלום כבר בתהליך',
  // The device's screen ("מכשיר מזומן").
  screenTitle: 'מכשיר מזומן',
  acknowledge: 'טופל',
  acknowledged: 'סומן כטופל',
  check: 'בדיקת חיבור',
  unresolvedTitle: 'תשלומים שממתינים לבירור',
  noUnresolved: 'אין תשלומים שממתינים לבירור',
  pendingTitle: 'תשלומים פתוחים מול עמדת המזומן',
  sourceCloud: 'מהענן',
  sourceLocal: 'מקומי',
  sourceDefault: 'ברירת מחדל',
} as const;

/** "13 ₪" — the device's figures as the screens say them. */
export const deviceMoney = cashMoneyText;
export const deviceTxShort = shortCode;
