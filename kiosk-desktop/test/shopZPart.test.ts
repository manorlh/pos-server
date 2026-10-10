/**
 * The Windows kiosk in the shop's Z (PARITY.md gap 5):
 *  - the main till's local shop Z asks for the kiosk's part through the cloud (heartbeat
 *    `pendingShopZPart`): closed as over the LAN, never twice for one request, answered with its
 *    section and manifest (`POST shop-z/remote-part`), a customer paying waited out;
 *  - "סגירה יחד עם ה-Z הסניפי" (kiosk/sync `closeRequest`): closed once idle, the result reported
 *    with the status until the cloud stops asking.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVICE_PAYING_WAIT_MS, kioskSection, planLanClose } from '../src/main/fiscal/shopZPart';
import { KioskService } from '../src/main/service';
import { saleTotals, type SaleLine } from '../src/core/sale';
import type { Transport } from '../src/main/printer/transports';

describe('planLanClose (CloseShiftCoordinator.planLanClose)', () => {
  const base = { closedForRequest: null, openShiftId: 's1', devicePaying: false, payingSinceMs: null, nowMs: 1_000_000, pendingDocuments: 0 };

  it('a request already closed for is answered "closed", nothing closed again', () => {
    expect(planLanClose({ ...base, closedForRequest: 's0' })).toEqual({ kind: 'answer', outcome: 'closed', shiftId: 's0' });
  });

  it('nothing open: no_open_shift', () => {
    expect(planLanClose({ ...base, openShiftId: null })).toEqual({ kind: 'answer', outcome: 'no_open_shift', shiftId: null });
  });

  it('a customer paying is waited out, up to the charge’s own timeout, then refuses', () => {
    expect(planLanClose({ ...base, devicePaying: true })).toEqual({ kind: 'wait' });
    expect(planLanClose({ ...base, devicePaying: true, payingSinceMs: base.nowMs - DEVICE_PAYING_WAIT_MS + 1 })).toEqual({ kind: 'wait' });
    expect(planLanClose({ ...base, devicePaying: true, payingSinceMs: base.nowMs - DEVICE_PAYING_WAIT_MS })).toEqual({ kind: 'answer', outcome: 'blocked_payment', shiftId: 's1' });
  });

  it('a payment still pending in the shift refuses it; else the open shift is closed', () => {
    expect(planLanClose({ ...base, pendingDocuments: 1 })).toEqual({ kind: 'answer', outcome: 'blocked_payment', shiftId: 's1' });
    expect(planLanClose(base)).toEqual({ kind: 'close', shiftId: 's1' });
  });
});

describe('the section', () => {
  const me = { machineId: 'm', posNumber: '4', machineName: 'קיוסק', operator: { id: 'kiosk:m', name: 'קיוסק' } };

  it('no shift waiting for a Z: an empty kiosk section, no manifest', () => {
    const r = kioskSection(me, [], () => []);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.section).toMatchObject({ shiftIds: [], till: null, manifest: null, report: { shiftCount: 0, deviceRole: 'kiosk', closedByName: 'קיוסק · קיוסק' } });
  });

  it('a close that cannot be read is never summed', () => {
    const s = { id: 'abcdef0123', sequence_number: 1, business_date: '2026-10-06', opened_at: '', opened_by_id: null, opened_by_name: null, opening_cash: 0, status: 'closed' as const, closed_at: '', close_payload: '{', close_accepted_at: null, z_report_id: null, z_number: null };
    expect(kioskSection(me, [s], () => [])).toEqual({ kind: 'unreadable', shiftId: 'abcdef0123' });
  });
});

/* ------------------------------------------------- through the real service */

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const line: SaleLine = { key: 'l1', productId: '0b1c2d3e-0000-4000-8000-000000000001', name: 'המבורגר', sku: null, basePriceAgorot: 4200, options: [], notes: [], qty: 1 };

/** A cloud that answers what the test says; records what the kiosk sent. */
function fakeCloud() {
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const answers: Record<string, (() => unknown) | undefined> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '').replace(MACHINE, 'm');
    sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = answers[`${method} ${p}`];
    return new Response(JSON.stringify(answer ? answer() : {}), { status: answer ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, answers, fetchFn };
}

function pairedKiosk(fetchFn: typeof fetch) {
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-shopz-')),
    appVersion: '0.3.0',
    deviceInfo: { platform: 'windows' },
    transport: noPrinter,
    fetch: fetchFn,
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4', documentPrefix: '4' });
  svc.api.setBase('http://localhost:8001');
  return svc;
}

/** A completed card sale in the open shift (as the payment leaves it). */
function sell(svc: KioskService) {
  const op = svc.operator();
  svc.ledger.openShift(op);
  const doc = svc.ledger.openCardSale({ documentType: 320, prefix: '4', branchId: null, operator: op, orderId: null, lines: [line], tracked: [], totals: saleTotals([line], 0.18) });
  svc.ledger.completeCardSale(doc!.id, { brand: 'visa', last4: '1111', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: 4200, meta: {} } as never);
  return doc!;
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe('the main till’s local shop Z, through the cloud (pendingShopZPart)', () => {
  it('closes the shift once for the request and answers with its section and manifest', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    const svc = pairedKiosk(fetchFn);
    try {
      const doc = sell(svc);
      const shiftId = svc.ledger.currentShift()!.id;
      answers['POST machines/me/heartbeat'] = () => ({ zMode: 'cloud', pendingShopZPart: { requestId: 'r1', roundId: 'round-1', force: true } });
      answers['POST sync/m/shop-z/remote-part'] = () => ({ state: 'reported' });
      const parts = () => sent.filter((s) => s.path === 'sync/m/shop-z/remote-part');

      expect(await svc.sync.heartbeat()).toBe(true);
      await until(() => parts().length === 1);
      const answer = parts()[0].body!;
      expect(answer).toMatchObject({ requestId: 'r1', roundId: 'round-1', machineId: MACHINE, outcome: 'closed', shiftId, message: 'נסגרה' });
      const section = answer.section as Record<string, unknown>;
      expect(section.shiftIds).toEqual([shiftId]);
      expect(section.manifest).toMatchObject({ documents: 1, documentIds: [doc.id], totals: { gross: '42.00', card: '42.00' }, shiftIds: [shiftId] });
      expect(section.report).toMatchObject({ deviceRole: 'kiosk', grossSales: '42.00', transactionsCount: 1 });
      // "Z — מזומן צפוי כולל הפקדות ותנועות מזומן" never applies to a kiosk (no drawer, no Cash In / Out
      // or deposits): its part carries no movements block, and its expected cash is float + cash + cash
      // tips as ever — the cloud's Z and the main till's paper take it as it is.
      expect(section.report).not.toHaveProperty('cashMovements');
      expect(section.report).toMatchObject({ openingCash: '0.00', expectedCash: '0.00' });
      expect(svc.ledger.currentShift()).toBeNull();

      // Asked again (the beat repeats it until the cloud has it): the same answer, nothing closed.
      svc.ledger.openShift(svc.operator());
      expect(await svc.sync.heartbeat()).toBe(true);
      await until(() => parts().length === 2);
      expect(parts()[1].body).toEqual(answer);
      expect(svc.ledger.currentShift()).not.toBeNull();

      // "נסה שוב" (a new request): the new shift closed too; both shifts, neither in a Z yet.
      answers['POST machines/me/heartbeat'] = () => ({ zMode: 'cloud', pendingShopZPart: { requestId: 'r2', roundId: 'round-1', force: true } });
      expect(await svc.sync.heartbeat()).toBe(true);
      await until(() => parts().length === 3);
      expect((parts()[2].body!.section as Record<string, unknown>).shiftIds).toHaveLength(2);

      // The main till's Z took them (the beat's recentShiftZs): the next part has no shift.
      answers['POST machines/me/heartbeat'] = () => ({
        zMode: 'cloud',
        recentShiftZs: svc.ledger.unreportedShifts().map((s) => ({ shiftId: s.id, zReportId: 'z-7', zNumber: 7 })),
        pendingShopZPart: { requestId: 'r3', roundId: 'round-2', force: true },
      });
      expect(await svc.sync.heartbeat()).toBe(true);
      await until(() => parts().length === 4);
      expect(parts()[3].body).toMatchObject({ outcome: 'no_open_shift', section: { shiftIds: [], manifest: null } });
    } finally {
      svc.stop();
    }
  });

  it('a display device never answers for the shop Z', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    const svc = pairedKiosk(fetchFn);
    try {
      (svc as unknown as { fiscalRole: boolean }).fiscalRole = false;
      answers['POST machines/me/heartbeat'] = () => ({ zMode: 'cloud', pendingShopZPart: { requestId: 'r1', roundId: 'round-1', force: true } });
      await svc.sync.heartbeat();
      await new Promise((r) => setTimeout(r, 50));
      expect(sent.some((s) => s.path.endsWith('shop-z/remote-part'))).toBe(false);
    } finally {
      svc.stop();
    }
  });
});

describe('"סגירה יחד עם ה-Z הסניפי" (kiosk/sync closeRequest)', () => {
  it('closes once idle, reports the result until the cloud stops asking', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    const svc = pairedKiosk(fetchFn);
    try {
      sell(svc);
      const shiftId = svc.ledger.currentShift()!.id;
      answers['POST sync/m/kiosk/sync'] = () => ({ kiosk: true, configVersion: 'v1', closeRequest: { id: 'c1', source: 'z_run', requestedAt: '' } });
      await svc.sync.kioskSync();
      await (svc as unknown as { tick30(): Promise<void> }).tick30();
      expect(svc.ledger.currentShift()).toBeNull();
      await until(() => sent.filter((s) => s.path === 'sync/m/kiosk/sync').length >= 2);
      const status = () => (sent.filter((s) => s.path === 'sync/m/kiosk/sync').pop()!.body as { status: Record<string, unknown> }).status;
      expect(status().closeResult).toEqual({ id: 'c1', state: 'done', shiftId, zNumber: null });

      // Still listed (the cloud has not applied it yet): not carried out again, still reported.
      sell(svc);
      await svc.sync.kioskSync();
      await (svc as unknown as { tick30(): Promise<void> }).tick30();
      expect(svc.ledger.currentShift()).not.toBeNull();
      // The cloud took it: forgotten.
      answers['POST sync/m/kiosk/sync'] = () => ({ kiosk: true, configVersion: 'v1', closeRequest: null });
      await svc.sync.kioskSync();
      await svc.sync.kioskSync();
      expect(status().closeResult).toBeUndefined();
    } finally {
      svc.stop();
    }
  });
});
