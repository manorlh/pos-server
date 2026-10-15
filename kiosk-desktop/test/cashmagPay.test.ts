/**
 * "מזומן" at a CashMag machine — the Windows kiosk's flow (kiosk/cashmagPay.ts, P:/specs/cashmag-windows.md §5)
 * with the real driver and client against the in-process fake server: exact, change, change owed, cancel, error
 * statuses, an invalid session, the deposits signal, the server's question, the busy close and the claim signal
 * (busy → free → the payment starts by itself), "חזרה", a drop mid-payment, the restart, and CashMag off (nothing
 * at all).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { CashMagPay, type CashMagEntry, type CashMagProgress } from '../src/main/kiosk/cashmagPay';
import { CASHMAG_BUSY_TEXT, okReply, refusedReply } from '../src/core/cash/cashmag';
import { BUSY_REASON, FakeCashMagServer, FN, payResult, type FakeConn, type FakeServerOptions, type ReceivedCall } from './support/cashmagFakeServer';
import { FakeRecycler } from './support/fakeRecycler';
import type { WsFactory } from '../src/main/cash/cashmagClient';

const stoppers: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0).reverse()) await s();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | null | undefined | false, ms = 8_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
};

async function server(o: FakeServerOptions = {}) {
  const s = new FakeCashMagServer(o);
  await s.listen();
  stoppers.push(() => s.close());
  return s;
}

function kv() {
  const db = openDb(':memory:');
  migrate(db);
  return new Kv(db);
}

interface Rig {
  pay: CashMagPay;
  kv: Kv;
  progress: CashMagProgress[];
  logs: string[];
  knocks: number;
  sockets: number;
}

function rig(port: number, params: Record<string, unknown> = {}, opts: { kv?: Kv; now?: () => number } = {}): Rig {
  const r = { progress: [] as CashMagProgress[], logs: [] as string[], knocks: 0, sockets: 0 } as Rig;
  const realWs = (globalThis as unknown as { WebSocket: new (u: string) => unknown }).WebSocket;
  const factory: WsFactory = (url) => {
    r.sockets++;
    return new realWs(url) as ReturnType<WsFactory>;
  };
  r.kv = opts.kv ?? kv();
  r.pay = new CashMagPay({
    kv: r.kv,
    params: () => ({ cashmagEnabled: true, cashmagHost: '127.0.0.1', cashmagPort: port, cashmagUserCode: '1234', ...params }),
    kioskName: () => 'קיוסק 3',
    log: (m) => r.logs.push(m),
    now: opts.now,
    pollMs: 100,
    probeEveryMs: 60_000,
    driverOptions: {
      factory,
      connectTimeoutMs: 2_000,
      reconnectGraceMs: 400,
      reconnectBaseMs: 50,
      knock: async () => {
        r.knocks++;
        return true;
      },
    },
  });
  stoppers.push(() => r.pay.stop());
  return r;
}

const order = (amountAgorot = 5734) => ({ orderId: 'o-1', docId: 'd-1', amountAgorot });
const payCalls = (s: FakeCashMagServer) => s.calls.filter((c) => c.fn === FN.pay);

/** A payment the test answers: the server holds it until told. */
function heldPay(s: FakeCashMagServer) {
  const box: { call: ReceivedCall | null; conn: FakeConn | null } = { call: null, conn: null };
  s.setHandler(FN.pay, (call, conn) => {
    box.call = call;
    box.conn = conn;
  });
  return box;
}

describe('a CashMag payment at the Windows kiosk', () => {
  it('exact: user, start, the payment in shekels (rounded to 57.30), the deposits live, GOODBYE — paid', async () => {
    const s = await server();
    s.setHandler(FN.pay, (call, conn) => {
      conn.signal('signalDeposits', { deposits: [{ idc_value: '50', ii_qty: 1, ie_fund_type: 3, is_currency: 'ILS' }] });
      setTimeout(() => {
        conn.signal('signalDeposits', { deposits: [{ idc_value: '50', ii_qty: 1, ie_fund_type: 3 }, { idc_value: '5', ii_qty: 1, ie_fund_type: 2 }, { idc_value: '2', ii_qty: 1, ie_fund_type: 2 }, { idc_value: '0.10', ii_qty: 3, ie_fund_type: 2 }] });
        setTimeout(() => conn.result(call.jobId, call.fn, 0, payResult({ balance: '0', deposits: [['50', 1], ['5', 1, 2], ['2', 1, 2], ['0.10', 3, 2]] })), 50);
      }, 50);
    });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), (p) => r.progress.push(p));
    expect(out.kind).toBe('paid');
    if (out.kind !== 'paid') return;
    expect(out.tx).toMatchObject({ hostId: 'cashmag', stationId: `cashmag:127.0.0.1:${s.port}`, state: 'DONE', outcome: 'paid', amountAgorot: 5734, dueAgorot: 5730, roundingAgorot: -4, insertedAgorot: 5730, changePaidAgorot: 0, changeOwedAgorot: 0, changeOwedAsk: false });
    expect(s.calls.map((c) => c.fn)).toEqual([FN.user, FN.start, FN.pay]);
    expect(s.calls[0].params).toEqual({ as_user_name: '1234' });
    expect(s.calls[2].params).toEqual({ adc_transaction_amount: 57.3, as_transaction_currency: 'ILS' });
    expect(r.progress.some((p) => p.stage === 'insert' && p.message === 'הכנס מזומן')).toBe(true);
    expect(r.progress.map((p) => p.insertedAgorot)).toContain(5000);
    expect(r.progress.map((p) => p.insertedAgorot)).toContain(5730);
    await until(() => s.steps.some((x) => x.step === 'GOODBYE'));
    // The journal: paid until the document is written, then closed.
    expect(r.pay.journal()).toMatchObject([{ stage: 'paid', insertedAgorot: 5730, docId: 'd-1' }]);
    await r.pay.ack(out.tx.txId, 'd-1');
    expect(r.pay.journal()).toEqual([]);
    // The user code never in a log line.
    expect(r.logs.join('\n')).not.toContain('1234');
  });

  it('change: 100 in, 42.70 back', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '0', deposits: [['100', 1]], dispensed: [['20', 2], ['2', 1, 2], ['0,50', 1, 2], ['0.10', 2, 2]] })) } });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), (p) => r.progress.push(p));
    expect(out).toMatchObject({ kind: 'paid', tx: { insertedAgorot: 10000, changePaidAgorot: 4270, changeOwedAgorot: 0 } });
  });

  it('change owed (balance below zero): paid, the kiosk asks the customer — a slip code ready', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '-2,70', deposits: [['100', 1]], dispensed: [['20', 2]] })) } });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), (p) => r.progress.push(p));
    expect(out).toMatchObject({ kind: 'paid', tx: { insertedAgorot: 10000, changePaidAgorot: 4000, changeOwedAgorot: 270, changeOwedAsk: true } });
    if (out.kind === 'paid') expect(out.tx.slipCode).toMatch(/^C-[A-Z0-9]{6}$/);
  });

  it('"ביטול" while inserting: dialogCancel, the money back — nothing kept, no fault', async () => {
    const s = await server();
    const box = heldPay(s);
    s.setHandler(FN.cancel, (call, conn) => {
      conn.result(call.jobId, call.fn, 0);
      conn.result(box.call!.jobId, FN.pay, 0, payResult({ balance: '57.30', deposits: [['20', 1]], dispensed: [['20', 1]] }));
    });
    const r = rig(s.port);
    const p = r.pay.pay(order(), (x) => r.progress.push(x));
    await until(() => box.call);
    box.conn!.signal('signalDeposits', { deposits: [{ idc_value: '20', ii_qty: 1 }] });
    await until(() => r.progress.some((x) => x.insertedAgorot === 2000));
    r.pay.cancel();
    const out = await p;
    expect(out).toMatchObject({ kind: 'refunded', message: 'התשלום בוטל — הכסף הוחזר (20 ₪)' });
    expect(s.calls.filter((c) => c.fn === FN.cancel)).toHaveLength(1);
    expect(r.pay.journal()).toEqual([]);
    expect(r.pay.unresolved()).toEqual([]);
  });

  it('an error status with money kept: a fault (no document) — CashMag blocked until a manager says "טופל"', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 5, payResult({ balance: '7.30', deposits: [['50', 1]] }), 'Transaction error') } });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), (p) => r.progress.push(p));
    expect(out).toMatchObject({ kind: 'held', tx: { state: 'HELD', heldAgorot: 5000, hostId: 'cashmag' } });
    expect(r.pay.unresolved()).toMatchObject([{ outcome: 'held', heldAgorot: 5000, reason: 'CM_STATUS_5' }]);
    // The next one is refused before anything is asked.
    const before = s.connections;
    const next = await r.pay.pay({ ...order(), docId: 'd-2' }, () => undefined);
    expect(next).toEqual({ kind: 'refunded', tx: null, message: 'תשלום קודם במכשיר המזומן ממתין לבירור. אנא פנו לצוות.' });
    expect(s.connections).toBe(before);
    expect(r.pay.offReason()).toContain('ממתין לבירור');
    // "טופל" by its short id.
    const short = r.pay.unresolved()[0].txId.replace(/-/g, '').slice(0, 8).toUpperCase();
    expect(r.pay.acknowledge(short, 'מנהל')).toBe(true);
    expect(r.pay.unresolved()).toEqual([]);
  });

  it('an error status with no figures: no telling — a fault, never "nothing happened"', async () => {
    const s = await server({ handlers: { [FN.pay]: (c, conn) => conn.send({ cm_ws_rpc_result: { job_id: c.jobId, function: c.fn, status: { ii_status: 7, ilst_warnings: [], is_message: '?' } } }) } });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), () => undefined);
    expect(out.kind).toBe('held');
    expect(r.pay.unresolved()).toMatchObject([{ outcome: 'unknown', reason: 'CM_STATUS_7' }]);
  });

  it('a session the server forgot: the handshake again, and the payment goes on', async () => {
    const s = await server({ rejectUnknownSessions: true, handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: 0, deposits: [[57.3, 1]] })) } });
    const store = kv();
    store.setJson('cashmag.session', { id: 'stale', at: Date.now() });
    const r = rig(s.port, {}, { kv: store });
    const out = await r.pay.pay(order(), () => undefined);
    expect(out.kind).toBe('paid');
    expect(s.steps.filter((x) => x.step === 'HELLO').map((x) => x.sessionId)).toEqual(['stale', '']);
    expect(store.getJson<{ id: string }>('cashmag.session')!.id).toMatch(/^sess-/);
  });

  it("the server's question: our dialog — confirm sends dialogValid, and the payment ends", async () => {
    const s = await server();
    const box = heldPay(s);
    s.setHandler(FN.valid, (call, conn) => {
      conn.result(call.jobId, call.fn, 0);
      conn.result(box.call!.jobId, FN.pay, 0, payResult({ balance: '0', deposits: [['50', 1], ['10', 1]], dispensed: [['2', 1, 2], ['0.50', 1, 2], ['0.20', 1, 2]] }));
    });
    const r = rig(s.port);
    const p = r.pay.pay(order(), (x) => r.progress.push(x));
    await until(() => box.call);
    box.conn!.signal('signalQuestionNotification', { title: 'אישור', text: 'לסיים את העסקה?' });
    const q = await until(() => r.progress.find((x) => x.stage === 'question'));
    expect(q.question).toEqual({ title: 'אישור', text: 'לסיים את העסקה?' });
    expect(await r.pay.answerQuestion(true)).toBe(true);
    expect((await p).kind).toBe('paid');
    expect(s.calls.filter((c) => c.fn === FN.valid)).toHaveLength(1);
    expect(s.calls.filter((c) => c.fn === FN.cancel)).toHaveLength(0);
  });

  it('busy ("Service occupé !"): the busy screen, asked again — and the payment starts by itself once free', async () => {
    let busy = 2;
    const s = await server({ busy: () => busy-- > 0, handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '0', deposits: [['57.30', 1]] })) } });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), (x) => r.progress.push(x));
    expect(out.kind).toBe('paid');
    const shown = r.progress.find((x) => x.stage === 'busy');
    expect(shown?.message).toBe(CASHMAG_BUSY_TEXT);
    expect(shown?.message).toBe('עמדת המזומן בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום');
    expect(s.closesSent).toBe(2);
    expect(s.connections).toBe(3);
    expect(payCalls(s)).toHaveLength(1);
  });

  it('busy, then "חזרה": nothing charged, no payment ever sent, nothing for the staff', async () => {
    const s = await server({ busy: () => true });
    const r = rig(s.port);
    const p = r.pay.pay(order(), (x) => r.progress.push(x));
    await until(() => r.progress.some((x) => x.stage === 'busy'));
    r.pay.cancel();
    expect(await p).toMatchObject({ kind: 'refunded', message: 'התשלום בוטל — לא נגבה דבר' });
    expect(payCalls(s)).toHaveLength(0);
    expect(r.pay.journal()).toEqual([]);
  });

  it('busy past `cashmagQueueTimeoutSec`: "…נסו שוב", nothing charged', async () => {
    const s = await server({ busy: () => true });
    const r = rig(s.port, { cashmagQueueTimeoutSec: 1 });
    const out = await r.pay.pay(order(), () => undefined);
    expect(out).toMatchObject({ kind: 'refunded', message: 'עמדת המזומן בשימוש כרגע על ידי לקוח אחר — נסו שוב' });
    expect(payCalls(s)).toHaveLength(0);
  });

  it('the claim signal: IN_USE_BY_ANOTHER → the busy screen on the same connection; FREE → the payment starts by itself', async () => {
    const s = await server({
      onWelcome: (conn) => conn.signal('signalClaimStateChanged', { ie_claim_state: 3 }),
      handlers: { [FN.pay]: (c, conn) => conn.result(c.jobId, c.fn, 0, payResult({ balance: '0', deposits: [['57.30', 1]] })) },
    });
    const r = rig(s.port);
    const p = r.pay.pay(order(), (x) => r.progress.push(x));
    await until(() => r.progress.some((x) => x.stage === 'busy'));
    await wait(300);
    expect(payCalls(s)).toHaveLength(0);
    s.live()!.signal('signalClaimStateChanged', { ie_claim_state: 1 });
    const out = await p;
    expect(out.kind).toBe('paid');
    expect(payCalls(s)).toHaveLength(1);
    // The connection was kept while waiting: one.
    expect(s.connections).toBe(1);
    expect(r.progress.find((x) => x.stage === 'busy')?.message).toBe(CASHMAG_BUSY_TEXT);
  });

  it('the claim signal, then "חזרה": nothing sent, nothing charged', async () => {
    const s = await server({ onWelcome: (conn) => conn.signal('signalClaimStateChanged', { ie_claim_state: 3 }) });
    const r = rig(s.port);
    const p = r.pay.pay(order(), (x) => r.progress.push(x));
    await until(() => r.progress.some((x) => x.stage === 'busy'));
    r.pay.cancel();
    expect(await p).toMatchObject({ kind: 'refunded', message: 'התשלום בוטל — לא נגבה דבר' });
    expect(payCalls(s)).toHaveLength(0);
  });

  it('the payment refused while the claim says another client: a wait on that connection, never a fault', async () => {
    let first = true;
    const s = await server({
      handlers: {
        [FN.pay]: (c, conn) => {
          if (first) {
            first = false;
            conn.signal('signalClaimStateChanged', { ie_claim_state: 3 });
            setTimeout(() => conn.send({ cm_ws_rpc_result: { job_id: c.jobId, function: c.fn, status: { ii_status: 9, ilst_warnings: [], is_message: 'busy' } } }), 30);
            setTimeout(() => conn.signal('signalClaimStateChanged', { ie_claim_state: 1 }), 400);
            return;
          }
          conn.result(c.jobId, c.fn, 0, payResult({ balance: '0', deposits: [['57.30', 1]] }));
        },
      },
    });
    const r = rig(s.port);
    const out = await r.pay.pay(order(), (x) => r.progress.push(x));
    expect(out.kind).toBe('paid');
    expect(payCalls(s)).toHaveLength(2);
    expect(r.progress.some((x) => x.stage === 'busy')).toBe(true);
    expect(r.pay.unresolved()).toEqual([]);
  });

  it('the connection lost mid-payment and never back: a fault for the staff (no telling)', async () => {
    const s = await server();
    const box = heldPay(s);
    const r = rig(s.port);
    const p = r.pay.pay(order(), (x) => r.progress.push(x));
    await until(() => box.call);
    box.conn!.signal('signalDeposits', { deposits: [{ idc_value: '50', ii_qty: 1 }] });
    await until(() => r.progress.some((x) => x.insertedAgorot === 5000));
    await s.close();
    const out = await p;
    expect(out).toMatchObject({ kind: 'held', tx: { heldAgorot: 5000 } });
    expect(r.pay.unresolved()).toMatchObject([{ outcome: 'unknown', reason: 'DISCONNECTED', insertedAgorot: 5000 }]);
  });

  it('the server unreachable: "אין חיבור לשרת CashMag", nothing kept — the other ways to pay stay', async () => {
    const s = await server();
    const port = s.port;
    await s.close();
    const r = rig(port);
    const out = await r.pay.pay(order(), () => undefined);
    expect(out).toEqual({ kind: 'refunded', tx: null, message: 'אין חיבור לשרת CashMag' });
    expect(r.pay.journal()).toEqual([]);
  });

  it('CashMag off: no driver, no knock, no connection — and the payment refused', async () => {
    const s = await server();
    const r = rig(s.port, { cashmagEnabled: false });
    r.pay.start();
    await r.pay.probe();
    const out = await r.pay.pay(order(), () => undefined);
    expect(out).toEqual({ kind: 'refunded', tx: null, message: 'מכשיר המזומן לא מוגדר לקיוסק' });
    expect(r.knocks).toBe(0);
    expect(r.sockets).toBe(0);
    expect(s.connections).toBe(0);
    expect(r.pay.enabled()).toBe(false);
    expect(r.pay.unreachableAlert()).toBeNull();
  });

  it('RLP: "not available" — never guessed', async () => {
    const r = rig(1, { cashmagProtocol: 'rlp' });
    expect(r.pay.offReason()).toBe('פרוטוקול CashMag שנבחר עוד לא נתמך');
    expect((await r.pay.pay(order(), () => undefined)).kind).toBe('refunded');
    expect(r.sockets).toBe(0);
  });
});

describe('CashMag idle, alerts and restarts (a fake recycler)', () => {
  function fakeRig(fake: FakeRecycler, params: Record<string, unknown> = {}, now: () => number = Date.now) {
    const store = kv();
    const pay = new CashMagPay({
      kv: store,
      params: () => ({ cashmagEnabled: true, cashmagHost: '10.0.0.5', cashmagPort: 65000, ...params }),
      log: () => undefined,
      now,
      pollMs: 50,
      probeEveryMs: 15_000,
      driverFor: () => fake,
    });
    stoppers.push(() => pay.stop());
    return { pay, store };
  }

  it('the tile: offered once the server answers a knock; a minute silent → the kiosk’s `cash` alert', async () => {
    let t = 1_000_000;
    const fake = new FakeRecycler();
    const { pay } = fakeRig(fake, {}, () => t);
    expect(pay.usable()).toBe(false);
    await pay.probe();
    expect(pay.usable()).toBe(true);
    fake.reachable = false;
    t += 50_000;
    await pay.probe();
    expect(pay.usable()).toBe(false);
    expect(pay.offReason()).toBe('אין חיבור לשרת CashMag');
    expect(pay.unreachableAlert()).toBeNull();
    t += 61_000;
    expect(pay.unreachableAlert()).toEqual({
      kind: 'cash',
      key: 'cash:cashmag:unreachable',
      reason: 'unreachable',
      text: 'אין קשר לשרת CashMag (10.0.0.5:65000)',
      detail: { stationId: 'cashmag:10.0.0.5:65000', stationName: 'CashMag', device: 'cashmag' },
    });
    // Only knocks: never a connection while idle.
    expect(fake.calls.filter((c) => c !== 'probe')).toEqual([]);
  });

  it('the kiosk’s own settings (kiosk.json) win for the server, the name and the user code; the rest only from the cloud', () => {
    const store = kv();
    const pay = new CashMagPay({
      kv: store,
      params: () => ({ cashmagEnabled: 'true', cashmagHost: '10.0.0.5', cashmagPort: '65000', cashmagUserCode: '11', cashmagCurrency: 'ils', cashmagTerminal: '' }),
      local: () => ({ host: '192.168.1.40', port: 65001, terminal: 'קיוסק ליד המכונה', userCode: '22' }),
      kioskName: () => 'קיוסק 3',
      log: () => undefined,
    });
    const c = pay.config();
    expect(c).toMatchObject({ enabled: true, host: '192.168.1.40', port: 65001, terminal: 'קיוסק ליד המכונה', userCode: '22', currency: 'ILS', protocol: 'jar', rounding: 'nearest_10', queueTimeoutSec: 0 });
    expect(c.sources).toEqual({ host: 'local', port: 'local', terminal: 'local', userCode: 'local' });
    expect(pay.stationId()).toBe('cashmag:192.168.1.40:65001');
  });

  it('only one payment at a time; a busy wait with "חזרה" from a fake that is always another client’s', async () => {
    const fake = new FakeRecycler();
    fake.connectReplies = [refusedReply('CLAIMED_BY_ANOTHER')];
    const { pay } = fakeRig(fake);
    const progress: CashMagProgress[] = [];
    const p = pay.pay(order(), (x) => progress.push(x));
    expect(await pay.pay({ ...order(), docId: 'd-2' }, () => undefined)).toMatchObject({ kind: 'refunded' });
    await until(() => progress.some((x) => x.stage === 'busy'));
    pay.cancel();
    expect(await p).toMatchObject({ kind: 'refunded', message: 'התשלום בוטל — לא נגבה דבר' });
    expect(fake.calls.filter((c) => c.startsWith('pay'))).toEqual([]);
  });

  it('a busy refusal at the payment with money already in: never asked again — a fault', async () => {
    const fake = new FakeRecycler();
    fake.payWith = async () => ({ valid: false, error: 'API_IS_BUSY', message: null, reachedDevice: true, balance: { currency: 'ILS', transactionAgorot: null, roundedAgorot: null, cashInAgorot: 2000, cashOutAgorot: 0, customerBalanceAgorot: null, merchantBalanceAgorot: null, overDispensedAgorot: null, cashIn: [], cashOut: [] }, fields: {} });
    const { pay } = fakeRig(fake);
    const out = await pay.pay(order(), () => undefined);
    expect(out).toMatchObject({ kind: 'held', tx: { heldAgorot: 2000 } });
    expect(fake.calls.filter((c) => c.startsWith('pay'))).toHaveLength(1);
  });

  it('the device not started: "not available", nothing kept', async () => {
    const fake = new FakeRecycler();
    fake.startReply = refusedReply('NOT_STARTED', 'no device');
    const { pay } = fakeRig(fake);
    expect(await pay.pay(order(), () => undefined)).toEqual({ kind: 'refunded', tx: null, message: 'מכשיר המזומן לא הופעל' });
    expect(pay.journal()).toEqual([]);
  });

  it('after a restart: answered paid → its document; sent and never answered → voided, the staff’s; never sent → voided, closed', async () => {
    const fake = new FakeRecycler();
    const { pay, store } = fakeRig(fake);
    const base: CashMagEntry = { txId: '', orderId: 'o', docId: '', amountAgorot: 5734, dueAgorot: 5730, stationId: 'cashmag:10.0.0.5:65000', currency: 'ILS', startedAt: 1, stage: 'started', outcome: null, insertedAgorot: 0, changeAgorot: 0, owedAgorot: 0, heldAgorot: 0, roundingAgorot: -4, reason: null };
    store.setJson('cashmag.journal', [
      { ...base, txId: 'aaaaaaaa-0000-4000-8000-000000000001', docId: 'd-started' },
      { ...base, txId: 'aaaaaaaa-0000-4000-8000-000000000002', docId: 'd-sent', stage: 'sent' },
      { ...base, txId: 'aaaaaaaa-0000-4000-8000-000000000003', docId: 'd-paid', stage: 'paid', insertedAgorot: 10000, changeAgorot: 4000, owedAgorot: 270 },
    ]);
    const voided: string[] = [];
    const written: Array<{ doc: string; owed: number; rounding: number }> = [];
    await pay.settle({
      docStatus: () => 'pending',
      writePaid: async (e, tx) => {
        written.push({ doc: e.docId, owed: tx.changeOwedAgorot, rounding: tx.roundingAgorot });
        return true;
      },
      voidDoc: (e, outcome) => voided.push(`${e.docId}:${outcome}`),
    });
    expect(voided).toEqual(['d-started:not_started', 'd-sent:interrupted']);
    expect(written).toEqual([{ doc: 'd-paid', owed: 270, rounding: -4 }]);
    expect(pay.unresolved()).toMatchObject([{ docId: 'd-sent', outcome: 'interrupted' }]);
    expect(pay.journal()).toHaveLength(1);
    // Nothing is asked of the device on a restart (there is no lookup by id).
    expect(fake.calls).toEqual([]);
    expect(okReply().valid).toBe(true);
  });

  it('the fake-only check that the busy reason text is the vendor’s', () => {
    expect(BUSY_REASON).toBe('Service occupé !');
  });
});
