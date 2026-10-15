/**
 * Cash stage 2 at the station (P:/specs/cash-paylink.md §11.15), with the simulator:
 *  - `ask`: change the unit could not pay — the client asks the customer (slip / credit / tip) and acknowledges the
 *    choice, kept once; without `ask` it is always a slip;
 *  - cash + card: `split` while accepting → PARTIAL (the cash part, no rounding) → `finish` (DONE paid) or `cancel`
 *    (refunded); a client gone → refunded after the grace; too long → HELD `split_timeout`; a voided document → HELD
 *    `split_void`; a power cut in PARTIAL → HELD like any open state.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashStation, type StationConfig } from '../src/main/cash/station';
import { SimulatedPaylink, type SimConfig } from '../src/main/cash/simulator';
import { cashSettingsOf } from '../src/core/cash/settings';
import { matchRoute } from '../src/core/cash/lanProtocol';
import type { TxView } from '../src/core/cash/tx';

const KIOSK = '11111111-1111-4111-8111-111111111111';

class Clock {
  t = 1_760_000_000_000;
  now = () => this.t;
}

const HOPPERS: SimConfig = {
  coins: [10, 50, 100, 200, 500, 1000],
  notes: { values: [2000, 5000, 10000, 20000], bus: 'id003', escrow: true },
  hoppers: [
    { valueAgorot: 1000, count: 50 },
    { valueAgorot: 500, count: 50 },
    { valueAgorot: 100, count: 50 },
    { valueAgorot: 10, count: 100 },
  ],
};

function world(over: Record<string, unknown> = {}, shared?: { db: ReturnType<typeof openDb>; device?: SimulatedPaylink; clock?: Clock }) {
  const db = shared?.db ?? openDb(':memory:');
  if (!shared) migrate(db);
  const clock = shared?.clock ?? new Clock();
  const device = shared?.device ?? new SimulatedPaylink({ autoTakeBills: true, piecesPerRead: 3, ...HOPPERS }, clock.now);
  const cfg: StationConfig = {
    stationId: 'st-1',
    name: 'עמדת מזומן 1',
    location: null,
    serial: '',
    settings: cashSettingsOf({ cashSettleMs: 400, ...over }),
    clients: [{ machineId: KIOSK, name: 'קיוסק 1', kind: 'kiosk' }],
  };
  const station = new CashStation(cfg, {
    hostId: () => 'host-1',
    device,
    journal: new CashJournal(db),
    now: clock.now,
    newId: () => randomUUID(),
    log: () => undefined,
    driverInstalled: () => true,
  });
  return { db, clock, device, station };
}

type W = ReturnType<typeof world>;

async function run(w: W, ms: number, step = 200, renew = true) {
  for (let t = 0; t <= ms; t += step) {
    if (renew && t % 2_000 === 0 && w.station.status(KIOSK).you.leaseId) w.station.lease(KIOSK, {});
    await w.station.tick();
    w.clock.t += step;
  }
}

function start(w: W, amount: number): TxView {
  const l = w.station.lease(KIOSK, {}).body as { leaseId: string };
  const r = w.station.startTx(KIOSK, randomUUID(), { leaseId: l.leaseId, amountAgorot: amount, orderRef: 'o-1', orderLabel: '57' });
  expect(r.status).toBe(200);
  return r.body as TxView;
}

const tx = (w: W, id: string) => w.station.getTx(KIOSK, id).body as TxView;

async function until(w: W, id: string, states: string[], maxMs = 30_000, renew = true): Promise<TxView> {
  for (let t = 0; t < maxMs; t += 200) {
    if (renew && t % 2_000 === 0 && w.station.status(KIOSK).you.leaseId) w.station.lease(KIOSK, {});
    await w.station.tick();
    w.clock.t += 200;
    if (states.includes(tx(w, id).state)) return tx(w, id);
  }
  throw new Error(`stuck in ${tx(w, id).state}`);
}

/** Change of 13 ₪ with every hopper jammed: all of it owed. */
async function owedSale(w: W): Promise<TxView> {
  await run(w, 600);
  const t = start(w, 3700);
  await run(w, 400);
  for (const v of [1000, 500, 100, 10]) w.device.jam(v);
  w.device.insert(5000);
  return until(w, t.txId, ['DONE']);
}

describe('ask (§11.15א): the customer chooses what to do with the change owed', () => {
  it('ask: changeOwedAsk; the choice acknowledged is kept once', async () => {
    const w = world({ cashChangeShortfall: 'ask' });
    const done = await owedSale(w);
    expect(done.outcome).toBe('paid');
    expect(done.changeOwedAgorot).toBeGreaterThan(0);
    expect(done.changeOwedAsk).toBe(true);
    expect(done.changeOwedAs).toBeNull();
    expect(done.message).toMatch(/^חסר עודף/);
    const acked = w.station.ackTx(KIOSK, done.txId, { documentId: 'd-1', changeOwedAs: 'credit' });
    expect(acked.status).toBe(200);
    expect((acked.body as TxView).changeOwedAs).toBe('credit');
    expect((acked.body as TxView).acked).toBe(true);
    // A second acknowledgement with another choice changes nothing.
    expect((w.station.ackTx(KIOSK, done.txId, { documentId: 'd-1', changeOwedAs: 'tip' }).body as TxView).changeOwedAs).toBe('credit');
  });

  it('ask: an unknown choice (or none) is a slip', async () => {
    const w = world({ cashChangeShortfall: 'ask' });
    const done = await owedSale(w);
    expect((w.station.ackTx(KIOSK, done.txId, { changeOwedAs: 'lottery' }).body as TxView).changeOwedAs).toBe('slip');
  });

  it('notify: never asked — whatever the client says, a slip', async () => {
    const w = world({ cashChangeShortfall: 'notify' });
    const done = await owedSale(w);
    expect(done.changeOwedAsk).toBe(false);
    expect(done.message).toMatch(/הפתק יודפס/);
    expect((w.station.ackTx(KIOSK, done.txId, { changeOwedAs: 'tip' }).body as TxView).changeOwedAs).toBe('slip');
  });

  it('nothing owed: no choice recorded', async () => {
    const w = world({ cashChangeShortfall: 'ask' });
    await run(w, 600);
    const t = start(w, 3000);
    await run(w, 400);
    w.device.insert(1000);
    w.device.insert(2000);
    const done = await until(w, t.txId, ['DONE']);
    const acked = w.station.ackTx(KIOSK, done.txId, { changeOwedAs: 'tip' }).body as TxView;
    expect([acked.changeOwedAsk, acked.changeOwedAs]).toEqual([false, null]);
  });
});

describe('cash + card (§11.15ב): split, PARTIAL, finish', () => {
  async function partial(w: W, amount = 8900, inserted = [2000, 2000]): Promise<TxView> {
    await run(w, 600);
    const t = start(w, amount);
    await run(w, 400);
    for (const v of inserted) {
      w.device.insert(v);
      await run(w, 400);
    }
    await run(w, 1_000);
    expect(tx(w, t.txId).insertedAgorot).toBe(inserted.reduce((s, v) => s + v, 0));
    const r = w.station.splitTx(KIOSK, t.txId);
    expect(r.status).toBe(200);
    return until(w, t.txId, ['PARTIAL']);
  }

  it('split → PARTIAL with the cash part (no rounding), closed to money; finish → DONE paid; repeats harmlessly', async () => {
    const w = world();
    const p = await partial(w, 8935);
    expect(p.splitAgorot).toBe(4000);
    expect(p.dueAgorot).toBe(4000);
    expect(p.roundingAgorot).toBe(0);
    expect(p.amountAgorot).toBe(8935);
    expect(p.message).toBe('השלימו את התשלום באשראי');
    expect(w.device.insert(1000)).toBe('rejected');
    const f = w.station.finishTx(KIOSK, p.txId);
    expect(f.status).toBe(200);
    const done = f.body as TxView;
    expect([done.state, done.outcome, done.splitAgorot, done.changeDueAgorot]).toEqual(['DONE', 'paid', 4000, 0]);
    expect(w.station.finishTx(KIOSK, p.txId).status).toBe(200);
    expect(w.station.ackTx(KIOSK, p.txId, { documentId: 'd-1' }).status).toBe(200);
  });

  it('cancel in PARTIAL: everything inserted comes back — DONE refunded', async () => {
    const w = world();
    const p = await partial(w);
    expect(w.station.cancelTx(KIOSK, p.txId, 'customer').status).toBe(200);
    const done = await until(w, p.txId, ['DONE', 'HELD']);
    expect([done.state, done.outcome, done.refundPaidAgorot]).toEqual(['DONE', 'refunded', 4000]);
    expect(w.station.finishTx(KIOSK, p.txId).status).toBe(409);
  });

  it('refused: nothing inserted / not accepting; finish outside PARTIAL', async () => {
    const w = world();
    await run(w, 600);
    const t = start(w, 5000);
    await run(w, 400);
    expect(w.station.splitTx(KIOSK, t.txId)).toMatchObject({ status: 409, body: { error: 'nothing_inserted' } });
    expect(w.station.finishTx(KIOSK, t.txId)).toMatchObject({ status: 409, body: { error: 'not_partial' } });
    w.device.insert(5000);
    const done = await until(w, t.txId, ['DONE']);
    expect(w.station.splitTx(KIOSK, done.txId)).toMatchObject({ status: 409, body: { error: 'not_accepting' } });
  });

  it('the kiosk stops renewing in PARTIAL: refunded at the device after the grace', async () => {
    const w = world({ cashRefundGraceSec: 20 });
    const p = await partial(w);
    await run(w, 8_000, 500, false);
    expect(tx(w, p.txId).state).toBe('PARTIAL');
    const done = await until(w, p.txId, ['DONE', 'HELD'], 40_000, false);
    expect([done.outcome, done.cancelReason, done.refundPaidAgorot]).toEqual(['refunded', 'client_gone', 4000]);
  });

  it('longer than cashSplitWaitSec in PARTIAL: HELD split_timeout — never refunded (the card may be charged)', async () => {
    const w = world({ cashSplitWaitSec: 60 });
    const p = await partial(w);
    const held = await until(w, p.txId, ['HELD', 'DONE'], 90_000);
    expect([held.state, held.heldReason, held.heldAgorot, held.refundPaidAgorot]).toEqual(['HELD', 'split_timeout', 4000, 0]);
  });

  it('the document was voided (ack void): the cash part is held for the customer', async () => {
    const w = world();
    const p = await partial(w);
    w.station.finishTx(KIOSK, p.txId);
    const r = w.station.ackTx(KIOSK, p.txId, { void: true });
    expect(r.status).toBe(200);
    const held = r.body as TxView;
    expect([held.state, held.heldReason, held.heldAgorot, held.acked]).toEqual(['HELD', 'split_void', 4000, true]);
    expect(held.slipCode).toMatch(/^C-/);
    // `void` on a sale that was not split is ignored.
    const w2 = world();
    await run(w2, 600);
    const t = start(w2, 3000);
    await run(w2, 400);
    w2.device.insert(1000);
    w2.device.insert(2000);
    const done = await until(w2, t.txId, ['DONE']);
    expect((w2.station.ackTx(KIOSK, done.txId, { void: true }).body as TxView).state).toBe('DONE');
  });

  it('a power cut in PARTIAL: HELD after the restart, nothing paid by itself', async () => {
    const shared = { db: openDb(':memory:'), clock: new Clock() };
    migrate(shared.db);
    const w1 = world({}, shared);
    const p = await partial(w1);
    w1.device.powerCut();
    const w2 = world({}, { ...shared, device: w1.device });
    await run(w2, 1_000);
    const held = tx(w2, p.txId);
    expect([held.state, held.heldReason, held.heldAgorot]).toEqual(['HELD', 'power_loss', 4000]);
  });

  it('the LAN routes', () => {
    const id = '7c0e5a1b-2d3f-4c5e-8a9b-0c1d2e3f4a5b';
    expect(matchRoute('POST', `/cash/stations/st-1/tx/${id}/split`)).toEqual({ kind: 'tx_split', stationId: 'st-1', txId: id });
    expect(matchRoute('POST', `/cash/stations/st-1/tx/${id}/finish`)).toEqual({ kind: 'tx_finish', stationId: 'st-1', txId: id });
    expect(matchRoute('GET', `/cash/stations/st-1/tx/${id}/split`)).toBeNull();
  });
});
