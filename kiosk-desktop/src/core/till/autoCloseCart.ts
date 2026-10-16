/**
 * "סגירת משמרת אוטומטית גם עם עגלה פתוחה" (the owner, 14.10.2026; P:/specs/auto-close-open-cart.md) — the Android
 * till's domain/AutoCloseOpenCart.kt, one to one. `autoCloseShiftAt` closes the shift at its time, never in the middle
 * of a payment; four till parameters (company → shop → area → till) say what it does about what is open then:
 *
 *  - `autoCloseOpenCart` — a basket with items, not paid: `wait` (the default — as always), `hold` (parked as a held sale
 *    "הושהתה בסגירה אוטומטית", back with "החזר הזמנה" in the next shift) or `discard` (voided, an exception with its items);
 *  - `autoCloseHeldSales` — the sales already parked: `keep` (the default) or `cancel` (each cancelled, recorded);
 *  - `autoCloseMaxWaitMin` (10) — a payment under way is waited for; past these minutes the close goes on all the same;
 *  - `autoCloseIgnoreTables` (off) — open tables hold it (the Windows till has no tables).
 *
 * Pure.
 */

import { decimalString, type HeldItem, type HeldSaleSummary } from './heldSales';

export const PARAM_AUTO_CLOSE_OPEN_CART = 'autoCloseOpenCart';
export const PARAM_AUTO_CLOSE_HELD_SALES = 'autoCloseHeldSales';
export const PARAM_AUTO_CLOSE_MAX_WAIT_MIN = 'autoCloseMaxWaitMin';
export const PARAM_AUTO_CLOSE_IGNORE_TABLES = 'autoCloseIgnoreTables';

/** The held sale's label of a basket the automatic close parked. */
export const AUTO_CLOSE_PARK_LABEL = 'הושהתה בסגירה אוטומטית';

/** Till events (pos-server exceptions.py `TILL_EVENT_TYPES`): the first three feed the cloud's exceptions. */
export const TILL_EVENT_AUTO_CLOSE_CART_HELD = 'auto_close_cart_held';
export const TILL_EVENT_AUTO_CLOSE_CART_DISCARDED = 'auto_close_cart_discarded';
export const TILL_EVENT_AUTO_CLOSE_HELD_CANCELLED = 'auto_close_held_sales_cancelled';
export const TILL_EVENT_SHIFT_AUTO_CLOSED = 'shift_auto_closed';

export type AutoCloseCartMode = 'wait' | 'hold' | 'discard';
export type AutoCloseHeldMode = 'keep' | 'cancel';

const str = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

export function cartModeOf(raw: unknown): AutoCloseCartMode {
  const v = str(raw);
  return v === 'hold' || v === 'discard' ? v : 'wait';
}

export function heldModeOf(raw: unknown): AutoCloseHeldMode {
  return str(raw) === 'cancel' ? 'cancel' : 'keep';
}

export const DEFAULT_MAX_WAIT_MIN = 10;
export const MAX_WAIT_MIN_LIMIT = 240;

/** Whole minutes, 0–240 ("10", "10.0"); empty or unreadable — 10. */
export function maxWaitOf(raw: unknown): number {
  const s = str(raw);
  if (s === '') return DEFAULT_MAX_WAIT_MIN;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_WAIT_MIN;
  return Math.min(Math.trunc(n), MAX_WAIT_MIN_LIMIT);
}

export interface AutoCloseRules {
  cart: AutoCloseCartMode;
  held: AutoCloseHeldMode;
  maxWaitMin: number;
  ignoreTables: boolean;
}

export function autoCloseRulesOf(params: Record<string, unknown>): AutoCloseRules {
  return {
    cart: cartModeOf(params[PARAM_AUTO_CLOSE_OPEN_CART]),
    held: heldModeOf(params[PARAM_AUTO_CLOSE_HELD_SALES]),
    maxWaitMin: maxWaitOf(params[PARAM_AUTO_CLOSE_MAX_WAIT_MIN]),
    ignoreTables: str(params[PARAM_AUTO_CLOSE_IGNORE_TABLES]) === 'true',
  };
}

export const maxWaitMs = (r: AutoCloseRules) => r.maxWaitMin * 60_000;

/** The till's sale as the automatic close looks at it. */
export interface AutoCloseSaleLook {
  cardInFlight: boolean;
  checkoutOpen: boolean;
  /** That payment has taken something (a leg, a card) or is already done: never backed out, parked or voided. */
  paymentTaken: boolean;
  basketOpen: boolean;
  tableOpen: boolean;
}

export const NO_SALE: AutoCloseSaleLook = { cardInFlight: false, checkoutOpen: false, paymentTaken: false, basketOpen: false, tableOpen: false };

export type AutoCloseStep = 'close' | 'wait_payment' | 'wait_cart' | 'hold' | 'discard';

export interface AutoCloseDecision {
  step: AutoCloseStep;
  /** Back out the payment screen first (nothing was taken), as its own "ביטול". */
  abandonPayment: boolean;
  /** Closing past the wait with a payment still on screen — left as it is. */
  overPayment: boolean;
}

const d = (step: AutoCloseStep, abandonPayment = false, overPayment = false): AutoCloseDecision => ({ step, abandonPayment, overPayment });

/** The one decision of the automatic close, once it is due and nothing else holds it (autoCloseDecision). */
export function autoCloseDecision(rules: AutoCloseRules, look: AutoCloseSaleLook, waitedMs: number, basketGraceOver = true): AutoCloseDecision {
  const pastWait = waitedMs >= maxWaitMs(rules);
  if (look.cardInFlight || (look.checkoutOpen && look.paymentTaken)) return pastWait ? d('close', false, true) : d('wait_payment');
  if (look.checkoutOpen) {
    if (!pastWait) return d('wait_payment');
    if (look.tableOpen) return rules.cart === 'wait' ? d('wait_payment') : d('close', false, true);
    if (rules.cart === 'wait') return d('wait_payment');
    return rules.cart === 'hold' ? d('hold', true) : d('discard', true);
  }
  if (look.basketOpen && !look.tableOpen) {
    if (rules.cart === 'wait') return d(basketGraceOver ? 'close' : 'wait_cart');
    return rules.cart === 'hold' ? d('hold') : d('discard');
  }
  return d('close');
}

export type AutoCloseCartAction = 'held' | 'discarded' | 'kept';

/** The basket the automatic close handled. */
export interface AutoCloseCart {
  action: AutoCloseCartAction;
  items: HeldItem[];
  itemCount: number;
  amountAgorot: number;
  heldSaleId: string | null;
  cashierId: string | null;
  paymentAbandoned: boolean;
  /** Why it was kept: table | kitchen | refund_lines | hold_failed. */
  keptReason: string | null;
}

/** "87 ₪", "87.50 ₪". */
export function autoCloseShekels(agorot: number): string {
  const whole = agorot % 100 === 0;
  return `${whole ? String(agorot / 100) : decimalString(agorot)} ₪`;
}

export function autoCloseCartEventType(action: AutoCloseCartAction): string | null {
  return action === 'held' ? TILL_EVENT_AUTO_CLOSE_CART_HELD : action === 'discarded' ? TILL_EVENT_AUTO_CLOSE_CART_DISCARDED : null;
}

export const DETAIL_ITEMS_MAX = 40;

/** What was done with the basket, in one line. */
export function autoCloseCartLine(cart: Pick<AutoCloseCart, 'action' | 'itemCount' | 'amountAgorot'>): string {
  const what = `${cart.itemCount} פריטים, ${autoCloseShekels(cart.amountAgorot)}`;
  if (cart.action === 'held') return `עגלה הושהתה (${AUTO_CLOSE_PARK_LABEL}) — ${what}`;
  if (cart.action === 'discarded') return `עגלה בוטלה בסגירה אוטומטית — ${what}`;
  return `עגלה נשארה בקופה — ${what}`;
}

export function autoCloseHeldCancelledLine(count: number, amountAgorot: number): string {
  return `בוטלו ${count} עסקאות מושהות בסגירה אוטומטית — ${autoCloseShekels(amountAgorot)}`;
}

/** The till event of a basket held or discarded: its details. */
export function autoCloseCartDetails(cart: AutoCloseCart, at: string, shiftSequence: number | null): Record<string, unknown> {
  return {
    action: cart.action,
    at,
    shiftSequence,
    heldSaleId: cart.heldSaleId,
    label: cart.action === 'held' ? AUTO_CLOSE_PARK_LABEL : null,
    itemCount: cart.itemCount,
    items: cart.items.slice(0, DETAIL_ITEMS_MAX).map((i) => ({ name: i.name, quantity: i.quantity })),
    total: decimalString(cart.amountAgorot),
    paymentAbandoned: cart.paymentAbandoned,
    keptReason: cart.keptReason,
    summary: autoCloseCartLine(cart),
  };
}

/** The one exception of the held sales the automatic close cancelled. */
export function autoCloseHeldCancelledDetails(cancelled: readonly HeldSaleSummary[], at: string): Record<string, unknown> {
  const total = cancelled.reduce((s, h) => s + h.totalAgorot, 0);
  return {
    at,
    count: cancelled.length,
    total: decimalString(total),
    heldSales: cancelled.slice(0, DETAIL_ITEMS_MAX).map((h) => ({
      heldSaleId: h.id,
      parkedAt: h.at,
      cashier: h.cashier,
      itemCount: h.itemCount,
      total: decimalString(h.totalAgorot),
      items: h.items.slice(0, 10).map((i) => ({ name: i.name, quantity: i.quantity })),
    })),
    summary: autoCloseHeldCancelledLine(cancelled.length, total),
  };
}

/** What one automatic close came to — the journal, the shift report and the next shift's notice. */
export interface AutoCloseRecord {
  shiftId: string;
  /** The parameter's time, "HH:MM". */
  at: string;
  closedAt: string | null;
  cart: AutoCloseCart | null;
  heldCancelled: number;
  heldCancelledAgorot: number;
  heldCarried: number;
  tablesCarried: number;
  overPayment: boolean;
  waitedMs: number;
}

/** Something the next shift is told of: a basket held or voided, held sales cancelled. */
export function worthNotice(r: AutoCloseRecord): boolean {
  return r.cart?.action === 'held' || r.cart?.action === 'discarded' || r.heldCancelled > 0;
}

/** "נסגרה אוטומטית ב-23:30". */
export function autoClosedLine(at: string): string {
  return `נסגרה אוטומטית ב-${at}`;
}

export function autoCloseReportLines(r: AutoCloseRecord): string[] {
  const out = [autoClosedLine(r.at)];
  if (r.cart) {
    out.push(autoCloseCartLine(r.cart));
    if (r.cart.paymentAbandoned) out.push('מסך התשלום בוטל (לא נגבה דבר)');
  }
  if (r.overPayment) out.push(`תשלום שלא הסתיים נשאר פתוח אחרי ${Math.floor(r.waitedMs / 60_000)} דקות המתנה`);
  if (r.heldCancelled > 0) out.push(autoCloseHeldCancelledLine(r.heldCancelled, r.heldCancelledAgorot));
  if (r.heldCarried > 0) out.push(`${r.heldCarried} עסקאות מושהות עברו למשמרת הבאה`);
  if (r.tablesCarried > 0) out.push(`${r.tablesCarried} שולחנות פתוחים עברו למשמרת הבאה`);
  return out;
}

/** What the next shift opens with, or null: "במשמרת הקודמת הושהתה עגלה בסגירה אוטומטית — 3 פריטים, 87 ₪". */
export function autoCloseNextShiftNotice(r: AutoCloseRecord): string | null {
  const lines: string[] = [];
  if (r.cart) {
    const what = `${r.cart.itemCount} פריטים, ${autoCloseShekels(r.cart.amountAgorot)}`;
    if (r.cart.action === 'held') lines.push(`במשמרת הקודמת הושהתה עגלה בסגירה אוטומטית — ${what}. היא זמינה ב"החזר הזמנה".`);
    else if (r.cart.action === 'discarded') lines.push(`במשמרת הקודמת בוטלה עגלה בסגירה אוטומטית — ${what}.`);
  }
  if (r.heldCancelled > 0) lines.push(`במשמרת הקודמת בוטלו ${r.heldCancelled} עסקאות מושהות בסגירה אוטומטית — ${autoCloseShekels(r.heldCancelledAgorot)}.`);
  return lines.length > 0 ? lines.join('\n') : null;
}

/** The journal's `shift_auto_closed` event: its details. */
export function shiftAutoClosedDetails(r: AutoCloseRecord, rules: AutoCloseRules): Record<string, unknown> {
  return {
    at: r.at,
    closedAt: r.closedAt,
    line: autoClosedLine(r.at),
    openCart: rules.cart,
    heldSales: rules.held,
    maxWaitMin: rules.maxWaitMin,
    ignoreTables: rules.ignoreTables,
    cart: r.cart
      ? { action: r.cart.action, heldSaleId: r.cart.heldSaleId, itemCount: r.cart.itemCount, total: decimalString(r.cart.amountAgorot), paymentAbandoned: r.cart.paymentAbandoned, keptReason: r.cart.keptReason }
      : null,
    heldSalesCancelled: r.heldCancelled,
    heldSalesCarried: r.heldCarried,
    tablesCarried: r.tablesCarried,
    overPayment: r.overPayment,
    waitedMs: r.waitedMs,
    lines: autoCloseReportLines(r),
  };
}

/** The records kept on the till: the last 40, newest last. */
export const AUTO_CLOSE_RECORDS_KEPT = 40;

/** The next shift's notice: taken once, never on the very shift it is about (AutoCloseStore.takeNotice). */
export function takeNotice(kept: AutoCloseRecord | null, openShiftId: string | null): { notice: string | null; keep: boolean } {
  if (!kept) return { notice: null, keep: false };
  if (kept.shiftId === openShiftId) return { notice: null, keep: true };
  return { notice: autoCloseNextShiftNotice(kept), keep: false };
}
