/**
 * The till's engine on the kiosk core (main/till/engine.ts) — a REAL KioskService behind it, a fake terminal and printer:
 * sign in, sell, cash with change, card (and its recovery), split, the document the cloud receives, the X, the shift, the Z.
 * Tests only: no real server, card terminal or Z.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { documentWire } from '../src/main/fiscal/ledger';
import { saleTotals, type SaleLine } from '../src/core/sale';
import { MANAGER_PIN, PIN, card, harness, readyTill, type Harness } from './tillEngineHarness';
import type { TillWorkMode } from '../src/main/till/engine';
import type { PrintDoc } from '../src/core/printDocs';

type Wire = Record<string, unknown> & { payments: Array<{ sequence: number; method: string; amount: number }>; amountTendered?: number };
const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});
const till = async (...args: Parameters<typeof readyTill>) => {
  const h = await readyTill(...args);
  open.push(h);
  return h;
};

/** The one completed document of the shift. */
const docsOf = (h: Harness) => h.svc.ledger.docsOfShift(h.svc.ledger.currentShift()!.id);
const receiptOf = (h: Harness, docId: string): PrintDoc | null => {
  const j = h.svc.printQueue.jobsFor(docId, 'receipt')[0];
  return j ? (JSON.parse(j.doc) as PrintDoc) : null;
};
const rows = (doc: PrintDoc | null) => (doc && doc.kind === 'receipt' ? doc.ops.filter((o): o is Extract<typeof o, { t: 'row' }> => o.t === 'row').map((o) => [o.label, o.value]) : []);

describe('staff: the PIN from the synced roster', () => {
  it('a wrong code is refused; the right one signs in as that employee, offline, bcrypt only', async () => {
    const h = harness();
    open.push(h);
    expect(h.state().session.locked).toBe(true);
    const bad = await h.fail('session.login', { pin: '0000' });
    expect(bad.code).toBe('wrong_pin');
    expect(bad.message).toBe('הקוד אינו מזוהה');
    const ok = await h.ok<{ cashier: { id: string; name: string } }>('session.login', { pin: PIN });
    expect(ok.cashier).toEqual({ id: 'u-cashier', name: 'דנה כהן' });
    expect(h.state().session).toMatchObject({ locked: false, cashier: { id: 'u-cashier', name: 'דנה כהן' }, demo: false });
    // The golden protocol's own spelling of the argument works too.
    await h.ok('session.logout');
    await h.ok('session.login', { code: MANAGER_PIN });
    expect(h.state().session.cashier?.name).toBe('אבי לוי');
  });

  it('five wrong codes lock the pad for a minute (kept across a restart)', async () => {
    const h = harness();
    open.push(h);
    for (let i = 0; i < 4; i++) expect((await h.fail('session.login', { pin: '1111' })).code).toBe('wrong_pin');
    const fifth = await h.fail('session.login', { pin: '1111' });
    expect(fifth.code).toBe('login_locked');
    // Even the right code waits.
    expect((await h.fail('session.login', { pin: PIN })).code).toBe('login_locked');
  });

  it('a user that is not in this shop, or inactive, or with a short code, never signs in', async () => {
    const h = harness();
    open.push(h);
    expect((await h.fail('session.login', { pin: '12' })).message).toBe('הקוד קצר מדי');
    const g = harness({ users: [{ id: 'x', username: 'x', firstName: 'א', lastName: null, pinHash: 'plaintext1234', role: 'cashier', isActive: true, shopId: null }] });
    open.push(g);
    expect((await g.fail('session.login', { pin: '1234' })).code).toBe('wrong_pin');
  });

  it('a locked till sells nothing', async () => {
    const h = harness();
    open.push(h);
    expect((await h.fail('sell.add', { productId: 'p-burger' })).message).toBe('יש להתחבר לקופה');
  });
});

describe('the catalog: the till channel', () => {
  it('shows what a till sells: not "קיוסק בלבד"; "קופות בלבד" is here', async () => {
    const h = await till();
    const cat = await h.ok<{ departments: Array<{ id: string }>; products: Array<{ id: string; priceAgorot: number }> }>('catalog.snapshot');
    expect(cat.products.map((p) => p.id).sort()).toEqual(['p-burger', 'p-cola', 'p-pos']);
    expect(cat.products.find((p) => p.id === 'p-cola')!.priceAgorot).toBe(1250);
    expect(cat.departments.map((d) => d.id)).toEqual(['c-main', 'c-drink']);
    // The scanner's codes ride along.
    expect(cat.products.find((p) => p.id === 'p-burger')).toMatchObject({ barcode: '7290000000011', sku: 'B1' });
  });
});

describe('selling', () => {
  it('the cart is priced by the kiosk engine: gross, VAT once per document, to the agora', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-cola', qty: 2 });
    await h.ok('sell.add', { productId: 'p-burger' });
    const s = h.state().sell;
    expect(s.lines.map((l) => [l.productId, l.qty, l.unitAgorot, l.totalAgorot])).toEqual([
      ['p-burger', 2, 4200, 8400],
      ['p-cola', 2, 1250, 2500],
    ]);
    const lines: SaleLine[] = [
      { key: 'a', productId: 'p-burger', name: '', sku: null, basePriceAgorot: 4200, options: [], notes: [], qty: 2 },
      { key: 'b', productId: 'p-cola', name: '', sku: null, basePriceAgorot: 1250, options: [], notes: [], qty: 2 },
    ];
    const t = saleTotals(lines, 0.18);
    expect(s.totalAgorot).toBe(t.totalAgorot);
    expect(s.totalAgorot).toBe(10_900);
    expect(s.vatAgorot).toBe(t.vatAgorot);
    expect(s.itemCount).toBe(4);
  });

  it('quantities and line removal; clearing', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    const id = h.state().sell.lines[0].lineId;
    await h.ok('sell.setQty', { lineId: id, qty: 3 });
    expect(h.state().sell.lines[0].qty).toBe(3);
    await h.ok('sell.setQty', { lineId: id, qty: 1 });
    expect(h.state().sell.lines[0].qty).toBe(1);
    await h.ok('sell.remove', { lineId: id });
    expect(h.state().sell.lines).toEqual([]);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('sell.clear');
    expect(h.state().sell.lines).toEqual([]);
  });

  it('a manual discount is "בקרוב"; an unknown product is refused', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-cola' });
    const e = await h.fail('sell.discount', { lineId: h.state().sell.lines[0].lineId, pct: 10 });
    expect(e).toMatchObject({ code: 'coming_soon', message: 'הנחה ידנית — בקרוב' });
    expect((await h.fail('sell.add', { productId: 'nope' })).code).toBe('invalid_args');
  });

  it('an op sent twice (a reconnect) is the same op: never applied twice', async () => {
    const h = await till();
    const call = { id: 900, op: 'sell.add' as const, args: { productId: 'p-cola' }, clientOpId: 'same-op' };
    await h.engine.call(call);
    await h.engine.call({ ...call, id: 901 });
    expect(h.state().sell.lines[0].qty).toBe(1);
  });

  it('every changing op needs its clientOpId', async () => {
    const h = await till();
    const r = await h.engine.call({ id: 1, op: 'sell.add', args: { productId: 'p-cola' } });
    expect(r.ok).toBe(false);
  });
});

describe('the shift', () => {
  it('no sale before a shift is open: "לא ניתן לגבות לפני פתיחת משמרת"', async () => {
    const h = harness();
    open.push(h);
    await h.ok('session.login', { pin: PIN });
    await h.ok('sell.add', { productId: 'p-cola' });
    expect((await h.fail('checkout.start')).message).toBe('לא ניתן לגבות לפני פתיחת משמרת.');
  });

  it('opens as the employee with the float counted into the drawer', async () => {
    const h = harness();
    open.push(h);
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 25_000 });
    const s = h.svc.ledger.currentShift()!;
    expect(s).toMatchObject({ opening_cash: 25_000, opened_by_id: 'u-cashier', opened_by_name: 'דנה כהן', status: 'open' });
    expect(h.state().shift).toMatchObject({ open: true, openingCashAgorot: 25_000, number: s.sequence_number });
    expect((await h.fail('shift.open', { openingCashAgorot: 0 })).code).toBe('shift_open');
    // The open reaches the cloud through the outbox (shift_open).
    expect(h.svc.outbox.all().some((r) => r.kind === 'shift_open')).toBe(true);
  });
});

describe('cash: exact, with change, and the document', () => {
  it('"מזומן מהיר": the exact amount — a 320 with one cash leg, the cashier on it, no change', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(h.state().checkout).toMatchObject({ phase: 'tender', totalAgorot: 5450, dueAgorot: 5450 });
    await h.ok('checkout.cash', { amountAgorot: 5450 });
    const c = h.state().checkout;
    expect(c).toMatchObject({ phase: 'done', changeAgorot: 0, paidAgorot: 5450 });
    expect(h.state().sell.lines).toEqual([]);
    const [d] = docsOf(h);
    expect(d).toMatchObject({ documentType: 320, status: 'completed', cashierId: 'u-cashier', cashierName: 'דנה כהן', channel: 'till', payments: [{ method: 'cash', amountAgorot: 5450 }], tenderedAgorot: 5450, changeAgorot: 0 });
    expect(c.documentRef).toBe(`2${String(d.number).padStart(7, '0')}`);
    const w = documentWire(d) as Wire;
    expect(w).toMatchObject({ documentType: 320, status: 'completed', paymentMethod: 'cash', amountTendered: 54.5, changeAmount: 0, totalAmount: 54.5, cashierId: 'u-cashier', vatRate: 0.18, netAmount: 46.19, vatAmount: 8.31 });
    expect(w.payments).toHaveLength(1);
    expect(w.payments[0]).toMatchObject({ sequence: 1, method: 'cash', amount: 54.5 });
    // It goes to the cloud the way the kiosk's documents do: one outbox row.
    expect(h.svc.outbox.all().filter((r) => r.kind === 'transaction')).toHaveLength(1);
  });

  it('cash with change: the leg is the goods, the note and the change are on the document', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 10_000 });
    expect(h.state().checkout).toMatchObject({ phase: 'done', changeAgorot: 5800 });
    const [d] = docsOf(h);
    expect(d.payments).toEqual([{ method: 'cash', amountAgorot: 4200 }]);
    expect(d).toMatchObject({ tenderedAgorot: 10_000, changeAgorot: 5800 });
    const w = documentWire(d) as Wire;
    expect(w).toMatchObject({ amountTendered: 100, changeAmount: 58, totalAmount: 42 });
    expect(w.payments[0].amount).toBe(42);
  });

  it('the receipt: "מזומן" with the note handed over, then "עודף"; the cash leg on the X', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 10_000 });
    const [d] = docsOf(h);
    const r = rows(receiptOf(h, d.id));
    expect(r).toContainEqual(['מזומן', '100.00']);
    expect(r).toContainEqual(['עודף', '58.00']);
    expect(r).toContainEqual(['מלצר/ית', 'דנה כהן']);
    // The X reads the cash leg: expected cash = the float + the goods in cash.
    const x = await h.ok<{ cashAgorot: number; cardAgorot: number; expectedCashAgorot: number; openingCashAgorot: number; vatAgorot: number }>('report.x');
    expect(x).toMatchObject({ cashAgorot: 4200, cardAgorot: 0, openingCashAgorot: 20_000, expectedCashAgorot: 24_200, vatAgorot: 641 });
  });

  it('less than due is a partial cash leg; the rest is taken, the note and the change at the end', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1000 });
    expect(h.state().checkout).toMatchObject({ phase: 'tender', paidAgorot: 1000, dueAgorot: 3200 });
    expect(docsOf(h)).toHaveLength(0);
    await h.ok('checkout.cash', { amountAgorot: 5000 });
    expect(h.state().checkout).toMatchObject({ phase: 'done', changeAgorot: 1800 });
    const [d] = docsOf(h);
    expect(d.payments).toEqual([
      { method: 'cash', amountAgorot: 1000 },
      { method: 'cash', amountAgorot: 3200 },
    ]);
    expect(d).toMatchObject({ tenderedAgorot: 6000, changeAgorot: 1800 });
  });

  it('numbering is strictly sequential, one series per machine, never reused', async () => {
    const h = await till();
    const numbers: number[] = [];
    for (let i = 0; i < 3; i++) {
      await h.ok('sell.add', { productId: 'p-cola' });
      await h.ok('checkout.start');
      await h.ok('checkout.cash', { amountAgorot: 1250 });
      numbers.push(docsOf(h).at(-1)!.number);
      await h.ok('checkout.finish');
    }
    expect(numbers[1]).toBe(numbers[0] + 1);
    expect(numbers[2]).toBe(numbers[1] + 1);
    expect(h.svc.ledger.counters.last(320)).toBe(numbers[2]);
  });

  it('an exempt dealer issues 400s at 0% VAT', async () => {
    const h = await till({ dealerType: 'exempt' });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1250 });
    const [d] = docsOf(h);
    expect(d).toMatchObject({ documentType: 400 });
    expect(d.totals).toMatchObject({ vatRate: 0, vatAgorot: 0 });
  });

  it('cancelling with cash already taken asks to hand it back first; the cart and no document remain', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1000 });
    const r = await h.ok<{ dialogId: string }>('checkout.cancel');
    expect(h.state().dialog).toMatchObject({ kind: 'confirm', title: 'החזר מזומן ללקוח' });
    await h.ok('dialog.answer', { dialogId: r.dialogId, action: 'approve' });
    expect(h.state().checkout.phase).toBe('idle');
    expect(docsOf(h)).toHaveLength(0);
    expect(h.state().sell.lines).toHaveLength(1);
  });
});

describe('the drawer and the receipt', () => {
  it('a cash sale kicks the drawer when the till parameter says so and the user may; a card sale does not', async () => {
    const on = await till({ parameters: { cashDrawer: 'כן' } }, PIN);
    // The cashier's legacy role does not hold the drawer-on-sale right: no kick.
    await on.ok('sell.add', { productId: 'p-cola' });
    await on.ok('checkout.start');
    await on.ok('checkout.cash', { amountAgorot: 1250 });
    await new Promise((r) => setTimeout(r, 30));
    const kicked = (h: Harness) => h.printer.sent.filter((b) => b.length === 5 && b[0] === 0x1b && b[1] === 0x70).length;
    // (the cashier's `CASH_DRAWER.OPEN_ON_CASH_SALE` is `allow` by default in the legacy table)
    expect(kicked(on)).toBe(1);
    const off = await till({ parameters: {} });
    await off.ok('sell.add', { productId: 'p-cola' });
    await off.ok('checkout.start');
    await off.ok('checkout.cash', { amountAgorot: 1250 });
    await new Promise((r) => setTimeout(r, 30));
    expect(kicked(off)).toBe(0);
  });

  it('"שאל לפני הדפסה": the receipt waits for the answer; "דוחות בלבד" prints no receipt', async () => {
    const ask = await till({ parameters: { askBeforePrint: 'true' } });
    await ask.ok('sell.add', { productId: 'p-cola' });
    await ask.ok('checkout.start');
    await ask.ok('checkout.cash', { amountAgorot: 1250 });
    expect(ask.state().checkout.askPrint).toBe(true);
    const id = docsOf(ask)[0].id;
    expect(receiptOf(ask, id)).toBeNull();
    await ask.ok('checkout.print', { print: true });
    expect(receiptOf(ask, id)).not.toBeNull();
    const none = await till({ parameters: { printMode: 'דוחות בלבד' } });
    await none.ok('sell.add', { productId: 'p-cola' });
    await none.ok('checkout.start');
    await none.ok('checkout.cash', { amountAgorot: 1250 });
    expect(receiptOf(none, docsOf(none)[0].id)).toBeNull();
  });

  it('the copy of the sale just done, on its own done screen, needs no code (the Android checkout\'s reprint)', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 2000 });
    const id = docsOf(h)[0].id;
    expect(h.state().checkout.documentId).toBe(id);
    await h.ok('doc.reprint', { documentId: id });
    expect(h.svc.printQueue.jobsFor(id, 'receipt')).toHaveLength(2);
    expect(h.state().dialog).toBeNull();
  });

  it('a copy from the history: "העתק", with the same numbers; it needs REPRINT (a cashier needs a manager)', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 2000 });
    const id = docsOf(h)[0].id;
    await h.ok('checkout.finish');
    const asked = await h.ok<{ dialogId: string }>('doc.reprint', { documentId: id });
    expect(h.state().dialog?.kind).toBe('manager_approval');
    await h.ok('dialog.answer', { dialogId: asked.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    const jobs = h.svc.printQueue.jobsFor(id, 'receipt');
    expect(jobs).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(jobs[1].doc))).toContain('העתק');
  });
});

describe('card', () => {
  it('charges the terminal for what is due; the document is pending BEFORE the frame, then completed with its card leg', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    let pendingWhenCharged: string | null = null;
    h.terminal.next = () => {
      pendingWhenCharged = h.svc.ledger.pendingDocs()[0]?.status ?? null;
      return { answer: 'APPROVED', card: card(), raw: '' };
    };
    await h.ok('checkout.card');
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingWhenCharged).toBe('pending');
    expect(h.terminal.sales[0].amountAgorot).toBe(4200);
    expect(h.state().checkout).toMatchObject({ phase: 'done', paidAgorot: 4200, changeAgorot: 0 });
    const [d] = docsOf(h);
    expect(d).toMatchObject({ status: 'completed', payments: [{ method: 'card', amountAgorot: 4200 }] });
    const w = documentWire(d) as Wire;
    expect(w).toMatchObject({ paymentMethod: 'card', cashierId: 'u-cashier' });
    expect(w.payments[0]).toMatchObject({ method: 'card', amount: 42, sequence: 1 });
    expect(w.amountTendered).toBeUndefined();
    const r = rows(receiptOf(h, d.id));
    expect(r).toContainEqual(['כרטיס אשראי', '42.00']);
  });

  it('declined: the document is voided (the number is burned), the tenders reopen; a retry is a new document', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    h.terminal.next = () => ({ answer: 'DECLINED', message: 'העסקה נדחתה', raw: null, statusCode: 5 });
    await h.ok('checkout.card');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.state().checkout).toMatchObject({ phase: 'tender', cardError: 'העסקה נדחתה', dueAgorot: 4200 });
    const first = docsOf(h)[0];
    expect(first).toMatchObject({ status: 'cancelled' });
    h.terminal.next = () => ({ answer: 'APPROVED', card: card(), raw: '' });
    await h.ok('checkout.card');
    await new Promise((r) => setTimeout(r, 50));
    const docs = docsOf(h);
    expect(docs.map((d) => d.status)).toEqual(['cancelled', 'completed']);
    expect(docs[1].number).toBe(first.number + 1);
    // Only final documents go out: the void and the completed one.
    expect(h.svc.outbox.all().filter((r) => r.kind === 'transaction')).toHaveLength(2);
  });

  it('cash first, the card for the rest: the card leg is last, the cash handed over is on the document', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1000 });
    await h.ok('checkout.card');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.terminal.sales[0].amountAgorot).toBe(3200);
    const [d] = docsOf(h);
    expect(d.payments).toEqual([
      { method: 'cash', amountAgorot: 1000 },
      { method: 'card', amountAgorot: 3200 },
    ]);
    expect(d).toMatchObject({ tenderedAgorot: 1000, changeAgorot: 0 });
    const w = documentWire(d) as Wire;
    expect(w.paymentMethod).toBe('card');
    expect(w.payments.map((p) => [p.sequence, p.method, p.amount])).toEqual([
      [1, 'cash', 10],
      [2, 'card', 32],
    ]);
    const r = rows(receiptOf(h, d.id));
    expect(r.map((x) => x[0]).filter((l) => l.startsWith('מזומן') || l.startsWith('כרטיס אשראי'))).toEqual(['מזומן', 'כרטיס אשראי ⁦**** 4580⁩']);
    // The X: cash and card both counted.
    const x = await h.ok<{ cashAgorot: number; cardAgorot: number }>('report.x');
    expect(x).toMatchObject({ cashAgorot: 1000, cardAgorot: 3200 });
  });

  it('an unknown answer blocks (never a second charge) until the terminal says; "בדוק שוב" completes the SAME document', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    h.terminal.next = () => ({ answer: 'UNKNOWN', message: 'אין תשובה', raw: null });
    h.terminal.resolveWith = () => ({ kind: 'unknown', message: 'עדיין לא ידוע' });
    await h.ok('checkout.card');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.state().checkout).toMatchObject({ cardUnknown: true });
    expect(h.svc.ledger.pendingDocs()).toHaveLength(1);
    // No tender while it is unknown.
    expect((await h.fail('checkout.cash', { amountAgorot: 4200 })).code).toBe('invalid_args');
    expect((await h.fail('checkout.card')).code).toBe('invalid_args');
    await h.ok('checkout.recheckCard');
    expect(h.state().checkout.cardUnknown).toBe(true);
    h.terminal.resolveWith = () => ({ kind: 'approved', card: card() });
    await h.ok('checkout.recheckCard');
    expect(h.state().checkout).toMatchObject({ phase: 'done' });
    expect(docsOf(h)).toHaveLength(1);
    expect(docsOf(h)[0].status).toBe('completed');
  });

  it('an unknown answer a manager marks "not approved": the document is voided and the tenders reopen', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    h.terminal.next = () => ({ answer: 'UNKNOWN', message: 'אין תשובה', raw: null });
    await h.ok('checkout.card');
    await new Promise((r) => setTimeout(r, 50));
    const asked = await h.ok<{ dialogId: string }>('checkout.markNotApproved');
    await h.ok('dialog.answer', { dialogId: asked.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(h.state().checkout).toMatchObject({ phase: 'tender', cardUnknown: false });
    expect(docsOf(h)[0].status).toBe('cancelled');
    expect(h.svc.pay.attempts()).toHaveLength(0);
  });

  it('no terminal set up: refused before anything is written', async () => {
    const h = await till();
    h.svc.pay.setProvider(null, null);
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    const e = await h.fail('checkout.card');
    expect(e.code).toBe('terminal_unavailable');
    expect(docsOf(h)).toHaveLength(0);
    expect(h.svc.ledger.counters.last(320)).toBe(0);
  });
});

describe('the close of the shift and the X', () => {
  it('closes with the counted cash: the X is frozen into the close, the difference is said, X is printed', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 4200 });
    await h.ok('checkout.finish');
    const shift = h.svc.ledger.currentShift()!;
    // A cashier's SHIFT_CLOSE is the legacy default (allow); counted 10 agorot short.
    const r = await h.ok<{ expectedCashAgorot: number; countedCashAgorot: number; differenceAgorot: number; shiftNumber: number }>('shift.close', { countedCashAgorot: 24_190 });
    expect(r).toMatchObject({ expectedCashAgorot: 24_200, countedCashAgorot: 24_190, differenceAgorot: -10, shiftNumber: shift.sequence_number });
    expect(h.svc.ledger.currentShift()).toBeNull();
    const closed = h.svc.ledger.lastClosedShift()!;
    const payload = JSON.parse(closed.close_payload!);
    expect(payload).toMatchObject({ countedCash: 241.9, expectedCash: 242, closedByName: 'דנה כהן', closedByUserId: 'u-cashier', unattended: false });
    expect(payload.till).toMatchObject({ openingCash: 200, totalCash: 42, totalCard: 0, transactionsCount: 1 });
    expect(h.svc.outbox.all().some((x) => x.kind === 'shift_close')).toBe(true);
    expect(h.svc.printQueue.jobsFor(`x:${shift.id}`, 'z')).toHaveLength(1);
    expect(h.state().shift.open).toBe(false);
  });

  it('never with a cart or a payment open, and not with a card still pending', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-cola' });
    expect((await h.fail('shift.close', { countedCashAgorot: 20_000 })).code).toBe('checkout_busy');
  });

  it('the X is an interim paper: "דו״ח X ביניים", as of now', async () => {
    const h = await till();
    const x = await h.ok<{ printed: boolean }>('report.x');
    expect(x.printed).toBe(true);
    const job = h.svc.printQueue.jobsFor(h.svc.printQueue.jobsFor(`x:${h.svc.ledger.currentShift()!.id}`, 'z')[0]?.ref_id ?? '', 'z');
    void job;
    const jobs = (h.svc as unknown as { db: { all: (s: string) => Array<{ doc: string }> } }).db.all("SELECT doc FROM print_jobs WHERE kind = 'z'");
    const text = jobs.map((j) => j.doc).join('|');
    expect(text).toContain('דו״ח X ביניים');
    expect(text).toContain('נכון לשעה:');
  });
});

describe('the Z: only the machine\'s own, only in zMode = till', () => {
  it('in the shop\'s Z mode: no Z here — closing the shift is all this till does', async () => {
    const h = await till({ zMode: 'cloud' });
    expect(h.state().z).toMatchObject({ canProduce: false, zMode: 'shop' });
    const e = await h.fail('z.produce', { countedCashAgorot: 20_000 });
    expect(e.message).toBe('הקופה מוגדרת כך שדו״ח Z מופק בענן ולא בקופה. אין צורך להפיק כאן.');
    expect(h.svc.ledger.currentShift()).not.toBeNull();
    expect(h.sent.some((s) => s.path.endsWith('till-z'))).toBe(false);
  });

  it('in till mode: an open shift is closed first (counted, X), then the machine\'s Z through tillZ — the cloud numbers it', async () => {
    const h = await till({
      zMode: 'till',
      answers: {
        'POST sync/m/*': () => ({}),
        'POST sync/m/till-z': () => ({ zReport: { id: 'z-1', machineId: 'm', machineSequenceNumber: 7, machineSequenceEpoch: 0, closedAt: '2026-10-10T12:00:00Z', businessDate: '2026-10-10' }, shiftIds: [] }),
      },
    });
    const r = await h.ok<{ zNumber: number; message: string }>('z.produce', { countedCashAgorot: 20_000 });
    expect(r).toMatchObject({ zNumber: 7, message: 'דו״ח Z מס׳ 7 הופק' });
    expect(h.svc.ledger.currentShift()).toBeNull();
    expect(h.svc.tillZ.list(1)[0]).toMatchObject({ number: 7 });
    expect(h.sent.filter((s) => s.path === 'sync/m/till-z' || s.path === 'm/till-z' || s.path.endsWith('/till-z'))).toHaveLength(1);
  });
});

describe('an independent till (Z on the till): no shifts in its UI', () => {
  const zAnswers = {
    'POST sync/m/*': () => ({}),
    'POST sync/m/transactions': (b: Record<string, unknown> | null) => ({ results: ((b?.transactions as Array<{ id: string }>) ?? []).map((t) => ({ id: t.id, status: 'accepted' })) }),
    'POST sync/m/till-z': () => ({ zReport: { id: 'z-9', machineId: 'm', machineSequenceNumber: 3, machineSequenceEpoch: 0, closedAt: '2026-10-10T12:00:00Z', businessDate: '2026-10-10' }, shiftIds: [] }),
  };

  it('the shift opens silently on the first sale with a float of 0, as the employee; there is nothing to open or close', async () => {
    const h = harness({ zMode: 'till', independent: true, answers: zAnswers });
    open.push(h);
    await h.ok('session.login', { pin: PIN });
    expect(h.state().shift).toMatchObject({ hidden: true, open: false });
    expect(h.svc.ledger.currentShift()).toBeNull();
    // No shift screens: refused (and the screens do not show them).
    expect((await h.fail('shift.open', { openingCashAgorot: 0 })).code).toBe('permission_denied');
    expect((await h.fail('report.x')).code).toBe('permission_denied');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(h.svc.ledger.currentShift()).toBeNull();
    await h.ok('checkout.cash', { amountAgorot: 1250 });
    const shift = h.svc.ledger.currentShift()!;
    expect(shift).toMatchObject({ opening_cash: 0, opened_by_id: 'u-cashier', status: 'open' });
    expect(h.state().shift).toMatchObject({ hidden: true, open: true, salesCount: 1, cashAgorot: 1250 });
    await h.ok('checkout.finish');
    expect((await h.fail('shift.close', { countedCashAgorot: 1250 })).code).toBe('permission_denied');
  });

  it('"הפק Z": the cash is counted, the internal shift closes, the Z is the machine\'s, no X paper; the next sale opens a new shift', async () => {
    const h = harness({ zMode: 'till', independent: true, answers: zAnswers });
    open.push(h);
    await h.ok('session.login', { pin: PIN });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1250 });
    await h.ok('checkout.finish');
    const first = h.svc.ledger.currentShift()!;
    // The count is needed while a shift is open.
    expect((await h.fail('z.produce')).code).toBe('invalid_args');
    const r = await h.ok<{ zNumber: number; message: string }>('z.produce', { countedCashAgorot: 1250 });
    expect(r).toMatchObject({ zNumber: 3, message: 'דו״ח Z מס׳ 3 הופק' });
    expect(h.svc.ledger.currentShift()).toBeNull();
    expect(h.svc.ledger.shift(first.id)!.status).toBe('closed');
    expect(JSON.parse(h.svc.ledger.shift(first.id)!.close_payload!)).toMatchObject({ countedCash: 12.5, expectedCash: 12.5 });
    expect(h.svc.printQueue.jobsFor(`x:${first.id}`, 'z')).toHaveLength(0);
    // The next sale opens a new internal shift.
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1250 });
    const second = h.svc.ledger.currentShift()!;
    expect(second.id).not.toBe(first.id);
    expect(second.sequence_number).toBe(first.sequence_number + 1);
  });

  it('the shift screens come back when the till parameter says so, and on a shop-Z or own-Z till they never left', async () => {
    const off = harness({ zMode: 'till', independent: true, parameters: { independentTillZOnly: 'false' } });
    open.push(off);
    await off.ok('session.login', { pin: PIN });
    expect(off.state().shift.hidden).toBe(false);
    await off.ok('shift.open', { openingCashAgorot: 5000 });
    const shop = harness({ zMode: 'cloud', independent: true });
    open.push(shop);
    await shop.ok('session.login', { pin: PIN });
    expect(shop.state().shift.hidden).toBe(false);
    expect((await shop.fail('checkout.start')).code).toBe('cart_empty');
    await shop.ok('sell.add', { productId: 'p-cola' });
    expect((await shop.fail('checkout.start')).message).toBe('לא ניתן לגבות לפני פתיחת משמרת.');
    const own = harness({ zMode: 'till', independent: false });
    open.push(own);
    await own.ok('session.login', { pin: PIN });
    expect(own.state().shift.hidden).toBe(false);
  });
});

describe('the kiosk <-> till switch from the till (mode.switch)', () => {
  type Facts = ReturnType<Parameters<TillWorkMode['setTillFacts']>[0]>;
  function fakeMode(over: Partial<TillWorkMode> = {}) {
    const calls: Array<{ source: string; by: string | null | undefined; byId: string | null | undefined }> = [];
    let provider: (() => Facts) | null = null;
    const wm: TillWorkMode = {
      mode: () => 'till',
      homeTill: () => false,
      offered: () => ({ toTill: false, toKiosk: true }),
      mayReturn: () => null,
      countdownSec: () => null,
      checkManagerCode: async (code) => (code === MANAGER_PIN ? { ok: true, id: 'u-manager', name: 'אבי לוי' } : { ok: false, reason: 'wrong', message: 'קוד מנהל שגוי' }),
      returnToKiosk: async (source, by, byId) => {
        calls.push({ source, by, byId });
        return null;
      },
      setTillFacts: (fn) => {
        provider = fn;
      },
      onChange: () => () => undefined,
      ...over,
    };
    return { wm, calls, facts: () => provider!() };
  }

  it('the till says what it holds (the basket, the payment, the employee, the last touch) to the runtime', async () => {
    const m = fakeMode();
    const h = await till({ workMode: m.wm });
    expect(m.facts()).toMatchObject({ basketOpen: false, checkoutOpen: false, holdsTender: false, cardInFlight: false, heldSales: 0, employee: { id: 'u-cashier', name: 'דנה כהן' } });
    await h.ok('sell.add', { productId: 'p-cola' });
    expect(m.facts().basketOpen).toBe(true);
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 500 });
    expect(m.facts()).toMatchObject({ checkoutOpen: true, holdsTender: true });
    const before = m.facts().lastActivityAtMs!;
    await new Promise((r) => setTimeout(r, 5));
    await h.ok('session.activity');
    expect(m.facts().lastActivityAtMs!).toBeGreaterThan(before);
  });

  it('what the screens show: the switch exists only when allowed, with the Android words', async () => {
    const h = await till();
    expect(h.state().mode.rolesAllowed).toEqual([]);
    const m = fakeMode();
    const g = await till({ workMode: m.wm });
    expect(g.state().mode).toMatchObject({ role: 'kiosk', current: 'till', rolesAllowed: ['kiosk'], switchLabel: 'חזרה למצב קיוסק' });
    const home = fakeMode({ homeTill: () => true });
    const t = await till({ workMode: home.wm });
    expect(t.state().mode).toMatchObject({ role: 'till', switchLabel: 'מעבר לקיוסק' });
  });

  it('always a manager\'s code: the cashier is asked; a wrong code keeps asking; the manager\'s switches and the session ends', async () => {
    const m = fakeMode();
    const h = await till({ workMode: m.wm });
    const asked = await h.ok<{ dialogId: string }>('mode.switch', { to: 'kiosk' });
    expect(h.state().dialog).toMatchObject({ kind: 'manager_approval', title: 'חזרה למצב קיוסק' });
    expect((await h.fail('dialog.answer', { dialogId: asked.dialogId, action: 'approve', answers: { pin: '0000' } })).message).toBe('קוד מנהל שגוי');
    expect(m.calls).toHaveLength(0);
    await h.ok('dialog.answer', { dialogId: asked.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(m.calls).toEqual([{ source: 'manual', by: 'אבי לוי', byId: 'u-manager' }]);
    expect(h.state().session.locked).toBe(true);
  });

  it('a manager signed in (KIOSK_TILL_MODE) needs no second code', async () => {
    const m = fakeMode();
    const h = await till({ workMode: m.wm }, MANAGER_PIN);
    await h.ok('mode.switch', { to: 'kiosk' });
    expect(h.state().dialog).toBeNull();
    expect(m.calls).toEqual([{ source: 'manual', by: 'אבי לוי', byId: 'u-manager' }]);
  });

  it('never mid-order or mid-payment: the refusal comes from the runtime, with its reason', async () => {
    const m = fakeMode({ mayReturn: () => ({ wire: 'basket_open', text: 'יש מכירה פתוחה — סיימו או השהו אותה' }) });
    const h = await till({ workMode: m.wm }, MANAGER_PIN);
    const e = await h.fail('mode.switch', { to: 'kiosk' });
    expect(e).toMatchObject({ code: 'mode_switch_busy', message: 'יש מכירה פתוחה — סיימו או השהו אותה', details: { reason: 'basket_open' } });
    expect(m.calls).toHaveLength(0);
  });

  it('where the owner never allowed it there is no switch at all', async () => {
    const h = await till({ workMode: fakeMode({ offered: () => ({ toTill: false, toKiosk: false }) }).wm }, MANAGER_PIN);
    expect((await h.fail('mode.switch', { to: 'kiosk' })).code).toBe('role_not_allowed');
  });
});
