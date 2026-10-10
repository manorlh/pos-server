/**
 * Vouchers in the Windows kiosk's own payment (service.startPayment), end to end with a fake cloud and a fake terminal —
 * the same behaviour as the Android kiosk (KioskPayMethodModel + KioskViewModel.startPayment) and the browser kiosk through the bridge:
 *
 *  - a DISCOUNT voucher ("שובר הנחה", held in the cloud before payment) takes its share off the lines the kiosk prices; the
 *    document carries it inside its discount (`items[].voucherDiscount`, `voucherDiscounts[]`), never as a tender; the card is
 *    asked for what is left and the tip on it; the hold is CONFIRMED with the document once the sale is written (or released
 *    when the basket ended up taking nothing off by it);
 *  - a GOODS voucher ("שובר פריטים") is a leg of the document (`production_voucher`) worked out again from the basket as it
 *    stands, the lines it paid marked "כלול בשובר #N (n)", the card paying the rest — and the tip, which a voucher never pays;
 *    the redemption is attached to the document once written;
 *  - the vouchers that pay it all need no terminal; a card that declines leaves the vouchers untouched (the customer pays again
 *    or gives them back); a payload that is not the vouchers of an order is refused.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appliedVoucherOf } from '@dash-lib/kioskPricingCorpus';
import { KioskService } from '../src/main/service';
import type { StartPaymentIn } from '../src/shared/bridge';
import type { Transport } from '../src/main/printer/transports';
import type { PaymentProvider, Resolution, SaleResult } from '../src/main/payment/provider';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
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

const APPROVED: SaleResult = { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123456', uid: 'u-1', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'x' } } };

/** The terminal: what it was asked (agorot) and what it answers. */
function fakePinpad() {
  const asked: number[] = [];
  let seq = 0;
  const script: { sale: SaleResult; resolve: Resolution } = { sale: APPROVED, resolve: { kind: 'unknown', message: 'no answer' } };
  const provider: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async (req) => {
      asked.push(req.amountAgorot);
      return script.sale;
    },
    resolve: async () => script.resolve,
    abort: async () => undefined,
  };
  return { provider, asked, script };
}

const open: KioskService[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.stop();
});

/** A kiosk paired to the fake cloud; with [terminal] a configured card, without it none. Tips: 10% presets. */
function kiosk(opts: { terminal?: ReturnType<typeof fakePinpad>; fetchFn: typeof fetch; methods?: string[] }) {
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-voucher-pay-')),
    appVersion: '0.3.0',
    deviceInfo: { platform: 'windows' },
    transport: noPrinter,
    fetch: opts.fetchFn,
    providers: opts.terminal ? [() => opts.terminal!.provider] : [],
    downloader: async () => { throw new Error('no media'); },
  });
  open.push(svc);
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4' });
  svc.cloud.applyCatalog({
    syncType: 'full',
    serverTime: 'x',
    machineCatalog: { mode: 'all' },
    categories: [{ id: 'c-main', name: 'עיקריות', isActive: true }, { id: 'c-drinks', name: 'שתייה', isActive: true }],
    products: [
      { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '1001' },
      { id: 'p-cola', name: 'קולה', price: 10, categoryId: 'c-drinks', inStock: true, isAvailable: true, sku: '2001' },
      { id: 'p-wine', name: 'יין', price: 60, categoryId: 'c-drinks', inStock: true, isAvailable: true, sku: '2002', noDiscount: true },
    ],
    menu: null,
  });
  svc.cloud.setPromotions([], null);
  svc.cloud.setKioskSnapshot({
    kiosk: true,
    configVersion: 'v1',
    operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' },
    config: { payment: { tipEnabled: true, methods: opts.methods ?? ['card', 'voucher'], receiptPolicy: 'always' }, pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 }, printing: {} },
  });
  svc.applyProvider();
  return svc;
}

const lines = (...items: Array<[string, number]>) => items.map(([productId, qty], i) => ({ key: `L${i + 1}`, productId, qty, options: [], notes: [] as string[] }));

const base = (over: Partial<StartPaymentIn> & Pick<StartPaymentIn, 'lines'>): StartPaymentIn => ({
  service: 'take_away', customerName: null, customerPhone: null, tableRef: null, tipPct: 10, tipAgorot: null, ...over,
});

/** A goods voucher the customer redeemed: its leg, as the screens send it (its amount as they counted it). */
const leg = (serial: number, productId: string, quantity: number, amountAgorot = 0, includeExtras = false) => ({
  redemptionId: `red-${serial}`, serial, amountAgorot, eventName: null, includeExtras, redeemed: [{ productId, tillProductId: null, name: null, quantity }],
});

/** A discount voucher held for the order: ₪10 off the order (the cloud's lookup + reserve, as the screens keep it). */
const discount = (over: Record<string, unknown> = {}, id = 'v1') =>
  appliedVoucherOf({
    voucherId: id, batchId: 'A', serial: 12, batchName: 'פסטיבל הקיץ', stacking: 'unlimited', uses: 1,
    benefit: { kind: 'order_discount', discountType: 'fixed', value: 1000, minPurchaseAgorot: null, maxDiscountAgorot: null, maxUnits: null, productIds: [], categoryIds: [], promotionPolicy: 'exclude', ...over },
  });

const until = async <T>(fn: () => T | null | undefined | false, ms = 4000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The cloud's answers to the vouchers' follow-ups: confirm, release, attach, reverse. */
function settling(answers: ReturnType<typeof fakeCloud>['answers'], ids: { reservations?: string[]; redemptions?: string[] }) {
  for (const r of ids.reservations ?? []) {
    answers[`POST sync/m/prepaid-vouchers/reservations/${r}/confirm`] = () => ({ status: 200, body: { ok: true } });
    answers[`POST sync/m/prepaid-vouchers/reservations/${r}/release`] = () => ({ status: 200, body: { ok: true } });
  }
  for (const r of ids.redemptions ?? []) {
    answers[`POST sync/m/prepaid-vouchers/redemptions/${r}/attach`] = () => ({ status: 200, body: { ok: true } });
    answers[`POST sync/m/prepaid-vouchers/redemptions/${r}/reverse`] = () => ({ status: 200, body: { ok: true } });
  }
}

async function paid(svc: KioskService, orderId: string) {
  await until(() => {
    const p = svc.currentPay();
    return p && p.orderId === orderId && ['approved', 'declined', 'unknown'].includes(p.phase) ? p : null;
  });
  const order = svc.orders.get(orderId)!;
  return { order, doc: order.transactionId ? svc.ledger.doc(order.transactionId) : null, progress: svc.currentPay()! };
}

const calls = (sent: Sent[], pathPart: string) => sent.filter((s) => s.path.includes(pathPart));
type Row = Record<string, unknown>;
const wireOf = async (svc: KioskService, docId: string): Promise<Row> => {
  const { documentWire } = await import('../src/main/fiscal/ledger');
  return documentWire(svc.ledger.doc(docId)!);
};

describe('a discount voucher in the kiosk payment', () => {
  it('takes its share off the lines; the card is asked for what is left and the tip on it; the hold is confirmed with the document', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    // 42 + 2 × 10 = 62, less ₪10: 52; the tip 10% of that, 5.20.
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1], ['p-cola', 2]), expectedTotalAgorot: 5200, vouchers: { legs: [], discounts: [discount()], saleRef: 'sale-1' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 5720 });
    if (!started.ok) return;
    const { order, doc, progress } = await paid(svc, started.orderId);
    expect(progress.phase).toBe('approved');
    expect(terminal.asked).toEqual([5720]);
    expect(order).toMatchObject({ totalAgorot: 5200, tipAgorot: 520, paid: true });
    expect(doc).toMatchObject({ status: 'completed', totals: { grossAgorot: 6200, discountAgorot: 1000, voucherDiscountAgorot: 1000, totalAgorot: 5200, tipAgorot: 520 } });
    const wire = await wireOf(svc, doc!.id);
    expect(wire).toMatchObject({ totalAmount: 62, documentDiscount: 10, tipAmount: 5.2 });
    // A discount is never a tender: the card leg is the goods after it.
    expect((wire.payments as Row[]).map((p) => [p.method, p.amount])).toEqual([['card', 52]]);
    const items = wire.items as Row[];
    expect(items.map((i) => i.voucherDiscount)).toEqual([6.77, 3.23]);
    expect(wire.voucherDiscounts).toEqual([
      {
        reservationId: 'r-v1', voucherId: 'v1', batchId: 'A', serial: 12, batchName: 'פסטיבל הקיץ', kind: 'order_discount', uses: 1, amount: 10,
        lines: [{ itemId: items[0].id, amount: 6.77 }, { itemId: items[1].id, amount: 3.23 }],
      },
    ]);
    // Confirmed with the document (its uses taken), never released; nothing redeemed again.
    const confirm = await until(() => calls(cloud.sent, 'reservations/r-v1/confirm')[0]);
    expect(confirm.body).toEqual({ transactionId: doc!.id, amountAgorot: 1000, uses: 1 });
    expect(calls(cloud.sent, 'reservations/r-v1/release')).toHaveLength(0);
    expect(calls(cloud.sent, 'prepaid-vouchers/redeem')).toHaveLength(0);
  });

  it('"לא מקבל הנחות": a line that takes none is left out, and the screen\'s total is the one charged', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    // 20% off the order: the burger's 8.40; the wine (60, takes none) pays whole. 42 + 60 − 8.40 = 93.60.
    const v = discount({ discountType: 'percent', value: 2000 });
    expect(await svc.startPayment(base({ lines: lines(['p-burger', 1], ['p-wine', 1]), tipPct: null, expectedTotalAgorot: 10200, vouchers: { legs: [], discounts: [v], saleRef: 's' } }))).toMatchObject({ ok: false, reason: 'changed', totalAgorot: 9360 });
    expect(terminal.asked).toEqual([]);
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1], ['p-wine', 1]), tipPct: null, expectedTotalAgorot: 9360, vouchers: { legs: [], discounts: [v], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 9360 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    const items = (await wireOf(svc, doc!.id)).items as Row[];
    expect(items.map((i) => i.voucherDiscount ?? null)).toEqual([8.4, null]);
  });

  it('a voucher that took nothing off (under its minimum) is given back once the sale is written, never confirmed', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-cola', 1]), tipPct: null, expectedTotalAgorot: 1000, vouchers: { legs: [], discounts: [discount({ minPurchaseAgorot: 5000 })], saleRef: 's' } }));
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, amountAgorot: 1000 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    expect((await wireOf(svc, doc!.id)).voucherDiscounts).toBeUndefined();
    await until(() => calls(cloud.sent, 'reservations/r-v1/release')[0]);
    expect(calls(cloud.sent, 'reservations/r-v1/confirm')).toHaveLength(0);
  });

  it('a declined card leaves it held (the customer pays again or gives it back): nothing confirmed, nothing released, the document cancelled', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'] });
    const terminal = fakePinpad();
    terminal.script.sale = { answer: 'DECLINED', message: 'סירוב', raw: null, statusCode: 33 };
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1]), tipPct: null, vouchers: { legs: [], discounts: [discount()], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 3200 });
    if (!started.ok) return;
    const { doc, progress } = await paid(svc, started.orderId);
    expect(progress).toMatchObject({ phase: 'declined', message: 'סירוב' });
    expect(doc).toMatchObject({ status: 'cancelled' });
    await new Promise((r) => setTimeout(r, 60));
    expect(calls(cloud.sent, 'reservations/')).toHaveLength(0);
  });

  it('a card that first answers "unknown" and is then found approved settles the vouchers too', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'] });
    const terminal = fakePinpad();
    terminal.script.sale = { answer: 'UNKNOWN', message: 'timeout', raw: null };
    terminal.script.resolve = { kind: 'approved', card: { brand: 'visa', last4: '4242', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: 3200, meta: {} } };
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1]), tipPct: null, vouchers: { legs: [], discounts: [discount()], saleRef: 's' } }));
    if (!started.ok) throw new Error('not started');
    const { doc, progress } = await paid(svc, started.orderId);
    expect(progress.phase).toBe('approved');
    const confirm = await until(() => calls(cloud.sent, 'reservations/r-v1/confirm')[0]);
    expect(confirm.body).toMatchObject({ transactionId: doc!.id, amountAgorot: 1000 });
  });

  it('with no terminal it is refused before anything is written — as with no voucher at all', async () => {
    const cloud = fakeCloud();
    const svc = kiosk({ fetchFn: cloud.fetchFn });
    expect(await svc.startPayment(base({ lines: lines(['p-burger', 1]), vouchers: { legs: [], discounts: [discount()], saleRef: 's' } }))).toMatchObject({ ok: false, reason: 'terminal' });
    expect(await svc.startPayment(base({ lines: lines(['p-burger', 1]) }))).toMatchObject({ ok: false, reason: 'terminal' });
    expect(svc.ledger.currentShift()).toBeNull();
  });

  it('a discount that pays the whole of the goods leaves only the tip for the card', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    // ₪10 off a ₪10 cola: nothing left of the goods; the tip is a percent of what the goods cost now: none.
    const started = await svc.startPayment(base({ lines: lines(['p-cola', 1]), tipPct: 10, expectedTotalAgorot: 0, vouchers: { legs: [], discounts: [discount()], saleRef: 's' } }));
    // Nothing to charge at all: refused, never a ₪0 sale.
    expect(started).toMatchObject({ ok: false, reason: 'empty' });
    expect(terminal.asked).toEqual([]);
  });
});

describe('a goods voucher in the kiosk payment (a leg of the document)', () => {
  it('is worked out again from the basket: a leg beside the card, the covered line marked, the redemption attached', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { redemptions: ['red-7'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    // 62 of goods; one cola (10) is the voucher's (the screen counted 9.99: the service's count is the one charged); the tip on all the goods: 6.20.
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1], ['p-cola', 2]), expectedTotalAgorot: 6200, vouchers: { legs: [leg(7, 'p-cola', 1, 999)], discounts: [], saleRef: 'sale-1' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 5200 + 620 });
    if (!started.ok) return;
    const { doc, progress } = await paid(svc, started.orderId);
    expect(progress.phase).toBe('approved');
    expect(terminal.asked).toEqual([5820]);
    const wire = await wireOf(svc, doc!.id);
    expect((wire.payments as Row[]).map((p) => [p.method, p.amount])).toEqual([['production_voucher', 10], ['card', 52]]);
    // The payments add up to the goods (the cloud refuses a document whose legs do not).
    expect((wire.payments as Row[]).reduce((s, p) => s + Math.round((p.amount as number) * 100), 0)).toBe(6200);
    expect(wire).toMatchObject({ tipAmount: 6.2, paymentMethod: 'card' });
    const items = wire.items as Row[];
    expect(items[0].notes).toBeUndefined();
    expect(String(items[1].notes)).toMatch(/^כלול בשובר #7 \(1\)/);
    expect(items[1]).toMatchObject({ totalPrice: 20 });
    const attach = await until(() => calls(cloud.sent, 'redemptions/red-7/attach')[0]);
    expect(attach.body).toEqual({ transactionId: doc!.id });
  });

  it('beside a discount voucher: the goods voucher is worth what the lines cost after it', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { reservations: ['r-v1'], redemptions: ['red-7'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    // Two colas (20), ₪10 off the order: each 5 net. The voucher for one cola is worth 5.
    const started = await svc.startPayment(base({ lines: lines(['p-cola', 2]), tipPct: null, expectedTotalAgorot: 1000, vouchers: { legs: [leg(7, 'p-cola', 1)], discounts: [discount()], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 500 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    const wire = await wireOf(svc, doc!.id);
    expect((wire.payments as Row[]).map((p) => [p.method, p.amount])).toEqual([['production_voucher', 5], ['card', 5]]);
    expect(wire.documentDiscount).toBe(10);
    await until(() => calls(cloud.sent, 'reservations/r-v1/confirm')[0] && calls(cloud.sent, 'redemptions/red-7/attach')[0]);
  });

  it('paying the whole goods needs no terminal: the document is complete with the leg alone, the vouchers settled', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { redemptions: ['red-7'] });
    const svc = kiosk({ fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-cola', 1]), tipPct: null, expectedTotalAgorot: 1000, vouchers: { legs: [leg(7, 'p-cola', 1)], discounts: [], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 0 });
    if (!started.ok) return;
    const { order, doc, progress } = await paid(svc, started.orderId);
    expect(progress).toMatchObject({ phase: 'approved', pickupLabel: 'K-1' });
    expect(order.paid).toBe(true);
    expect(doc).toMatchObject({ status: 'completed', card: null });
    const wire = await wireOf(svc, doc!.id);
    expect(wire).toMatchObject({ paymentMethod: 'production_voucher', totalAmount: 10 });
    expect((wire.payments as Row[]).map((p) => [p.method, p.amount])).toEqual([['production_voucher', 10]]);
    await until(() => calls(cloud.sent, 'redemptions/red-7/attach')[0]);
  });

  it('paying the whole goods, the tip is still the card\'s: the terminal is asked for it alone, and the document has both', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { redemptions: ['red-7'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-cola', 1]), tipPct: 10, expectedTotalAgorot: 1000, vouchers: { legs: [leg(7, 'p-cola', 1)], discounts: [], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 100 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    expect(terminal.asked).toEqual([100]);
    const wire = await wireOf(svc, doc!.id);
    expect(wire).toMatchObject({ tipAmount: 1, tipPaymentMethod: 'card', paymentMethod: 'card' });
    expect((wire.payments as Row[]).map((p) => [p.method, p.amount])).toEqual([['production_voucher', 10], ['card', 0]]);
  });

  it('no terminal and something left to pay: refused before anything is written, the leg untouched', async () => {
    const cloud = fakeCloud();
    const svc = kiosk({ fetchFn: cloud.fetchFn });
    const r = await svc.startPayment(base({ lines: lines(['p-burger', 1], ['p-cola', 1]), tipPct: null, vouchers: { legs: [leg(7, 'p-cola', 1)], discounts: [], saleRef: 's' } }));
    expect(r).toMatchObject({ ok: false, reason: 'terminal' });
    expect(svc.ledger.currentShift()).toBeNull();
    expect(calls(cloud.sent, 'redemptions/')).toHaveLength(0);
  });

  it('a voucher the basket no longer needs goes back on itself, and is no leg', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { redemptions: ['red-8'] });
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    // A voucher for a burger, a basket of a cola alone.
    const started = await svc.startPayment(base({ lines: lines(['p-cola', 1]), tipPct: null, vouchers: { legs: [leg(8, 'p-burger', 1, 4200)], discounts: [], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 1000 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    expect(((await wireOf(svc, doc!.id)).payments as Row[]).map((p) => p.method)).toEqual(['card']);
    await until(() => calls(cloud.sent, 'redemptions/red-8/reverse')[0]);
    expect(calls(cloud.sent, 'redemptions/red-8/attach')).toHaveLength(0);
  });

  it('a declined card leaves the leg: the document cancelled, the redemption not attached', async () => {
    const cloud = fakeCloud();
    settling(cloud.answers, { redemptions: ['red-7'] });
    const terminal = fakePinpad();
    terminal.script.sale = { answer: 'DECLINED', message: 'סירוב', raw: null, statusCode: 33 };
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1], ['p-cola', 1]), tipPct: null, vouchers: { legs: [leg(7, 'p-cola', 1)], discounts: [], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 4200 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    expect(doc).toMatchObject({ status: 'cancelled' });
    await new Promise((r) => setTimeout(r, 60));
    expect(calls(cloud.sent, 'redemptions/')).toHaveLength(0);
  });
});

describe('the vouchers of an order are checked', () => {
  it('a payload that is not the vouchers of an order is refused before anything is priced or charged', async () => {
    const cloud = fakeCloud();
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const bad = [
      'x',
      { legs: [], discounts: [] },
      { legs: 'x', discounts: [], saleRef: 's' },
      { legs: [{ redemptionId: '', serial: 1, amountAgorot: 1, redeemed: [] }], discounts: [], saleRef: 's' },
      { legs: [], discounts: [{ reservationId: 'r' }], saleRef: 's' },
    ];
    for (const vouchers of bad) {
      expect(await svc.startPayment(base({ lines: lines(['p-cola', 1]), vouchers: vouchers as never }))).toMatchObject({ ok: false, reason: 'error', message: 'השוברים של ההזמנה אינם תקינים' });
    }
    expect(terminal.asked).toEqual([]);
    expect(svc.ledger.currentShift()).toBeNull();
  });

  it('no vouchers at all is the card sale as before: the card for all of it, the document without legs', async () => {
    const cloud = fakeCloud();
    const terminal = fakePinpad();
    const svc = kiosk({ terminal, fetchFn: cloud.fetchFn });
    const started = await svc.startPayment(base({ lines: lines(['p-burger', 1]), tipPct: null, expectedTotalAgorot: 4200, vouchers: { legs: [], discounts: [], saleRef: 's' } }));
    expect(started).toMatchObject({ ok: true, amountAgorot: 4200 });
    if (!started.ok) return;
    const { doc } = await paid(svc, started.orderId);
    const wire = await wireOf(svc, doc!.id);
    expect((wire.payments as Row[]).map((p) => [p.method, p.amount])).toEqual([['card', 42]]);
    expect(wire.voucherDiscounts).toBeUndefined();
    expect(calls(cloud.sent, 'prepaid-vouchers')).toHaveLength(0);
  });
});

describe('the open order to the till refuses a discount voucher (it is redeemed here, in the kiosk\'s own payment)', () => {
  it('with the Android kiosk\'s words, and nothing sent to the tills', async () => {
    const cloud = fakeCloud();
    const svc = kiosk({ fetchFn: cloud.fetchFn, methods: ['cash_at_till', 'voucher'] });
    const r = await svc.placeOpenOrder({
      ...base({ lines: lines(['p-cola', 1]) }), vouchers: [], discounts: [{ reservationId: 'r-v1' }],
    } as never);
    expect(r).toMatchObject({ ok: false });
    expect(calls(cloud.sent, 'kiosk/open-orders')).toHaveLength(0);
  });
});
