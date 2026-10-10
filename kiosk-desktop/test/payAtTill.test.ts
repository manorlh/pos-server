/**
 * "איך תרצו לשלם?" on the Windows kiosk (PARITY.md gap 7): the methods configured (payment.methods),
 * what the kiosk can take now, "מזומן בקופה" — the basket priced here, the open order to the tills,
 * written first and sent until the cloud takes it — and prepaid vouchers redeemed online and given
 * back. The order's wire is pinned as a golden payload the server validates (open_order.json).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openOrderWire, orderDue } from '@dash-lib/kioskWebOrders';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const GOLDEN = path.join(here, 'fixtures', 'contract');
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

type Sent = { method: string; path: string; body: Record<string, unknown> | null };

function fakeCloud() {
  const sent: Sent[] = [];
  const answers: Record<string, ((b: Record<string, unknown> | null) => { status: number; body?: unknown } | 'offline') | undefined> = {};
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/api\/v1\//, '').replace(MACHINE, 'm');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, path: p, body });
    const answer = answers[`${method} ${p}`]?.(body) ?? { status: 404, body: { detail: 'Not Found' } };
    if (answer === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, answers, fetchFn };
}

function kiosk(fetchFn: typeof fetch, payment: Record<string, unknown>, printing: Record<string, unknown> = {}) {
  const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-till-')), appVersion: '0.3.0', deviceInfo: { platform: 'windows' }, transport: noPrinter, fetch: fetchFn, downloader: async () => { throw new Error('no media'); } });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
  svc.cloud.applyCatalog({
    syncType: 'full',
    serverTime: 'x',
    machineCatalog: { mode: 'all' },
    categories: [{ id: 'c-main', name: 'עיקריות', isActive: true }, { id: 'c-drinks', name: 'שתייה', isActive: true }],
    products: [
      { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '1001', imageUrl: 'https://img.example/b.png', allergens: ['gluten'] },
      { id: 'p-cola', name: 'קולה', price: 10, categoryId: 'c-drinks', inStock: true, isAvailable: true, sku: '2001' },
    ],
    menu: null,
  });
  // 1+1 on drinks: the order carries each line's share, as the till will charge it.
  svc.cloud.setPromotions([{ id: 'promo-1', name: '1+1 שתייה', type: 'buy_x_get_y', priority: 0, config: { target: { categoryIds: ['c-drinks'] }, buyQuantity: 1, getQuantity: 1 } }], null);
  svc.cloud.setKioskSnapshot({ kiosk: true, configVersion: 'v1', operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' }, config: { payment: { tipEnabled: true, ...payment }, pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 }, printing } });
  return svc;
}

const basket = (expected?: number) => ({
  lines: [
    { key: 'L1', productId: 'p-burger', qty: 1, options: [], notes: ['בלי בצל'] },
    { key: 'L2', productId: 'p-cola', qty: 2, options: [], notes: [] },
  ],
  service: 'take_away' as const,
  customerName: 'דנה',
  customerPhone: null,
  tableRef: null,
  tipPct: 10,
  tipAgorot: null,
  ...(expected !== undefined ? { expectedTotalAgorot: expected } : {}),
});

describe('what this kiosk can take now', () => {
  it('the methods configured; the card only with a ready terminal, a voucher only online, cash at the till always', () => {
    const { fetchFn } = fakeCloud();
    const svc = kiosk(fetchFn, { methods: ['cash_at_till', 'card', 'voucher'] });
    try {
      const pay = svc.view().pay;
      expect(pay.methods).toEqual(['cash_at_till', 'card', 'voucher']);
      // No terminal configured in the test: the card is off, with its reason.
      expect(pay.usable).toEqual(['cash_at_till', 'voucher']);
      expect(pay.cardOff).toBeTruthy();
    } finally {
      svc.stop();
    }
  });

  it('never "פיצול תשלום בכרטיסים" (split_card): one card per document here', () => {
    const { fetchFn } = fakeCloud();
    const svc = kiosk(fetchFn, { methods: ['split_card', 'cash_at_till', 'card', 'voucher'] });
    try {
      const pay = svc.view().pay;
      expect(pay.methods).toEqual(['cash_at_till', 'card', 'voucher']);
      expect(pay.usable).not.toContain('split_card');
      expect(pay.usable).toEqual(['cash_at_till', 'voucher']);
    } finally {
      svc.stop();
    }
  });

  it('only split_card and a voucher: the card beside it, and the voucher kept but not usable with no terminal to pay what it leaves', () => {
    const { fetchFn } = fakeCloud();
    const svc = kiosk(fetchFn, { methods: ['voucher', 'split_card'] });
    try {
      const pay = svc.view().pay;
      // A voucher is a leg of the document the card pays the rest of (as the Android kiosk), so it stays on the list; but with no usable
      // card and no "מזומן בקופה" its order could not be finished here: never a dead end (voucherCanFinish).
      expect(pay.methods).toEqual(['card', 'voucher']);
      expect(pay.usable).not.toContain('split_card');
      expect(pay.usable).not.toContain('voucher');
    } finally {
      svc.stop();
    }
    const alone = kiosk(fakeCloud().fetchFn, { methods: ['split_card'] });
    try {
      expect(alone.view().pay.methods).toEqual(['card']);
      expect(alone.view().pay.usable).toEqual([]);
    } finally {
      alone.stop();
    }
  });
});

describe('"מזומן בקופה": the open order to the tills', () => {
  it('priced here (promotions included), numbered, sent; its wire is the server’s (golden)', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    answers['POST sync/m/kiosk/open-orders'] = (b) => ({ status: 200, body: { accepted: ((b?.orders ?? []) as Array<{ localId: string }>).map((o) => o.localId), rejected: [] } });
    const svc = kiosk(fetchFn, { methods: ['cash_at_till', 'card'] });
    try {
      // 42 + 2 × 10, the second cola free: 52.
      const r = await svc.placeOpenOrder({ ...basket(5200), vouchers: [] });
      expect(r).toMatchObject({ ok: true, pickupLabel: 'K-1', pending: false });
      if (!r.ok) return;
      // The tip: 10% of what the goods cost after the promotions.
      expect(r.dueAgorot).toBe(5200 + 520);
      expect(r.code).toBe(`KO:${r.localId}`);
      const wire = (sent.find((s) => s.path === 'sync/m/kiosk/open-orders')!.body!.orders as Array<Record<string, unknown>>)[0];
      expect(wire).toMatchObject({ totalAgorot: 5200, tipAgorot: 520, voucherAgorot: 0, dueAgorot: 5720, itemCount: 3, state: 'open' });
      const lines = wire.lines as Array<Record<string, unknown>>;
      expect(lines.map((l) => l.totalAgorot)).toEqual([4200, 1000]);
      // The golden payload (stable ids and times), validated by the server's schema.
      const order = svc.payAtTill.order(r.localId)!;
      const stable = { ...order, localId: 'open-order-1', createdAtMs: Date.parse('2026-10-07T09:30:00Z'), businessDate: '2026-10-07' };
      const text = `${JSON.stringify(openOrderWire(stable), null, 2)}\n`;
      const file = path.join(GOLDEN, 'open_order.json');
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(file, text);
      }
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
      expect(orderDue(stable)).toBe(5720);
    } finally {
      svc.stop();
    }
  });

  it('never a total the customer did not see; never where cash at the till is not offered', async () => {
    const { fetchFn } = fakeCloud();
    const svc = kiosk(fetchFn, { methods: ['cash_at_till', 'card'] });
    const card = kiosk(fetchFn, { methods: ['card'] });
    try {
      expect(await svc.placeOpenOrder({ ...basket(6200), vouchers: [] })).toMatchObject({ ok: false, reason: 'changed', totalAgorot: 5200 });
      expect(await card.placeOpenOrder({ ...basket(5200), vouchers: [] })).toMatchObject({ ok: false, reason: 'error' });
    } finally {
      svc.stop();
      card.stop();
    }
  });

  it('the cloud prices it otherwise while the customer waits: nothing placed or printed, the change shown', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    // The cloud's own price of the burger (kiosk_basket_check.price_lines): ₪45, not the ₪42 here.
    answers['POST sync/m/kiosk/open-orders'] = (b) => ({
      status: 200,
      body: { accepted: [], rejected: ((b?.orders ?? []) as Array<{ localId: string }>).map((o) => ({ localId: o.localId, reason: 'price_changed', lines: [{ key: 'L1', productId: 'p-burger', name: 'המבורגר', fromAgorot: 4200, toAgorot: 4500, reason: 'price' }] })) },
    });
    answers['GET sync/m/catalog'] = () => ({ status: 200, body: { syncType: 'delta', serverTime: 'y', products: [], categories: [] } });
    // "בון מטבח במדפסת הקיוסק" on: the bon "ממתין לתשלום בקופה" prints here (off — the default — the till prints it).
    const svc = kiosk(fetchFn, { methods: ['cash_at_till'], cashAtTillKitchenBeforePay: true }, { bonOnKiosk: true });
    try {
      const r = await svc.placeOpenOrder({ ...basket(5200), vouchers: [] });
      expect(r).toEqual({ ok: false, reason: 'changed', changes: [{ kind: 'repriced', productId: 'p-burger', name: 'המבורגר', key: 'L1', from: 4200, to: 4500 }] });
      // Sent while the customer waited; forgotten (never retried); no bon, no slip; the catalog asked at once.
      const posted = sent.filter((x) => x.path === 'sync/m/kiosk/open-orders');
      expect((posted[0].body!.orders as Array<Record<string, unknown>>)[0].customerWaiting).toBe(true);
      expect(svc.payAtTill.orders()).toEqual([]);
      expect(svc.view().staff.unprintedBons).toBe(0);
      expect(sent.some((x) => x.method === 'GET' && x.path.startsWith('sync/m/catalog'))).toBe(true);
      // Asked again and taken: the kitchen's bon ("ממתין לתשלום בקופה") and the slip print now.
      answers['POST sync/m/kiosk/open-orders'] = (b) => ({ status: 200, body: { accepted: ((b?.orders ?? []) as Array<{ localId: string }>).map((o) => o.localId) } });
      const again = await svc.placeOpenOrder({ ...basket(5200), vouchers: [] });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(svc.printQueue.jobsFor(again.localId, 'bon')).toHaveLength(1);
      expect(svc.payAtTill.order(again.localId)!.kitchenSent).toBe(true);
    } finally {
      svc.stop();
    }
  });

  it('offline: kept, the screen told it waits, sent with the next beat', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    answers['POST sync/m/kiosk/open-orders'] = () => 'offline';
    const svc = kiosk(fetchFn, { methods: ['cash_at_till'] });
    try {
      const r = await svc.placeOpenOrder({ ...basket(5200), vouchers: [] });
      expect(r).toMatchObject({ ok: true, pending: true });
      expect(svc.payAtTill.pending()).toBe(1);
      answers['POST sync/m/kiosk/open-orders'] = (b) => ({ status: 200, body: { accepted: ((b?.orders ?? []) as Array<{ localId: string }>).map((o) => o.localId) } });
      await svc.payAtTill.flush();
      expect(svc.payAtTill.pending()).toBe(0);
      const posted = sent.filter((s) => s.path === 'sync/m/kiosk/open-orders');
      expect(posted).toHaveLength(2);
      // The retry never says the customer waits: the slip may be in their hand (never refused for its prices).
      expect(posted.map((p) => (p.body!.orders as Array<Record<string, unknown>>)[0].customerWaiting)).toEqual([true, undefined]);
    } finally {
      svc.stop();
    }
  });
});

describe('vouchers', () => {
  it('redeemed for the basket’s goods it covers (net of promotions), the order carries it; given back, retried until the cloud answers', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    answers['POST sync/m/prepaid-vouchers/lookup'] = () => ({ status: 200, body: { redeemable: true, splitAllowed: true, items: [{ productId: 'p-cola', name: 'קולה', quantity: 2, remaining: 2 }] } });
    answers['POST sync/m/prepaid-vouchers/redeem'] = (b) => ({ status: 200, body: { redemptionId: 'red-1', redeemed: b?.items, voucher: { serial: 77, eventName: 'אירוע' } } });
    answers['POST sync/m/kiosk/open-orders'] = (b) => ({ status: 200, body: { accepted: ((b?.orders ?? []) as Array<{ localId: string }>).map((o) => o.localId) } });
    const svc = kiosk(fetchFn, { methods: ['cash_at_till', 'voucher'] });
    try {
      const r = await svc.redeemVoucher({ code: 'ABCD1234', basket: basket(5200), earlier: [], clientRequestId: 'try-1' });
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      // Two colas, the second free by the promotion: the voucher covers what they cost, ₪10.
      expect(r.leg).toMatchObject({ redemptionId: 'red-1', serial: 77, amountAgorot: 1000 });
      expect(sent.find((s) => s.path === 'sync/m/prepaid-vouchers/redeem')!.body).toMatchObject({ clientRequestId: 'try-1', items: [{ productId: 'p-cola', quantity: 2 }], posUserId: `kiosk:${MACHINE}` });
      const placed = await svc.placeOpenOrder({ ...basket(5200), vouchers: [r.leg] });
      expect(placed).toMatchObject({ ok: true, dueAgorot: 5200 + 520 - 1000 });
      // Given back: offline first, then the next beat.
      answers[`POST sync/m/prepaid-vouchers/redemptions/red-2/reverse`] = () => 'offline';
      await svc.reverseVoucher('red-2');
      answers[`POST sync/m/prepaid-vouchers/redemptions/red-2/reverse`] = () => ({ status: 200, body: {} });
      await svc.payAtTill.flush();
      expect(sent.filter((s) => s.path.endsWith('red-2/reverse'))).toHaveLength(2);
      await svc.payAtTill.flush();
      expect(sent.filter((s) => s.path.endsWith('red-2/reverse'))).toHaveLength(2);
    } finally {
      svc.stop();
    }
  });

  it('a voucher that matches nothing in the basket is never redeemed; a refusal says why', async () => {
    const { sent, answers, fetchFn } = fakeCloud();
    answers['POST sync/m/prepaid-vouchers/lookup'] = () => ({ status: 200, body: { redeemable: true, items: [{ productId: 'p-other', name: 'x', quantity: 1, remaining: 1 }] } });
    const svc = kiosk(fetchFn, { methods: ['cash_at_till', 'voucher'] });
    try {
      expect(await svc.redeemVoucher({ code: 'ABCD1234', basket: basket(), earlier: [], clientRequestId: 'x' })).toEqual({ kind: 'no_match' });
      expect(sent.some((s) => s.path.endsWith('prepaid-vouchers/redeem'))).toBe(false);
      answers['POST sync/m/prepaid-vouchers/lookup'] = () => ({ status: 200, body: { redeemable: false, status: 'used' } });
      expect(await svc.redeemVoucher({ code: 'ABCD1234', basket: basket(), earlier: [], clientRequestId: 'y' })).toEqual({ kind: 'refused', reason: 'prepaid_voucher_used' });
      // The cloud's own words come along…
      answers['POST sync/m/prepaid-vouchers/lookup'] = () => ({
        status: 200, body: { redeemable: false, reason: 'prepaid_voucher_used', message: 'השובר מומש כבר בקופה 2 בשעה 14:05' },
      });
      expect(await svc.redeemVoucher({ code: 'ABCD1234', basket: basket(), earlier: [], clientRequestId: 'z' })).toEqual({
        kind: 'refused', reason: 'prepaid_voucher_used', message: 'השובר מומש כבר בקופה 2 בשעה 14:05',
      });
      // …but a voucher this kiosk cannot book sends the customer to the till, never "update the till".
      answers['POST sync/m/prepaid-vouchers/lookup'] = () => ({
        status: 200, body: { redeemable: false, reason: 'prepaid_voucher_update_required', message: 'יש לעדכן את גרסת הקופה כדי לממש שובר מסוג זה' },
      });
      expect(await svc.redeemVoucher({ code: 'ABCD1234', basket: basket(), earlier: [], clientRequestId: 'u' })).toEqual({
        kind: 'refused', reason: 'prepaid_voucher_update_required',
      });
      expect(sent.some((s) => s.path.endsWith('prepaid-vouchers/redeem'))).toBe(false);
    } finally {
      svc.stop();
    }
  });
});

describe('the golden open order is the server’s fixture too', () => {
  const serverFile = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'kiosk_desktop', 'open_order.json');
  it.runIf(existsSync(serverFile))('the same bytes in server/tests/fixtures/kiosk_desktop', () => {
    expect(readFileSync(serverFile, 'utf8').replace(/\r\n/g, '\n')).toBe(readFileSync(path.join(GOLDEN, 'open_order.json'), 'utf8').replace(/\r\n/g, '\n'));
  });
});
