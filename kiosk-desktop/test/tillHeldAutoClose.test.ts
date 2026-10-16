/**
 * Held sales and the automatic close with a basket open — the pure rules (core/till/heldSales.ts, core/till/autoCloseCart.ts)
 * and the store (main/till/heldStore.ts): the Android till's HeldSaleCodecTest, HeldSalesAtCloseTest and AutoCloseOpenCartTest
 * cases that are not the engine's.
 */

import { describe, expect, it } from 'vitest';
import {
  HELD_CANCEL_LOCAL,
  HELD_CANCEL_REMOTE,
  allowCloseWithHeldSales,
  decimalString,
  heldItemCount,
  heldSaleCancelDetails,
  heldSaleOf,
  heldSalesGate,
  heldWaitText,
  holdLabelOf,
  holdRefusal,
  resumeNeedsHold,
  type HeldSaleSummary,
} from '../src/core/till/heldSales';
import {
  AUTO_CLOSE_PARK_LABEL,
  NO_SALE,
  autoCloseCartDetails,
  autoCloseCartEventType,
  autoCloseDecision,
  autoCloseHeldCancelledDetails,
  autoCloseNextShiftNotice,
  autoCloseReportLines,
  autoCloseRulesOf,
  autoCloseShekels,
  autoClosedLine,
  maxWaitOf,
  shiftAutoClosedDetails,
  takeNotice,
  worthNotice,
  type AutoCloseRecord,
  type AutoCloseRules,
} from '../src/core/till/autoCloseCart';
import { HeldStore } from '../src/main/till/heldStore';

function memoryKv() {
  const m = new Map<string, string>();
  return {
    getJson<T>(k: string): T | null {
      const v = m.get(k);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    setJson(k: string, v: unknown) {
      m.set(k, JSON.stringify(v));
    },
  };
}

const line = (id: string, unit: number, qty = 1) => ({ id, productId: `p-${id}`, name: `מוצר ${id}`, qty, unitAgorot: unit, discount: null, oth: null });

describe('held sales (HeldSaleCodecTest, HeldSalesAtCloseTest)', () => {
  it('a plain cart round-trips unchanged, its prices and its order kept', () => {
    const kv = memoryKv();
    const store = new HeldStore(kv, () => Date.parse('2026-10-16T10:00:00Z'));
    const id = store.hold([line('a', 4_200, 2), line('b', 1_250)], { id: 'u1', name: 'דנה' }, 'שולחן 4', 9_650)!;
    const back = store.peek(id)!;
    expect(back.lines.map((l) => [l.productId, l.qty, l.unitAgorot])).toEqual([
      ['p-a', 2, 4_200],
      ['p-b', 1, 1_250],
    ]);
    expect(back).toMatchObject({ label: 'שולחן 4', itemCount: 3, totalAgorot: 9_650, cashierId: 'u1', cashierName: 'דנה', createdAt: '2026-10-16T10:00:00.000Z' });
  });

  it('a line discount and an OTH round-trip with their type', () => {
    const kv = memoryKv();
    const store = new HeldStore(kv);
    const id = store.hold(
      [
        { ...line('a', 1_000), discount: { type: 'percentage' as const, value: 1_000 } },
        { ...line('b', 2_000), oth: { reason: 'פיצוי', by: 'u1', approvedBy: 'm1', approverName: 'אבי' } },
      ],
      { id: 'u1', name: null },
      null,
      900,
    )!;
    const back = store.peek(id)!;
    expect(back.lines[0].discount).toEqual({ type: 'percentage', value: 1_000 });
    expect(back.lines[1].oth).toEqual({ reason: 'פיצוי', by: 'u1', approvedBy: 'm1', approverName: 'אבי' });
  });

  it('absent optional fields decode as null, never as the literal text null; a bad row is dropped', () => {
    expect(heldSaleOf({ id: 'x', lines: [{ productId: 'p', qty: 1, unitAgorot: 100 }] })).toMatchObject({ label: null, cashierName: null, lines: [{ discount: null, oth: null, name: 'p' }] });
    expect(heldSaleOf({ id: 'x' })).toBeNull();
    expect(heldSaleOf(null)).toBeNull();
  });

  it('resuming takes the row (never two live copies); a second resume or cancel finds nothing', () => {
    const store = new HeldStore(memoryKv());
    const id = store.hold([line('a', 100)], { id: 'u1', name: null }, null, 100)!;
    expect(store.count()).toBe(1);
    expect(store.resume(id)?.id).toBe(id);
    expect(store.resume(id)).toBeNull();
    expect(store.discard(id)).toBe(false);
    expect(store.count()).toBe(0);
  });

  it('an empty basket is not parked; nor one with returns', () => {
    expect(new HeldStore(memoryKv()).hold([], { id: 'u', name: null }, null, 0)).toBeNull();
    expect(holdRefusal({ empty: true, hasRefundLines: false })).toBe('אין פריטים בסל להעברה להמתנה');
    expect(holdRefusal({ empty: false, hasRefundLines: true })).toBe('אי אפשר להשהות עסקה עם זיכויים.');
    expect(holdRefusal({ empty: false, hasRefundLines: false })).toBeNull();
    expect(resumeNeedsHold(false)).toBe(true);
    expect(resumeNeedsHold(true)).toBe(false);
  });

  it('the label is trimmed to 24 characters, none when blank; items count rounded up', () => {
    expect(holdLabelOf('  ')).toBeNull();
    expect(holdLabelOf('x'.repeat(30))).toHaveLength(24);
    expect(heldItemCount([1, 0.4, 2])).toBe(4);
  });

  it('a local close warns while sales are held - and offers to keep them only when the shop allows it', () => {
    expect(heldSalesGate(0, false)).toBe('proceed');
    expect(heldSalesGate(2, false)).toBe('warn');
    expect(heldSalesGate(2, true)).toBe('warn_with_keep_option');
    expect(allowCloseWithHeldSales({})).toBe(false);
    expect(allowCloseWithHeldSales({ allowCloseWithHeldSales: ' true ' })).toBe(true);
  });

  it('cancelled at the till only with a reason - and the held_sale_cancelled details', () => {
    const sale: HeldSaleSummary = { id: 'h1', at: '2026-10-16T10:00:00Z', cashierId: 'u1', cashier: 'דנה', itemCount: 2, totalAgorot: 4_250, items: [{ name: 'קולה', quantity: 2 }], label: null };
    expect(heldSaleCancelDetails(sale, HELD_CANCEL_LOCAL, 'הלקוח עזב', '2026-10-16T11:00:00Z', { approvedBy: 'm1' })).toEqual({
      heldSaleId: 'h1',
      source: 'local',
      reason: 'הלקוח עזב',
      approvedBy: 'm1',
      cashier: 'דנה',
      items: [{ name: 'קולה', quantity: 2 }],
      total: '42.50',
      at: '2026-10-16T11:00:00Z',
    });
    const remote = heldSaleCancelDetails(sale, HELD_CANCEL_REMOTE, 'r', 'now', { by: 'x', requestId: 'q' });
    expect(remote).toMatchObject({ by: 'x', requestId: 'q' });
    expect('approvedBy' in remote).toBe(false);
    expect(decimalString(5)).toBe('0.05');
  });

  it('how long it has waited, in the list', () => {
    const at = '2026-10-16T10:00:00Z';
    expect(heldWaitText(at, Date.parse(at) + 30_000)).toBe('ממתין פחות מדקה');
    expect(heldWaitText(at, Date.parse(at) + 12 * 60_000)).toBe('ממתין 12 דקות');
    expect(heldWaitText(at, Date.parse(at) + 125 * 60_000)).toBe('ממתין 2 שעות ו־5 דקות');
  });
});

describe('the automatic close with a basket open (AutoCloseOpenCartTest)', () => {
  const rules = (o: Partial<AutoCloseRules> = {}): AutoCloseRules => ({ cart: 'wait', held: 'keep', maxWaitMin: 10, ignoreTables: false, ...o });

  it("the defaults are today's - wait, keep, 10 minutes, tables hold it", () => {
    expect(autoCloseRulesOf({})).toEqual({ cart: 'wait', held: 'keep', maxWaitMin: 10, ignoreTables: false });
    expect(maxWaitOf('')).toBe(10);
    expect(maxWaitOf('abc')).toBe(10);
    expect(maxWaitOf('-3')).toBe(10);
  });

  it("the cloud's values are read", () => {
    expect(autoCloseRulesOf({ autoCloseOpenCart: 'HOLD', autoCloseHeldSales: 'cancel', autoCloseMaxWaitMin: '25.0', autoCloseIgnoreTables: 'true' })).toEqual({ cart: 'hold', held: 'cancel', maxWaitMin: 25, ignoreTables: true });
    expect(autoCloseRulesOf({ autoCloseOpenCart: 'discard' }).cart).toBe('discard');
    expect(autoCloseRulesOf({ autoCloseOpenCart: 'other' }).cart).toBe('wait');
    expect(maxWaitOf('999')).toBe(240);
    expect(maxWaitOf('0')).toBe(0);
  });

  it('wait - a basket holds it for its grace, then the close goes on and leaves it, as always', () => {
    const look = { ...NO_SALE, basketOpen: true };
    expect(autoCloseDecision(rules(), look, 0, false).step).toBe('wait_cart');
    expect(autoCloseDecision(rules(), look, 0, true).step).toBe('close');
  });

  it('hold and discard act on the basket at once', () => {
    const look = { ...NO_SALE, basketOpen: true };
    expect(autoCloseDecision(rules({ cart: 'hold' }), look, 0)).toEqual({ step: 'hold', abandonPayment: false, overPayment: false });
    expect(autoCloseDecision(rules({ cart: 'discard' }), look, 0)).toEqual({ step: 'discard', abandonPayment: false, overPayment: false });
  });

  it('a card payment is never interrupted - waited for, then closed over and left as it is', () => {
    const card = { ...NO_SALE, cardInFlight: true, checkoutOpen: true, basketOpen: true };
    for (const cart of ['wait', 'hold', 'discard'] as const) {
      expect(autoCloseDecision(rules({ cart }), card, 9 * 60_000).step).toBe('wait_payment');
      expect(autoCloseDecision(rules({ cart }), card, 10 * 60_000)).toEqual({ step: 'close', abandonPayment: false, overPayment: true });
    }
    const taken = { ...NO_SALE, checkoutOpen: true, paymentTaken: true, basketOpen: true };
    expect(autoCloseDecision(rules({ cart: 'hold' }), taken, 0).step).toBe('wait_payment');
  });

  it('a cash payment not finished waits, then the basket goes by the mode', () => {
    const cash = { ...NO_SALE, checkoutOpen: true, basketOpen: true };
    expect(autoCloseDecision(rules({ cart: 'hold' }), cash, 0).step).toBe('wait_payment');
    expect(autoCloseDecision(rules({ cart: 'hold' }), cash, 10 * 60_000)).toEqual({ step: 'hold', abandonPayment: true, overPayment: false });
    expect(autoCloseDecision(rules({ cart: 'discard' }), cash, 10 * 60_000)).toEqual({ step: 'discard', abandonPayment: true, overPayment: false });
    expect(autoCloseDecision(rules({ cart: 'wait' }), cash, 10 * 60_000).step).toBe('wait_payment');
  });

  it('nothing open closes at once in every mode', () => {
    for (const cart of ['wait', 'hold', 'discard'] as const) expect(autoCloseDecision(rules({ cart }), NO_SALE, 0).step).toBe('close');
  });

  it('the journal line says when and what; the events and their details', () => {
    expect(autoClosedLine('23:30')).toBe('נסגרה אוטומטית ב-23:30');
    expect(autoCloseShekels(8_700)).toBe('87 ₪');
    expect(autoCloseShekels(8_750)).toBe('87.50 ₪');
    const cart = { action: 'held' as const, items: [{ name: 'קולה', quantity: 2 }], itemCount: 2, amountAgorot: 2_500, heldSaleId: 'h1', cashierId: 'u1', paymentAbandoned: false, keptReason: null };
    expect(autoCloseCartEventType('held')).toBe('auto_close_cart_held');
    expect(autoCloseCartEventType('discarded')).toBe('auto_close_cart_discarded');
    expect(autoCloseCartEventType('kept')).toBeNull();
    expect(autoCloseCartDetails(cart, '23:30', 7)).toMatchObject({ action: 'held', label: AUTO_CLOSE_PARK_LABEL, total: '25.00', summary: `עגלה הושהתה (${AUTO_CLOSE_PARK_LABEL}) — 2 פריטים, 25 ₪`, shiftSequence: 7 });
    const held: HeldSaleSummary = { id: 'h2', at: 'x', cashierId: null, cashier: null, itemCount: 1, totalAgorot: 1_000, items: [], label: null };
    expect(autoCloseHeldCancelledDetails([held], '23:30')).toMatchObject({ count: 1, total: '10.00', summary: 'בוטלו 1 עסקאות מושהות בסגירה אוטומטית — 10 ₪' });
  });

  it("the next shift's notice is shown once, on the next shift only, and the report keeps its lines", () => {
    const record: AutoCloseRecord = {
      shiftId: 's1',
      at: '23:30',
      closedAt: 'x',
      cart: { action: 'held', items: [], itemCount: 3, amountAgorot: 8_700, heldSaleId: 'h1', cashierId: null, paymentAbandoned: true, keptReason: null },
      heldCancelled: 0,
      heldCancelledAgorot: 0,
      heldCarried: 2,
      tablesCarried: 0,
      overPayment: false,
      waitedMs: 0,
    };
    expect(worthNotice(record)).toBe(true);
    expect(autoCloseNextShiftNotice(record)).toBe('במשמרת הקודמת הושהתה עגלה בסגירה אוטומטית — 3 פריטים, 87 ₪. היא זמינה ב"החזר הזמנה".');
    expect(takeNotice(record, 's1')).toEqual({ notice: null, keep: true });
    expect(takeNotice(record, 's2').notice).toContain('הושהתה עגלה');
    expect(takeNotice(null, 's2')).toEqual({ notice: null, keep: false });
    expect(autoCloseReportLines(record)).toEqual([
      'נסגרה אוטומטית ב-23:30',
      `עגלה הושהתה (${AUTO_CLOSE_PARK_LABEL}) — 3 פריטים, 87 ₪`,
      'מסך התשלום בוטל (לא נגבה דבר)',
      '2 עסקאות מושהות עברו למשמרת הבאה',
    ]);
    expect(shiftAutoClosedDetails(record, rules({ cart: 'hold' }))).toMatchObject({ openCart: 'hold', heldSales: 'keep', maxWaitMin: 10, heldSalesCarried: 2 });
    expect(worthNotice({ ...record, cart: { ...record.cart!, action: 'kept' } })).toBe(false);
  });
});
