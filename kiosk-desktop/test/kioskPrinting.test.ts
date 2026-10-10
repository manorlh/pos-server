/**
 * The Windows kiosk's printing, as the owner asked on 07.10.2026 after testing the Royal kiosk:
 *
 *  - "בון מטבח במדפסת הקיוסק" (`printing.bonOnKiosk`, off by default): every page this kiosk prints is
 *    on its own printer, so off it prints no kitchen bon — not after a card sale, not "ממתין לתשלום
 *    בקופה" before a cash-at-the-till one (the till prints it then); on, as before.
 *  - "שוברים" (item tickets): printed here right after the slip and the receipt, by the till's rules —
 *    each product's mode from the catalog, "שוברי פריט" (`itemTicketMode`) from the parameters.
 *  - Every receipt says where it was issued: "סניף הרצליה · קופה 3 · קיוסק רויאל".
 *
 * The rules are pinned by fixtures shared byte for byte with pos-android (kiosk_bon_route.json,
 * item_ticket_cases.json, receipt_place_cases.json — the last also server/tests/fixtures).
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOwnPrinter, kioskBonOwnShare, kioskBonRoute, windowsBonRoute } from '../src/core/kioskBonRoute';
import {
  itemTicketSetting,
  itemTicketsPrint,
  resolveTicketMode,
  splitItemTickets,
  ticketModeFor,
  type TicketItem,
  type TicketMode,
} from '../src/core/itemTickets';
import { placeLine, receiptDoc, ticketDoc, type ReceiptDoc, type TicketDoc } from '../src/core/printDocs';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const fixture = (name: string) => readFileSync(path.join(here, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

// The LF-normalised SHA-256 the Android and the cloud's tests pin too.
const BON_ROUTE_SHA256 = 'a4d79f8812154a8a4f147932e50193cfd699803f013cc496679744ccc1a28cb2';
const ITEM_TICKETS_SHA256 = 'a743a959ea2942cfb7a8534c91815b1e780e4f78921553465bb2c941d9cd09f7';
const PLACE_SHA256 = 'eab9011b51428a3f797ffb7df3792a2a6e103b1dcd7450667fa8c63cdd7d2a4f';

describe('where the bon goes (kiosk_bon_route.json, shared with pos-android)', () => {
  const text = fixture('kiosk_bon_route.json');
  const root = JSON.parse(text) as {
    cases: Array<{ name: string; single: boolean; singleOwn: boolean; bonOnKiosk: boolean; kitchenPrinters: number; ownPrinter: boolean; route: string; ownShare: boolean }>;
    ownPrinter: Array<{ name: string; type: string | null; purpose: string | null; isHost: boolean; scope: string | null; own: boolean }>;
  };

  it('the same bytes as pos-android’s', () => {
    expect(sha(text)).toBe(BON_ROUTE_SHA256);
  });

  it.each(root.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const route = kioskBonRoute(c);
    expect(route).toBe(c.route);
    expect(kioskBonOwnShare(route, c.bonOnKiosk)).toBe(c.ownShare);
  });

  it.each(root.ownPrinter.map((c) => [c.name, c] as const))('own printer: %s', (_name, c) => {
    expect(isOwnPrinter(c)).toBe(c.own);
  });

  it('the Windows kiosk: off (the default) no bon at all, a named printer included; on, as before', () => {
    expect(windowsBonRoute({})).toBe('none');
    expect(windowsBonRoute({ bonMode: 'routing', bonOnKiosk: false })).toBe('none');
    expect(windowsBonRoute({ bonMode: 'single', bonPrinterId: 'p1', bonOnKiosk: false })).toBe('none');
    expect(windowsBonRoute({ bonMode: 'routing', bonOnKiosk: true })).toBe('own');
    expect(windowsBonRoute({ bonMode: 'single', bonPrinterId: 'p1', bonOnKiosk: true })).toBe('single');
  });
});

describe('item tickets (item_ticket_cases.json, shared with pos-android)', () => {
  const text = fixture('item_ticket_cases.json');
  type Line = { productId: string; name: string; quantity: number; mode: TicketMode; unitLabel?: string; entries?: number; refund?: boolean };
  const root = JSON.parse(text) as {
    split: Array<{ name: string; lines: Line[]; tickets: TicketItem[][] }>;
    resolve: Array<{ product: string | null; category: string | null; mode: string }>;
    prints: Array<{ name: string; documentType: number; hasPrinter: boolean; setting: string; prints: boolean }>;
    settings: Array<{ value: string | null; setting: string }>;
    override: Array<{ setting: string; product: TicketMode; mode: TicketMode }>;
  };
  const norm = (tickets: TicketItem[][]) =>
    tickets.map((t) => t.map((i) => ({ name: i.name, quantity: i.quantity, ...(i.unitLabel ? { unitLabel: i.unitLabel } : {}), ...(i.entry ? { entry: i.entry, entries: i.entries } : {}) })));

  it('the same bytes as pos-android’s', () => {
    expect(sha(text)).toBe(ITEM_TICKETS_SHA256);
  });

  it.each(root.split.map((c) => [c.name, c] as const))('split: %s', (_name, c) => {
    expect(norm(splitItemTickets(c.lines))).toEqual(c.tickets);
  });

  it('resolve, the device setting, the override and when they print', () => {
    for (const c of root.resolve) expect(resolveTicketMode(c.product, c.category)).toBe(c.mode);
    for (const c of root.settings) expect(itemTicketSetting(c.value)).toBe(c.setting);
    for (const c of root.override) expect(ticketModeFor(c.product, itemTicketSetting(c.setting))).toBe(c.mode);
    for (const c of root.prints) expect(itemTicketsPrint(c.documentType, c.hasPrinter, itemTicketSetting(c.setting)), c.name).toBe(c.prints);
  });

  it('the ticket as the till draws it: business, "שובר 2/3", the item big, the till and the sale small', () => {
    const t = ticketDoc({
      businessName: 'רויאל ספיריט', shopName: 'הרצליה', machineName: 'קיוסק Windows', posNumber: '4', transactionNumber: '40000057',
      issuedAt: new Date(2026, 9, 7, 23, 9), items: [{ name: 'מים מינרליים', quantity: 1 }], index: 2, count: 3,
    });
    expect(t).toMatchObject({ kind: 'ticket', businessName: 'רויאל ספיריט', shopName: 'הרצליה' });
    expect(t.title).toContain('2/3');
    expect(t.items).toHaveLength(1);
    expect(t.items[0].name).toBe('מים מינרליים');
    expect(t.items[0].qty).toContain('× 1');
    expect(t.foot[0]).toBe('2026-10-07 23:09');
    expect(t.foot[1]).toContain('קופה: קיוסק Windows');
    expect(t.foot[1]).toContain('4');
    expect(t.foot[2]).toContain('#40000057');
    const entry = ticketDoc({ businessName: null, shopName: 'הרצליה', machineName: null, posNumber: null, transactionNumber: null, issuedAt: new Date(), items: [{ name: 'כרטיס', quantity: 1, entry: 2, entries: 4 }], index: 1, count: 1 });
    expect(entry).toMatchObject({ businessName: 'הרצליה', shopName: null, title: 'שובר' });
    expect(entry.items[0].qty).toContain('כניסה');
  });
});

describe('where a document was issued (receipt_place_cases.json, shared with pos-android and the cloud)', () => {
  const text = fixture('receipt_place_cases.json');
  const root = JSON.parse(text) as { cases: Array<{ name: string; shopName: string | null; posNumber: string | null; deviceName: string | null; line: string | null }> };

  it('the same bytes as pos-android’s and the server’s', () => {
    expect(sha(text)).toBe(PLACE_SHA256);
    const server = readFileSync(path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'receipt_place_cases.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(server).toBe(text);
  });

  it.each(root.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(placeLine(c.shopName, c.posNumber, c.deviceName)).toBe(c.line);
  });
});

/* ------------------------------------------------------------- the service */

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

function kiosk(printing: Record<string, unknown>, parameters: Record<string, unknown> = {}) {
  const fetchFn: typeof fetch = async () => new Response('{}', { status: 404 });
  const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-print-')), appVersion: '0.3.0', deviceInfo: { platform: 'windows' }, transport: noPrinter, fetch: fetchFn, downloader: async () => { throw new Error('no media'); } });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: null, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק רויאל', posNumber: '3', shopName: 'הרצליה' });
  svc.cloud.setParameters(parameters, null);
  svc.cloud.applyCatalog({
    syncType: 'full',
    serverTime: 'x',
    machineCatalog: { mode: 'all' },
    categories: [{ id: 'c-drinks', name: 'שתייה', isActive: true }],
    products: [
      { id: 'p-water', name: 'מים מינרליים', price: 10, categoryId: 'c-drinks', inStock: true, isAvailable: true, sku: '1', ticketMode: 'per_unit' },
      { id: 'p-cola', name: 'קולה', price: 12, categoryId: 'c-drinks', inStock: true, isAvailable: true, sku: '2', ticketMode: 'off' },
    ],
    menu: null,
  });
  svc.cloud.setKioskSnapshot({ kiosk: true, configVersion: 'v1', operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק רויאל' }, config: { printing, pickup: { scope: 'kiosk', prefix: 'A', start: 1, max: 99 } } });
  return svc;
}

/** A completed card sale of 2 waters and a cola, and its paid order. */
function paidOrder(svc: KioskService): string {
  svc.ledger.openShift({ id: `kiosk:${MACHINE}`, name: 'קיוסק רויאל' });
  const line = (key: string, productId: string, name: string, qty: number) => ({ key, productId, name, sku: null, basePriceAgorot: 1000, options: [], notes: [], qty });
  const draft = svc.ledger.openCardSale({
    documentType: 320, prefix: null, branchId: null, operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק רויאל' }, orderId: 'order-1',
    lines: [line('L1', 'p-water', 'מים מינרליים', 2), line('L2', 'p-cola', 'קולה', 1)], tracked: [],
    totals: { totalAgorot: 3000, netAgorot: 2542, vatAgorot: 458, vatRate: 0.18, tipAgorot: 0, chargeAgorot: 3000 } as never,
  })!;
  svc.ledger.completeCardSale(draft.id, { brand: 'visa', last4: '4242', authNum: '0123456', payments: null, firstPaymentAgorot: null } as never);
  svc.orders.put({
    localId: 'order-1', createdAtMs: Date.now(), businessDate: '2026-10-07', serviceType: 'take_away', tableRef: null, fulfillmentMode: 'BON', configVersion: null,
    customerName: null, customerPhone: null, itemCount: 3, totalAgorot: 3000, tipAgorot: 0, paid: true, paidAt: new Date().toISOString(), transactionId: draft.id,
    transactionNumber: '40000001', pickupNumber: 4, pickupLabel: 'A-4', bonRequestedAtMs: null, bonJobIds: [], bonStatus: 'none', bonDetail: null, receiptStatus: 'none', recovered: false,
  } as never);
  return 'order-1';
}

const docsOf = <T>(svc: KioskService, orderId: string, kind: 'bon' | 'ticket' | 'receipt') =>
  svc.printQueue.jobsFor(orderId, kind).map((j) => JSON.parse(j.doc) as T);

describe('the Windows kiosk prints', () => {
  it('no kitchen bon with the setting off (the default) — said on the order; on, the bon as before', () => {
    const off = kiosk({});
    const on = kiosk({ bonOnKiosk: true });
    try {
      const a = paidOrder(off);
      off.printBon(a, false);
      expect(off.printQueue.jobsFor(a, 'bon')).toHaveLength(0);
      expect(off.orders.get(a)).toMatchObject({ bonStatus: 'none', bonDetail: expect.stringContaining('בון מטבח במדפסת הקיוסק') });
      // A staff reprint does not print it on the kiosk either.
      off.printBon(a, true);
      expect(off.printQueue.jobsFor(a, 'bon')).toHaveLength(0);
      const b = paidOrder(on);
      on.printBon(b, false);
      expect(on.printQueue.jobsFor(b, 'bon')).toHaveLength(1);
    } finally {
      off.stop();
      on.stop();
    }
  });

  it('the item tickets of a sale: one per water (per unit), none for the cola (off)', () => {
    const svc = kiosk({});
    try {
      const id = paidOrder(svc);
      expect(svc.printItemTickets(id)).toBe(2);
      const docs = docsOf<TicketDoc>(svc, id, 'ticket');
      expect(docs.map((d) => d.items.map((i) => i.name))).toEqual([['מים מינרליים'], ['מים מינרליים']]);
      expect(docs[1].title).toContain('2/2');
      expect(docs[0].foot.join(' ')).toContain('קיוסק רויאל');
    } finally {
      svc.stop();
    }
  });

  it('"שוברי פריט": off on this kiosk prints none; one per sale combines what had tickets on', () => {
    const off = kiosk({}, { itemTicketMode: 'כבוי' });
    const perSale = kiosk({}, { itemTicketMode: 'שובר אחד לעסקה' });
    try {
      expect(off.printItemTickets(paidOrder(off))).toBe(0);
      const id = paidOrder(perSale);
      expect(perSale.printItemTickets(id)).toBe(1);
      const [doc] = docsOf<TicketDoc>(perSale, id, 'ticket');
      // The cola's tickets are off: never turned on by the device's setting.
      expect(doc.items.map((i) => i.name)).toEqual(['מים מינרליים']);
    } finally {
      off.stop();
      perSale.stop();
    }
  });

  it('the receipt says where it was issued, under the business', () => {
    const svc = kiosk({});
    try {
      const id = paidOrder(svc);
      svc.printReceipt(id, true);
      const [doc] = docsOf<ReceiptDoc>(svc, id, 'receipt');
      const texts = doc.ops.map((o) => ('text' in o ? o.text : o.t));
      const place = texts.indexOf('סניף הרצליה · קופה 3 · קיוסק רויאל');
      expect(place).toBeGreaterThan(0);
      expect(place).toBeLessThan(texts.indexOf('חשבונית מס/קבלה'));
      // Without a place: no line, the document as before.
      const plain = receiptDoc({ documentType: 320, number: '1', copy: 'original', issuedAt: new Date(), printedAt: new Date(), cashierName: 'x', business: { companyName: 'X', vatNumber: null, companyRegNumber: null, companyAddress: null, companyAddressNumber: null, companyCity: null, companyZip: null, phone: null, dealerType: null, branchId: null }, lines: [], totalAgorot: 0, netAgorot: 0, vatAgorot: 0, vatRate: 0.18, tipAgorot: 0, card: null, footer: [null, null], logoUrl: null });
      expect(plain.ops.some((o) => 'text' in o && o.text.startsWith('סניף'))).toBe(false);
    } finally {
      svc.stop();
    }
  });

  it('one paper (the owner, 08.10.2026): no separate number slip by default, the order number big on the receipt', () => {
    const svc = kiosk({});
    const off = kiosk({ orderNumberOnReceipt: false, pickupSlip: true });
    try {
      expect(svc.config().printing.pickupSlip).toBe(false);
      expect(svc.config().printing.orderNumberOnReceipt).toBe(true);
      const id = paidOrder(svc);
      svc.printReceipt(id, false);
      const [doc] = docsOf<ReceiptDoc>(svc, id, 'receipt');
      const texts = doc.ops.map((o) => ('text' in o ? o.text : o.t));
      const heading = texts.indexOf('מספר הזמנה');
      expect(heading).toBeGreaterThan(texts.indexOf('סניף הרצליה · קופה 3 · קיוסק רויאל'));
      expect(heading).toBeLessThan(texts.indexOf('חשבונית מס/קבלה'));
      expect(doc.ops[heading + 1]).toEqual({ t: 'text', text: '⁦A-4⁩', style: 'number', align: 'center' });
      // A kiosk that saved the slip on and the number off: as it saved.
      expect(off.config().printing.pickupSlip).toBe(true);
      const other = paidOrder(off);
      off.printReceipt(other, false);
      const [plain] = docsOf<ReceiptDoc>(off, other, 'receipt');
      expect(plain.ops.some((o) => 'text' in o && o.text === 'מספר הזמנה')).toBe(false);
    } finally {
      svc.stop();
      off.stop();
    }
  });
});
