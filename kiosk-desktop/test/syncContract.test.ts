/**
 * The sync contract, both ways:
 *  - the cloud's answers RECORDED from the dev API (npm run smoke -- --record test/fixtures/recorded)
 *    are replayed through the real service: pairing, machines/me, settings, parameters, catalog,
 *    kiosk/sync, heartbeat, POS users;
 *  - what the kiosk SENDS is pinned as golden fixtures (test/fixtures/contract/*.json, the same bytes
 *    in pos-server server/tests/fixtures/kiosk_desktop/, where tests/test_kiosk_desktop_contract.py
 *    validates them against the server's own schemas). Re-generate with UPDATE_GOLDEN=1.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderWire, receiptAfterApproval, receiptStatusOf, type KioskOrder, type ReceiptStatus } from '../src/core/kioskOrders';
import { saleTotals, type SaleLine } from '../src/core/sale';
import { documentWire, shiftCloseWire, type DocDraft, type ShiftRow } from '../src/main/fiscal/ledger';
import { docResults, plan, type OutboxRow } from '../src/main/sync/outbox';
import { apiBase } from '../src/main/sync/api';
import { kdsSaleRelease, saleDispatchId } from '../src/main/kiosk/kdsRelease';
import { KioskService } from '../src/main/service';
import { OrderStore } from '../src/main/kiosk/orders';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import type { Api } from '../src/main/sync/api';
import type { Transport } from '../src/main/printer/transports';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const RECORDED = path.join(here, 'fixtures', 'recorded');
const GOLDEN = path.join(here, 'fixtures', 'contract');
const update = process.env.UPDATE_GOLDEN === '1';

function golden(name: string, value: unknown) {
  const file = path.join(GOLDEN, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (update || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
}

const recorded = (name: string) => JSON.parse(readFileSync(path.join(RECORDED, `${name}.json`), 'utf8')) as { status: number; body: Record<string, unknown> };

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

/** A cloud that answers from the recorded fixtures; records what the kiosk sent. */
function replayCloud() {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'id');
    sent.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : null });
    const name = `${method}_${p.replace(/\//g, '_')}`;
    const file = path.join(RECORDED, `${name}.json`);
    if (!existsSync(file)) return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
    const r = JSON.parse(readFileSync(file, 'utf8')) as { status: number; body: unknown };
    let body = r.body as Record<string, unknown>;
    if (name === 'POST_pairing_validate') body = { ...body, accessToken: 'test-token' };
    return new Response(JSON.stringify(body), { status: r.status, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
  };
  return { sent, fetchFn };
}

describe('the cloud’s recorded answers, through the real service', () => {
  it('has recordings to replay', () => {
    expect(readdirSync(RECORDED).length).toBeGreaterThanOrEqual(8);
  });

  it('pairs (snake_case body), reads the machine, settings, parameters, catalog, kiosk/sync and POS users', async () => {
    const { sent, fetchFn } = replayCloud();
    const svc = new KioskService({
      dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-contract-')),
      appVersion: '0.1.0',
      deviceInfo: { model: 'Windows kiosk', manufacturer: 'test', platform: 'windows' },
      transport: noPrinter,
      fetch: fetchFn,
      downloader: async () => {
        throw new Error('no media in the contract test');
      },
    });
    try {
      const r = await svc.pair({ serverUrl: 'http://localhost:8001', code: 'sti2yd0n', machineName: 'קיוסק Windows' });
      expect(r).toEqual({ ok: true });
      const validate = sent.find((s) => s.path === 'pairing/validate')!;
      expect(validate.body).toMatchObject({ code: 'STI2YD0N', machine_name: 'קיוסק Windows', device_info: { platform: 'windows' } });
      expect(Object.keys(validate.body as object)).not.toContain('machineName');

      const me = recorded('GET_machines_me').body;
      const v = svc.view();
      expect(v.phase).toBe('kiosk');
      expect(v.machine).toMatchObject({ machineId: me.machineId, posNumber: me.posNumber, shopName: me.shopName });
      const catalog = recorded('GET_sync_id_catalog').body as { products: Array<Record<string, unknown>> };
      const sellable = catalog.products.filter((p) => p.inStock !== false && p.salesChannel !== 'pos_only');
      expect(v.catalog.products.length).toBe(sellable.length);
      expect(v.catalog.products.every((p) => p.imageUrl === null || p.imageUrl.startsWith('kiosk://'))).toBe(true); // never a network URL
      const kiosk = recorded('POST_sync_id_kiosk_sync').body;
      expect(v.configVersion).toBe(kiosk.configVersion);
      expect(svc.operator()).toEqual(kiosk.operator);
      expect(svc.cloud.posUsers().length).toBe((recorded('GET_sync_id_pos-users').body.users as unknown[]).length);
      expect(svc.cloud.posUsers().every((u) => u.pinHash === '<redacted>' || u.pinHash.startsWith('$2'))).toBe(true);

      // The heartbeat: what the kiosk says, and what it keeps of the answer.
      expect(await svc.sync.heartbeat()).toBe(true);
      const beat = sent.filter((s) => s.path === 'machines/me/heartbeat').pop()!.body as Record<string, unknown>;
      expect(beat).toMatchObject({ appVersion: '0.1.0', pendingCount: 0, pendingDocuments: 0, realtimeConnected: false, documentCounters: { '320': 0, '330': 0, '400': 0 } });
      expect(beat.offlineTillZ).toMatchObject({ pending: 0, conflict: false });
      const hb = recorded('POST_machines_me_heartbeat').body;
      expect(svc.cloud.heartbeat()).toMatchObject({ zMode: hb.zMode, lastTillZNumber: hb.lastTillZNumber });

      // kiosk/sync carries the kiosk's status (known keys only).
      await svc.sync.kioskSync();
      const status = (sent.filter((s) => s.path === 'sync/id/kiosk/sync').pop()!.body as { status: Record<string, unknown> }).status;
      for (const k of ['flowState', 'shiftOpen', 'appliedConfigVersion', 'mediaReady', 'mediaMissing', 'mediaBytes', 'bonPrinter', 'receiptPrinter', 'ordersToday', 'salesTodayAgorot', 'pendingOrders', 'unprintedBons', 'appVersion']) {
        expect(status).toHaveProperty(k);
      }
      // Never a sale to the cloud while nothing was sold.
      expect(sent.some((s) => s.path.endsWith('transactions'))).toBe(false);
    } finally {
      svc.stop();
    }
  });

  it('the base URL as the till normalizes it', () => {
    expect(apiBase('http://localhost:8001')).toBe('http://localhost:8001/api/v1/');
    expect(apiBase('https://api.r2m.co.il/api/v1/ ')).toBe('https://api.r2m.co.il/api/v1/');
  });
});

/* ------------------------------------------------------- what is sent */

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const SHIFT = '5b0c7e1d-1111-4222-8333-444455556666';
const line1: SaleLine = {
  key: 'l1',
  productId: '0b1c2d3e-0000-4000-8000-000000000001',
  name: 'המבורגר',
  sku: '1001',
  basePriceAgorot: 3800,
  options: [{ groupId: '0b1c2d3e-0000-4000-8000-0000000000a1', optionId: '0b1c2d3e-0000-4000-8000-0000000000b1', name: 'גבינה', priceAgorot: 400, qty: 1 }],
  notes: ['בלי בצל'],
  qty: 1,
};
const line2: SaleLine = { key: 'l2', productId: '0b1c2d3e-0000-4000-8000-000000000002', name: 'צ׳יפס', sku: null, basePriceAgorot: 2350, options: [], notes: [], qty: 2 };

function draft(status: DocDraft['status']): DocDraft {
  const totals = saleTotals([line1, line2], 0.18);
  return {
    id: 'c1a8f0e2-5b7d-4a1e-9f3c-6d2e8b1a4c77',
    documentType: 320,
    number: 57,
    prefix: '4',
    status,
    createdAt: '2026-10-06T09:14:40.000Z',
    updatedAt: '2026-10-06T09:15:01.300Z',
    shiftId: SHIFT,
    businessDate: '2026-10-06',
    cashierId: `kiosk:${MACHINE}`,
    cashierName: 'קיוסק Windows',
    branchId: '12',
    orderId: 'order-1',
    lines: [line1, line2],
    itemIds: ['0b1c2d3e-0000-4000-8000-0000000000c1', '0b1c2d3e-0000-4000-8000-0000000000c2'],
    tracked: [line2.productId],
    totals,
    card:
      status === 'completed'
        ? {
            brand: 'mastercard',
            last4: '7407',
            authNum: '0123456',
            uid: '24071711405408830122531',
            payments: null,
            firstPaymentAgorot: null,
            chargedAgorot: totals.chargeAgorot,
            meta: { vuid: '4120000000123', uid: '24071711405408830122531', authNum: '0123456', cardLast4: '7407', statusCode: 0, outcome: 'approved', chargedAmount: totals.chargeAgorot, keyed: false, result: { statusCode: 0, mutagName: 'Mastercard', cardNumber: '542386***7407' } },
          }
        : null,
    paymentId: '0b1c2d3e-0000-4000-8000-0000000000d1',
    voidMeta: status === 'cancelled' ? { vuid: '4120000000122', outcome: 'declined', resolvedBy: 'getTransactionByVuid', requestedAmount: totals.chargeAgorot, kind: 'sale', message: 'סירוב', supersededBy: null, resolvedAt: '2026-10-06T09:14:50.000Z' } : null,
  };
}

const shift: ShiftRow = {
  id: SHIFT,
  sequence_number: 12,
  business_date: '2026-10-06',
  opened_at: '2026-10-06T05:01:12.000Z',
  opened_by_id: `kiosk:${MACHINE}`,
  opened_by_name: 'קיוסק Windows',
  opening_cash: 0,
  status: 'open',
  closed_at: null,
  close_payload: null,
  close_accepted_at: null,
  z_report_id: null,
  z_number: null,
};

describe('what the kiosk sends (golden, validated by the server’s schemas)', () => {
  it('a 320 card sale: bare number + prefix, gross totals, VAT once, the card leg = goods (tip apart), meta as strings', () => {
    const wire = documentWire(draft('completed'));
    expect(wire.transactionNumber).toBe('57');
    expect(wire.documentPrefix).toBe('4');
    expect(wire.totalAmount).toBe(89);
    expect(wire.netAmount).toBe(75.42);
    expect(wire.vatAmount).toBe(13.58);
    const leg = (wire.payments as Array<Record<string, unknown>>)[0];
    expect(leg.amount).toBe(89);
    expect((leg.nayaxMeta as Record<string, unknown>).statusCode).toBe('0'); // every top-level value a string
    expect(typeof (leg.nayaxMeta as Record<string, unknown>).result).toBe('string');
    golden('transaction_card_sale_320', { transactions: [wire] });
  });

  it('a declined sale: cancelled, its number kept, no tender', () => {
    const wire = documentWire(draft('cancelled'));
    expect(wire.status).toBe('cancelled');
    expect(wire.payments).toEqual([]);
    golden('transaction_cancelled_320', { transactions: [wire] });
  });

  it('the shift open and close (the open repeated in the close)', () => {
    golden('shift_open', {
      id: shift.id,
      businessDate: shift.business_date,
      sequenceNumber: shift.sequence_number,
      openedAt: shift.opened_at,
      openingCash: 0,
      openedByUserId: shift.opened_by_id,
      openedByName: shift.opened_by_name,
    });
    const close = shiftCloseWire(shift, [draft('completed')], { closedByName: 'קיוסק · קיוסק Windows', vatRate: 0.18, now: '2026-10-06T21:00:03.120Z' });
    expect(close).toMatchObject({ countedCash: 0, expectedCash: 0, transactionIds: [draft('completed').id], till: { totalSales: 89, totalCard: 89, vatTotal: 13.58, transactionsCount: 1 } });
    golden('shift_close', close);
  });

  it('a kiosk order', () => {
    const o: KioskOrder = {
      localId: 'order-1',
      createdAtMs: 0,
      businessDate: '2026-10-06',
      serviceType: 'take_away',
      tableRef: null,
      fulfillmentMode: 'BON',
      configVersion: 'c727da0ef0f5b92e',
      customerName: 'דנה',
      customerPhone: null,
      itemCount: 3,
      totalAgorot: 8900,
      tipAgorot: 0,
      paid: true,
      paidAt: '2026-10-06T09:15:01.300Z',
      transactionId: draft('completed').id,
      transactionNumber: '40000057',
      pickupNumber: 17,
      pickupLabel: 'A-17',
      bonRequestedAtMs: 1,
      bonJobIds: ['j'],
      bonStatus: 'sent',
      bonDetail: null,
      receiptStatus: 'declined',
      recovered: false,
      syncedHash: null,
    };
    // Every value this kiosk (and the Android one, KioskOrders.kt) can put on the wire: each receipt
    // and bon state and each order status — and the values older versions stored ("none" /
    // "queued" receipts, which the cloud refused), as they are sent now.
    const variant = (n: number, change: Partial<KioskOrder>): KioskOrder => ({ ...o, localId: `order-${n}`, pickupNumber: 16 + n, pickupLabel: `A-${16 + n}`, ...change });
    const all: KioskOrder[] = [
      o,
      variant(2, { receiptStatus: 'pending', bonStatus: 'queued' }),
      variant(3, { receiptStatus: 'printed', bonStatus: 'printed' }),
      variant(4, { receiptStatus: 'failed', bonStatus: 'failed', bonDetail: 'לא הודפס' }),
      variant(5, { receiptStatus: 'skipped', bonStatus: 'none', fulfillmentMode: 'KDS', serviceType: 'eat_in', tableRef: '12', customerPhone: '0501234567' }),
      variant(6, { receiptStatus: receiptAfterApproval('ask', true), recovered: true, bonDetail: 'שוחזר — הדפסה חוזרת מהניהול' }),
      variant(7, { receiptStatus: 'none' as unknown as ReceiptStatus }),
      variant(8, { receiptStatus: 'queued' as unknown as ReceiptStatus }),
    ];
    const wires = all.map(orderWire);
    expect(new Set(wires.map((w) => w.receiptStatus))).toEqual(new Set(['pending', 'printed', 'declined', 'failed', 'skipped']));
    expect(new Set(wires.map((w) => w.bonStatus))).toEqual(new Set(['none', 'queued', 'sent', 'printed', 'failed']));
    expect(new Set(wires.map((w) => w.status))).toEqual(new Set(['paid', 'paid_print_failed', 'recovered']));
    expect(wires.slice(6).map((w) => w.receiptStatus)).toEqual(['skipped', 'pending']);
    golden('kiosk_orders', { orders: wires });
  });

  it('the receipt after the money, by the policy (the Android kiosk’s values)', () => {
    expect(receiptAfterApproval('always', false)).toBe('printed');
    expect(receiptAfterApproval('ask', false)).toBe('pending');
    expect(receiptAfterApproval('never', false)).toBe('skipped');
    expect(receiptAfterApproval('always', true)).toBe('skipped');
    expect(['pending', 'printed', 'declined', 'failed', 'skipped'].map(receiptStatusOf)).toEqual(['pending', 'printed', 'declined', 'failed', 'skipped']);
    expect([undefined, null, 'none', 'queued', 'x'].map(receiptStatusOf)).toEqual(['pending', 'pending', 'skipped', 'pending', 'pending']);
  });

  it('an order stored with a refused receipt value is sent as one the cloud takes, once', async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), 'kd-orders-')), 'k.db'));
    migrate(db);
    const store = new OrderStore(db);
    const stored = { localId: 'old-1', createdAtMs: 1, businessDate: '2026-10-06', serviceType: 'take_away', tableRef: null, fulfillmentMode: 'BON', configVersion: null, customerName: null, customerPhone: null, itemCount: 1, totalAgorot: 1200, tipAgorot: 0, paid: true, paidAt: '2026-10-06T09:15:01.300Z', transactionId: 't', transactionNumber: '40000001', pickupNumber: 1, pickupLabel: '1', bonRequestedAtMs: 1, bonJobIds: ['j'], bonStatus: 'sent', bonDetail: null, receiptStatus: 'none', recovered: false, syncedHash: 'refused-before' };
    db.run('INSERT INTO kiosk_orders (local_id, created_at, json) VALUES (?, ?, ?)', 'old-1', 1, JSON.stringify(stored));
    expect(store.get('old-1')?.receiptStatus).toBe('skipped');
    const posts: Array<Array<Record<string, unknown>>> = [];
    const api = {
      post: async (_p: string, body: { orders: Array<Record<string, unknown>> }) => {
        posts.push(body.orders);
        // As server/app/schemas/kiosk.py KioskOrderIn takes it.
        for (const w of body.orders) expect(['printed', 'declined', 'failed', 'skipped', 'pending']).toContain(w.receiptStatus);
        return { kind: 'ok', status: 200, body: { accepted: body.orders.map((w) => w.localId) }, headers: new Headers() };
      },
    } as unknown as Api;
    expect(await store.push(api, 'm')).toBe(true);
    expect(await store.push(api, 'm')).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0][0].receiptStatus).toBe('skipped');
  });

  it('a KDS release of a paid KDS-mode order (the Android kiosk’s payload, idempotent by the document)', () => {
    const doc = draft('completed');
    const body = kdsSaleRelease({
      transactionId: doc.id,
      transactionNumber: '40000057',
      order: { serviceType: 'take_away', customerName: 'דנה', customerPhone: '0501234567', pickupNumber: 17 },
      lines: doc.lines,
      categoryOf: (id) => (id === line1.productId ? '0b1c2d3e-0000-4000-8000-0000000000e1' : null),
      actorName: 'קיוסק Windows',
      occurredAt: doc.updatedAt,
    });
    expect(body.id).toBe(saleDispatchId(doc.id));
    golden('kds_release', body);
  });
});

describe('the golden payloads are the server’s fixtures too', () => {
  const serverDir = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'kiosk_desktop');
  it.runIf(existsSync(serverDir))('the same bytes in server/tests/fixtures/kiosk_desktop (validated by test_kiosk_desktop_contract.py)', () => {
    for (const f of readdirSync(GOLDEN)) {
      expect(readFileSync(path.join(serverDir, f), 'utf8').replace(/\r\n/g, '\n'), f).toBe(readFileSync(path.join(GOLDEN, f), 'utf8').replace(/\r\n/g, '\n'));
    }
  });
});

describe('the outbox order', () => {
  const row = (seq: number, kind: OutboxRow['kind'], ref: string): OutboxRow => ({ seq, kind, ref_id: ref, created_at: '', attempts: 0, last_error: null, next_at: 0 });

  it('side rows first; per shift by number: open → documents → close', () => {
    const steps = plan(
      [row(1, 'shift_close', 's1'), row(2, 'transaction', 'd2'), row(3, 'shift_open', 's2'), row(4, 'transmission', 't'), row(5, 'transaction', 'd1'), row(6, 'shift_open', 's1')],
      (d) => (d === 'd1' ? 's1' : 's2'),
      (id) => ({ id, sequence: id === 's1' ? 1 : 2, openedAt: '' }),
    );
    expect(steps.map((s) => `${s.kind}:${'row' in s ? s.row.ref_id : s.rows.map((r) => r.ref_id).join(',')}`)).toEqual(['side:t', 'open:s1', 'docs:d1', 'close:s1', 'open:s2', 'docs:d2']);
  });

  it('accepted and duplicate are success; a missing result is held, never assumed taken', () => {
    const r = docResults(['a', 'b', 'c', 'd'], { results: [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'duplicate' }, { id: 'c', status: 'rejected', reason: 'x' }] });
    expect([...r.values()].map((x) => x.result)).toEqual(['synced', 'synced', 'rejected', 'held']);
  });
});
