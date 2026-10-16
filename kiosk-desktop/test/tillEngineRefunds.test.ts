/**
 * The Windows till's refunds, discounts, OTH, held sales, the automatic close and "כשאין הרשאה" — over a REAL KioskService
 * (tillEngineHarness: a fake cloud, terminal and printer), mirroring the Android till's tests of each flow: the history
 * refund (DetailViewModel: CardRefundGateTest, RefundGateOrderTest, DetailRefundApproverLimitTest), the mixed basket
 * (MixedBasketTest, CardRefundXReportTest), discounts and OTH (OwnerDecisions1410Test, OthClubTest), held sales
 * (HeldSalesAtCloseTest), the automatic close (AutoCloseOpenCartTest) and DeniedActionsTest's gates. No real refund, no
 * real sale, no real Z: the terminal is a fake one, the cloud a fake one.
 */

import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { documentWire, shiftCloseWire, type DocDraft } from '../src/main/fiscal/ledger';
import { MANAGER_PIN, PIN, card, harness, readyTill, roster, type Harness, type HarnessOptions } from './tillEngineHarness';
import type { DocumentDetail } from '../src/shared/till/protocol';
import type { PrintDoc } from '../src/core/printDocs';

type Wire = Record<string, unknown> & { items: Array<Record<string, unknown>>; payments: Array<{ sequence: number; method: string; amount: number; nayaxMeta?: Record<string, string> }> };

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});
const till = async (o: HarnessOptions = {}, pin = PIN, openingAgorot = 20_000) => {
  const h = await readyTill(o, pin, openingAgorot);
  open.push(h);
  return h;
};
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const allDocs = (h: Harness): DocDraft[] => h.svc.ledger.docsOfShift(h.svc.ledger.currentShift()!.id);
const wireOf = (d: DocDraft) => documentWire(d) as Wire;
const events = (h: Harness, type?: string) =>
  h.svc.outbox
    .all()
    .filter((r) => r.kind === 'till_event')
    .map((r) => h.svc.kv.getJson<{ type: string; details: Record<string, unknown>; posUserId: string | null; amount?: number }>(`tillEvent:${r.ref_id}`)!)
    .filter((e) => !type || e.type === type);
const receipt = (h: Harness, docId: string): PrintDoc | null => {
  const j = h.svc.printQueue.jobsFor(docId, 'receipt')[0];
  return j ? (JSON.parse(j.doc) as PrintDoc) : null;
};
const rowsOf = (doc: PrintDoc | null) => (doc && doc.kind === 'receipt' ? doc.ops.filter((o): o is Extract<typeof o, { t: 'row' }> => o.t === 'row').map((o) => [o.label, o.value]) : []);
const textsOf = (doc: PrintDoc | null) => (doc && doc.kind === 'receipt' ? doc.ops.filter((o): o is Extract<typeof o, { t: 'text' }> => o.t === 'text').map((o) => o.text) : []);

/** Answer the engine's open dialog with a code. */
async function approveWith(h: Harness, pin: string) {
  const d = h.state().dialog;
  if (!d) throw new Error('no dialog');
  return h.call('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin } });
}

/** A cash sale of the basket (the exact amount), its document. */
async function cashSale(h: Harness, lines: Array<[string, number]>): Promise<DocDraft> {
  for (const [productId, qty] of lines) await h.ok('sell.add', { productId, qty });
  await h.ok('checkout.start');
  await h.ok('checkout.cash', { amountAgorot: h.state().checkout.dueAgorot });
  await h.ok('checkout.finish');
  return allDocs(h).filter((d) => d.documentType === 320 || d.documentType === 400).at(-1)!;
}

/** A card sale with the acquirer's id on its meta. */
async function cardSale(h: Harness, productId: string, acquirer: string | null = 'acq-1'): Promise<DocDraft> {
  h.terminal.next = () => ({ answer: 'APPROVED', card: card({ meta: acquirer ? { vuid: 'v', result: { transactionId: acquirer } } : { vuid: 'v' } }), raw: '' });
  await h.ok('sell.add', { productId });
  await h.ok('checkout.start');
  await h.ok('checkout.card');
  await wait();
  await h.ok('checkout.finish');
  return allDocs(h).filter((d) => d.documentType === 320).at(-1)!;
}

/** Users of the spec's roles with the cloud's permissions and limits (the roster's shape). */
function cloudUser(id: string, pin: string, permissions: Record<string, string>, limits: Record<string, Record<string, number>> | null = null, extra: Record<string, unknown> = {}) {
  return { id, username: id, firstName: id, lastName: null, pinHash: bcrypt.hashSync(pin, 4), role: 'cashier', isActive: true, shopId: null, permissions, limits, tillRoleKey: id, ...extra };
}

describe('"זיכוי" from the history (DetailViewModel)', () => {
  it('a cash credit note: 330 in its own series, linked line by line, the original part-credited then credited, the X', async () => {
    const h = await till({}, MANAGER_PIN);
    const sale = await cashSale(h, [
      ['p-burger', 2],
      ['p-cola', 1],
    ]);
    expect(sale).toMatchObject({ documentType: 320, number: 1 });
    const detail = await h.ok<DocumentDetail>('doc.detail', { documentId: sale.id });
    expect(detail.lines.map((l) => [l.name, l.remainingQty])).toEqual([
      ['המבורגר', 2],
      ['קולה', 1],
    ]);
    expect(detail).toMatchObject({ refundMethod: 'cash', anythingRefundable: true, refundAllAgorot: 9_650, isRefundDocument: false });
    const burgerItem = detail.lines[0].itemId;
    expect((await h.ok<DocumentDetail>('doc.detail', { documentId: sale.id, quantities: { [burgerItem]: 1 } })).selectedAgorot).toBe(4_200);

    const r = await h.ok<{ ref: string }>('doc.refund', { documentId: sale.id, quantities: { [burgerItem]: 1, [detail.lines[1].itemId]: 0 } });
    expect(r.ref).toBe('20000001');
    const credit = allDocs(h).find((d) => d.documentType === 330)!;
    expect(credit).toMatchObject({ status: 'completed', number: 1, refundOfTransactionId: sale.id, approvedByPosUserId: 'u-manager', payments: [{ method: 'cash', amountAgorot: 4_200 }], tenderedAgorot: 4_200, changeAgorot: 0 });
    expect(h.svc.ledger.doc(sale.id)!.status).toBe('partial_refund');
    const w = wireOf(credit);
    expect(w).toMatchObject({ documentType: 330, refundOfTransactionId: sale.id, totalAmount: 42, paymentMethod: 'cash', approvedByPosUserId: 'u-manager', status: 'completed' });
    expect(w.items[0]).toMatchObject({ refundOfItemId: burgerItem, quantity: 1, unitPrice: 42, totalPrice: 42 });
    expect(w.payments).toMatchObject([{ method: 'cash', amount: 42 }]);
    // The paper: "חשבונית זיכוי", what it credits, the sum.
    const paper = receipt(h, credit.id);
    expect(textsOf(paper)).toContain('חשבונית זיכוי');
    expect(textsOf(paper)).toContain('זיכוי עבור מסמך #20000001');
    expect(rowsOf(paper)).toContainEqual(['סכום זיכוי', '42.00']);

    // The rest of the document, then nothing is left.
    await h.ok('doc.refund', { documentId: sale.id });
    expect(h.svc.ledger.doc(sale.id)!.status).toBe('refunded');
    const credits = allDocs(h).filter((d) => d.documentType === 330);
    expect(credits.map((c) => [c.number, c.totals.totalAgorot])).toEqual([
      [1, 4_200],
      [2, 5_450],
    ]);
    // Nothing left to pick: the screen says "כל הפריטים במסמך זוכו" (DetailScreen); a call that still arrives selects nothing.
    expect((await h.fail('doc.refund', { documentId: sale.id })).message).toBe('בחר לפחות פריט אחד לזיכוי');
    expect((await h.ok<DocumentDetail>('doc.detail', { documentId: sale.id })).anythingRefundable).toBe(false);

    // The X: the sale gross, the refunds, the cash out of the drawer.
    const x = await h.ok<{ salesAgorot: number; refundsAgorot: number; cashAgorot: number; expectedCashAgorot: number }>('report.x');
    expect(x).toMatchObject({ refundsAgorot: 9_650, cashAgorot: 0, expectedCashAgorot: 20_000, salesAgorot: 0 });
    // The next sale is 320 #2: the series never mix.
    const next = await cashSale(h, [['p-cola', 1]]);
    expect(next.number).toBe(2);
  });

  it('a legacy cashier asks a manager (REFUND, at the credited sum); a credit note of a credit note is refused', async () => {
    const h = await till();
    const sale = await cashSale(h, [['p-cola', 2]]);
    const r = await h.ok<{ dialogId: string }>('doc.refund', { documentId: sale.id });
    expect(r.dialogId).toBeTruthy();
    expect(h.state().dialog?.body).toBe('זיכוי / החזר — דורש אישור מנהל');
    expect(allDocs(h).filter((d) => d.documentType === 330)).toHaveLength(0);
    // The cashier's own code is not a manager's.
    expect((await approveWith(h, PIN)).ok).toBe(false);
    const ok = await approveWith(h, MANAGER_PIN);
    expect(ok.ok).toBe(true);
    const credit = allDocs(h).find((d) => d.documentType === 330)!;
    expect(credit).toMatchObject({ cashierId: 'u-cashier', approvedByPosUserId: 'u-manager' });
    expect((await h.fail('doc.refund', { documentId: credit.id })).code).toBe('refund_refused');
  });

  it('only an approver whose own refund limit covers the credit may give it (DetailRefundApproverLimitTest)', async () => {
    const users = [
      ...roster(),
      cloudUser('sup', '5555', { REFUND: 'allow', SELL: 'allow', SHIFT_OPEN: 'allow' }, { REFUND: { maxAmount: 50 } }),
    ];
    const h = await till({ users });
    const sale = await cashSale(h, [['p-burger', 2]]);
    await h.ok('doc.refund', { documentId: sale.id });
    const over = await approveWith(h, '5555');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.message).toBe('המגבלה של המאשר/ת לא מכסה את הסכום או האחוז הזה');
    expect((await approveWith(h, MANAGER_PIN)).ok).toBe(true);
    // A supervisor signed in alone: within the limit alone, above it a manager.
    const g = await till({ users }, '5555');
    const s2 = await cashSale(g, [['p-burger', 2]]);
    const items = (await g.ok<DocumentDetail>('doc.detail', { documentId: s2.id })).lines;
    await g.ok('doc.refund', { documentId: s2.id, quantities: { [items[0].itemId]: 1 } });
    expect(g.state().dialog).toBeNull();
    const r = await g.ok<{ dialogId?: string }>('doc.refund', { documentId: s2.id, quantities: { [items[0].itemId]: 1 } });
    expect(r.dialogId).toBeUndefined();
    const big = await cashSale(g, [['p-burger', 2]]);
    const bigItems = (await g.ok<DocumentDetail>('doc.detail', { documentId: big.id })).lines;
    const asked = await g.ok<{ dialogId?: string }>('doc.refund', { documentId: big.id, quantities: { [bigItems[0].itemId]: 2 } });
    expect(asked.dialogId).toBeTruthy();
    expect(g.state().dialog?.body).toBe('זיכוי / החזר — מעל המותר לך, דורש אישור מנהל');
  });

  it('no shift: refused before anything is asked or written', async () => {
    const h = await till({}, MANAGER_PIN);
    const sale = await cashSale(h, [['p-cola', 1]]);
    await h.ok('shift.close', { countedCashAgorot: 21_250 });
    const e = await h.fail('doc.refund', { documentId: sale.id });
    expect(e).toMatchObject({ code: 'shift_not_open', message: 'לא ניתן לבצע זיכוי לפני פתיחת משמרת.' });
  });

  it('a card credit is written pending BEFORE the terminal is asked, linked by the acquirer id; approved completes it (CardRefundGateTest)', async () => {
    const h = await till({}, MANAGER_PIN);
    const sale = await cardSale(h, 'p-burger');
    let statusWhenAsked: string | null = null;
    h.terminal.refundNext = () => {
      statusWhenAsked = allDocs(h).find((d) => d.documentType === 330)?.status ?? null;
      return { answer: 'APPROVED', card: card({ meta: { vuid: 'r', refundOfTransactionId: sale.id } }), raw: '' };
    };
    const detail = await h.ok<DocumentDetail>('doc.detail', { documentId: sale.id });
    expect(detail.refundMethod).toBe('card');
    const r = await h.ok<{ pending?: boolean }>('doc.refund', { documentId: sale.id });
    expect(r.pending).toBe(true);
    await wait();
    expect(statusWhenAsked).toBe('pending');
    expect(h.terminal.refunds[0]).toMatchObject({ amountAgorot: 4_200, originalTransactionId: 'acq-1' });
    const credit = allDocs(h).find((d) => d.documentType === 330)!;
    expect(credit).toMatchObject({ status: 'completed', payments: [{ method: 'card', amountAgorot: 4_200 }] });
    expect(wireOf(credit).payments[0]).toMatchObject({ method: 'card', amount: 42 });
    expect(h.svc.ledger.doc(sale.id)!.status).toBe('refunded');
    // A card refund's tender takes it off the card takings, not the drawer (CardRefundXReportTest).
    const x = await h.ok<{ cardAgorot: number; cashAgorot: number; expectedCashAgorot: number }>('report.x');
    expect(x).toMatchObject({ cardAgorot: 0, cashAgorot: 0, expectedCashAgorot: 20_000 });
  });

  it('a declined card refund voids its pending credit note and completes nothing; the number stays burned', async () => {
    const h = await till({}, MANAGER_PIN);
    const sale = await cardSale(h, 'p-burger');
    h.terminal.refundNext = () => ({ answer: 'DECLINED', message: 'סירוב', raw: null, statusCode: 6 });
    await h.ok('doc.refund', { documentId: sale.id });
    await wait();
    const credit = allDocs(h).find((d) => d.documentType === 330)!;
    expect(credit.status).toBe('cancelled');
    expect(h.svc.ledger.doc(sale.id)!.status).toBe('completed');
    expect((await h.ok<DocumentDetail>('doc.detail', { documentId: sale.id })).anythingRefundable).toBe(true);
    // A lost answer is not an approval here either (runCardRefund): voided, never completed.
    h.terminal.refundNext = () => ({ answer: 'UNKNOWN', message: 'אין תשובה', raw: null });
    await h.ok('doc.refund', { documentId: sale.id });
    await wait();
    expect(allDocs(h).filter((d) => d.documentType === 330).map((d) => [d.number, d.status])).toEqual([
      [1, 'cancelled'],
      [2, 'cancelled'],
    ]);
  });

  it('a card refund with no reference is refused before any approval is spent (RefundGateOrderTest)', async () => {
    const h = await till();
    const sale = await cardSale(h, 'p-burger', null);
    const e = await h.fail('doc.refund', { documentId: sale.id });
    expect(e.message).toBe('לא נמצאה הפניה לעסקה המקורית במכשיר. לא ניתן לבצע זיכוי מקושר.');
    expect(h.state().dialog).toBeNull();
    expect(h.terminal.refunds).toHaveLength(0);
  });

  it('"ללא אשראי": a card sale is credited in cash', async () => {
    const h = await till({}, MANAGER_PIN);
    const sale = await cardSale(h, 'p-cola');
    h.svc.pay.setProvider(null, 'none');
    expect((await h.ok<DocumentDetail>('doc.detail', { documentId: sale.id })).refundMethod).toBe('cash');
    await h.ok('doc.refund', { documentId: sale.id });
    expect(allDocs(h).find((d) => d.documentType === 330)).toMatchObject({ status: 'completed', payments: [{ method: 'cash', amountAgorot: 1_250 }] });
    expect(h.terminal.refunds).toHaveLength(0);
  });

  it('an exempt dealer credits on a receipt refund (−400) with no VAT, in the 400 series', async () => {
    const h = await till({ dealerType: 'exempt' }, MANAGER_PIN);
    const sale = await cashSale(h, [['p-cola', 1]]);
    expect(sale.documentType).toBe(400);
    await h.ok('doc.refund', { documentId: sale.id });
    const credit = allDocs(h).find((d) => d.documentType === -400)!;
    expect(credit).toMatchObject({ number: 2, totals: { vatAgorot: 0, totalAgorot: 1_250 } });
    expect(wireOf(credit)).toMatchObject({ documentType: -400, vatAmount: 0 });
  });
});

describe('"זיכוי" on the sell screen: the mixed basket (MixedBasketTest)', () => {
  it('a catalog return in a basket that nets positive: a 320 and an unlinked 330, cash for the net, exchange for the rest', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('refund.button');
    expect(h.state().sell.refundChooser).toBe(true);
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('refund.end');
    await h.ok('sell.add', { productId: 'p-burger' });
    const s = h.state().sell;
    expect(s.lines.map((l) => [l.productId, l.refund === true, l.totalAgorot])).toEqual([
      ['p-cola', true, 1_250],
      ['p-burger', false, 4_200],
    ]);
    expect(s).toMatchObject({ saleTotalAgorot: 4_200, refundTotalAgorot: 1_250, totalAgorot: 2_950 });
    await h.ok('checkout.start');
    expect(h.state().checkout.basket).toMatchObject({ step: 'return_customer', netAgorot: 2_950, hasUnlinked: true, customer: { required: true } });
    // A return with no receipt needs its customer.
    expect((await h.fail('checkout.returnCustomer', { name: 'אבי כהן' })).message).toBe('חובה בזיכוי ללא קבלה: שם, וטלפון או כתובת.');
    await h.ok('checkout.returnCustomer', { name: 'אבי כהן', phone: '050-1234567' });
    expect(h.state().checkout.basket?.step).toBe('tender');
    await h.ok('checkout.cash', { amountAgorot: 3_000 });
    expect(h.state().checkout).toMatchObject({ phase: 'done', changeAgorot: 50 });
    const docs = allDocs(h);
    const sale = docs.find((d) => d.documentType === 320)!;
    const credit = docs.find((d) => d.documentType === 330)!;
    expect(sale.basketId).toBeTruthy();
    expect(credit.basketId).toBe(sale.basketId);
    expect(sale.payments).toEqual([
      { method: 'cash', amountAgorot: 2_950 },
      { method: 'exchange', amountAgorot: 1_250 },
    ]);
    expect(credit.payments).toEqual([{ method: 'exchange', amountAgorot: 1_250 }]);
    expect(credit).toMatchObject({ refundOfTransactionId: null, customer: { name: 'אבי כהן', phone: '050-1234567', address: null } });
    const w = wireOf(sale);
    expect(w).toMatchObject({ paymentMethod: 'cash', basketId: sale.basketId, amountTendered: 30, changeAmount: 0.5 });
    expect(w.payments.map((p) => [p.sequence, p.method, p.amount])).toEqual([
      [1, 'cash', 29.5],
      [2, 'exchange', 12.5],
    ]);
    const cw = wireOf(credit);
    expect(cw).toMatchObject({ paymentMethod: 'exchange', customerName: 'אבי כהן', customerPhone: '050-1234567', totalAmount: 12.5 });
    expect(cw.items[0].refundOfItemId).toBeUndefined();
    // The X: exchange on its own row, never cash or the drawer; net takings are exactly the money that moved.
    const x = await h.ok<{ cashAgorot: number; expectedCashAgorot: number; refundsAgorot: number; salesAgorot: number }>('report.x');
    expect(x).toMatchObject({ cashAgorot: 2_950, expectedCashAgorot: 22_950, refundsAgorot: 1_250, salesAgorot: 2_950 });
    const close = shiftCloseWire(h.svc.ledger.currentShift()!, allDocs(h), { closedByName: 'x', vatRate: 0.18, now: new Date().toISOString() }) as { till: Record<string, number> };
    expect(close.till).toMatchObject({ totalExchange: 0, exchangeReceived: 12.5 });
    // The paper: each document, the credit note followed by the shop's copy to sign.
    expect(rowsOf(receipt(h, sale.id))).toContainEqual(['קיזוז החלפה', '12.50']);
    expect(h.svc.printQueue.jobsFor(`${credit.id}:merchant`, 'receipt')).toHaveLength(1);
  });

  it('an even exchange: everything settled in exchange, no money moves', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('refund.button');
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('refund.end');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.returnCustomer', { name: 'דנה', address: 'הרצל 1' });
    expect(h.state().checkout.basket?.step).toBe('exchange');
    expect((await h.fail('checkout.cash', { amountAgorot: 100 })).code).toBe('invalid_args');
    await h.ok('checkout.exchange');
    const docs = allDocs(h);
    expect(docs.flatMap((d) => d.payments ?? []).every((l) => l.method === 'exchange')).toBe(true);
    expect(docs.map((d) => wireOf(d).paymentMethod)).toEqual(['exchange', 'exchange']);
  });

  it('lines picked off a receipt: capped by what is left (this cart included); a payout in cash rides the linked credit note', async () => {
    const h = await till({}, MANAGER_PIN);
    const original = await cashSale(h, [['p-cola', 2]]);
    const found = await h.ok<{ document: { number: string }; lines: Array<{ itemId: string; remainingQty: number; unitNetAgorot: number }> }>('refund.find', { query: '20000001' });
    expect(found.document.number).toBe('20000001');
    expect(found.lines[0]).toMatchObject({ remainingQty: 2, unitNetAgorot: 1_250 });
    // The short number finds it too; a number that is not there is said.
    expect((await h.ok<{ lines: unknown[] }>('refund.find', { query: '1' })).lines).toHaveLength(1);
    expect((await h.ok<{ notFound: boolean; message: string }>('refund.find', { query: '99' })).message).toBe('לא נמצאה קבלה 99 לזיכוי');
    await h.ok('refund.button');
    await h.ok('refund.add', { transactionId: original.id, quantities: { [found.lines[0].itemId]: 5 } });
    expect(h.state().sell.lines).toMatchObject([{ refund: true, qty: 2, totalAgorot: 2_500, fromReceipt: '20000001' }]);
    // Nothing left on the line: a second pick adds nothing.
    expect((await h.fail('refund.add', { transactionId: original.id, quantities: { [found.lines[0].itemId]: 1 } })).message).toBe('כל הפריטים במסמך זוכו');
    expect((await h.ok<{ lines: Array<{ remainingQty: number; inCart: number }> }>('refund.pick', { transactionId: original.id })).lines[0]).toMatchObject({ remainingQty: 0, inCart: 2 });
    await h.ok('checkout.start');
    // Linked returns: the customer is asked, not required.
    expect(h.state().checkout.basket).toMatchObject({ step: 'return_customer', customer: { required: false }, netAgorot: -2_500, payoutAgorot: 2_500 });
    await h.ok('checkout.returnCustomer', { name: '' });
    expect(h.state().checkout.basket?.step).toBe('payout');
    await h.ok('checkout.payout', { method: 'cash' });
    expect(h.state().checkout).toMatchObject({ phase: 'done', basket: { handedBackAgorot: 2_500 } });
    const credit = allDocs(h).find((d) => d.documentType === 330)!;
    expect(credit).toMatchObject({ refundOfTransactionId: original.id, payments: [{ method: 'cash', amountAgorot: 2_500 }], status: 'completed' });
    expect(wireOf(credit).items[0]).toMatchObject({ refundOfItemId: found.lines[0].itemId, totalPrice: 25 });
    expect(h.svc.ledger.doc(original.id)!.status).toBe('refunded');
    expect((await h.ok<{ expectedCashAgorot: number }>('report.x')).expectedCashAgorot).toBe(20_000);
  });

  it('a card payout is linked to the one card original that can take it, written pending first (card recovery on)', async () => {
    const h = await till({}, MANAGER_PIN);
    const original = await cardSale(h, 'p-burger', 'acq-77');
    const found = await h.ok<{ lines: Array<{ itemId: string }> }>('refund.pick', { transactionId: original.id });
    await h.ok('refund.button');
    await h.ok('refund.add', { transactionId: original.id, quantities: { [found.lines[0].itemId]: 1 } });
    await h.ok('checkout.start');
    await h.ok('checkout.returnCustomer', { name: '' });
    expect(h.state().checkout.basket).toMatchObject({ step: 'payout', payoutRoute: 'linked' });
    let pendingWhenAsked: string | null = null;
    h.terminal.refundNext = () => {
      pendingWhenAsked = allDocs(h).find((d) => d.documentType === 330)?.status ?? null;
      return { answer: 'APPROVED', card: card({ meta: { vuid: 'r' } }), raw: '' };
    };
    await h.ok('checkout.payout', { method: 'card' });
    await wait();
    expect(pendingWhenAsked).toBe('pending');
    expect(h.terminal.refunds[0]).toMatchObject({ amountAgorot: 4_200, originalTransactionId: 'acq-77' });
    expect(h.state().checkout).toMatchObject({ phase: 'done', basket: { handedBackAgorot: 4_200 } });
    expect(allDocs(h).find((d) => d.documentType === 330)).toMatchObject({ status: 'completed', payments: [{ method: 'card', amountAgorot: 4_200 }] });
    // Its attempt was kept on disk while the frame was out, and forgotten once settled.
    expect(h.svc.pay.attempts()).toHaveLength(0);
  });

  it('a declined card payout voids the whole basket; the cashier can hand the money back in cash', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('refund.button');
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.returnCustomer', { name: 'דנה', phone: '050' });
    expect(h.state().checkout.basket?.payoutRoute).toBe('unlinked');
    h.terminal.refundNext = () => ({ answer: 'DECLINED', message: 'סירוב', raw: null, statusCode: 6 });
    await h.ok('checkout.payout', { method: 'card' });
    await wait();
    expect(h.state().checkout.cardError).toBe('הזיכוי לכרטיס נדחה: סירוב. אפשר להחזיר במזומן.');
    expect(h.terminal.refunds[0].originalTransactionId).toBeNull();
    await h.ok('checkout.payout', { method: 'cash' });
    expect(allDocs(h).filter((d) => d.documentType === 330).map((d) => d.status)).toEqual(['cancelled', 'completed']);
  });

  it('unlinked card credits switched off: no card payout for a catalog return', async () => {
    const h = await till({ parameters: { unlinkedCardCreditEnabled: 'false' } }, MANAGER_PIN);
    await h.ok('refund.button');
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.returnCustomer', { name: 'דנה', phone: '050' });
    expect(h.state().checkout.basket?.payoutRoute).toBe('unavailable');
    expect((await h.fail('checkout.payout', { method: 'card' })).message).toBe('זיכוי לכרטיס אינו זמין');
  });

  it("the refund's authority: a legacy cashier asks a manager at the button; held for the basket, spent at the commit", async () => {
    const h = await till();
    const r = await h.ok<{ dialogId: string }>('refund.button');
    expect(r.dialogId).toBeTruthy();
    expect(h.state().sell.refundChooser).toBeUndefined();
    await approveWith(h, MANAGER_PIN);
    expect(h.state().sell.refundChooser).toBe(true);
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.returnCustomer', { name: 'דנה', phone: '050' });
    // The manager's approval covers the basket: no second code.
    await h.ok('checkout.payout', { method: 'cash' });
    expect(h.state().dialog).toBeNull();
    expect(allDocs(h).find((d) => d.documentType === 330)).toMatchObject({ approvedByPosUserId: 'u-manager', cashierId: 'u-cashier' });
  });

  it('a basket with returns is never parked', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('refund.button');
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    expect((await h.fail('held.hold')).message).toBe('אי אפשר להשהות עסקה עם זיכויים.');
  });
});

describe('discounts and OTH with their ceilings (OwnerDecisions1410Test, OthClubTest)', () => {
  it('a line discount: on the line, inside the document discount, never in the gross; the operator named as its approver', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger' });
    const lineId = h.state().sell.lines[0].lineId;
    await h.ok('sell.discount', { lineId, pct: 10 });
    expect(h.state().sell.lines[0]).toMatchObject({ discountPct: 10, discountAgorot: 420, totalAgorot: 3_780 });
    expect(h.state().sell.totalAgorot).toBe(3_780);
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 3_780 });
    const d = allDocs(h)[0];
    expect(d.totals).toMatchObject({ grossAgorot: 4_200, discountAgorot: 420, totalAgorot: 3_780 });
    const w = wireOf(d);
    expect(w).toMatchObject({ totalAmount: 42, documentDiscount: 4.2, approvedByPosUserId: 'u-manager' });
    expect(w.items[0]).toMatchObject({ totalPrice: 42, discount: 4.2, discountType: 'fixed', lineDiscount: -4.2 });
    expect(rowsOf(receipt(h, d.id))).toContainEqual(['הנחה', '-4.20']);
    // The X: the discount on its own line.
    expect((await h.ok<{ discountsAgorot: number }>('report.x')).discountsAgorot).toBe(420);
  });

  it("a discount above the role's percent asks a manager whose own ceiling covers it", async () => {
    const users = [...roster(), cloudUser('sup30', '3030', { SELL: 'allow', DISCOUNT: 'allow', SHIFT_OPEN: 'allow' }, { DISCOUNT: { maxPercent: 30 } }), cloudUser('sup60', '6060', { DISCOUNT: 'allow' }, { DISCOUNT: { maxPercent: 60 } })];
    const h = await till({ users }, '3030');
    await h.ok('sell.add', { productId: 'p-burger' });
    const lineId = h.state().sell.lines[0].lineId;
    await h.ok('sell.discount', { lineId, pct: 20 });
    expect(h.state().sell.lines[0].discountPct).toBe(20);
    await h.ok('sell.discount', { lineId, pct: 50 });
    expect(h.state().dialog?.body).toBe('הנחה — מעל המותר לך, דורש אישור מנהל');
    expect((await approveWith(h, '3030')).ok).toBe(false);
    expect((await approveWith(h, '6060')).ok).toBe(true);
    expect(h.state().sell.lines[0].discountPct).toBe(50);
    // Taking it off needs nobody.
    await h.ok('sell.discount', { lineId, pct: 0 });
    expect(h.state().sell.lines[0].discountPct).toBe(0);
  });

  it('the basket discount: %, ₪ and "the customer pays", over the lines that take discounts, a fixed sum over the basket refused', async () => {
    const products = [
      { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
      { id: 'p-wine', name: 'יין', price: 80, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', noDiscount: true },
    ];
    const h = await till({ products }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-wine' });
    const p = await h.ok<{ amountAgorot: number; newTotalAgorot: number; excludedAgorot: number }>('discount.preview', { mode: 'percent', input: '10' });
    expect(p).toMatchObject({ amountAgorot: 420, newTotalAgorot: 11_780, excludedAgorot: 8_000 });
    expect((await h.fail('discount.apply', { mode: 'fixed', input: '50' })).message).toBe('ההנחה גדולה מהסכום לתשלום');
    await h.ok('discount.apply', { mode: 'target', input: '120' });
    expect(h.state().sell).toMatchObject({ totalAgorot: 12_000, basketDiscount: { amountAgorot: 200, type: 'fixed', value: 200 } });
    await h.ok('discount.apply', { mode: 'percent', input: '10' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 11_780 });
    const w = wireOf(allDocs(h)[0]);
    expect(w).toMatchObject({ documentDiscount: 4.2, basketDiscount: 4.2, basketDiscountPercent: 10, basketDiscountKind: 'manual' });
  });

  it('OTH: off unless the parameter; a line given free with its reason; on the document and the paper at ₪0', async () => {
    const off = await till({}, MANAGER_PIN);
    await off.ok('sell.add', { productId: 'p-burger' });
    expect((await off.fail('oth.confirm', { lineIds: [off.state().sell.lines[0].lineId], reason: 'פיצוי' })).code).toBe('permission_denied');
    const h = await till({ parameters: { othEnabled: 'true' } }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-cola' });
    const burger = h.state().sell.lines[0].lineId;
    await h.ok('oth.confirm', { lineIds: [burger], reason: 'פיצוי' });
    expect(h.state().sell.lines[0]).toMatchObject({ oth: 'פיצוי', discountPct: 100, totalAgorot: 0 });
    expect(h.state().sell.totalAgorot).toBe(1_250);
    // A line discount on an OTH line is refused aloud.
    expect((await h.fail('sell.discount', { lineId: burger, pct: 10 })).message).toBe('הפריט על חשבון הבית (OTH). כדי לתת עליו הנחה אחרת — קודם בטלו את ה-OTH.');
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 1_250 });
    const d = allDocs(h)[0];
    const w = wireOf(d);
    expect(w.items[0]).toMatchObject({ othReason: 'פיצוי', othBy: 'u-manager', othApprovedBy: 'u-manager', discount: 42, totalPrice: 42 });
    expect(w.documentDiscount).toBe(42);
    expect(textsOf(receipt(h, d.id))).toContain('OTH — פיצוי');
  });

  it("OTH's ceiling: above the operator's `maxAmount` an approval with the amount, offered only to approvers it covers", async () => {
    const users = [...roster(), cloudUser('c50', '5050', { SELL: 'allow', OTH: 'allow', SHIFT_OPEN: 'allow' }, { OTH: { maxAmount: 30 } }), cloudUser('s100', '1001', { OTH: 'allow' }, { OTH: { maxAmount: 100 } }), cloudUser('s20', '2002', { OTH: 'allow' }, { OTH: { maxAmount: 20 } })];
    const h = await till({ users, parameters: { othEnabled: 'true' } }, '5050');
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('sell.add', { productId: 'p-burger' });
    const [cola, burger] = h.state().sell.lines.map((l) => l.lineId);
    // ₪12.50 — within ₪30: alone.
    await h.ok('oth.confirm', { lineIds: [cola], reason: 'טעימה' });
    expect(h.state().dialog).toBeNull();
    // ₪42 — over: asked, with the amount.
    await h.ok('oth.confirm', { lineIds: [burger], reason: 'פיצוי' });
    expect(h.state().dialog?.body).toBe('על חשבון הבית (OTH) · ₪42.00 — מעל התקרה שלך');
    const capped = await approveWith(h, '2002');
    expect(capped.ok).toBe(false);
    expect((await approveWith(h, '1001')).ok).toBe(true);
    expect(h.state().sell.lines[1].oth).toBe('פיצוי');
    // "בטל OTH": back at its price (allowed alone — the operator's OTH, no amount).
    await h.ok('oth.undo', { lineId: burger });
    expect(h.state().sell.lines[1]).toMatchObject({ discountPct: 0, totalAgorot: 4_200 });
  });

  it('OTH with a legacy cashier: a manager approves (othRequiresManager on); off, the cashier gives it alone', async () => {
    const h = await till({ parameters: { othEnabled: 'true' } });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('oth.confirm', { lineIds: [h.state().sell.lines[0].lineId], reason: 'עובד' });
    expect(h.state().dialog).not.toBeNull();
    await approveWith(h, MANAGER_PIN);
    expect(h.state().sell.lines[0].oth).toBe('עובד');
    const g = await till({ parameters: { othEnabled: 'true', othRequiresManager: 'false' } });
    await g.ok('sell.add', { productId: 'p-cola' });
    await g.ok('oth.confirm', { lineIds: [g.state().sell.lines[0].lineId], reason: 'עובד' });
    expect(g.state().dialog).toBeNull();
    expect(g.state().sell.lines[0].oth).toBe('עובד');
  });

  it('a hand-discounted line keeps out of the promotions (Promotions.kt basketOf)', async () => {
    const promotions = [{ id: 'pr1', name: '1+1 שתייה', type: 'buy_x_get_y', priority: 0, config: { target: { categoryIds: ['c-drink'] }, buyQuantity: 1, getQuantity: 1 } }];
    const h = await till({ promotions }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-cola', qty: 2 });
    expect(h.state().sell.promotionsAgorot).toBe(1_250);
    await h.ok('sell.discount', { lineId: h.state().sell.lines[0].lineId, pct: 5 });
    expect(h.state().sell.promotionsAgorot ?? 0).toBe(0);
    expect(h.state().sell.lines[0].discountAgorot).toBe(125);
  });
});

describe('held sales (HeldSalesAtCloseTest)', () => {
  it('parked and picked up: the screen handed back empty, the lines and the parked price back', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger', qty: 2 });
    await h.ok('sell.discount', { lineId: h.state().sell.lines[0].lineId, pct: 10 });
    const { id } = await h.ok<{ id: string }>('held.hold', { label: 'שולחן 4' });
    expect(h.state().sell.lines).toEqual([]);
    expect(h.state().held).toMatchObject({ count: 1, sales: [{ id, label: 'שולחן 4', itemCount: 2, totalAgorot: 7_560 }] });
    // The catalog's price moves while it is parked: the customer pays what they were quoted.
    h.svc.cloud.applyCatalog({ syncType: 'full', products: [{ id: 'p-burger', name: 'המבורגר', price: 50, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' }], categories: [{ id: 'c-main', name: 'מנות', isActive: true }], menu: null, machineCatalog: { mode: 'all' }, serverTime: 'y' });
    await h.ok('held.resume', { id });
    expect(h.state().sell.lines[0]).toMatchObject({ qty: 2, unitAgorot: 4_200, discountPct: 10, totalAgorot: 7_560 });
    expect(h.state().held?.count).toBe(0);
    // Not twice.
    expect((await h.fail('held.resume', { id })).message).toBe('המכירה שבהמתנה לא נמצאה ולא נטענה.');
  });

  it('picking one up over a live basket asks first; the answer parks what is on screen — nothing lost', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger' });
    const { id } = await h.ok<{ id: string }>('held.hold');
    await h.ok('sell.add', { productId: 'p-cola' });
    const conflict = await h.fail('held.resume', { id });
    expect(conflict.details).toMatchObject({ conflict: true });
    await h.ok('held.resume', { id, parkLive: true });
    expect(h.state().sell.lines.map((l) => l.productId)).toEqual(['p-burger']);
    expect(h.state().held?.sales.map((s) => s.items.map((i) => i.name))).toEqual([['קולה']]);
  });

  it('cancelled only with a reason, behind HELD_SALE_CANCEL, recorded as held_sale_cancelled', async () => {
    const h = await till();
    await h.ok('sell.add', { productId: 'p-cola', qty: 2 });
    const { id } = await h.ok<{ id: string }>('held.hold');
    expect((await h.fail('held.cancel', { id, reason: '  ' })).message).toBe('יש לכתוב סיבת ביטול');
    await h.ok('held.cancel', { id, reason: 'הלקוח עזב' });
    expect(h.state().dialog?.body).toBe('ביטול מכירה מושהית — דורש אישור מנהל');
    await approveWith(h, MANAGER_PIN);
    expect(h.state().held?.count).toBe(0);
    const [e] = events(h, 'held_sale_cancelled');
    expect(e).toMatchObject({ posUserId: 'u-cashier', amount: 25, details: { source: 'local', reason: 'הלקוח עזב', approvedBy: 'u-manager', total: '25.00', items: [{ name: 'קולה', quantity: 2 }] } });
  });

  it('every close asks first: "יש N מכירות מושהות" — and keeps them only where the shop allows it', async () => {
    const h = await till({}, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('held.hold');
    const e = await h.fail('shift.close', { countedCashAgorot: 20_000 });
    expect(e).toMatchObject({ code: 'held_sales', message: 'יש 1 מכירות מושהות', details: { count: 1, keepAllowed: false } });
    expect((await h.fail('shift.close', { countedCashAgorot: 20_000, keepHeld: true })).code).toBe('held_sales');
    const g = await till({ parameters: { allowCloseWithHeldSales: 'true' } }, MANAGER_PIN);
    await g.ok('sell.add', { productId: 'p-cola' });
    await g.ok('held.hold');
    expect((await g.fail('shift.close', { countedCashAgorot: 20_000 })).details).toMatchObject({ keepAllowed: true });
    await g.ok('shift.close', { countedCashAgorot: 20_000, keepHeld: true });
    expect(g.state().shift.open).toBe(false);
    expect(g.state().held?.count).toBe(1);
  });
});

describe('the automatic close with a basket open (AutoCloseOpenCartTest)', () => {
  const at = (hhmm: string) => {
    const d = new Date('2026-10-16T08:00:00');
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  let clock = at('10:00');
  const now = () => clock;

  it('hold - the basket is parked under its label, the shift closes, the next shift is told once', async () => {
    clock = at('10:00');
    const h = await till({ parameters: { autoCloseShiftAt: '23:30', autoCloseOpenCart: 'hold' }, now }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger' });
    expect(await h.engine.autoCloseTick(at('23:00'))).toBeNull();
    const record = await h.engine.autoCloseTick(at('23:31'));
    expect(record).toMatchObject({ at: '23:30', cart: { action: 'held', itemCount: 1, amountAgorot: 4_200 }, heldCarried: 1 });
    expect(h.state().sell.lines).toEqual([]);
    expect(h.state().shift.open).toBe(false);
    expect(h.state().held?.sales[0].label).toBe('הושהתה בסגירה אוטומטית');
    expect(events(h, 'auto_close_cart_held')[0].details).toMatchObject({ action: 'held', label: 'הושהתה בסגירה אוטומטית', total: '42.00' });
    expect(events(h, 'shift_auto_closed')[0].details).toMatchObject({ at: '23:30', openCart: 'hold', line: 'נסגרה אוטומטית ב-23:30' });
    // The next shift opens with the notice; "הבנתי" takes it away.
    expect(h.state().notice).toBeNull();
    await h.ok('shift.open', { openingCashAgorot: 0 });
    expect(h.state().notice).toEqual({ title: 'סגירה אוטומטית במשמרת הקודמת', text: 'במשמרת הקודמת הושהתה עגלה בסגירה אוטומטית — 1 פריטים, 42 ₪. היא זמינה ב"החזר הזמנה".' });
    await h.ok('notice.ack');
    expect(h.state().notice).toBeNull();
  });

  it('discard - the basket is voided and recorded; wait (the default) closes and leaves it, as always', async () => {
    clock = at('10:00');
    const h = await till({ parameters: { autoCloseShiftAt: '23:30', autoCloseOpenCart: 'discard' }, now }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-cola', qty: 2 });
    await h.engine.autoCloseTick(at('23:31'));
    expect(h.state().sell.lines).toEqual([]);
    expect(h.state().held?.count).toBe(0);
    expect(events(h, 'auto_close_cart_discarded')[0].details).toMatchObject({ action: 'discarded', itemCount: 2, total: '25.00' });
    clock = at('10:00');
    const g = await till({ parameters: { autoCloseShiftAt: '23:30' }, now }, MANAGER_PIN);
    await g.ok('sell.add', { productId: 'p-cola' });
    const r = await g.engine.autoCloseTick(at('23:31'));
    expect(r?.cart).toBeNull();
    expect(g.state().shift.open).toBe(false);
    expect(g.state().sell.lines).toHaveLength(1);
  });

  it('a payment under way is waited for; past the wait the basket goes by the mode, the payment backed out', async () => {
    clock = at('10:00');
    const h = await till({ parameters: { autoCloseShiftAt: '23:30', autoCloseOpenCart: 'hold', autoCloseMaxWaitMin: '10' }, now }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(await h.engine.autoCloseTick(at('23:31'))).toBeNull();
    expect(h.state().shift.open).toBe(true);
    expect(await h.engine.autoCloseTick(at('23:35'))).toBeNull();
    const r = await h.engine.autoCloseTick(at('23:42'));
    expect(r?.cart).toMatchObject({ action: 'held', paymentAbandoned: true });
    expect(h.state().checkout.phase).toBe('idle');
  });

  it('held sales - cancel cancels each with its till event, never the basket this close parked', async () => {
    clock = at('10:00');
    const h = await till({ parameters: { autoCloseShiftAt: '23:30', autoCloseOpenCart: 'hold', autoCloseHeldSales: 'cancel' }, now }, MANAGER_PIN);
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('held.hold');
    await h.ok('sell.add', { productId: 'p-cola' });
    const r = await h.engine.autoCloseTick(at('23:31'));
    expect(r).toMatchObject({ heldCancelled: 1, heldCancelledAgorot: 4_200, heldCarried: 1 });
    expect(h.state().held?.sales.map((s) => s.label)).toEqual(['הושהתה בסגירה אוטומטית']);
    expect(events(h, 'held_sale_cancelled')[0].details).toMatchObject({ source: 'auto_close', reason: 'סגירה אוטומטית ב-23:30' });
    expect(events(h, 'auto_close_held_sales_cancelled')[0].details).toMatchObject({ count: 1, total: '42.00' });
  });

  it('nothing before the time, and a shift opened after it waits for tomorrow', async () => {
    clock = at('23:40');
    const h = await till({ parameters: { autoCloseShiftAt: '23:30' }, now }, MANAGER_PIN);
    expect(await h.engine.autoCloseTick(at('23:50'))).toBeNull();
    expect(h.state().shift.open).toBe(true);
  });
});

describe('"כשאין הרשאה" at the till (DeniedActionsTest)', () => {
  const waiter = () => cloudUser('waiter', '4444', { SELL: 'allow', SHIFT_OPEN: 'allow', REFUND: 'deny', DISCOUNT: 'approval', Z: 'deny', SHIFT_CLOSE: 'allow', LINE_VOID: 'allow', HELD_SALE_CANCEL: 'deny' });

  it('show (the default): the option is there and a tap says "אין הרשאה"', async () => {
    const h = await till({ users: [...roster(), waiter()] }, '4444');
    expect(h.state().session.hidden ?? []).not.toContain('REFUND');
    expect((await h.fail('refund.button')).message).toBe('אין לך הרשאה: זיכוי / החזר');
  });

  it("hide: the role's denials are left out — by the level, or by the employee's own over it", async () => {
    const h = await till({ users: [...roster(), waiter()], parameters: { deniedActionUi: 'hide' } }, '4444');
    expect(h.state().session.hidden).toEqual(expect.arrayContaining(['REFUND', 'Z', 'HELD_SALE_CANCEL']));
    expect(h.state().session.hidden).not.toContain('SHIFT_OPEN');
    expect(h.state().session.hidden).not.toContain('DISCOUNT');
    // A tap that still arrives is refused as today.
    expect((await h.fail('refund.button')).code).toBe('permission_denied');
    const g = await till({ users: [...roster(), { ...waiter(), deniedUi: 'show' }], parameters: { deniedActionUi: 'hide' } }, '4444');
    expect(g.state().session.hidden ?? []).not.toContain('REFUND');
  });

  it('code: a role\'s denial asks a manager\'s code and is recorded as an approval', async () => {
    const h = await till({ users: [...roster(), waiter()], parameters: { deniedActionUi: 'code' } }, '4444');
    expect(h.state().session.hidden ?? []).not.toContain('REFUND');
    const r = await h.ok<{ dialogId: string }>('refund.button');
    expect(r.dialogId).toBeTruthy();
    expect(h.state().dialog?.body).toBe('זיכוי / החזר — דורש אישור מנהל');
    await approveWith(h, MANAGER_PIN);
    expect(h.state().sell.refundChooser).toBe(true);
  });

  it('a waiter of the cloud roster on the wire: limits and deniedUi kept off the roster pull', async () => {
    const h = harness();
    open.push(h);
    h.svc.cloud.applyPosUsers({ syncType: 'full', serverTime: 't', users: [{ ...waiter(), limits: { DISCOUNT: { maxPercent: 30, junk: 'x' } }, deniedUi: 'CODE' }] });
    const [u] = h.svc.cloud.posUsers();
    expect(u.limits).toEqual({ DISCOUNT: { maxPercent: 30 } });
    expect(u.deniedUi).toBe('code');
  });
});
