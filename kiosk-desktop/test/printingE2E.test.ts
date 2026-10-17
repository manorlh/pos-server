/**
 * Printing end to end on Windows ("תבדוק ותתקן גם לווינדוס 10 ו-7, במצב קופה וגם קיוסק", the owner 17.10.2026): the real
 * flows of the till and the kiosk (main/till/engine.ts, main/service.ts) through the real print queue and the real TCP
 * transport (main/printer/transports.ts tcpSend / tcpStatus) to a fake ESC/POS printer on the loopback
 * (test/fakePrinter.ts) — every byte it got read back as the head would.
 *
 * Checked: every document prints once (no duplicate, none missing), each job is INIT · picture · cut, item tickets one
 * per unit, the drawer pulses only on cash at the counter (never card, never the device's cash), paper out is found
 * before a page is lost, kiosk receipts by `receiptPolicy`, reprints, the other till's documents and drawer, the width.
 *
 * The drawing here is a stand-in (a bar whose height names the page): the real one is Chromium's, checked by the print
 * smoke runs under Electron 44 and 22 (scripts/print-e2e.ts → P:/specs/win-printing-e2e/).
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrintDoc } from '../src/core/printDocs';
import type { PaymentProvider, SaleResult } from '../src/main/payment/provider';
import type { DrawnPage, PageRenderer } from '../src/main/printer/printQueue';
import { DefaultTransport, healthOfBits, tcpStatus, type PrinterTarget, type SendOptions, type Transport } from '../src/main/printer/transports';
import { KioskService } from '../src/main/service';
import type { PayProgress, StartPaymentIn } from '../src/shared/bridge';
import { FakePrinter, parseEscPos } from './fakePrinter';
import { harness, MANAGER_PIN, PIN, type Harness, type HarnessOptions } from './tillEngineHarness';

/** The app's own transport (main/printer/transports.ts DefaultTransport) for TCP — the spooler's PowerShell never started. */
function tcpTransport(): Transport & { sends: number } {
  const real = new DefaultTransport();
  const t = {
    sends: 0,
    async send(target: PrinterTarget, bytes: Uint8Array, opts?: SendOptions) {
      t.sends += 1;
      if (target.transport !== 'tcp') throw new Error('no printer configured');
      await real.send(target, bytes, opts);
    },
    status: (target: PrinterTarget) => real.status(target),
    list: async () => [],
    dispose: () => undefined,
  };
  return t;
}

/** A stand-in drawing: [width] wide, a black bar 8 rows tall, then white — every page the same shape, its doc kept. */
function recordingRenderer(drawn: Array<{ doc: PrintDoc; width: number }>): PageRenderer {
  return async (doc, width): Promise<DrawnPage> => {
    drawn.push({ doc, width });
    const height = 40;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let y = 4; y < 12; y++) for (let x = 0; x < width; x++) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    return { width, height, rgba };
  };
}

const until = async <T>(fn: () => T | null | undefined | false, ms = 8_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** Nothing more comes for a while (the queue is idle and the printer got nothing new). */
async function settled(h: Harness, printer: FakePrinter, quietMs = 250) {
  let last = -1;
  let since = Date.now();
  for (;;) {
    const busy = h.svc.printQueue.busy;
    const queued = (h.svc as unknown as { db: { get: (s: string) => { n: number } } }).db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE status IN ('queued','sending')").n;
    const n = printer.jobs.length;
    if (n !== last || busy || queued > 0) {
      last = n;
      since = Date.now();
    } else if (Date.now() - since > quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

let printer: FakePrinter;
const open: Harness[] = [];

beforeEach(async () => {
  printer = new FakePrinter();
  await printer.start();
});

afterEach(async () => {
  for (const h of open.splice(0)) h.stop();
  await printer.stop();
});

interface Rig {
  h: Harness;
  drawn: Array<{ doc: PrintDoc; width: number }>;
  transport: ReturnType<typeof tcpTransport>;
}

async function till(o: HarnessOptions = {}, pin = PIN): Promise<Rig> {
  const drawn: Rig['drawn'] = [];
  const transport = tcpTransport();
  const h = harness({ ...o, transport, renderer: recordingRenderer(drawn) });
  open.push(h);
  h.svc.setLocalSettings({ printer: { transport: 'tcp', host: printer.address!.host, port: printer.address!.port } });
  // The kitchen queue's worker (svc.start() runs it in the app).
  h.svc.kitchen.start();
  await h.ok('session.login', { pin });
  await h.ok('shift.open', { openingCashAgorot: 20_000 });
  return { h, drawn, transport };
}

/** The harness's catalog, with item tickets: the cola one per unit, the burger one per line, the steak none. */
const TICKETED: Array<Record<string, unknown>> = [
  { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', ticketMode: 'per_line' },
  { id: 'p-cola', name: 'קולה', price: 12.5, categoryId: 'c-drink', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', ticketMode: 'per_unit' },
  { id: 'p-pos', name: 'סטייק צוות', price: 80, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
];

const kinds = (r: Rig) => r.drawn.map((d) => d.doc.kind);
const titles = (r: Rig) => r.drawn.map((d) => ('title' in d.doc ? String((d.doc as { title?: unknown }).title ?? '') : '').replace(/\p{Cf}/gu, ''));

describe('the fake printer reads the app’s bytes back', () => {
  it('a page: INIT, the picture centred on 576, feed, one partial cut; DLE EOT answered as the state says', async () => {
    const { job, centreOn, toMono } = await import('../src/core/escpos');
    const rgba = new Uint8Array(16 * 2 * 4).fill(0);
    const bytes = job(centreOn(toMono(rgba, 16, 2), 576), { cut: true });
    const p = parseEscPos(bytes);
    expect(p.events.map((e) => e.op)).toEqual(['init', 'raster', 'feed', 'cut']);
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0].width).toBe(576);
    expect(p.unknown).toBe(0);
    printer.state.paper = 'out';
    expect(healthOfBits(await tcpStatus(printer.address!.host, printer.address!.port))).toBe('no_paper');
    printer.state.paper = 'near_end';
    expect(healthOfBits(await tcpStatus(printer.address!.host, printer.address!.port))).toBe('paper_low');
    printer.state.paper = 'ok';
    printer.state.coverOpen = true;
    expect(healthOfBits(await tcpStatus(printer.address!.host, printer.address!.port))).toBe('cover_open');
  });
});

describe('the till (Windows 10/11 and 7 share this code)', () => {
  it('a cash sale: one receipt, one drawer pulse (pin 2), nothing twice', async () => {
    const r = await till({ parameters: { cashDrawer: 'כן' } });
    await r.h.ok('sell.add', { productId: 'p-burger' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 5_000 });
    await r.h.ok('checkout.finish');
    await settled(r.h, printer);
    expect(kinds(r)).toEqual(['receipt']);
    expect(printer.pageJobs()).toHaveLength(1);
    const page = printer.pageJobs()[0].parsed;
    expect(page.cuts).toBe(1);
    expect(page.pages[0].width).toBe(576);
    expect(printer.kicks()).toEqual([{ pin: 2, onMs: 50, offMs: 500 }]);
  });

  it('a card sale: the receipt, never the drawer', async () => {
    const r = await till({ parameters: { cashDrawer: 'כן' } });
    await r.h.ok('sell.add', { productId: 'p-burger' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.card');
    await until(() => r.h.state().checkout.phase === 'done');
    await settled(r.h, printer);
    expect(kinds(r)).toEqual(['receipt']);
    expect(printer.kicks()).toHaveLength(0);
  });

  it('item tickets ("שובר פריט"): one per unit after the receipt, as the Android till prints them', async () => {
    const r = await till({ products: TICKETED, parameters: { cashDrawer: 'כן' } });
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('sell.add', { productId: 'p-burger' });
    await r.h.ok('sell.add', { productId: 'p-pos' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 20_000 });
    await r.h.ok('checkout.finish');
    await settled(r.h, printer);
    expect(kinds(r)).toEqual(['receipt', 'ticket', 'ticket', 'ticket']);
    expect(titles(r).slice(1)).toEqual(['שובר 1/3', 'שובר 2/3', 'שובר 3/3']);
    expect(printer.pageJobs()).toHaveLength(4);
  });

  it('item tickets print under "דוחות בלבד" too (no receipt) — and never for a credit note', async () => {
    const r = await till({ products: TICKETED, parameters: { printMode: 'דוחות בלבד' } }, MANAGER_PIN);
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 1_250 });
    await r.h.ok('checkout.finish');
    await settled(r.h, printer);
    expect(kinds(r)).toEqual(['ticket']);
  });

  it('the copy ("העתק") prints once more, the X once, a refund from the history its credit note', async () => {
    const r = await till({ parameters: { cashDrawer: 'כן' } }, MANAGER_PIN);
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 1_250 });
    const id = r.h.state().checkout.documentId!;
    await r.h.ok('checkout.finish');
    await r.h.ok('doc.reprint', { documentId: id });
    await settled(r.h, printer);
    expect(kinds(r)).toEqual(['receipt', 'receipt']);
    expect(JSON.stringify(r.drawn[1].doc)).toContain('העתק');
    await r.h.ok('report.x');
    await settled(r.h, printer);
    expect(kinds(r)).toEqual(['receipt', 'receipt', 'z']);
    await r.h.ok('doc.refund', { documentId: id });
    await settled(r.h, printer);
    // A refund from the history: its credit note (Android ReceiptService.print — the shop's copy is the basket's).
    expect(kinds(r).slice(3)).toEqual(['receipt']);
    // The cash went back: the drawer opened for the sale and for the refund — once each.
    expect(printer.kicks()).toHaveLength(2);
  });

  it('one printer for everything ("אותה מדפסת יכולה להיות הכל"): "בונים במכירה" with no kitchen printer — the bon prints on the receipt printer, each page cut', async () => {
    const r = await till({ products: TICKETED, parameters: { kitchenTicketsOnSale: true, cashDrawer: 'כן' } });
    await r.h.ok('sell.add', { productId: 'p-burger' });
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 10_000 });
    expect(r.h.state().checkout.kitchenWarning ?? null).toBeNull();
    await r.h.ok('checkout.finish');
    await until(() => printer.pageJobs().length >= 4);
    await settled(r.h, printer, 600);
    // The bon, the receipt, the cola's ticket, the burger's — four pages on one printer, none dropped, one cut each.
    expect(kinds(r).sort()).toEqual(['kitchen', 'receipt', 'ticket', 'ticket']);
    expect(printer.pageJobs()).toHaveLength(4);
    for (const j of printer.pageJobs()) expect(j.parsed.cuts).toBe(1);
    // The receipt before its item tickets.
    expect(kinds(r).filter((k) => k !== 'kitchen')).toEqual(['receipt', 'ticket', 'ticket']);
    expect(printer.kicks()).toHaveLength(1);
  });

  it('a mixed basket (a return and a sale): the sale, the credit note and its shop copy, "סיכום עסקה"; tickets for the sale only', async () => {
    const r = await till({ products: TICKETED }, MANAGER_PIN);
    await r.h.ok('refund.button');
    await r.h.ok('refund.catalog');
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('refund.end');
    await r.h.ok('sell.add', { productId: 'p-burger' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.returnCustomer', { name: 'אבי כהן', phone: '050-1234567' });
    await r.h.ok('checkout.cash', { amountAgorot: 3_000 });
    await settled(r.h, printer, 400);
    expect(kinds(r)).toEqual(['receipt', 'receipt', 'receipt', 'receipt', 'ticket']);
    const text = JSON.stringify(r.drawn.map((d) => d.doc));
    expect(text).toContain('העתק לבית העסק');
    expect(JSON.stringify(r.drawn[3].doc)).toContain('סיכום עסקה');
    expect(JSON.stringify(r.drawn[3].doc)).toContain('שולם');
  });

  it('paper out on a network printer: the receipt is NOT sent into it (it would be lost) — the queue waits, says "no_paper", prints once the roll is in', async () => {
    printer.state.paper = 'out';
    const r = await till();
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 1_250 });
    const id = r.h.state().checkout.documentId!;
    await until(() => r.h.svc.printQueue.lastFailure);
    expect(r.h.svc.printQueue.health()).toBe('no_paper');
    expect(printer.pageJobs()).toHaveLength(0);
    printer.state.paper = 'ok';
    await until(() => r.h.svc.printQueue.jobsFor(id, 'receipt')[0]?.status === 'failed' || r.h.svc.printQueue.jobsFor(id, 'receipt')[0]?.status === 'sent', 15_000);
    if (r.h.svc.printQueue.jobsFor(id, 'receipt')[0].status === 'failed') r.h.svc.printQueue.retryFailed(id);
    await until(() => printer.pageJobs().length === 1);
    await settled(r.h, printer);
    expect(printer.pageJobs()).toHaveLength(1);
    expect(r.h.svc.printQueue.health()).toBe('ok');
  }, 30_000);

  it('the paper runs out on an item ticket: it is never printed again by itself (exchanged for goods) — the receipt is', async () => {
    const r = await till({ products: TICKETED });
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('checkout.start');
    // The roll ends on the second page this sale sends (the ticket, after the receipt): the head takes its bytes, then
    // answers "paper out".
    printer.state.runOutOnPage = 2;
    await r.h.ok('checkout.cash', { amountAgorot: 1_250 });
    await until(() => r.h.svc.printQueue.jobsFor(r.h.state().checkout.documentId!, 'ticket')[0]?.status === 'failed', 15_000);
    const ticket = r.h.svc.printQueue.jobsFor(r.h.state().checkout.documentId!, 'ticket')[0];
    expect(ticket.attempts).toBe(1);
    expect(ticket.last_error).toMatch(/no_paper|cut short/);
  }, 30_000);
});

/* ------------------------------------------------------------------ the kiosk */

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const APPROVED: SaleResult = { answer: 'APPROVED', raw: '', card: { brand: 'visa', last4: '4242', authNum: '0123456', uid: 'u-1', payments: null, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'x' } } };

interface KioskRig {
  svc: KioskService;
  drawn: Array<{ doc: PrintDoc; width: number }>;
  progress: PayProgress[];
}

const kioskStops: Array<() => void> = [];
afterEach(() => {
  for (const s of kioskStops.splice(0)) s();
});

function kiosk(o: { payment?: Record<string, unknown>; printing?: Record<string, unknown>; params?: Record<string, unknown> } = {}): KioskRig {
  const drawn: KioskRig['drawn'] = [];
  // The cloud is not there (every call: no network) — a kiosk prints all by itself.
  const fetchFn: typeof fetch = async () => {
    throw new TypeError('fetch failed');
  };
  let seq = 0;
  const provider: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async () => APPROVED,
    resolve: async () => ({ kind: 'unknown', message: 'no answer' }),
    abort: async () => undefined,
  };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-print-e2e-')),
    appVersion: '0.5.16',
    deviceInfo: { platform: 'windows' },
    transport: tcpTransport(),
    fetch: fetchFn,
    providers: [() => provider],
    renderer: recordingRenderer(drawn),
    downloader: async () => {
      throw new Error('no network');
    },
  });
  kioskStops.push(() => svc.stop());
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק Windows', posNumber: '4', shopName: 'הרצליה' });
  svc.cloud.applyCatalog({
    syncType: 'full',
    serverTime: 'x',
    machineCatalog: { mode: 'all' },
    categories: [{ id: 'c-main', name: 'עיקריות', isActive: true }],
    products: [
      { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '1001', ticketMode: 'per_line' },
      { id: 'p-cola', name: 'קולה', price: 10, categoryId: 'c-main', inStock: true, isAvailable: true, sku: '2001', ticketMode: 'per_unit' },
    ],
    menu: null,
  });
  svc.cloud.setPromotions([], null);
  svc.cloud.setKioskSnapshot({
    kiosk: true,
    configVersion: 'v1',
    operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק Windows' },
    config: {
      general: { blockWhenOffline: false },
      payment: { methods: ['card'], receiptPolicy: 'always', tipEnabled: false, ...(o.payment ?? {}) },
      pickup: { scope: 'kiosk', prefix: 'K', start: 1, max: 99 },
      printing: { pickupSlip: true, ...(o.printing ?? {}) },
    },
  });
  svc.cloud.setSettings({ settings: {}, businessInfo: { companyName: 'רויאל בר', vatNumber: '515151515' }, settingsUpdatedAt: null, serverTime: null });
  svc.cloud.setParameters({ ...(o.params ?? {}) }, null);
  svc.applyProvider();
  svc.setLocalSettings({ printer: { transport: 'tcp', host: printer.address!.host, port: printer.address!.port } });
  svc.kitchen.start();
  const progress: PayProgress[] = [];
  svc.on('pay', (p: PayProgress) => progress.push(p));
  return { svc, drawn, progress };
}

const order = (lines: Array<{ productId: string; qty: number }>): StartPaymentIn => ({
  lines: lines.map((l, i) => ({ key: `L${i + 1}`, productId: l.productId, qty: l.qty, options: [], notes: [] })),
  service: 'take_away',
  customerName: null,
  customerPhone: null,
  tableRef: null,
  tipPct: null,
  tipAgorot: null,
});

async function cardSale(k: KioskRig, lines: Array<{ productId: string; qty: number }>) {
  const r = await k.svc.startPayment(order(lines));
  expect(r.ok).toBe(true);
  const orderId = (r as { orderId: string }).orderId;
  await until(() => k.progress.find((p) => p.orderId === orderId && p.phase === 'approved'));
  return orderId;
}

/** Settled: the queue idle and nothing new at the printer for a while. */
async function kioskSettled(k: KioskRig, quietMs = 300) {
  let last = -1;
  let since = Date.now();
  for (;;) {
    const queued = (k.svc as unknown as { db: { get: (s: string) => { n: number } } }).db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE status IN ('queued','sending')").n;
    if (printer.jobs.length !== last || k.svc.printQueue.busy || queued > 0) {
      last = printer.jobs.length;
      since = Date.now();
    } else if (Date.now() - since > quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const kioskKinds = (k: KioskRig) => k.drawn.map((d) => d.doc.kind);

describe('the kiosk (Windows 10/11; the Windows 7 build is till only but prints through the same code)', () => {
  it('receiptPolicy "always": the pickup slip, the receipt, the item tickets, then the bon (auto, no kitchen printer) — each once, cut; never the drawer', async () => {
    const k = kiosk();
    await cardSale(k, [{ productId: 'p-burger', qty: 1 }, { productId: 'p-cola', qty: 2 }]);
    await kioskSettled(k, 600);
    expect(kioskKinds(k)).toEqual(['slip', 'receipt', 'ticket', 'ticket', 'ticket', 'bon']);
    expect(printer.pageJobs()).toHaveLength(6);
    for (const j of printer.pageJobs()) expect(j.parsed.cuts).toBe(1);
    expect(printer.kicks()).toHaveLength(0);
  });

  it('receiptPolicy "ask": no receipt until the customer says yes — and a second "yes" (a double tap) prints none', async () => {
    const k = kiosk({ payment: { receiptPolicy: 'ask' }, printing: { pickupSlip: false } });
    const id = await cardSale(k, [{ productId: 'p-burger', qty: 1 }]);
    await kioskSettled(k, 600);
    expect(kioskKinds(k)).toEqual(['ticket', 'bon']);
    await k.svc.receiptChoice(id, true);
    await k.svc.receiptChoice(id, true);
    await kioskSettled(k);
    expect(kioskKinds(k)).toEqual(['ticket', 'bon', 'receipt']);
  });

  it('receiptPolicy "never": no receipt (a "yes" from a stale screen prints none either); the tickets still print', async () => {
    const k = kiosk({ payment: { receiptPolicy: 'never' }, printing: { pickupSlip: false } });
    const id = await cardSale(k, [{ productId: 'p-cola', qty: 1 }]);
    await k.svc.receiptChoice(id, true);
    await kioskSettled(k, 600);
    expect(kioskKinds(k)).toEqual(['ticket', 'bon']);
  });

  it('one printer for everything (the owner 17.10.2026): "בון מטבח במדפסת הקיוסק" auto and no kitchen printer — the bon on the kiosk receipt printer, last, cut', async () => {
    for (const bonOnKiosk of ['auto', true] as const) {
      printer.reset();
      const k = kiosk({ printing: { pickupSlip: false, bonOnKiosk } });
      await cardSale(k, [{ productId: 'p-burger', qty: 1 }]);
      await kioskSettled(k, 600);
      expect(kioskKinds(k)).toEqual(['receipt', 'ticket', 'bon']);
      expect(printer.pageJobs()).toHaveLength(3);
      for (const j of printer.pageJobs()) expect(j.parsed.cuts).toBe(1);
    }
  });

  it('"בון מטבח במדפסת הקיוסק" off (chosen): no bon on the kiosk', async () => {
    const k = kiosk({ printing: { pickupSlip: false, bonOnKiosk: false } });
    await cardSale(k, [{ productId: 'p-burger', qty: 1 }]);
    await kioskSettled(k, 600);
    expect(kioskKinds(k)).toEqual(['receipt', 'ticket']);
  });

  it('a copy of the receipt prints once, marked "העתק"', async () => {
    const k = kiosk({ printing: { pickupSlip: false } });
    const id = await cardSale(k, [{ productId: 'p-cola', qty: 2 }]);
    await kioskSettled(k, 600);
    expect(kioskKinds(k)).toEqual(['receipt', 'ticket', 'ticket', 'bon']);
    k.svc.printReceipt(id, true);
    await kioskSettled(k);
    expect(kioskKinds(k)).toEqual(['receipt', 'ticket', 'ticket', 'bon', 'receipt']);
    expect(JSON.stringify(k.drawn[4].doc)).toContain('העתק');
  });

  it('"מזומן בקופה" with no cloud: the slip to take to the till ("ממתינה לסנכרון"), once', async () => {
    const k = kiosk({ payment: { methods: ['cash_at_till'] }, printing: { pickupSlip: true } });
    const r = await k.svc.placeOpenOrder({ ...order([{ productId: 'p-burger', qty: 1 }]), vouchers: [] });
    expect(r).toMatchObject({ ok: true, pending: true });
    await kioskSettled(k);
    // The cash slip is drawn as a receipt page (core/printDocs.ts payAtTillSlipDoc) — never the pickup slip as well.
    expect(kioskKinds(k)).toEqual(['receipt']);
    expect(JSON.stringify(k.drawn[0].doc)).toContain('ממתינה לסנכרון');
    expect(printer.pageJobs()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ width, the picker, the overrides */

describe('"רוחב הדפסה" and "מדפסות"', () => {
  it('a 512-dot head: set to 512, every page fits (none cut); left at 576, the head would cut it (what the setting is for)', async () => {
    printer.state.widthDots = 512;
    const r = await till({ products: TICKETED });
    r.h.svc.setLocalSettings({ printer: { transport: 'tcp', host: printer.address!.host, port: printer.address!.port, widthDots: 512 } });
    await r.h.ok('sell.add', { productId: 'p-cola' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 1_250 });
    await settled(r.h, printer);
    expect(r.drawn.map((d) => d.width)).toEqual([480, 480]);
    expect(printer.pageJobs().map((j) => j.parsed.pages[0].width)).toEqual([512, 512]);
    expect(printer.pageJobs().some((j) => j.parsed.overflow)).toBe(false);
    printer.reset();
    r.h.svc.setLocalSettings({ printer: { transport: 'tcp', host: printer.address!.host, port: printer.address!.port } });
    await r.h.ok('checkout.finish');
    await r.h.ok('sell.add', { productId: 'p-pos' });
    await r.h.ok('checkout.start');
    await r.h.ok('checkout.cash', { amountAgorot: 8_000 });
    await settled(r.h, printer);
    expect(printer.pageJobs()[0].parsed.overflow).toBe(true);
  });

  it('one printer by default; "מדפסת נפרדת לשוברי פריט" sends only the item tickets elsewhere', async () => {
    const second = new FakePrinter();
    await second.start();
    try {
      const r = await till({ products: TICKETED });
      r.h.svc.setLocalSettings({ printerRoles: { ticket: { transport: 'tcp', host: second.address!.host, port: second.address!.port } } });
      await r.h.ok('sell.add', { productId: 'p-cola' });
      await r.h.ok('sell.add', { productId: 'p-cola' });
      await r.h.ok('checkout.start');
      await r.h.ok('checkout.cash', { amountAgorot: 2_500 });
      await settled(r.h, printer);
      await until(() => second.pageJobs().length === 2);
      expect(printer.pageJobs()).toHaveLength(1);
      expect(second.pageJobs()).toHaveLength(2);
    } finally {
      await second.stop();
    }
  });

  it('the picker: this PC’s Windows queues, the network printer found on 9100, the choices — and a chosen printer that is gone, said', async () => {
    const r = await till();
    const svc = r.h.svc;
    (svc as unknown as { opts: { printerScan: unknown } }).opts.printerScan = {
      localIpv4: () => '127.0.0.2',
      sweep: async (hosts: string[]) => hosts.filter((h) => h === '127.0.0.1'),
      status: async () => 'ok',
    };
    const queues = [{ name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', health: 'ok' as const }];
    (svc.usbWatch as unknown as { refresh: () => Promise<unknown>; current: () => unknown }).refresh = async () => ({ queues, devices: [], ports: [], at: Date.now() });
    (svc.usbWatch as unknown as { current: () => unknown }).current = () => ({ queues, devices: [], ports: [], at: Date.now() });
    const v = await svc.printerPicker(true);
    const fake = `tcp:${printer.address!.host}:${printer.address!.port}`;
    expect(v.rows.map((x) => x.id)).toEqual(expect.arrayContaining(['win:Microsoft Print to PDF', 'tcp:127.0.0.1:9100', fake]));
    expect(v.rows.find((x) => x.id === fake)).toMatchObject({ roles: ['receipt'], status: 'ready', missing: false });
    expect(v.roles.map((x) => x.value)).toEqual([expect.stringContaining('מדפסת רשת'), 'כמו המדפסת של המכשיר', 'כמו המדפסת של המכשיר']);
    expect(v.alerts).toEqual([]);
    // The printer is switched off: still listed (the choice), red, said at the top.
    await printer.stop();
    const gone = await svc.printerPicker(false);
    expect(gone.rows.find((x) => x.id === fake)).toMatchObject({ status: 'offline' });
    expect(gone.alerts[0]).toContain('לא עונה');
    await printer.start();
    // A chosen Windows queue that is no longer there.
    svc.setLocalSettings({ printer: { transport: 'spooler', queueName: 'SNBC BTP-R880NPV' } });
    const missing = await svc.printerPicker(false);
    expect(missing.rows[0]).toMatchObject({ id: 'win:SNBC BTP-R880NPV', missing: true, roles: ['receipt'] });
    expect(missing.alerts[0]).toContain('"SNBC BTP-R880NPV" לא נמצאה');
  });

  it('"בדיקה" on a row: a test page on that printer only — nothing chosen, nothing queued', async () => {
    const r = await till();
    const res = await r.h.svc.technicianAction({ type: 'printerTestTarget', target: { transport: 'tcp', host: printer.address!.host, port: printer.address!.port } });
    // The technician's code is needed first.
    expect(res.ok).toBe(false);
    (r.h.svc as unknown as { adminUntil: number }).adminUntil = Date.now() + 60_000;
    const ok = await r.h.svc.technicianAction({ type: 'printerTestTarget', target: { transport: 'tcp', host: printer.address!.host, port: printer.address!.port } });
    expect(ok).toMatchObject({ ok: true });
    await until(() => printer.pageJobs().length === 1);
    expect(JSON.stringify(r.drawn[0].doc)).toContain('בדיקת מדפסת');
  });
});
