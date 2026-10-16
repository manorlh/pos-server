/**
 * The cash stations' side on the Windows till (P:/specs/cash-paylink.md §11.8, §11.15א) — pos-android CashOwedTillTest and the
 * CashCreditService cases: "עודף חייב ללקוח" named by its station, "שולם ללקוח" (the drawer's rules and a manager first, then
 * the cloud by a new movement id, and only after its 200 the cash out under that same id), and "זיכוי מזומן" at the payment.
 * Tests only: a fake cloud.
 */

import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { cashMoneyText, owedCashOutReason, owedLine, parseOwedList, shortCode } from '../src/core/till/cashOwed';
import type { DrawerVerdict } from '../src/core/till/drawer';
import { documentWire } from '../src/main/fiscal/ledger';
import type { ApiReply } from '../src/main/sync/api';
import { CashOwedRepository, redeemCredit, type CashCreditCloud, type CashOutDrawer, type CashOwedCloud } from '../src/main/till/tillCash';
import { MANAGER_PIN, PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const BODY = {
  items: [
    { id: 'o-1', kind: 'change_owed', stationId: 'st-2', stationName: 'עמדת מזומן 2', txId: 'tx-1', slipCode: 'C-K7Q3MX', amountAgorot: 1300, orderLabel: '57', clientName: 'קיוסק 3', createdAt: '2026-10-14T18:00:00Z' },
    { id: 'o-2', kind: 'held_credit', stationId: 'st-2', stationName: 'עמדת מזומן 2', txId: 'tx-2', slipCode: null, amountAgorot: 5000, orderLabel: null, clientName: 'קיוסק 3', createdAt: '2026-10-14T18:05:00Z' },
    { id: 'o-3', kind: 'something_new', txId: 'tx-3', amountAgorot: 100 },
    { id: 'o-4', kind: 'change_owed', txId: 'tx-4', amountAgorot: 0 },
  ],
};

const ok = (body: unknown): ApiReply => ({ kind: 'ok', status: 200, body, headers: new Headers() });
const refused = (status: number, body: unknown): ApiReply => ({ kind: 'refused', status, body, detail: null, headers: new Headers() });

class FakeCloud implements CashOwedCloud {
  pays: unknown[][] = [];
  payReply: ApiReply = ok({ ok: true });
  fetches = 0;
  steps: string[] | null = null;
  constructor(public owedBody: unknown = BODY) {}
  async owed() {
    this.fetches += 1;
    return ok(this.owedBody);
  }
  async pay(id: string, movementId: string, shiftId: string | null, userId: string | null, userName: string | null, amountAgorot: number) {
    this.steps?.push('cloud');
    this.pays.push([id, movementId, shiftId, userId, userName, amountAgorot]);
    return this.payReply;
  }
}

function repo(cloud: FakeCloud, shift: string | null = 'shift-9', verdict: DrawerVerdict | null = null) {
  return new CashOwedRepository({ cloud, shiftId: () => shift, drawerVerdict: () => verdict, user: () => ({ id: 'u-1', name: 'דנה' }), newId: () => 'mv-1' });
}

/** The till's side: the manager who approves (null — the prompt dismissed), the drawer picked, the cash outs, the order. */
class Drawer {
  cashOuts: Array<[string, number, string]> = [];
  approvers: Array<string | null> = [];
  drawers: Array<string | null> = [];
  asked: DrawerVerdict[] = [];
  constructor(
    public approver: string | null = null,
    public pick: CashOutDrawer<string> = { kind: 'not_asked' },
    public steps: string[] = [],
  ) {}
  pay(r: CashOwedRepository, n: NonNullable<ReturnType<CashOwedRepository['byId']>>, reason: string) {
    return r.pay<string, string>(
      n,
      reason,
      async (v) => {
        this.steps.push('approve');
        this.asked.push(v);
        return this.approver;
      },
      async () => {
        this.steps.push('drawer');
        return this.pick;
      },
      (id, amount, why, who, drawer) => {
        this.steps.push('cash_out');
        this.cashOuts.push([id, amount, why]);
        this.approvers.push(who);
        this.drawers.push(drawer);
      },
    );
  }
}

const needs: DrawerVerdict = { kind: 'approval', eventType: 'CASH_OUT', permission: 'CASH_DRAWER.CASH_OUT', why: 'SETTING', amountAgorot: 1300 };

describe('"עודף חייב ללקוח" and "שולם ללקוח" (CashOwedTillTest)', () => {
  it('the debts as the cloud lists them — an unknown kind or no amount is never offered', async () => {
    const cloud = new FakeCloud();
    const r = repo(cloud);
    await r.refreshIfDue(1);
    expect(r.items.map((n) => n.id)).toEqual(['o-1', 'o-2']);
    const owed = r.items[0];
    expect(owed.kind).toBe('change_owed');
    expect(owed.slipCode).toBe('C-K7Q3MX');
    expect(owedLine(owed)).toBe('עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪');
    expect(owedLine(r.items[1])).toBe('עמדת מזומן 2 · זיכוי מוחזק: 50 ₪');
    // Not again before its time.
    await r.refreshIfDue(2);
    expect(cloud.fetches).toBe(1);
    await r.refreshIfDue(3, true);
    expect(cloud.fetches).toBe(2);
    expect(parseOwedList({})).toEqual([]);
    expect(cashMoneyText(1350)).toBe('13.50 ₪');
    expect(shortCode('ab12cd34-0000-4000-8000-000000000000')).toBe('AB12CD34');
  });

  it('paid to the customer — the cloud first, then the cash out under the same movement id', async () => {
    const cloud = new FakeCloud();
    const r = repo(cloud);
    await r.refreshIfDue(1);
    const drawer = new Drawer();
    const n = r.byId('o-1')!;
    const reason = owedCashOutReason(n);
    expect(reason).toBe('עודף חייב ללקוח · הזמנה 57 · C-K7Q3MX');
    expect(await drawer.pay(r, n, reason)).toEqual({ kind: 'paid', movementId: 'mv-1' });
    expect(cloud.pays).toEqual([['o-1', 'mv-1', 'shift-9', 'u-1', 'דנה', 1300]]);
    expect(drawer.cashOuts).toEqual([['mv-1', 1300, reason]]);
    expect(r.byId('o-1')).toBeNull();
    // No slip code: the transaction's short code.
    expect(owedCashOutReason({ ...n, slipCode: null, orderLabel: null, txId: 'ab12cd34-0000-4000-8000-000000000000' })).toBe('עודף חייב ללקוח · AB12CD34');
  });

  it("a manager's approval the drawer wants — asked before anything is sent, a dismissed prompt sends nothing", async () => {
    const cloud = new FakeCloud();
    const r = repo(cloud, 'shift-9', needs);
    await r.refreshIfDue(1);
    const dismissed = new Drawer(null);
    expect(await dismissed.pay(r, r.byId('o-1')!, 'x')).toEqual({ kind: 'refused', why: 'not_approved' });
    expect(dismissed.asked).toEqual([needs]);
    expect(cloud.pays).toEqual([]);
    expect(dismissed.cashOuts).toEqual([]);
    expect(r.byId('o-1')).not.toBeNull();
    const approved = new Drawer('manager-7');
    expect(await approved.pay(r, r.byId('o-1')!, 'x')).toEqual({ kind: 'paid', movementId: 'mv-1' });
    expect(approved.asked).toHaveLength(1);
    expect(cloud.pays[0][1]).toBe('mv-1');
    expect(approved.cashOuts).toEqual([['mv-1', 1300, 'x']]);
    expect(approved.approvers).toEqual(['manager-7']);
    // No approval wanted: none asked, the cash out with no approver.
    const plain = new Drawer('never');
    const p = repo(new FakeCloud());
    await p.refreshIfDue(1);
    expect(await plain.pay(p, p.byId('o-1')!, 'x')).toEqual({ kind: 'paid', movementId: 'mv-1' });
    expect(plain.asked).toEqual([]);
    expect(plain.approvers).toEqual([null]);
  });

  it('several drawers — which one is asked after the approval and before the cloud, a dismissed choice sends nothing', async () => {
    const steps: string[] = [];
    const cloud = new FakeCloud();
    cloud.steps = steps;
    const r = repo(cloud, 'shift-9', needs);
    await r.refreshIfDue(1);
    const dismissed = new Drawer('manager-7', { kind: 'dismissed' }, steps);
    expect(await dismissed.pay(r, r.byId('o-1')!, 'x')).toEqual({ kind: 'refused', why: 'no_drawer' });
    expect(steps).toEqual(['approve', 'drawer']);
    expect(dismissed.cashOuts).toEqual([]);
    steps.length = 0;
    const picked = new Drawer('manager-7', { kind: 'picked', target: 'drawer-2' }, steps);
    expect(await picked.pay(r, r.byId('o-1')!, 'x')).toEqual({ kind: 'paid', movementId: 'mv-1' });
    expect(steps).toEqual(['approve', 'drawer', 'cloud', 'cash_out']);
    expect(picked.drawers).toEqual(['drawer-2']);
    expect(picked.approvers).toEqual(['manager-7']);
  });

  it('already paid another way — no cash out here', async () => {
    const cloud = new FakeCloud();
    cloud.payReply = refused(409, { detail: { code: 'already_resolved', message: 'החוב כבר נסגר.', resolvedBy: 'יוסי', resolvedAt: '2026-10-14T18:10:00Z' } });
    const r = repo(cloud);
    await r.refreshIfDue(1);
    const drawer = new Drawer();
    expect(await drawer.pay(r, r.byId('o-1')!, 'x')).toEqual({ kind: 'already', by: 'יוסי', at: '2026-10-14T18:10:00Z' });
    expect(drawer.cashOuts).toEqual([]);
    expect(r.byId('o-1')).toBeNull();
  });

  it('no shift, a drawer rule, or no cloud — nothing paid, nothing out of the drawer', async () => {
    const notice = parseOwedList(BODY)[0];
    const drawer = new Drawer();
    const noShift = new FakeCloud();
    expect(await drawer.pay(repo(noShift, null), notice, 'x')).toEqual({ kind: 'refused', why: 'no_shift' });
    expect(noShift.pays).toEqual([]);
    const ruled = new FakeCloud();
    const r = await drawer.pay(repo(ruled, 'shift-9', { kind: 'refused', eventType: 'CASH_OUT', permission: 'CASH_DRAWER.CASH_OUT', why: 'הכנסה / הוצאה / הפקדה כבויות בהגדרות הקופה' }), notice, 'x');
    expect(r).toMatchObject({ kind: 'refused', why: 'not_allowed' });
    expect(ruled.pays).toEqual([]);
    const shiftClosed = new FakeCloud();
    shiftClosed.payReply = refused(409, { detail: { code: 'shift_not_open', message: 'אין משמרת פתוחה' } });
    expect(await drawer.pay(repo(shiftClosed), notice, 'x')).toMatchObject({ kind: 'refused', why: 'no_shift' });
    const goneCloud = new FakeCloud();
    goneCloud.payReply = refused(404, { detail: { code: 'owed_not_found', message: 'לא נמצא' } });
    const gone = repo(goneCloud);
    await gone.refreshIfDue(1);
    expect(await drawer.pay(gone, gone.byId('o-1')!, 'x')).toEqual({ kind: 'refused', why: 'failed', detail: 'לא נמצא' });
    expect(gone.byId('o-1')).toBeNull();
    const offline = new FakeCloud();
    offline.payReply = { kind: 'offline', reason: 'no network' };
    expect(await drawer.pay(repo(offline), notice, 'x')).toMatchObject({ kind: 'refused', why: 'offline' });
    expect(drawer.cashOuts).toEqual([]);
  });
});

/* ---------------------------------------------------------- cash credits */

class FakeCredits implements CashCreditCloud {
  lookup: ApiReply = ok({ api: 1, credit: { code: 'C-K7Q3MX', amountAgorot: 1300, remainingAgorot: 1300, status: 'open' } });
  redeemReplies: ApiReply[] = [];
  redeems: Array<[string, string, number]> = [];
  released: string[] = [];
  async credit() {
    return this.lookup;
  }
  async redeem(code: string, id: string, amount: number) {
    this.redeems.push([code, id, amount]);
    return this.redeemReplies.shift() ?? ok({ redemption: { id, amountAgorot: amount } });
  }
  release(id: string) {
    this.released.push(id);
  }
}

describe('"זיכוי מזומן": taking a credit (CashCreditService)', () => {
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  it('the code scanned or typed; min(what is left on it, the goods left)', async () => {
    const c = new FakeCredits();
    expect(await redeemCredit(c, 'CC:C-K7Q3MX', 1_000, [], ids)).toMatchObject({ kind: 'taken', use: { code: 'C-K7Q3MX', amountAgorot: 1_000 } });
    expect(c.redeems[0][2]).toBe(1_000);
    expect(await redeemCredit(c, 'c-k7q3mx', 5_000, [], ids)).toMatchObject({ kind: 'taken', use: { amountAgorot: 1_300 } });
  });

  it('refused: not a code, in the sale already, nothing due, used, written off, unknown', async () => {
    const c = new FakeCredits();
    expect(await redeemCredit(c, 'hello', 1_000, [], ids)).toEqual({ kind: 'refused', why: 'not_a_code' });
    expect(await redeemCredit(c, 'C-K7Q3MX', 1_000, [{ code: 'C-K7Q3MX', redemptionId: 'r', amountAgorot: 1 }], ids)).toEqual({ kind: 'refused', why: 'in_sale' });
    expect(await redeemCredit(c, 'C-K7Q3MX', 0, [], ids)).toEqual({ kind: 'refused', why: 'nothing_due' });
    c.lookup = ok({ credit: { code: 'C-K7Q3MX', remainingAgorot: 0, status: 'used' } });
    expect(await redeemCredit(c, 'C-K7Q3MX', 1_000, [], ids)).toEqual({ kind: 'refused', why: 'used' });
    c.lookup = ok({ credit: { code: 'C-K7Q3MX', remainingAgorot: 500, status: 'written_off' } });
    expect(await redeemCredit(c, 'C-K7Q3MX', 1_000, [], ids)).toEqual({ kind: 'refused', why: 'written_off' });
    c.lookup = refused(404, { detail: { code: 'credit_not_found' } });
    expect(await redeemCredit(c, 'C-K7Q3MX', 1_000, [], ids)).toEqual({ kind: 'refused', why: 'not_found' });
  });

  it('less left than looked up (amount_exceeds): once more for that; no answer on the redeem — given back', async () => {
    const c = new FakeCredits();
    c.redeemReplies = [refused(409, { detail: { code: 'amount_exceeds', remainingAgorot: 400 } })];
    expect(await redeemCredit(c, 'C-K7Q3MX', 1_000, [], ids)).toMatchObject({ kind: 'taken', use: { amountAgorot: 400 } });
    expect(c.redeems.map((r) => r[2])).toEqual([1_000, 400]);
    // A new id per amount.
    expect(c.redeems[0][1]).not.toBe(c.redeems[1][1]);
    const off = new FakeCredits();
    off.redeemReplies = [{ kind: 'offline', reason: 'x' }];
    expect(await redeemCredit(off, 'C-K7Q3MX', 1_000, [], ids)).toEqual({ kind: 'refused', why: 'offline' });
    expect(off.released).toEqual([off.redeems[0][1]]);
  });
});

/* -------------------------------------------------------------- the engine */

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

async function till(o: HarnessOptions = {}, pin = PIN): Promise<Harness> {
  const h = harness(o);
  open.push(h);
  await h.ok('session.login', { pin });
  await h.ok('shift.open', { openingCashAgorot: 20_000 });
  return h;
}

const creditAnswers = (remaining = 1_000) => ({
  'GET sync/m/cash/credits/C-K7Q3MX': () => ({ api: 1, credit: { code: 'C-K7Q3MX', amountAgorot: remaining, remainingAgorot: remaining, status: 'open' } }),
  'POST sync/m/cash/credits/C-K7Q3MX/redeem': (body: Record<string, unknown> | null) => ({ api: 1, ok: true, redemption: { id: body?.redemptionId, amountAgorot: body?.amountAgorot } }),
  'POST sync/m/cash/credits/redemptions/*': () => ({ api: 1, ok: true }),
});

describe('the till: "זיכוי מזומן" at the payment, "שולם ללקוח"', () => {
  it('a credit pays part of the goods; the cash pays the rest; the document names the redemption; the drawer opens for the cash only', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן' }, answers: creditAnswers(1_000) });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    expect(await h.ok('checkout.credit', { code: 'CC:C-K7Q3MX' })).toEqual({ creditAgorot: 1_000 });
    expect(h.state().checkout).toMatchObject({ phase: 'tender', dueAgorot: 3_200, legs: [{ method: 'cash_credit', amountAgorot: 1_000, credit: { code: 'C-K7Q3MX' } }] });
    // The same credit twice: refused.
    expect((await h.fail('checkout.credit', { code: 'C-K7Q3MX' })).message).toBe('הזיכוי כבר בהזמנה הזו');
    await h.ok('checkout.cash', { amountAgorot: 5_000 });
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    expect(doc.payments).toEqual([
      { method: 'cash_credit', amountAgorot: 1_000, cashCredit: { code: 'C-K7Q3MX', redemptionId: expect.any(String) } },
      { method: 'cash', amountAgorot: 3_200 },
    ]);
    const wire = documentWire(doc) as { payments: Array<Record<string, unknown>>; paymentMethod: string; changeAmount: number };
    expect(wire.payments[0]).toMatchObject({ method: 'cash_credit', amount: 10, cashCredit: { code: 'C-K7Q3MX' } });
    expect(wire).toMatchObject({ paymentMethod: 'cash', changeAmount: 18 });
    await new Promise((r) => setTimeout(r, 30));
    const ev = h.engine.drawer.service.store.eventsOfShift(h.svc.ledger.currentShift()!.id).find((e) => e.eventType === 'CASH_SALE');
    expect(ev?.amountAgorot).toBe(3_200);
  });

  it('a credit for all of it closes the sale at once — no cash, no drawer; cancelling a payment gives the credit back', async () => {
    const h = await till({ parameters: { cashDrawer: 'בתשלום מזומן' }, answers: creditAnswers(5_000) });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    await h.ok('checkout.credit', { code: 'C-K7Q3MX' });
    expect(h.state().checkout.phase).toBe('done');
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    expect(documentWire(doc)).toMatchObject({ paymentMethod: 'cash_credit' });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.engine.drawer.service.store.eventsOfShift(h.svc.ledger.currentShift()!.id).filter((e) => e.eventType === 'CASH_SALE')).toEqual([]);
    expect(h.state().checkout.legs[0].credit?.code).toBe('C-K7Q3MX');
    await h.ok('checkout.finish');
    // Taken, then the payment abandoned: back on the credit.
    const p = await till({ answers: creditAnswers(1_000) });
    await p.ok('sell.add', { productId: 'p-burger' });
    await p.ok('checkout.start');
    await p.ok('checkout.credit', { code: 'C-K7Q3MX' });
    const id = p.state().checkout.legs[0].credit!.redemptionId;
    await p.ok('checkout.cancel');
    await new Promise((r) => setTimeout(r, 30));
    expect(p.state().checkout.phase).toBe('idle');
    expect(p.sent.some((s) => s.method === 'POST' && s.path === `sync/m/cash/credits/redemptions/${id}/release`)).toBe(true);
  });

  it('"שולם ללקוח": the cloud by a new movement id, then the cash out from this drawer under it — a cashier on a manager\'s code', async () => {
    const pays: Array<Record<string, unknown> | null> = [];
    const h = await till({
      parameters: { cashDrawer: 'בתשלום מזומן + כפתור' },
      users: [
        { id: 'u-cashier', username: 'dana', firstName: 'דנה', lastName: 'כהן', pinHash: bcrypt.hashSync(PIN, 4), role: 'cashier', isActive: true, shopId: null, permissions: { SELL: 'allow', SHIFT_OPEN: 'allow', 'CASH_DRAWER.CASH_OUT': 'approval' } },
        { id: 'u-manager', username: 'avi', firstName: 'אבי', lastName: 'לוי', pinHash: bcrypt.hashSync(MANAGER_PIN, 4), role: 'shop_manager', isActive: true, shopId: null },
      ],
      answers: {
        'GET sync/m/cash/owed': () => BODY,
        'POST sync/m/cash/owed/o-1/pay': (body) => {
          pays.push(body);
          return { ok: true };
        },
      },
    });
    const list = await h.ok<{ items: Array<{ id: string; line: string }> }>('owed.refresh');
    expect(list.items.map((x) => x.line)).toEqual(['עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪', 'עמדת מזומן 2 · זיכוי מוחזק: 50 ₪']);
    await h.ok('owed.pay', { id: 'o-1' });
    await new Promise((r) => setTimeout(r, 20));
    const d = h.state().dialog!;
    expect(d.body).toBe('הוצאת מזומן — דורש אישור מנהל');
    expect(pays).toEqual([]);
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(await h.engine.cash.lastPay).toMatchObject({ kind: 'paid' });
    expect(pays).toHaveLength(1);
    const movementId = pays[0]!.movementId as string;
    expect(pays[0]).toMatchObject({ shiftId: h.svc.ledger.currentShift()!.id, userId: 'u-cashier', amountAgorot: 1300 });
    const m = h.engine.drawer.service.store.movement(movementId)!;
    expect(m).toMatchObject({ type: 'cash_out', amountAgorot: 1300, reason: 'עודף חייב ללקוח · הזמנה 57 · C-K7Q3MX', note: 'tx-1', approverId: 'u-manager' });
    expect(h.state().owed?.items.map((x) => x.id)).toEqual(['o-2']);
  });
});
