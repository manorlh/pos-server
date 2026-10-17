/**
 * "מזומן במכשיר" on the Windows till (main/till/tillDeviceCash.ts, core/till/deviceCash.ts — the Android till's
 * CheckoutViewModel.payOnCashMag → recordDeviceCash): CashMag through the kiosk's own client over a fake recycler, the cash
 * station through a fake client — the pending document before the device, one cash leg naming the device's transaction, the
 * change owed (slip / credit, the slip given from the drawer), the busy machine with "חזרה", a fault and "טופל", a lost
 * station answer ("בדוק שוב" / a manager's "סמן כלא שולם"), the restart, the drawer kept out of it (no drawer opens, the X's
 * expected cash leaves the device's cash out), the kiosk's recovery leaving the till's payments alone, the menu row.
 * Tests only: fakes — never a device.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { balanceOf, CASHMAG_BUSY_TEXT, okReply, refusedReply, type CashRecyclerReply } from '../src/core/cash/cashmag';
import { cashSettingsOf } from '../src/core/cash/settings';
import type { TxView } from '../src/core/cash/tx';
import { buildXTill } from '../src/core/sale';
import { xCashBlock, withCashWithTips } from '../src/core/till/cashWithTips';
import { deviceOwedChoices, deviceSettle, isTillCashRef, tillCashRef } from '../src/core/till/deviceCash';
import { buildTillMenu } from '../src/core/till/tillMenu';
import { xDoc } from '../src/core/printDocs';
import { documentWire, xDocOf } from '../src/main/fiscal/ledger';
import { CashMagPay, txViewOf, type CashMagEntry } from '../src/main/kiosk/cashmagPay';
import type { CashOutcome, CashPending, CashProgress } from '../src/main/kiosk/cashPay';
import type { CashStationRef } from '../src/main/cash/client';
import { KioskCoreTillEngine } from '../src/main/till/engine';
import type { PaylinkPort } from '../src/main/till/tillDeviceCash';
import type { KioskService } from '../src/main/service';
import { FakeRecycler } from './support/fakeRecycler';
import { MANAGER_PIN, readyTill, type Harness } from './tillEngineHarness';

const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const s of stoppers.splice(0).reverse()) s();
});

const until = async <T>(fn: () => T | null | undefined | false, ms = 5_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const paid = (cashIn: number, cashOut: number, owed = 0): CashRecyclerReply => ({
  ...okReply(),
  balance: balanceOf({ currency: 'ILS', cashInAgorot: cashIn, cashOutAgorot: cashOut, customerBalanceAgorot: owed > 0 ? -owed : 0, ...(owed > 0 ? { merchantBalanceAgorot: owed } : {}) }),
});

const MAG_PARAMS = { cashmagEnabled: true, cashmagHost: '10.0.0.9', cashmagPort: 5000, cashmagRounding: 'none' };

/** A till whose CashMag is the kiosk's own client over [fake]. */
async function magTill(fake: FakeRecycler, params: Record<string, unknown> = {}, pin?: string) {
  let mag: CashMagPay | null = null;
  const h = await readyTill(
    {
      parameters: { ...MAG_PARAMS, ...params },
      deviceCash: (svc) => {
        mag = new CashMagPay({ kv: svc.kv, params: () => svc.cloud.parameters(), kioskName: () => 'קופה 2', log: () => undefined, driverFor: () => fake, pollMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
        return { cashmag: mag, paylink: new FakePaylink(false), online: () => true, settleEveryMs: 0 };
      },
    },
    pin,
  );
  stoppers.push(() => h.stop());
  await mag!.probe();
  return { h, mag: mag! };
}

async function sale(h: Harness) {
  await h.ok('sell.add', { productId: 'p-burger', qty: 1 });
  await h.ok('checkout.start');
}

/* ------------------------------------------------------------------ a fake cash station client */

const STATION: CashStationRef = { stationId: 'st-1', name: 'עמדת מזומן 1', location: null, hostId: 'host-1', hostName: 'שרת', lanAddress: '10.0.0.5', port: 47630, secret: 'x' };

function tx(over: Partial<TxView> & { txId: string }): TxView {
  const base = txViewOf({ txId: over.txId, stationId: 'st-1', amountAgorot: 4200, dueAgorot: 4200, startedAt: 0 }, { state: 'DONE', outcome: 'paid', inserted: 4200 });
  return { ...base, hostId: 'host-1', ...over };
}

class FakePaylink implements PaylinkPort {
  inFlight = false;
  ok = true;
  cancelled = false;
  acks: Array<{ txId: string; documentId: string | null; extra: unknown }> = [];
  list: CashPending[] = [];
  lookups = new Map<string, { kind: 'tx'; tx: TxView } | { kind: 'none' } | { kind: 'offline' }>();
  cancelsAt: string[] = [];
  /** The payment's script: progress, then the outcome. */
  script: (txId: string, progress: (p: CashProgress) => void, self: FakePaylink) => Promise<CashOutcome> = async (txId) => ({ kind: 'paid', tx: tx({ txId }) });
  private n = 0;
  constructor(private readonly on = true) {}
  configured() {
    return this.on;
  }
  usable() {
    return this.on && this.ok;
  }
  offReason() {
    return this.ok ? null : 'מכשיר המזומן לא זמין';
  }
  station() {
    return this.on ? STATION : null;
  }
  settings() {
    return cashSettingsOf({});
  }
  async pay(input: { orderId: string; docId: string; amountAgorot: number; orderLabel: string | null }, onProgress: (p: CashProgress) => void): Promise<CashOutcome> {
    this.inFlight = true;
    this.n += 1;
    const txId = `00000000-0000-4000-8000-00000000000${this.n}`;
    this.list.push({ txId, stationId: 'st-1', leaseId: null, orderId: input.orderId, docId: input.docId, amountAgorot: input.amountAgorot, orderLabel: null, startedAt: Date.now(), started: true, finalState: null });
    try {
      return await this.script(txId, onProgress, this);
    } finally {
      this.inFlight = false;
    }
  }
  cancel() {
    this.cancelled = true;
  }
  async ack(txId: string, documentId: string | null, _n: string | null, _l: string | null = null, extra: unknown = {}) {
    this.acks.push({ txId, documentId, extra });
    this.forget(txId);
    return true;
  }
  async lookUp(txId: string) {
    return this.lookups.get(txId) ?? { kind: 'offline' as const };
  }
  async cancelAt(txId: string) {
    this.cancelsAt.push(txId);
  }
  pending() {
    return this.list;
  }
  forget(txId: string) {
    this.list = this.list.filter((p) => p.txId !== txId);
  }
  async refreshStatus() {}
}

async function linkTill(link: FakePaylink, pin?: string) {
  const h = await readyTill({ deviceCash: () => ({ paylink: link, cashmag: offMag(), online: () => true, settleEveryMs: 0 }) }, pin);
  stoppers.push(() => h.stop());
  return h;
}

/** CashMag off (the default): nothing of it runs. */
function offMag() {
  const fake = new FakeRecycler();
  return new CashMagPay({ kv: { getJson: () => null, setJson: () => undefined, delete: () => undefined } as never, params: () => ({}), log: () => undefined, driverFor: () => fake });
}

/* ------------------------------------------------------------------ the rules */

describe('the rules (core/till/deviceCash.ts)', () => {
  it('the device leg closes what was left; the change owed is change unless left as a tip', () => {
    const meta = { txId: 't', stationId: 's', hostId: 'cashmag', receivedAgorot: 10_000, changeAgorot: 4_000, changeOwedAgorot: 270, roundingAgorot: 0, slipCode: 'C-X' };
    const s = deviceSettle(5_730, [{ method: 'cash', amountAgorot: 1_000, handedAgorot: 1_000 }], meta)!;
    expect(s.legs.map((l) => [l.method, l.amountAgorot])).toEqual([
      ['cash', 1_000],
      ['cash', 4_730],
    ]);
    expect(s.tenderedAgorot).toBe(11_000);
    expect(s.changeAgorot).toBe(4_270);
    expect(s.tipAgorot).toBe(0);
    const tip = deviceSettle(5_730, [], { ...meta, changeOwedAs: 'tip' })!;
    expect(tip.legs[0].amountAgorot).toBe(5_730 + 270);
    expect(tip.changeAgorot).toBe(4_000);
    expect(tip.tipAgorot).toBe(270);
    expect(deviceSettle(1_000, [{ method: 'cash', amountAgorot: 1_000, handedAgorot: 1_000 }], meta)).toBeNull();
  });

  it('the change owed: a slip always, a credit online (CashMag only with cashmagOwedCredit), a tip only where the sale takes one', () => {
    expect(deviceOwedChoices({ kind: 'cashmag', online: true, cashmagOwedCredit: false, tipOk: false })).toEqual(['slip']);
    expect(deviceOwedChoices({ kind: 'cashmag', online: true, cashmagOwedCredit: true, tipOk: false })).toEqual(['slip', 'credit']);
    expect(deviceOwedChoices({ kind: 'paylink', online: false, cashmagOwedCredit: false, tipOk: true })).toEqual(['slip', 'tip']);
    expect(deviceOwedChoices({ kind: 'paylink', online: true, cashmagOwedCredit: false, tipOk: false })).toEqual(['slip', 'credit']);
    expect(isTillCashRef(tillCashRef('d-1'))).toBe(true);
    expect(isTillCashRef('order-1')).toBe(false);
  });

  it("the X: the device's cash is cash, never the drawer's — off the expected cash and the drawer block, its own line", () => {
    const base = { status: 'completed', documentType: 320, transactionNumber: 1, grossAgorot: 5_000, itemsQty: 1, documentDiscountAgorot: 0, paymentMethod: 'cash', vatAgorot: null, vatRate: 18, tipAgorot: 0, tipPaymentMethod: null };
    const { till } = buildXTill(
      [
        { ...base, id: 'a', payments: [{ method: 'cash', amountAgorot: 5_000 }] },
        { ...base, id: 'b', payments: [{ method: 'cash', amountAgorot: 5_000, device: true }] },
      ],
      20_000,
      18,
    );
    expect(till.totalCash).toBe(100);
    expect(till.totalDeviceCash).toBe(50);
    expect(till.expectedCash).toBe(250);
    const block = xCashBlock(till, true);
    expect(block.find((l) => l.bold)?.agorot).toBe(25_000);
    // Every cash taking on "מזומן ממכירות", the device's on its own "מזומן במכשיר" line (the shared golden's rule).
    expect(block.filter((l) => l.key === 'cashSales' || l.key === 'deviceCash').map((l) => [l.key, l.agorot, l.label])).toEqual([
      ['cashSales', 10_000, 'מזומן ממכירות'],
      ['deviceCash', -5_000, 'מזומן במכשיר'],
    ]);
    const tips = withCashWithTips({ ...till, totalCardTips: 0 }, { param: true, shortfall: 'partial', askChoice: null });
    expect(tips.drawerCash).toBe(50);
    const paper = JSON.stringify(xDoc({ business: { companyName: 'x', dealerType: 'company' } as never, till, cashierName: 'דנה', shiftNumber: 1, businessDate: null, openedAt: new Date(), closedAt: null, printedAt: new Date(), countedCash: null } as never));
    expect(paper).toContain('מזומן במכשיר');
    const { till: none } = buildXTill([{ ...base, id: 'a', payments: [{ method: 'cash', amountAgorot: 5_000 }] }], 0, 18);
    expect('totalDeviceCash' in none).toBe(false);
  });
});

/* ------------------------------------------------------------------ CashMag at the till */

describe('CashMag at the till', () => {
  it('paid exactly: the pending document before the device, one cash leg naming the transaction, no drawer, the X', async () => {
    const fake = new FakeRecycler();
    let docAtPay: string | null = null;
    const { h, mag } = await magTill(fake);
    fake.payWith = async (_f, due) => {
      docAtPay = h.svc.ledger.pendingDocs()[0]?.status ?? null;
      return paid(due, 0);
    };
    await sale(h);
    expect(h.state().deviceCash).toMatchObject({ kind: 'cashmag', name: 'CashMag', available: true });
    const kick = vi.spyOn(h.engine.drawer, 'afterCashSale');
    await h.ok('deviceCash.pay');
    expect(h.state().checkout.phase).toBe('card_waiting');
    await h.engine.deviceCash.lastRun;
    await until(() => h.state().checkout.phase === 'done');
    expect(docAtPay).toBe('pending');
    expect(fake.calls).toContain('pay:4200');
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    expect(doc.status).toBe('completed');
    const wire = documentWire(doc) as { payments: Array<Record<string, unknown>> };
    expect(wire.payments).toHaveLength(1);
    expect(wire.payments[0]).toMatchObject({ method: 'cash', amount: 42, cashDevice: { hostId: 'cashmag', stationId: 'cashmag:10.0.0.9:5000', receivedAgorot: 4200, changeAgorot: 0, changeOwedAgorot: 0 } });
    expect(kick).not.toHaveBeenCalled();
    expect(mag.journal()).toEqual([]);
    expect(h.state().checkout.deviceCash?.stage).toBe('done');
    expect(h.state().checkout.changeAgorot).toBe(0);
    // The X: cash, but never the drawer's.
    const x = buildXTill(h.svc.ledger.docsOfShift(doc.shiftId).map(xDocOf), 20_000, 18).till;
    expect(x.totalCash).toBe(42);
    expect(x.totalDeviceCash).toBe(42);
    expect(x.expectedCash).toBe(200);
    await h.ok('checkout.finish');
    expect(h.state().checkout.deviceCash ?? null).toBeNull();
  });

  it('change owed with a credit on offer: asked before the document; the choice goes on the leg', async () => {
    const fake = new FakeRecycler();
    fake.payWith = async () => paid(10_000, 5_000, 800);
    const { h } = await magTill(fake, { cashmagOwedCredit: true });
    await sale(h);
    await h.ok('deviceCash.pay');
    const d = await until(() => h.state().dialog);
    expect(d.actions.map((a) => a.id)).toEqual(['slip', 'credit']);
    expect(h.state().checkout.deviceCash?.stage).toBe('owed');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'credit' });
    await until(() => h.state().checkout.phase === 'done');
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    const leg = (documentWire(doc) as { payments: Array<{ cashDevice: Record<string, unknown> }> }).payments[0];
    expect(leg.cashDevice).toMatchObject({ changeOwedAgorot: 800, changeOwedAs: 'credit', changeAgorot: 5_000 });
    expect(doc.changeAgorot).toBe(5_800);
    expect(doc.tenderedAgorot).toBe(10_000);
    expect(h.state().checkout.deviceCash?.done).toMatchObject({ owedFromDrawer: false, owedAgorot: 0 });
    expect(h.state().checkout.deviceCash?.done?.notice).toContain('זיכוי להזמנה הבאה');
  });

  it('change owed, a slip only: nothing asked — "נתתי מהמגירה" is a cash out under the drawer\'s rules', async () => {
    const fake = new FakeRecycler();
    fake.payWith = async () => paid(10_000, 5_000, 800);
    const { h } = await magTill(fake, {}, MANAGER_PIN);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => h.state().checkout.phase === 'done');
    expect(h.state().dialog).toBeNull();
    const done = h.state().checkout.deviceCash!.done!;
    expect(done).toMatchObject({ owedAgorot: 800, owedFromDrawer: true, owedPaid: false });
    expect(done.notice).toContain('יש לתת מהמגירה');
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    await h.ok('deviceCash.owedPaid');
    expect(h.engine.drawer.service.shiftTotals(doc.shiftId).movements.cashOut).toBe(800);
    expect(h.state().checkout.deviceCash!.done!.owedPaid).toBe(true);
    expect((await h.fail('deviceCash.owedPaid')).code).toBe('invalid_args');
  });

  it('the machine another client\'s: the busy screen, "חזרה" — nothing sent, the document voided, the tenders back', async () => {
    const fake = new FakeRecycler();
    fake.connectReplies = [refusedReply('CLAIMED_BY_ANOTHER')];
    const { h } = await magTill(fake);
    await sale(h);
    await h.ok('deviceCash.pay');
    const v = await until(() => (h.state().checkout.deviceCash?.stage === 'busy' ? h.state().checkout.deviceCash : null));
    expect(v.message).toBe(CASHMAG_BUSY_TEXT);
    expect(v.cancelLabel).toBe('חזרה');
    const docId = h.svc.ledger.pendingDocs()[0].id;
    await h.ok('checkout.cancel');
    await until(() => h.state().checkout.phase === 'tender');
    expect(fake.calls.filter((c) => c.startsWith('pay'))).toEqual([]);
    expect(h.svc.ledger.doc(docId)!.status).toBe('cancelled');
    expect(h.state().checkout.cardError).toContain('לא נגבה דבר');
    expect(h.state().checkout.legs).toEqual([]);
    expect(h.state().deviceCash?.available).toBe(true);
  });

  it('a fault: no document, CashMag blocked until a manager says "טופל" on "מכשיר מזומן"', async () => {
    const fake = new FakeRecycler();
    fake.payWith = async () => ({ valid: false, error: 'API_IS_BUSY', message: null, reachedDevice: true, balance: balanceOf({ currency: 'ILS', cashInAgorot: 2_000, cashOutAgorot: 0 }), fields: {} });
    const { h, mag } = await magTill(fake);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => h.state().checkout.phase === 'tender' && h.state().checkout.cardError);
    expect(h.state().checkout.cardError).toContain('לא נכתב מסמך');
    expect(h.svc.ledger.pendingDocs()).toEqual([]);
    expect(h.state().deviceCash).toMatchObject({ available: false, unresolvedCount: 1 });
    expect((await h.fail('deviceCash.pay')).message).toContain('ממתין לבירור');
    // The cashier opens the screen: a manager's code (CASH_DRAWER.APPROVE_OPEN).
    const r = await h.ok<{ dialogId?: string }>('deviceCash.open');
    expect(r?.dialogId).toBeTruthy();
    await h.ok('dialog.answer', { dialogId: r.dialogId!, action: 'approve', answers: { pin: MANAGER_PIN } });
    const sc = h.state().deviceCash!.screen!;
    expect(sc.unresolved).toHaveLength(1);
    expect(sc.rows.find((x) => x.label === 'שרת')?.value).toContain('10.0.0.9:5000');
    const ack = await h.ok<{ dialogId?: string }>('deviceCash.acknowledge', { txId: sc.unresolved[0].txId });
    if (ack?.dialogId) await h.ok('dialog.answer', { dialogId: ack.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(mag.unresolved()).toEqual([]);
    expect(h.state().deviceCash?.available).toBe(true);
  });

  it('after a restart: paid → the document now; sent and never answered → voided and the staff\'s', async () => {
    const fake = new FakeRecycler();
    let release: (r: CashRecyclerReply) => void = () => undefined;
    fake.payWith = () => new Promise((r) => (release = r));
    const { h } = await magTill(fake);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => fake.calls.some((c) => c.startsWith('pay')));
    const docId = h.svc.ledger.pendingDocs()[0].id;
    const entry = h.svc.kv.getJson<CashMagEntry[]>('cashmag.journal')![0];
    expect(entry.orderId).toBe(tillCashRef(docId));
    // The till "crashed" with the answer paid on the disk: a new engine over the same device data.
    h.engine.stop();
    h.svc.kv.setJson('cashmag.journal', [{ ...entry, stage: 'paid', insertedAgorot: 5_000, changeAgorot: 800 }]);
    const engine2 = await restart(h.svc, fake);
    await engine2.deviceCash.settle();
    const doc = h.svc.ledger.doc(docId)!;
    expect(doc.status).toBe('completed');
    expect((documentWire(doc) as { payments: Array<Record<string, unknown>> }).payments[0]).toMatchObject({ cashDevice: { receivedAgorot: 5_000, changeAgorot: 800 } });
    expect(engine2.snapshot().checkout.phase).toBe('idle');
    release(paid(0, 0));
    engine2.stop();
  });

  it('after a restart with the payment out and no answer: voided, CashMag waits for "טופל"', async () => {
    const fake = new FakeRecycler();
    fake.payWith = () => new Promise(() => undefined);
    const { h } = await magTill(fake);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => fake.calls.some((c) => c.startsWith('pay')));
    const docId = h.svc.ledger.pendingDocs()[0].id;
    h.engine.stop();
    const engine2 = await restart(h.svc, fake);
    await engine2.deviceCash.settle();
    expect(h.svc.ledger.doc(docId)!.status).toBe('cancelled');
    expect(engine2.snapshot().deviceCash).toMatchObject({ unresolvedCount: 1, available: false });
    engine2.stop();
  });
});

async function restart(svc: KioskService, fake: FakeRecycler) {
  const mag = new CashMagPay({ kv: svc.kv, params: () => svc.cloud.parameters(), log: () => undefined, driverFor: () => fake, pollMs: 20 });
  await mag.probe();
  return new KioskCoreTillEngine({ svc, compare: (p, h) => bcrypt.compare(p, h), shopXLan: { manual: true }, deviceCash: { cashmag: mag, paylink: new FakePaylink(false), online: () => true, settleEveryMs: 0 } });
}

/* ------------------------------------------------------------------ the cash station at the till */

describe('the cash station (PayLink) at the till', () => {
  it('queued, then paid with change: the queue\'s words, the document, the acknowledgement with the document', async () => {
    const link = new FakePaylink();
    let go: () => void = () => undefined;
    link.script = async (txId, progress) => {
      progress({ stage: 'queued', position: 2, tx: null, message: '' });
      await new Promise<void>((r) => (go = r));
      progress({ stage: 'insert', position: 0, tx: tx({ txId, state: 'ACCEPTING', outcome: null, insertedAgorot: 2_000, remainingAgorot: 2_200 }), message: 'הכניסו כסף' });
      return { kind: 'paid', tx: tx({ txId, insertedAgorot: 5_000, changePaidAgorot: 800, changeDueAgorot: 800 }) };
    };
    const h = await linkTill(link);
    await sale(h);
    expect(h.state().deviceCash).toMatchObject({ kind: 'paylink', name: 'עמדת מזומן 1', available: true });
    await h.ok('deviceCash.pay');
    const q = await until(() => (h.state().checkout.deviceCash?.stage === 'busy' ? h.state().checkout.deviceCash : null));
    expect(q.message).toContain('בשימוש כרגע על ידי לקוח אחר');
    expect(q.message).toContain('מקום 2 בתור');
    go();
    await until(() => h.state().checkout.phase === 'done');
    const doc = h.svc.ledger.doc(h.state().checkout.documentId!)!;
    expect((documentWire(doc) as { payments: Array<Record<string, unknown>> }).payments[0]).toMatchObject({ method: 'cash', cashDevice: { stationId: 'st-1', hostId: 'host-1', receivedAgorot: 5_000, changeAgorot: 800 } });
    expect(link.acks).toEqual([{ txId: expect.any(String), documentId: doc.id, extra: { changeOwedAs: null } }]);
    expect(isTillCashRef(link.list[0]?.orderId ?? tillCashRef('x'))).toBe(true);
    expect(h.state().checkout.deviceCash?.done?.notice).toContain('המכשיר נתן עודף');
  });

  it('the station asks about change owed: the till asks, the choice goes to the station with the acknowledgement', async () => {
    const link = new FakePaylink();
    link.script = async (txId) => ({ kind: 'paid', tx: tx({ txId, insertedAgorot: 5_000, changePaidAgorot: 0, changeOwedAgorot: 800, changeOwedAsk: true, slipCode: 'C-ABCDEF' }) });
    const h = await linkTill(link);
    await sale(h);
    await h.ok('deviceCash.pay');
    const d = await until(() => h.state().dialog);
    await h.ok('dialog.answer', { dialogId: d.id, action: 'slip' });
    await until(() => h.state().checkout.phase === 'done');
    expect(link.acks[0].extra).toEqual({ changeOwedAs: 'slip' });
    // A station's slip is the cloud's debt ("עודף חייב ללקוח"): never given from this drawer here.
    expect(h.state().checkout.deviceCash?.done).toMatchObject({ owedAgorot: 800, owedFromDrawer: false });
  });

  it('the station silent mid-payment: not known — "בדוק שוב" settles by its word', async () => {
    const link = new FakePaylink();
    link.script = async (txId) => ({ kind: 'lost', txId, insertedAgorot: 1_000 });
    const h = await linkTill(link);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => h.state().checkout.deviceCash?.stage === 'unknown');
    expect(h.state().checkout.phase).toBe('tender');
    expect((await h.fail('checkout.cancel')).code).toBe('card_in_flight');
    expect((await h.fail('checkout.cash', { amountAgorot: 4_200 })).code).toBe('invalid_args');
    const p = link.list[0];
    await h.ok('deviceCash.recheck');
    expect(h.state().checkout.deviceCash?.stage).toBe('unknown');
    link.lookups.set(p.txId, { kind: 'tx', tx: tx({ txId: p.txId, insertedAgorot: 4_200 }) });
    await h.ok('deviceCash.recheck');
    expect(h.state().checkout.phase).toBe('done');
    expect(h.svc.ledger.doc(p.docId)!.status).toBe('completed');
    expect(link.acks.map((a) => a.documentId)).toEqual([p.docId]);
  });

  it('not known, and a manager says it was not paid: the document voided, the tenders back', async () => {
    const link = new FakePaylink();
    link.script = async (txId) => ({ kind: 'lost', txId, insertedAgorot: 0 });
    const h = await linkTill(link);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => h.state().checkout.deviceCash?.stage === 'unknown');
    const docId = link.list[0].docId;
    const r = await h.ok<{ dialogId?: string }>('deviceCash.markNotPaid');
    await h.ok('dialog.answer', { dialogId: r.dialogId!, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(h.svc.ledger.doc(docId)!.status).toBe('cancelled');
    expect(h.state().checkout.phase).toBe('tender');
    expect(h.state().checkout.cardError).toContain('סומן כלא שולם');
  });

  it('refunded at the station: no document, the words, the tenders back; the button off while the station is not ready', async () => {
    const link = new FakePaylink();
    link.script = async (txId) => ({ kind: 'refunded', tx: tx({ txId, outcome: 'refunded', insertedAgorot: 2_000, refundPaidAgorot: 2_000 }), message: 'הכסף הוחזר' });
    const h = await linkTill(link);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => h.state().checkout.phase === 'tender' && h.state().checkout.cardError);
    expect(h.state().checkout.cardError).toContain('הכסף הוחזר');
    expect(h.svc.ledger.pendingDocs()).toEqual([]);
    link.ok = false;
    expect(h.state().deviceCash).toMatchObject({ available: false, reason: 'מכשיר המזומן לא זמין' });
    expect((await h.fail('deviceCash.pay')).code).toBe('invalid_args');
  });

  it('after a restart: a payment the station says was paid gets its document; one it never started is voided', async () => {
    const link = new FakePaylink();
    link.script = () => new Promise(() => undefined);
    const h = await linkTill(link);
    await sale(h);
    await h.ok('deviceCash.pay');
    await until(() => link.list.length === 1);
    const p = link.list[0];
    h.engine.stop();
    link.inFlight = false;
    link.lookups.set(p.txId, { kind: 'tx', tx: tx({ txId: p.txId, insertedAgorot: 4_200 }) });
    const engine2 = new KioskCoreTillEngine({ svc: h.svc, compare: (a, b) => bcrypt.compare(a, b), shopXLan: { manual: true }, deviceCash: { paylink: link, cashmag: offMag(), online: () => true, settleEveryMs: 0 } });
    await engine2.deviceCash.settle();
    expect(h.svc.ledger.doc(p.docId)!.status).toBe('completed');
    expect(link.acks.map((a) => a.documentId)).toEqual([p.docId]);
    engine2.stop();
  });
});

/* ------------------------------------------------------------------ the kiosk's recovery and the menu */

describe("the kiosk's recovery leaves the till's payments alone; the menu row", () => {
  it("settleCashMag / settleCash skip `till:` entries", async () => {
    const h = await readyTill({ deviceCash: () => ({ paylink: new FakePaylink(false), cashmag: offMag(), settleEveryMs: 0 }) });
    stoppers.push(() => h.stop());
    const entry = { txId: 'aaaaaaaa-0000-4000-8000-000000000001', orderId: tillCashRef('d-9'), docId: 'd-9', amountAgorot: 100, dueAgorot: 100, stationId: 'cashmag:x:1', currency: 'ILS', startedAt: 1, stage: 'sent', outcome: null, insertedAgorot: 0, changeAgorot: 0, owedAgorot: 0, heldAgorot: 0, roundingAgorot: 0, reason: null };
    h.svc.kv.setJson('cashmag.journal', [entry]);
    await h.svc.settleCashMag();
    expect(h.svc.kv.getJson<CashMagEntry[]>('cashmag.journal')).toEqual([entry]);
    h.svc.kv.setJson('cash.pending', [{ txId: 't-1', stationId: 's', leaseId: null, orderId: tillCashRef('d-9'), docId: 'd-9', amountAgorot: 100, orderLabel: null, startedAt: 1, started: true, finalState: null }]);
    await h.svc.settleCash();
    expect(h.svc.cashPay.pending()).toHaveLength(1);
  });

  it('"מכשיר מזומן" in the menu: with a device or a payment waiting, never with APPROVE_OPEN denied', () => {
    const facts = { shiftOpen: true, zOnly: false, hidden: [], denied: [] as string[], current: null } as unknown as Parameters<typeof buildTillMenu>[0];
    const rows = (f: Parameters<typeof buildTillMenu>[0]) => buildTillMenu(f).flatMap((g) => g.rows);
    expect(rows(facts).some((r) => r.target === 'deviceCash')).toBe(false);
    const row = rows({ ...facts, deviceCash: { name: 'CashMag', unresolved: 1 } }).find((r) => r.target === 'deviceCash')!;
    expect(row).toMatchObject({ label: 'מכשיר מזומן', sub: '1 ממתינים לבירור', subError: true, key: null });
    expect(rows({ ...facts, denied: ['CASH_DRAWER.APPROVE_OPEN'], deviceCash: { name: 'CashMag', unresolved: 0 } }).some((r) => r.target === 'deviceCash')).toBe(false);
  });
});
