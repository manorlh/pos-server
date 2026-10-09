import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autoCloseDue,
  autoCloseMayRun,
  autoCloseTimeOf,
  lastKnownTillZ,
  nextOfflineZNumber,
  offlineTillZAllowed,
  offlineZNext,
  refusalClearsOwed,
  reservationStillValid,
  sumTillTotals,
  tillZRefusalOf,
  tillZsToKeep,
  todayAt,
  zSequenceHoles,
  type StoredTillZ,
} from '../src/core/tillZ';
import { saleTotals } from '../src/core/sale';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { Outbox } from '../src/main/sync/outbox';
import { Ledger } from '../src/main/fiscal/ledger';
import { TillZService } from '../src/main/fiscal/tillZService';
import { Api } from '../src/main/sync/api';

const z = (n: number, extra: Partial<StoredTillZ> = {}): StoredTillZ => ({ id: `z${n}`, machineId: 'm1', number: n, epoch: 0, closedAt: '2026-10-01T22:00:00Z', businessDate: null, state: 'synced', ...extra });

describe('the last Z number known for sure (SPEC_OFFLINE_TILL_Z §4.1)', () => {
  it('is the higher of this machine’s own Zs and the cloud’s lastTillZNumber', () => {
    expect(lastKnownTillZ([z(5), z(7)], 'm1', 0, 6)).toBe(7);
    expect(lastKnownTillZ([z(5)], 'm1', 0, 9)).toBe(9);
    expect(lastKnownTillZ([], 'm1', 0, 0)).toBe(0);
  });

  it('never counts a row of another machine, another epoch, or one superseded', () => {
    expect(lastKnownTillZ([z(50, { machineId: 'm2' }), z(40, { epoch: 1 }), z(30, { state: 'superseded' }), z(3)], 'm1', 0, null)).toBe(3);
  });

  it('nothing known → no offline Z', () => {
    expect(lastKnownTillZ([], 'm1', 0, null)).toBe(null);
    expect(nextOfflineZNumber(null)).toBe(null);
  });

  it('the next is exactly the last + 1', () => {
    expect(nextOfflineZNumber(7)).toBe(8);
  });

  it('a reservation is taken again only while it is still exactly the next', () => {
    const r = { machineId: 'm1', number: 8, zId: 'z', clientRequestId: 'c' };
    expect(reservationStillValid(r, 'm1', 7)).toBe(true);
    expect(reservationStillValid(r, 'm1', 8)).toBe(false);
    expect(reservationStillValid(r, 'm2', 7)).toBe(false);
    expect(reservationStillValid(null, 'm1', 7)).toBe(false);
  });

  it('the offline Z only with the parameter, per-till Z, no cloud and paired', () => {
    expect(offlineTillZAllowed(true, 'till', true, true)).toBe(true);
    expect(offlineTillZAllowed(true, 'cloud', true, true)).toBe(false);
    expect(offlineTillZAllowed(false, 'till', true, true)).toBe(false);
    expect(offlineTillZAllowed(true, 'till', false, true)).toBe(false);
  });
});

describe('the upload of an offline Z never renumbers (§5.4)', () => {
  it('created / duplicate → synced; no answer, 5xx, waiting 409 → pending; any other 409/4xx → conflict', () => {
    expect(offlineZNext('pending', { kind: 'created' })).toBe('synced');
    expect(offlineZNext('pending', { kind: 'duplicate' })).toBe('synced');
    expect(offlineZNext('pending', { kind: 'no_answer' })).toBe('pending');
    expect(offlineZNext('pending', { kind: 'http', status: 503, detail: null })).toBe('pending');
    expect(offlineZNext('pending', { kind: 'http', status: 409, detail: 'shift_not_closed' })).toBe('pending');
    expect(offlineZNext('pending', { kind: 'http', status: 409, detail: 'offline_z_out_of_sequence' })).toBe('conflict');
    expect(offlineZNext('pending', { kind: 'http', status: 409, detail: 'offline_z_number_taken' })).toBe('conflict');
    expect(offlineZNext('conflict', { kind: 'created' })).toBe('conflict');
    expect(offlineZNext('conflict', { kind: 'retry_by_person' })).toBe('pending');
    expect(offlineZNext('synced', { kind: 'http', status: 409, detail: 'x' })).toBe('synced');
  });

  it('finds the holes in the sequence', () => {
    expect(zSequenceHoles([3, 4, 7, 5])).toEqual([6]);
    expect(zSequenceHoles([1, 2, 3])).toEqual([]);
  });

  it('keeps 31 days, everything not in the cloud, and always the newest', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const kept = tillZsToKeep(
      [z(1, { closedAt: '2026-08-01T00:00:00Z' }), z(2, { closedAt: '2026-08-02T00:00:00Z', state: 'pending' }), z(3, { closedAt: '2026-10-01T00:00:00Z' }), z(4, { closedAt: '2026-08-03T00:00:00Z' })],
      now,
    );
    expect(kept.map((x) => x.number).sort()).toEqual([2, 3, 4]);
  });
});

describe('the automatic close', () => {
  it('runs at the kiosk’s time, else the parameter', () => {
    expect(autoCloseTimeOf('23:30', '22:00')).toBe('23:30');
    expect(autoCloseTimeOf('', '22:00')).toBe('22:00');
    expect(autoCloseTimeOf('', '')).toBe(null);
    expect(autoCloseTimeOf('25:00', 'x')).toBe(null);
  });

  it('is due only past today’s moment, for a shift opened before it', () => {
    const now = new Date(2026, 9, 6, 23, 31).getTime();
    expect(autoCloseDue(now, '23:30', new Date(2026, 9, 6, 8, 0).getTime())).toBe(true);
    expect(autoCloseDue(new Date(2026, 9, 6, 23, 29).getTime(), '23:30', new Date(2026, 9, 6, 8, 0).getTime())).toBe(false);
    // Opened after the moment: tomorrow's.
    expect(autoCloseDue(now, '23:30', new Date(2026, 9, 6, 23, 30, 30).getTime())).toBe(false);
    expect(todayAt(now, '23:30')).toBe(new Date(2026, 9, 6, 23, 30).getTime());
  });

  it('never with a customer on it, a payment held, or a card on the terminal', () => {
    expect(autoCloseMayRun({ kiosk: true, flowIdle: true, flowBusy: false, cardInFlight: false })).toBe(true);
    expect(autoCloseMayRun({ kiosk: true, flowIdle: false, flowBusy: false, cardInFlight: false })).toBe(false);
    expect(autoCloseMayRun({ kiosk: true, flowIdle: true, flowBusy: true, cardInFlight: false })).toBe(false);
    expect(autoCloseMayRun({ kiosk: true, flowIdle: true, flowBusy: false, cardInFlight: true })).toBe(false);
  });

  it('refusals: a Z that will never come clears the owed one (empty_z too)', () => {
    expect(tillZRefusalOf(409, 'nothing_to_report')).toBe('nothing_to_report');
    expect(tillZRefusalOf(409, 'empty_z')).toBe('empty_z');
    expect(tillZRefusalOf(409, 'z_run_in_progress:abc')).toBe('z_run_in_progress');
    expect(tillZRefusalOf(403, 'shift_belongs_to_another_machine')).toBe('shift_belongs_to_another_machine');
    expect(tillZRefusalOf(500, 'x')).toBe(null);
    expect(refusalClearsOwed('empty_z')).toBe(true);
    expect(refusalClearsOwed('shift_not_closed')).toBe(false);
  });

  it('sums the closes’ till totals, leaving VAT out when one is missing', () => {
    expect(sumTillTotals([{ totalSales: 10, totalCard: 10, totalTips: 0, totalRefunds: 0, totalCash: 0, transactionsCount: 1, vatTotal: 1.53 }, { totalSales: 5.5, totalCard: 5.5, transactionsCount: 2, vatTotal: 0.84 }])).toMatchObject({
      totalSales: 15.5,
      totalCard: 15.5,
      transactionsCount: 3,
      vatTotal: 2.37,
    });
    expect(sumTillTotals([{ totalSales: 1, transactionsCount: 1 }])!.vatTotal).toBeUndefined();
    expect(sumTillTotals([null])).toBe(null);
  });
});

/** A cloud for the Z: records the bodies, answers from a script. */
function fakeCloud(answers: Array<((body: Record<string, unknown>) => Response) | 'offline'>) {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    bodies.push({ url, body });
    if (url.includes('/till-z')) {
      const next = answers.shift();
      if (!next) throw new Error('no answer scripted');
      if (next === 'offline') throw new TypeError('fetch failed');
      return next(body);
    }
    return new Response('{}', { status: 200 });
  };
  return { bodies, fetchFn };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(fetchFn: typeof fetch) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-z-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  const kv = new Kv(db);
  const outbox = new Outbox(db);
  const ledger = new Ledger(db, kv, outbox);
  const api = new Api('http://cloud.test/', () => 't', fetchFn);
  const printed: Array<Record<string, unknown>> = [];
  const svc = new TillZService({
    db,
    kv,
    api,
    ledger,
    machineId: () => 'm1',
    zMode: () => 'till',
    flush: async () => {
      // The cloud accepted every close.
      for (const s of ledger.unreportedShifts()) ledger.markCloseAccepted(s.id, {});
    },
    transmit: async () => ({ outcome: 'success', batchNumber: '123', statusCode: 0, statusMessage: 'ok', error: null, transactionCount: 1, amountAgorot: 5400, raw: null }),
    print: (zr) => printed.push(zr),
    log: () => undefined,
  });
  return { db, kv, ledger, svc, printed };
}

const line = { key: 'a', productId: '0b1c2d3e-0000-4000-8000-000000000001', name: 'x', sku: null, basePriceAgorot: 5400, options: [], notes: [], qty: 1 };

describe('TillZService (the kiosk’s automatic close and Z)', () => {
  it('closes at the time, asks the Z once with one request id, stores it with the cloud’s number, prints', async () => {
    const { bodies, fetchFn } = fakeCloud([
      'offline',
      'offline',
      (b) => json(201, { status: 'created', zReport: { id: 'zr-1', machineSequenceNumber: 8, machineId: 'm1', closedAt: '2026-10-06T21:00:00Z', businessDate: '2026-10-06' }, shiftIds: [b.throughShiftId] }),
    ]);
    const { ledger, svc, printed, kv, db } = setup(fetchFn);
    const shift = ledger.openShift({ id: 'kiosk:m1', name: 'קיוסק' }, new Date(2026, 9, 6, 8, 0));
    const doc = ledger.openCardSale({ documentType: 320, prefix: '4', branchId: null, operator: { id: 'kiosk:m1', name: 'קיוסק' }, orderId: null, lines: [line], tracked: [], totals: saleTotals([line], 0.18) })!;
    ledger.completeCardSale(doc.id, { brand: 'visa', last4: '1234', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: 5400, meta: { vuid: 'v' } });
    const at = { mayRun: true, kioskAt: '23:30', paramAt: null, closerName: 'קיוסק · רויאל', vatRate: 0.18 };

    await svc.tick({ ...at, now: new Date(2026, 9, 6, 23, 31) }); // closes, owes the Z, no cloud
    expect(ledger.currentShift()).toBe(null);
    expect(svc.owed).toBe(true);
    const firstId = bodies.find((b) => b.url.includes('/till-z'))!.body.clientRequestId;
    await svc.tick({ ...at, now: new Date(2026, 9, 6, 23, 32) }); // still no cloud
    await svc.tick({ ...at, now: new Date(2026, 9, 6, 23, 33) }); // produced
    const ids = bodies.filter((b) => b.url.includes('/till-z')).map((b) => b.body.clientRequestId);
    expect(new Set(ids).size).toBe(1); // never a second Z for the same close
    expect(ids[0]).toBe(firstId);
    const zBody = bodies.filter((b) => b.url.includes('/till-z'))[0].body;
    expect(zBody).toMatchObject({ throughShiftId: shift.id, createdByName: 'קיוסק · רויאל', unattended: true, till: { totalSales: 54, totalCard: 54, transactionsCount: 1 } });
    expect((zBody.cardTransmission as Record<string, unknown>).outcome).toBe('success');
    expect(svc.owed).toBe(false);
    expect(kv.get('tillZ.pendingRequest')).toBe(null);
    expect(db.get<{ number: number }>('SELECT number FROM till_zs')!.number).toBe(8);
    expect(ledger.shift(shift.id)!.z_number).toBe(8);
    expect(printed).toHaveLength(1);
  });

  it('does not run with a customer on the kiosk', async () => {
    const { fetchFn } = fakeCloud([]);
    const { ledger, svc } = setup(fetchFn);
    ledger.openShift({ id: 'k', name: 'k' }, new Date(2026, 9, 6, 8, 0));
    await svc.tick({ mayRun: false, kioskAt: '23:30', paramAt: null, closerName: 'k', vatRate: 0.18, now: new Date(2026, 9, 6, 23, 45) });
    expect(ledger.currentShift()).not.toBe(null);
  });

  it('a day without a sale (409 empty_z) clears the owed Z — no endless retry', async () => {
    const { fetchFn } = fakeCloud([() => json(409, { detail: 'empty_z' })]);
    const { ledger, svc } = setup(fetchFn);
    ledger.openShift({ id: 'k', name: 'k' }, new Date(2026, 9, 6, 8, 0));
    await svc.tick({ mayRun: true, kioskAt: '23:30', paramAt: null, closerName: 'k', vatRate: 0.18, now: new Date(2026, 9, 6, 23, 45) });
    expect(svc.owed).toBe(false);
  });

  it('the owed Z survives a restart (on disk)', async () => {
    const { fetchFn } = fakeCloud(['offline']);
    const { ledger, svc, kv } = setup(fetchFn);
    ledger.openShift({ id: 'k', name: 'k' }, new Date(2026, 9, 6, 8, 0));
    await svc.tick({ mayRun: true, kioskAt: '23:30', paramAt: null, closerName: 'k', vatRate: 0.18, now: new Date(2026, 9, 6, 23, 45) });
    expect(kv.get('tillZ.owed')).toBe('1');
    expect(kv.getJson<{ id: string }>('tillZ.pendingRequest')!.id).toMatch(/[0-9a-f-]{36}/);
  });
});
