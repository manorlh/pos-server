/**
 * Held ("parked") sales — "להמתנה" / "מכירות בהמתנה" — and what every close does about them: the Android till's
 * HeldSaleRepository.kt, HeldSaleCodec.kt and HeldSalesAtClose.kt (domain + repo), in the Windows till's terms.
 *
 *  - a held sale is not a document: no number, never sent to the cloud, no trading day — holding is allowed with the
 *    shift closed; it becomes a sale only when resumed and paid. Resuming takes the row (never two live copies);
 *  - a snapshot, not references: each line keeps its product's name and the price it was parked at, so a catalog sync that
 *    reprices or delists an item does not change a basket the customer was quoted;
 *  - not with a refund line (it would come back as a sale), not empty;
 *  - every local close warns while sales are held ("יש N מכירות מושהות"): each is paid or cancelled first — a cancel needs
 *    HELD_SALE_CANCEL (a manager's code where the role asks it), a reason, and records a `held_sale_cancelled` till event;
 *    `allowCloseWithHeldSales` also offers "סגור והשאר מושהות".
 *
 * Pure.
 */

import { formatAgorot } from '../money';
import type { DiscountType, OthMark } from './discounts';
import type { LineChoices } from './choices';

/** The longest label a held sale takes (HoldLabelMaxChars). */
export const HOLD_LABEL_MAX = 24;

/** One parked line. */
export interface HeldLine {
  id: string;
  productId: string;
  name: string;
  qty: number;
  /** The unit price it was parked at, agorot. */
  unitAgorot: number;
  discount: { type: DiscountType; value: number } | null;
  oth: OthMark | null;
  /** "מחייב אישור מנהל במכירה": who let it in (so the pick-up does not ask twice). */
  managerApproval?: { byId: string; byName: string; at: string; self: boolean } | null;
  /** "תוספות / ארוחה / הערות" (core/till/choices.ts): what the line was ordered with; its dish's own price then (`baseAgorot`). */
  choices?: LineChoices | null;
  baseAgorot?: number | null;
}

/** A held sale as it is kept on the till. */
export interface HeldSale {
  id: string;
  label: string | null;
  itemCount: number;
  totalAgorot: number;
  lines: HeldLine[];
  cashierId: string;
  cashierName: string | null;
  createdAt: string;
}

/** One line of a held sale, as the warning and the cancel's till event name it. */
export interface HeldItem {
  name: string;
  quantity: number;
}

/** One held sale as a close lists it. */
export interface HeldSaleSummary {
  id: string;
  at: string;
  cashierId: string | null;
  cashier: string | null;
  itemCount: number;
  totalAgorot: number;
  items: HeldItem[];
  label: string | null;
}

export function summaryOf(h: HeldSale): HeldSaleSummary {
  return {
    id: h.id,
    at: h.createdAt,
    cashierId: h.cashierId,
    cashier: h.cashierName,
    itemCount: h.itemCount,
    totalAgorot: h.totalAgorot,
    items: h.lines.map((l) => ({ name: l.name, quantity: l.qty })),
    label: h.label,
  };
}

/** Items as a held sale counts them: the quantities, rounded up. */
export function heldItemCount(quantities: readonly number[]): number {
  return Math.ceil(quantities.reduce((s, q) => s + q, 0));
}

/** The label as kept: trimmed, at most 24 characters, none when blank. */
export function holdLabelOf(raw: unknown): string | null {
  const t = typeof raw === 'string' ? raw.trim().slice(0, HOLD_LABEL_MAX) : '';
  return t.length > 0 ? t : null;
}

/** Why a basket cannot be parked, in the Android till's words; null — it can. */
export function holdRefusal(input: { empty: boolean; hasRefundLines: boolean }): string | null {
  if (input.empty) return HELD_TEXT.holdEmpty;
  if (input.hasRefundLines) return HELD_TEXT.holdRefundBlocked;
  return null;
}

/** Picking a held sale up while items are rung up: the live basket is parked first, never merged or lost (resumeNeedsHold). */
export function resumeNeedsHold(liveCartEmpty: boolean): boolean {
  return !liveCartEmpty;
}

/* ---------------------------------------------------------------- at a close */

/** "סגירה עם מכירות מושהות": a local close may go on and leave them parked. Off unless "true". */
export const PARAM_ALLOW_CLOSE_WITH_HELD_SALES = 'allowCloseWithHeldSales';

export function allowCloseWithHeldSales(params: Record<string, unknown>): boolean {
  const v = params[PARAM_ALLOW_CLOSE_WITH_HELD_SALES];
  return v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

export type HeldSalesGate = 'proceed' | 'warn' | 'warn_with_keep_option';

export function heldSalesGate(count: number, allowCloseWithHeld: boolean): HeldSalesGate {
  if (count <= 0) return 'proceed';
  return allowCloseWithHeld ? 'warn_with_keep_option' : 'warn';
}

/** Money as the wire's decimal string: "42.50". */
export function decimalString(agorot: number): string {
  return formatAgorot(agorot);
}

export const TILL_EVENT_HELD_SALE_CANCELLED = 'held_sale_cancelled';
export const HELD_CANCEL_LOCAL = 'local';
export const HELD_CANCEL_REMOTE = 'remote';
export const HELD_CANCEL_AUTO_CLOSE = 'auto_close';

/** The till event of a held sale cancelled ([TILL_EVENT_HELD_SALE_CANCELLED]): its details (heldSaleCancelDetails). */
export function heldSaleCancelDetails(
  sale: HeldSaleSummary,
  source: string,
  reason: string,
  at: string,
  extra: { approvedBy?: string | null; by?: string | null; requestId?: string | null } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { heldSaleId: sale.id, source, reason };
  if (source === HELD_CANCEL_LOCAL) out.approvedBy = extra.approvedBy ?? null;
  if (source === HELD_CANCEL_REMOTE) {
    out.by = extra.by ?? null;
    out.requestId = extra.requestId ?? null;
  }
  out.cashier = sale.cashier;
  out.items = sale.items.map((i) => ({ name: i.name, quantity: i.quantity }));
  out.total = decimalString(sale.totalAgorot);
  out.at = at;
  return out;
}

/** The Android till's words (res/values/strings.xml). */
export const HELD_TEXT = {
  hold: 'להמתנה',
  holdNow: 'העבר להמתנה',
  holdWithLabel: 'להמתנה עם שם',
  holdEmpty: 'אין פריטים בסל להעברה להמתנה',
  holdFailed: 'לא הצלחנו להעביר את הסל להמתנה. הפריטים נשארו בסל.',
  holdLabelTitle: 'שם למכירה בהמתנה',
  holdLabelWhy: 'לא חובה. שם לקוח או מספר שולחן, כדי לזהות אותה אחר כך.',
  heldOpen: (n: number) => `מכירות בהמתנה: ${n}`,
  heldTitle: 'מכירות בהמתנה',
  heldEmpty: 'אין מכירות בהמתנה',
  heldUnnamed: 'ללא שם',
  heldResume: 'טען מכירה',
  heldDiscard: 'מחק',
  heldGone: 'המכירה שבהמתנה לא נמצאה ולא נטענה.',
  conflictTitle: 'יש פריטים בסל',
  conflictMessage: (what: string) => `הסל הנוכחי (${what}) יעבור להמתנה, ואז תיטען המכירה שבחרת. שום פריט לא נמחק.`,
  conflictConfirm: 'העבר להמתנה וטען',
  holdRefundBlocked: 'אי אפשר להשהות עסקה עם זיכויים.',
  closeTitle: (n: number) => `יש ${n} מכירות מושהות`,
  closeBody: 'יש לשלם או לבטל אותן לפני הסגירה. לחצו להצגת המכירות המושהות.',
  closeKeep: 'סגור והשאר מושהות',
  closePay: 'פתח לתשלום',
  closeCancel: 'בטל',
  cancelTitle: (shekels: string) => `ביטול מכירה מושהית (₪${shekels})`,
  cancelReason: 'סיבת הביטול',
  cancelConfirm: 'בטל מכירה',
  waitNow: 'ממתין פחות מדקה',
  waitMinutes: (n: number) => `ממתין ${n} דקות`,
  waitHours: (h: number, m: number) => `ממתין ${h} שעות ו־${m} דקות`,
} as const;

/** "ממתין 12 דקות" for a sale parked at [at]. */
export function heldWaitText(atIso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(atIso)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return HELD_TEXT.waitNow;
  if (minutes < 60) return HELD_TEXT.waitMinutes(minutes);
  return HELD_TEXT.waitHours(Math.floor(minutes / 60), minutes % 60);
}

/** A held sale read back from storage, or null when it is not one (never a crash on a bad row). */
export function heldSaleOf(raw: unknown): HeldSale | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !Array.isArray(o.lines)) return null;
  const lines: HeldLine[] = [];
  for (const x of o.lines) {
    if (!x || typeof x !== 'object') continue;
    const l = x as Record<string, unknown>;
    if (typeof l.productId !== 'string' || typeof l.qty !== 'number' || typeof l.unitAgorot !== 'number') continue;
    const d = l.discount as { type?: unknown; value?: unknown } | null | undefined;
    const discount: HeldLine['discount'] = d && (d.type === 'percentage' || d.type === 'fixed') && typeof d.value === 'number' ? { type: d.type, value: d.value } : null;
    const oth = l.oth && typeof (l.oth as OthMark).reason === 'string' ? (l.oth as OthMark) : null;
    lines.push({
      id: typeof l.id === 'string' ? l.id : `h${lines.length + 1}`,
      productId: l.productId,
      name: typeof l.name === 'string' ? l.name : l.productId,
      qty: l.qty,
      unitAgorot: l.unitAgorot,
      discount,
      oth,
      ...(l.managerApproval && typeof l.managerApproval === 'object' ? { managerApproval: l.managerApproval as HeldLine['managerApproval'] } : {}),
      // "תוספות / ארוחה / הערות": kept as written (the engine checks them against the catalog again on the way in).
      ...(l.choices && typeof l.choices === 'object' && Array.isArray((l.choices as LineChoices).options) ? { choices: l.choices as LineChoices } : {}),
      ...(typeof l.baseAgorot === 'number' ? { baseAgorot: l.baseAgorot } : {}),
    });
  }
  return {
    id: o.id,
    label: typeof o.label === 'string' ? o.label : null,
    itemCount: typeof o.itemCount === 'number' ? o.itemCount : heldItemCount(lines.map((l) => l.qty)),
    totalAgorot: typeof o.totalAgorot === 'number' ? o.totalAgorot : 0,
    lines,
    cashierId: typeof o.cashierId === 'string' ? o.cashierId : '',
    cashierName: typeof o.cashierName === 'string' ? o.cashierName : null,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
  };
}
