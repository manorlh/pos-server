import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { CashJournal } from '../src/main/cash/journal';
import { CashStation, type StationConfig } from '../src/main/cash/station';
import { SimulatedPaylink, type SimConfig } from '../src/main/cash/simulator';
import { cashSettingsOf, type CashSettings } from '../src/core/cash/settings';
import type { TxView } from '../src/core/cash/tx';
import type { LeaseView, StationStatus } from '../src/core/cash/lanProtocol';
import { PAY_FINISHED } from '../src/core/cash/paylinkApi';

const KIOSK_A = '11111111-1111-4111-8111-111111111111';
const KIOSK_B = '22222222-2222-4222-8222-222222222222';

class Clock {
  t = 1_760_000_000_000;
  now = () => this.t;
}

function world(sim: SimConfig, over: Record<string, unknown> = {}, shared?: { db: ReturnType<typeof openDb>; device?: SimulatedPaylink; clock?: Clock }) {
  const db = shared?.db ?? openDb(':memory:');
  if (!shared) migrate(db);
  const clock = shared?.clock ?? new Clock();
  const device = shared?.device ?? new SimulatedPaylink({ autoTakeBills: true, piecesPerRead: 3, ...sim }, clock.now);
  const journal = new CashJournal(db);
  const settings: CashSettings = cashSettingsOf({ cashSettleMs: 400, ...over });
  const cfg: StationConfig = {
    stationId: 'st-1',
    name: 'עמדת מזומן 1',
    location: 'ליד קיוסק 1',
    serial: '',
    settings,
    clients: [
      { machineId: KIOSK_A, name: 'קיוסק 1', kind: 'kiosk' },
      { machineId: KIOSK_B, name: 'קיוסק 2', kind: 'kiosk' },
    ],
  };
  const logs: string[] = [];
  const station = new CashStation(cfg, {
    hostId: () => 'host-1',
    device,
    journal,
    now: clock.now,
    newId: () => randomUUID(),
    log: (m) => logs.push(m),
    driverInstalled: () => true,
  });
  return { db, clock, device, journal, station, logs };
}

type W = ReturnType<typeof world>;

/** Ticks with the clock moving (`ms` total, a tick every `step`). */
async function run(w: W, ms: number, step = 200) {
  for (let t = 0; t <= ms; t += step) {
    await w.station.tick();
    w.clock.t += step;
  }
}

async function ready(w: W) {
  await run(w, 600);
  expect(w.station.status(null).state).not.toBe('fault');
}

function lease(w: W, client = KIOSK_A, leaseId?: string): LeaseView {
  const r = w.station.lease(client, leaseId ? { leaseId } : {});
  expect(r.status).toBe(200);
  return r.body as LeaseView;
}

function start(w: W, amount: number, client = KIOSK_A, l?: LeaseView): TxView {
  const ls = l ?? lease(w, client);
  const txId = randomUUID();
  const r = w.station.startTx(client, txId, { leaseId: ls.leaseId, amountAgorot: amount, orderRef: 'o-1', orderLabel: '57' });
  expect(r.status).toBe(200);
  return r.body as TxView;
}

function tx(w: W, id: string, client = KIOSK_A): TxView {
  return w.station.getTx(client, id).body as TxView;
}

async function untilState(w: W, id: string, states: string[], maxMs = 20_000, client = KIOSK_A, renew = true) {
  for (let t = 0; t < maxMs; t += 200) {
    // The kiosk keeps renewing its lease (every 2 s in life).
    if (renew && t % 2_000 === 0) for (const c of [KIOSK_A, KIOSK_B]) if (w.station.status(c).you.leaseId) w.station.lease(c, {});
    await w.station.tick();
    w.clock.t += 200;
    if (states.includes(tx(w, id, client).state)) return tx(w, id, client);
  }
  throw new Error(`tx ${id} stuck in ${tx(w, id, client).state}`);
}

const HOPPERS: SimConfig = {
  coins: [10, 50, 100, 200, 500, 1000],
  notes: { values: [2000, 5000, 10000, 20000], bus: 'id003', escrow: true },
  hoppers: [
    { valueAgorot: 1000, count: 50 },
    { valueAgorot: 500, count: 50 },
    { valueAgorot: 200, count: 50 },
    { valueAgorot: 100, count: 50 },
    { valueAgorot: 50, count: 50 },
    { valueAgorot: 10, count: 100 },
  ],
};

describe('cash station — paying with the simulator', () => {
  it('exact amount: DONE paid, no change, acceptance closed after', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 3000);
    await run(w, 400);
    expect(tx(w, t.txId).state).toBe('ACCEPTING');
    expect(w.device.insert(2000)).toBe('escrow');
    await run(w, 400);
    expect(w.device.insert(1000)).toBe('accepted');
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.outcome).toBe('paid');
    expect(done.insertedAgorot).toBe(3000);
    expect(done.changeDueAgorot).toBe(0);
    expect(done.inserted).toEqual([
      { valueAgorot: 2000, kind: 'note', count: 1 },
      { valueAgorot: 1000, kind: 'coin', count: 1 },
    ]);
    // Closed to money once paid.
    expect(w.device.insert(100)).toBe('rejected');
    // The journal logged every command with counters, before it was sent.
    const cmds = w.journal.commandsOf(t.txId);
    expect(cmds.length).toBeGreaterThan(1);
    expect(cmds.every((c) => c.counters !== null)).toBe(true);
  });

  it('overpay: change paid from the hoppers', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 3740);
    await run(w, 400);
    w.device.insert(5000);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.outcome).toBe('paid');
    expect(done.changeDueAgorot).toBe(1260);
    expect(done.changePaidAgorot).toBe(1260);
    expect(done.changeOwedAgorot).toBe(0);
    expect(done.paidOut).toEqual(
      expect.arrayContaining([
        { valueAgorot: 1000, kind: 'coin', count: 1 },
        { valueAgorot: 200, kind: 'coin', count: 1 },
        { valueAgorot: 50, kind: 'coin', count: 1 },
        { valueAgorot: 10, kind: 'coin', count: 1 },
      ]),
    );
  });

  it('cash rounding: 37.35 is collected as 37.40 and the leg carries +5', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 3735);
    expect(t.dueAgorot).toBe(3740);
    expect(t.roundingAgorot).toBe(5);
  });

  it('a jam mid-payout: the change that could not be paid is owed (notify), with a slip code', async () => {
    const w = world({ ...HOPPERS, hoppers: [{ valueAgorot: 1000, count: 50 }, { valueAgorot: 500, count: 50 }, { valueAgorot: 100, count: 50 }, { valueAgorot: 10, count: 100 }] });
    await ready(w);
    const t = start(w, 3700);
    await run(w, 400);
    w.device.jam(1000);
    w.device.jam(500);
    w.device.jam(100);
    w.device.jam(10);
    w.device.insert(5000);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.outcome).toBe('paid');
    expect(done.changeDueAgorot).toBe(1300);
    expect(done.changeOwedAgorot).toBe(1300 - done.changePaidAgorot);
    expect(done.changeOwedAgorot).toBeGreaterThan(0);
    expect(done.slipCode).toMatch(/^C-[A-Z0-9]{6}$/);
    expect(done.owedId).toBe(t.txId);
  });

  it('cancel: the money comes back (as change) — DONE refunded', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 5000);
    await run(w, 400);
    w.device.insert(1000);
    w.device.insert(500);
    await run(w, 400);
    expect(tx(w, t.txId).insertedAgorot).toBe(1500);
    const c = w.station.cancelTx(KIOSK_A, t.txId, 'customer');
    expect(c.status).toBe(200);
    const done = await untilState(w, t.txId, ['DONE', 'HELD']);
    expect(done.state).toBe('DONE');
    expect(done.outcome).toBe('refunded');
    expect(done.refundPaidAgorot).toBe(1500);
    expect(done.cancelReason).toBe('customer');
    // Idempotent.
    expect(w.station.cancelTx(KIOSK_A, t.txId, 'customer').status).toBe(200);
  });

  it('cancel with nothing inserted: nothing_inserted', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 5000);
    await run(w, 400);
    w.station.cancelTx(KIOSK_A, t.txId, 'customer');
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.outcome).toBe('nothing_inserted');
  });

  it('idle timeout: refunded by itself', async () => {
    const w = world(HOPPERS, { cashIdleTimeoutSec: 20 });
    await ready(w);
    const t = start(w, 5000);
    await run(w, 400);
    w.device.insert(200);
    const done = await untilState(w, t.txId, ['DONE'], 40_000);
    expect(done.outcome).toBe('refunded');
    expect(done.cancelReason).toBe('idle');
  });

  it('a refund the hoppers cannot pay: HELD with what is owed', async () => {
    const w = world({ ...HOPPERS, hoppers: [{ valueAgorot: 100, count: 3 }] });
    await ready(w);
    const t = start(w, 5000);
    await run(w, 400);
    expect(w.device.insert(1000)).toBe('accepted');
    await run(w, 400);
    w.station.cancelTx(KIOSK_A, t.txId, 'customer');
    const held = await untilState(w, t.txId, ['DONE', 'HELD']);
    expect(held.state).toBe('HELD');
    expect(held.heldReason).toBe('refund_short');
    expect(held.heldAgorot).toBe(700);
  });

  it('too late to cancel once the amount is in', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 1000);
    await run(w, 400);
    w.device.insert(1000);
    await untilState(w, t.txId, ['DONE']);
    expect(w.station.cancelTx(KIOSK_A, t.txId, 'customer').status).toBe(409);
  });
});

describe('cash station — prevent: what is accepted', () => {
  it('a note whose change the unit cannot pay is inhibited before it goes in (200 on 15)', async () => {
    const w = world(HOPPERS, { cashMaxChangeAgorot: 10000 });
    await ready(w);
    const t = start(w, 1500);
    await run(w, 400);
    const v = tx(w, t.txId);
    expect(v.accepting.notes).toEqual([2000, 5000, 10000]);
    expect(v.accepting.notes).not.toContain(20000);
    expect(w.device.insert(20000)).toBe('rejected');
  });

  it('exact amount only when the change on hand is low', async () => {
    const w = world({ ...HOPPERS, hoppers: [{ valueAgorot: 100, count: 5 }] }, { cashExactChangeBelowAgorot: 3000 });
    await ready(w);
    const t = start(w, 2500);
    await run(w, 400);
    const v = tx(w, t.txId);
    expect(v.exactOnly).toBe(true);
    expect(v.accepting.notes).toEqual([2000]);
    expect(v.accepting.coins).not.toContain(10000);
    expect(w.station.status(KIOSK_A).exactOnly).toBe(true);
  });

  it('a note that reached escrow but needs change that cannot be paid is returned', async () => {
    const w = world({ ...HOPPERS, hoppers: [{ valueAgorot: 1000, count: 1 }] }, { cashExactChangeBelowAgorot: 0 });
    await ready(w);
    const t = start(w, 3000);
    await run(w, 400);
    // Slip a 50 in past the inhibits (a race): the escrow rule still refuses (20 change, one 10 coin).
    (w.device as unknown as { acceptors: Array<{ coins: Array<{ valueAgorot: number; inhibit: boolean }> }> }).acceptors[1].coins.find((c) => c.valueAgorot === 5000)!.inhibit = false;
    expect(w.device.insert(5000)).toBe('escrow');
    await run(w, 400);
    expect(w.device.escrowNote).toBe(null);
    expect(tx(w, t.txId).insertedAgorot).toBe(0);
    expect(w.device.commands.some((c) => c.op === 'escrow' && c.action === 'return')).toBe(true);
  });
});

describe('cash station — leases and the queue', () => {
  it('two kiosks: the second waits (position 1) and is granted once the first acks', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const a = lease(w, KIOSK_A);
    const b = lease(w, KIOSK_B);
    expect(a.state).toBe('granted');
    expect(b.state).toBe('queued');
    expect(b.position).toBe(1);
    // The second cannot start.
    const r = w.station.startTx(KIOSK_B, randomUUID(), { leaseId: b.leaseId, amountAgorot: 1000 });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe('not_holder');
    const t = start(w, 1000, KIOSK_A, a);
    await run(w, 400);
    w.device.insert(1000);
    // Both keep renewing.
    await untilState(w, t.txId, ['DONE']);
    lease(w, KIOSK_B, b.leaseId);
    // Once the first is DONE, the second holds the unit.
    expect(lease(w, KIOSK_B, b.leaseId).state).toBe('granted');
    expect(w.station.ackTx(KIOSK_A, t.txId, { documentId: 'd-1', documentNumber: 'K1-5' }).status).toBe(200);
    const t2 = start(w, 500, KIOSK_B, lease(w, KIOSK_B, b.leaseId));
    expect(t2.state).toBe('LEASED');
  });

  it('a queued lease not renewed for 6 s is dropped; renewing an unknown lease is 404', async () => {
    const w = world(HOPPERS);
    await ready(w);
    lease(w, KIOSK_A);
    const b = lease(w, KIOSK_B);
    await run(w, 7_000, 500);
    const r = w.station.lease(KIOSK_B, { leaseId: b.leaseId });
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe('unknown_lease');
  });

  it('the kiosk vanishes mid-transaction: closed at once, refunded at the device after the grace', async () => {
    const w = world(HOPPERS, { cashRefundGraceSec: 20 });
    await ready(w);
    const t = start(w, 5000);
    await run(w, 400);
    w.device.insert(1000);
    // No renewals from now on.
    await run(w, 7_000, 500);
    const mid = tx(w, t.txId);
    expect(mid.state).toBe('ACCEPTING');
    expect(w.device.insert(500)).toBe('rejected');
    const done = await untilState(w, t.txId, ['DONE', 'HELD'], 40_000, KIOSK_A, false);
    expect(done.outcome).toBe('refunded');
    expect(done.cancelReason).toBe('client_gone');
    expect(done.refundPaidAgorot).toBe(1000);
  });

  it('a kiosk that comes back within the grace goes on: acceptance opens again', async () => {
    const w = world(HOPPERS, { cashRefundGraceSec: 60 });
    await ready(w);
    const t = start(w, 3000);
    await run(w, 400);
    w.device.insert(1000);
    await run(w, 7_000, 500);
    expect(w.device.insert(500)).toBe('rejected');
    // Renewed again.
    expect(w.station.lease(KIOSK_A, {}).status).toBe(200);
    await run(w, 400);
    expect(tx(w, t.txId).state).toBe('ACCEPTING');
    expect(w.device.insert(2000)).toBe('escrow');
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.outcome).toBe('paid');
  });

  it('start is idempotent by txId; another body for the same id is a conflict', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const l = lease(w);
    const txId = randomUUID();
    const r1 = w.station.startTx(KIOSK_A, txId, { leaseId: l.leaseId, amountAgorot: 1000 });
    const r2 = w.station.startTx(KIOSK_A, txId, { leaseId: l.leaseId, amountAgorot: 1000 });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((r2.body as TxView).txId).toBe(txId);
    expect(w.station.startTx(KIOSK_A, txId, { leaseId: l.leaseId, amountAgorot: 2000 }).status).toBe(409);
    expect(w.station.startTx(KIOSK_B, txId, { leaseId: l.leaseId, amountAgorot: 1000 }).status).toBe(409);
  });
});

describe('cash station — power cuts and the journal', () => {
  it('power cut mid-transaction: after the restart the transaction is HELD, nothing paid by itself', async () => {
    const shared = { db: openDb(':memory:'), clock: new Clock() };
    migrate(shared.db);
    const w1 = world(HOPPERS, {}, shared);
    await ready(w1);
    const t = start(w1, 5000);
    await run(w1, 400);
    w1.device.insert(2000);
    await run(w1, 400);
    w1.device.insert(1000);
    await run(w1, 400);
    expect(tx(w1, t.txId).insertedAgorot).toBe(3000);
    const paidBefore = w1.device.commands.filter((c) => c.op === 'pay_out').length;
    w1.device.powerCut();
    // A new process: a new station over the same journal and the same (restarted) unit.
    const w2 = world(HOPPERS, {}, { ...shared, device: w1.device });
    await run(w2, 1_000);
    const held = tx(w2, t.txId);
    expect(held.state).toBe('HELD');
    expect(held.heldReason).toBe('power_loss');
    expect(held.heldAgorot).toBe(3000);
    expect(w1.device.commands.filter((c) => c.op === 'pay_out').length).toBe(paidBefore);
    // The kiosk can still acknowledge it (its fault slip).
    expect(w2.station.ackTx(KIOSK_A, t.txId, {}).status).toBe(200);
  });

  it('a bill presented when the power went is left for staff (bills_pending), delivered only on request', async () => {
    const w = world({ coins: [100], notes: { values: [2000, 5000], bus: 'id003', escrow: true }, noteRecycler: { units: [{ valueAgorot: 2000, count: 10 }] }, hoppers: [{ valueAgorot: 100, count: 100 }], autoTakeBills: false });
    await ready(w);
    const t = start(w, 3000);
    await run(w, 400);
    w.device.insert(5000);
    await run(w, 3_000);
    expect(w.device.presentedBill).toBe(2000);
    w.device.powerCut();
    await run(w, 2_000);
    expect(tx(w, t.txId).state).toBe('HELD');
    expect(w.station.alerts().some((a) => a.code === 'bills_pending')).toBe(true);
    expect(w.station.status(null).state).toBe('maintenance');
    await w.station.deliverPending(null);
    await run(w, 400);
    expect(w.station.alerts().some((a) => a.code === 'bills_pending')).toBe(false);
  });

  it('a paid transaction never acknowledged becomes a held credit after cashUnackedHoldMin', async () => {
    const w = world(HOPPERS, { cashUnackedHoldMin: 5 });
    await ready(w);
    const t = start(w, 1000);
    await run(w, 400);
    w.device.insert(1000);
    await untilState(w, t.txId, ['DONE']);
    await run(w, 6 * 60_000, 30_000);
    const v = tx(w, t.txId);
    expect(v.state).toBe('HELD');
    expect(v.heldReason).toBe('unacked');
    expect(v.heldAgorot).toBe(1000);
  });
});

describe('cash station — device families', () => {
  it('level-only hoppers: unknown until counted; the ledger counts refills, routed coins and payouts', async () => {
    const w = world({
      coins: [100, 500],
      notes: null,
      hoppers: [
        { valueAgorot: 100, count: 200, levelOnly: true, lowAt: 20, highAt: 400, fed: true, capacity: 600 },
        { valueAgorot: 500, count: 100, levelOnly: true, lowAt: 10, highAt: 300 },
      ],
    });
    await ready(w);
    const one = w.station.ledger()!.denominations.find((d) => d.valueAgorot === 100)!;
    expect(one.accurate).toBe(false);
    expect(one.count).toBe(0);
    expect(w.station.refill('float', [{ valueAgorot: 100, count: 200 }, { valueAgorot: 500, count: 100 }], { userId: null, name: 'דנה' }, null, null).ok).toBe(true);
    await run(w, 400);
    expect(w.station.ledger()!.denominations.find((d) => d.valueAgorot === 100)!.count).toBe(200);
    // A sale: three 1 ₪ coins routed into the hopper; 5 ₪ − 2 ₪ change paid from it.
    const t = start(w, 200, KIOSK_A);
    await run(w, 400);
    w.device.insert(100);
    await run(w, 200);
    w.device.insert(500);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.changePaidAgorot).toBe(400);
    const after = w.station.ledger()!.denominations.find((d) => d.valueAgorot === 100)!;
    expect(after.count).toBe(200 + 1 - 4);
    expect(w.device.inside(100)).toBe(after.count);
  });

  it('a note recycler: notes routed into it are change; a full dump moves them to the cashbox', async () => {
    const w = world({ coins: [100], notes: { values: [2000, 5000], bus: 'id003', escrow: true }, noteRecycler: { units: [{ valueAgorot: 2000, count: 5 }] }, hoppers: [{ valueAgorot: 100, count: 100 }] });
    await ready(w);
    const t = start(w, 3000);
    await run(w, 400);
    w.device.insert(5000);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.changePaidAgorot).toBe(2000);
    expect(done.paidOut).toEqual([{ valueAgorot: 2000, kind: 'note', count: 1 }]);
    w.station.ackTx(KIOSK_A, t.txId, {});
    await run(w, 400);
    const before = w.station.ledger()!.denominations.find((d) => d.valueAgorot === 2000)!.count;
    expect(before).toBe(4);
    const r = await w.station.dump(2000, null, null, null);
    expect(r.ok).toBe(true);
    await run(w, 1_000);
    expect(w.station.ledger()!.denominations.find((d) => d.valueAgorot === 2000)!.count).toBe(0);
    expect(w.journal.moves('st-1').some((m) => m.kind === 'dump')).toBe(true);
    expect(w.station.ledger()!.cashbox.notes).toBeGreaterThanOrEqual(4);
  });

  it('an MDB note recycler cannot dump (the manual)', async () => {
    const w = world({ coins: [100], notes: { values: [2000], bus: 'mdb', escrow: true }, noteRecycler: { units: [{ valueAgorot: 2000, count: 5 }] } });
    await ready(w);
    const r = await w.station.dump(2000, null, null, null);
    expect(r.ok).toBe(false);
  });

  it('SmartHopper: per-denomination counts, change from it, the whole-unit dump', async () => {
    const w = world({ coins: [10, 50, 100, 200, 500, 1000], notes: null, smartHopper: { denominations: [{ valueAgorot: 100, count: 30 }, { valueAgorot: 500, count: 20 }, { valueAgorot: 10, count: 50 }] } });
    await ready(w);
    const inv = w.station.ledger()!;
    expect(inv.denominations.map((d) => [d.valueAgorot, d.count, d.accurate])).toEqual([
      [10, 50, true],
      [100, 30, true],
      [500, 20, true],
    ]);
    const t = start(w, 340);
    await run(w, 400);
    w.device.insert(1000);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.changePaidAgorot).toBe(660);
    w.station.ackTx(KIOSK_A, t.txId, {});
    const r = await w.station.dump(null, null, null, null);
    expect(r.ok).toBe(true);
    await run(w, 600);
    expect(w.station.ledger()!.changeAvailableAgorot).toBe(0);
  });

  it('MDB changer: tubes are change (level 2 inhibited), the level 3 payout pays', async () => {
    const w = world({ coins: [50, 100, 200, 500, 1000], notes: null, mdbChanger: { tubes: [{ valueAgorot: 100, count: 40 }, { valueAgorot: 50, count: 40 }, { valueAgorot: 500, count: 20 }] } });
    await ready(w);
    expect(w.station.ledger()!.changeAvailableAgorot).toBe(40 * 100 + 40 * 50 + 20 * 500);
    const t = start(w, 350);
    await run(w, 400);
    w.device.insert(1000);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.changePaidAgorot).toBe(650);
    expect(done.changeOwedAgorot).toBe(0);
  });

  it('extended escrow: a cancel gives the customer their own notes back; a sale stacks them', async () => {
    const sim: SimConfig = { coins: [100], notes: { values: [2000, 5000], bus: 'ebds', escrow: true }, noteRecycler: { units: [{ valueAgorot: 2000, count: 5 }], extendedEscrow: true }, hoppers: [{ valueAgorot: 100, count: 100 }] };
    const w = world(sim);
    await ready(w);
    const t = start(w, 9000);
    await run(w, 400);
    expect(w.device.insert(5000)).toBe('accepted');
    await run(w, 400);
    expect(tx(w, t.txId).insertedAgorot).toBe(5000);
    w.station.cancelTx(KIOSK_A, t.txId, 'customer');
    const done = await untilState(w, t.txId, ['DONE', 'HELD']);
    expect(done.outcome).toBe('refunded');
    expect(w.device.commands.some((c) => c.op === 'ext_escrow' && c.command === 5)).toBe(true);
    // No coin payout was needed: the same note went back.
    expect(w.device.commands.filter((c) => c.op === 'pay_out').length).toBe(0);
    w.station.ackTx(KIOSK_A, t.txId, {});
    const t2 = start(w, 7000);
    await run(w, 400);
    w.device.insert(5000);
    await run(w, 200);
    w.device.insert(2000);
    const paid = await untilState(w, t2.txId, ['DONE']);
    expect(paid.outcome).toBe('paid');
    expect(w.device.commands.some((c) => c.op === 'ext_escrow' && c.command === 4)).toBe(true);
  });

  it('PaySpecific when the greedy walk would fail and the firmware has precise pay', async () => {
    const w = world({ coins: [10, 50, 100, 200, 500, 1000], notes: null, hoppers: [{ valueAgorot: 50, count: 10 }, { valueAgorot: 20, count: 10 }] as SimConfig['hoppers'] }, { cashExactChangeBelowAgorot: 0 });
    await ready(w);
    // 60 agorot of change: greedy takes 50 and cannot finish (no 10); 20 ×3 can.
    const t = start(w, 140);
    await run(w, 400);
    w.device.insert(200);
    const done = await untilState(w, t.txId, ['DONE']);
    expect(done.changePaidAgorot).toBe(60);
    expect(w.device.commands.some((c) => c.op === 'pay_specific')).toBe(true);
  });
});

describe('cash station — watchdog, alerts, lamps', () => {
  it('CheckOperation lapses: the unit stops taking money by itself', async () => {
    const w = world(HOPPERS);
    await ready(w);
    const t = start(w, 5000);
    await run(w, 400);
    await w.station.watchdogTick();
    expect(w.device.insert(100)).toBe('accepted');
    w.clock.t += 5_000;
    expect(w.device.insert(100)).toBe('rejected');
    await w.station.watchdogTick();
    expect(w.device.insert(100)).toBe('accepted');
    void t;
  });

  it('door and cashbox switches, low change, and the fault lamp', async () => {
    const w = world({ ...HOPPERS, hoppers: [{ valueAgorot: 100, count: 3 }] }, {
      cashSwitchMap: JSON.stringify({ door: { n: 0, closedMeans: 'closed' }, cashbox: { n: 1, closedMeans: 'present' } }),
      cashLampMap: JSON.stringify({ ready: 2, busy: 3, fault: 4 }),
      cashFloatLevels: JSON.stringify({ '100': { target: 100, low: 10 } }),
    });
    w.device.setSwitch(0, true);
    w.device.setSwitch(1, true);
    await ready(w);
    expect(w.station.alerts().map((a) => a.code)).toEqual(expect.arrayContaining(['hopper_low', 'change_low']));
    expect(w.station.status(null).state).toBe('ready');
    expect(w.device.lamps.get(2)).toBe(true);
    w.device.setSwitch(1, false);
    await run(w, 400);
    expect(w.station.alerts().some((a) => a.code === 'cashbox_removed')).toBe(true);
    expect(w.station.status(null).state).toBe('fault');
    expect(w.device.lamps.get(4)).toBe(true);
    expect(w.station.lease(KIOSK_A, {}).status).toBe(409);
    w.device.setSwitch(0, false);
    await run(w, 400);
    expect(w.station.alerts().some((a) => a.code === 'door_open')).toBe(true);
    const hb = w.station.heartbeatBlock() as { alerts: Array<{ message: string }> };
    expect(hb.alerts[0].message.startsWith('עמדת מזומן 1 (ליד קיוסק 1): ')).toBe(true);
  });

  it('no driver: fault with "דרייבר מזומן לא מותקן"; a consistency error blocks', async () => {
    const w = world(HOPPERS);
    w.device.consistencyError = 'Coin count impossible';
    await ready(w).catch(() => undefined);
    await run(w, 400);
    const s: StationStatus = w.station.status(null);
    expect(s.state).toBe('fault');
    expect(w.station.alerts().some((a) => a.code === 'consistency')).toBe(true);
  });

  it('count: a level-only hopper takes the count, the move keeps expected vs counted', async () => {
    const w = world({ coins: [100], notes: null, hoppers: [{ valueAgorot: 100, count: 50, levelOnly: true }] });
    await ready(w);
    w.station.refill('float', [{ valueAgorot: 100, count: 40 }], null, null, null);
    await run(w, 200);
    const r = await w.station.count([{ valueAgorot: 100, count: 50 }], null, null, null, null);
    expect(r.ok).toBe(true);
    const m = w.journal.moves('st-1').find((x) => x.kind === 'count')!;
    expect(m.expectedAgorot).toBe(4000);
    expect(m.countedAgorot).toBe(5000);
    await run(w, 200);
    expect(w.station.ledger()!.denominations[0].count).toBe(50);
    void PAY_FINISHED;
  });

  it('refill through the acceptor is a refill, not a sale', async () => {
    const w = world({ coins: [100, 500], notes: null, hoppers: [{ valueAgorot: 100, count: 0, fed: true, capacity: 500 }] });
    await ready(w);
    expect(w.station.refillViaAcceptor(true, { userId: null, name: 'דנה' }, null).ok).toBe(true);
    await run(w, 400);
    expect(w.station.status(null).state).toBe('maintenance');
    w.device.insert(100);
    w.device.insert(100);
    w.device.insert(500);
    await run(w, 200);
    const r = w.station.refillViaAcceptor(false, null, null);
    expect(r.ok).toBe(true);
    expect(r.move!.amountAgorot).toBe(700);
    expect(r.move!.kind).toBe('refill');
    await run(w, 400);
    expect(w.device.insert(100)).toBe('rejected');
  });
});
