/**
 * "היסטוריית עסקאות" in the Windows kiosk's manager menu and its reprints (main/service.ts adminHistory / adminReprint,
 * core/kioskReprint.ts) — the owner, 16.10.2026: "היסטוריית עסקאות של הקיוסק… וגם אופציה להדפיס שוב שובר פריט שלא
 * הודפס". As the Android kiosk's KioskReprintPanel: today / the week kept / older from the cloud, searched; per sale
 * "שובר פריט" (all, or only those that did not print — "לא הודפס" per ticket from its print job), "חשבונית (העתק)",
 * "בון למטבח"; each "הדפסה חוזרת" on the paper, under REPRINT (the menu's manager alone, else another manager's code),
 * recorded (the cloud's `reprint` event, the day's log); never automatic.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { RosterUser } from '../src/core/desktopExit';
import { localDate } from '../src/core/kioskOrders';
import { REPRINT_TEXT, shiftDay } from '../src/core/kioskReprint';
import type { BonDoc, TicketDoc } from '../src/core/printDocs';
import { KioskService, type TillEngineEvent } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const hash = (pin: string) => bcrypt.hashSync(pin, 4);

function person(over: Partial<RosterUser> & { pin: string }): RosterUser {
  const { pin, ...rest } = over;
  return { id: 'u', username: 'x', firstName: 'דנה', lastName: 'כהן', pinHash: hash(pin), role: 'cashier', isActive: true, shopId: SHOP, permissions: null, tillRoleName: null, ...rest };
}
/** A shop manager: the menu, and "הדפסה חוזרת" alone (the legacy role allows it). */
const boss = person({ id: 'boss', username: 'boss', firstName: 'רונית', lastName: 'מנהלת', pin: '7001', role: 'shop_manager', permissions: { KIOSK_UNLOCK: 'allow' } });
/** A shift lead: opens the menu, but a reprint needs another manager's code. */
const lead = person({ id: 'lead', username: 'lead', firstName: 'אחמ״ש', lastName: '', pin: '7002', role: 'cashier', permissions: { KIOSK_UNLOCK: 'allow', REPRINT: 'approval' } });

type Fetched = { url: string; method: string };
const services: KioskService[] = [];
afterEach(() => {
  while (services.length > 0) services.pop()!.stop();
});

function kiosk(opts: { printing?: Record<string, unknown>; cloud?: (url: string) => Response | Promise<Response> } = {}) {
  const calls: Fetched[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (opts.cloud && /\/kiosk\/orders\?/.test(url) && (init?.method ?? 'GET') === 'GET') return opts.cloud(url);
    return new Response('{}', { status: 404 });
  };
  const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-history-')), appVersion: '0.5.6', deviceInfo: { platform: 'windows' }, transport: noPrinter, fetch: fetchFn, downloader: async () => { throw new Error('no media'); } });
  services.push(svc);
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קיוסק רויאל', posNumber: '3', shopName: 'הרצליה', shopId: SHOP });
  svc.cloud.setParameters({}, null);
  svc.cloud.applyPosUsers({ syncType: 'full', serverTime: '2026-10-16T10:00:00Z', users: [boss, lead] });
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
  svc.cloud.setKioskSnapshot({ kiosk: true, configVersion: 'v1', operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק רויאל' }, config: { printing: opts.printing ?? {}, pickup: { scope: 'kiosk', prefix: 'A', start: 1, max: 99 } } });
  return { svc, calls };
}

/** A completed card sale of 2 waters (a ticket each) and a cola (none); its order kept unless [kept] is false. */
function sale(svc: KioskService, id: string, opts: { label?: string; at?: number; kept?: boolean; recovered?: boolean; date?: string } = {}) {
  if (!svc.ledger.currentShift()) svc.ledger.openShift({ id: `kiosk:${MACHINE}`, name: 'קיוסק רויאל' });
  const line = (key: string, productId: string, name: string, qty: number) => ({ key, productId, name, sku: null, basePriceAgorot: 1000, options: [], notes: [], qty });
  const draft = svc.ledger.openCardSale({
    documentType: 320, prefix: null, branchId: null, operator: { id: `kiosk:${MACHINE}`, name: 'קיוסק רויאל' }, orderId: id,
    lines: [line('L1', 'p-water', 'מים מינרליים', 2), line('L2', 'p-cola', 'קולה', 1)], tracked: [],
    totals: { totalAgorot: 3000, netAgorot: 2542, vatAgorot: 458, vatRate: 0.18, tipAgorot: 0, chargeAgorot: 3000 } as never,
  })!;
  svc.ledger.completeCardSale(draft.id, { brand: 'visa', last4: '4242', authNum: '0123456', payments: null, firstPaymentAgorot: null } as never);
  const at = opts.at ?? Date.now();
  if (opts.kept !== false) {
    svc.orders.put({
      localId: id, createdAtMs: at, businessDate: opts.date ?? localDate(at), serviceType: 'take_away', tableRef: null, fulfillmentMode: 'BON', configVersion: null,
      customerName: 'רונית', customerPhone: null, itemCount: 3, totalAgorot: 3000, tipAgorot: 0, paid: true, paidAt: new Date(at).toISOString(), transactionId: draft.id,
      transactionNumber: `4000000${id.slice(-1)}`, pickupNumber: 4, pickupLabel: opts.label ?? 'A-4', bonRequestedAtMs: null, bonJobIds: [], bonStatus: 'none', bonDetail: null,
      receiptStatus: 'skipped', recovered: opts.recovered === true, syncedHash: null,
    });
  }
  return draft.id;
}

const jobs = (svc: KioskService, orderId: string, kind: 'ticket' | 'receipt' | 'bon') => svc.printQueue.jobsFor(orderId, kind);
const setStatus = (svc: KioskService, jobId: string, status: string) => svc.db.run('UPDATE print_jobs SET status = ? WHERE id = ?', status, jobId);
const events = (svc: KioskService) =>
  svc.outbox
    .all()
    .filter((r) => r.kind === 'till_event')
    .map((r) => svc.kv.getJson<TillEngineEvent>(`tillEvent:${r.ref_id}`)!)
    .filter((e) => e.type === 'reprint');

describe('"היסטוריית עסקאות": each sale with how its pages printed', () => {
  it('today’s sale: time, label, amount, payment, the receipt, and each item ticket — one the queue gave up on is "לא הודפס", in the corner too', async () => {
    // "בון מטבח במדפסת הקיוסק" off (chosen): no bon on this kiosk.
    const { svc } = kiosk({ printing: { bonOnKiosk: false } });
    const tx = sale(svc, 'order-1');
    expect(svc.printItemTickets('order-1')).toBe(2);
    svc.printReceipt('order-1', false);
    const [t1, t2] = jobs(svc, 'order-1', 'ticket');
    // Each page knows which ticket it is (for "לא הודפס" per ticket).
    expect((JSON.parse(t2.doc) as TicketDoc)).toMatchObject({ index: 2, count: 2 });
    setStatus(svc, t1.id, 'sent');
    setStatus(svc, t2.id, 'failed');
    setStatus(svc, jobs(svc, 'order-1', 'receipt')[0].id, 'sent');
    expect(await svc.adminUnlock('7001')).toMatchObject({ ok: true });
    const h = await svc.adminHistory({ days: 1, query: '' });
    expect(h).toMatchObject({ days: 1, older: false, total: 1, cloud: 'off', alone: true, bonsOn: false, unprintedTickets: 1, lastBon: null });
    expect(h.rows[0]).toMatchObject({
      localId: 'order-1',
      label: 'A-4',
      totalAgorot: 3000,
      payment: 'אשראי ···4242',
      receipt: 'נשלחה למדפסת',
      bon: 'ללא בון',
      source: 'kiosk',
      kinds: ['item_tickets', 'invoice_copy'],
      tickets: [
        { index: 1, count: 2, state: 'sent', prints: 1 },
        { index: 2, count: 2, state: 'failed', prints: 1 },
      ],
    });
    void tx;
    // The corner's red label, as the bons' ("שובר פריט לא הודפס").
    expect(svc.view().staff.unprintedTickets).toBe(1);
    // The search: the pickup label, the amount, the name; nothing else.
    for (const q of ['A4', 'a-4', '30', '₪30.00', 'רונית', '40000001']) expect((await svc.adminHistory({ days: 1, query: q })).total, q).toBe(1);
    expect((await svc.adminHistory({ days: 1, query: 'B9' })).total).toBe(0);
  });

  it('"היום" is today, "7 ימים" the week the kiosk keeps; nothing without the manager’s code', async () => {
    const { svc } = kiosk();
    sale(svc, 'order-1');
    sale(svc, 'order-2', { at: Date.now() - 3 * 86_400_000, label: 'A-2' });
    await expect(svc.adminHistory({ days: 1, query: '' })).rejects.toThrow('נדרש קוד מנהל');
    await svc.adminUnlock('7001');
    expect((await svc.adminHistory({ days: 1, query: '' })).rows.map((r) => r.localId)).toEqual(['order-1']);
    expect((await svc.adminHistory({ days: 7, query: '' })).rows.map((r) => r.localId)).toEqual(['order-1', 'order-2']);
  });
});

describe('"שובר פריט" again: all, or only what did not print — marked, recorded, never by itself', () => {
  it('"רק מה שלא הודפס": the very ticket again, "הדפסה חוזרת" at its head, the cloud’s reprint event and the day’s log', async () => {
    const { svc } = kiosk();
    const tx = sale(svc, 'order-1');
    svc.printItemTickets('order-1');
    const [t1, t2] = jobs(svc, 'order-1', 'ticket');
    setStatus(svc, t1.id, 'sent');
    setStatus(svc, t2.id, 'failed');
    await svc.adminUnlock('7001');
    // "הדפסה חוזרת של מה שנכשל" never sends an item ticket out again by itself (it is exchanged for goods).
    await svc.adminAction({ type: 'retryPrints' });
    expect(svc.printQueue.job(t2.id)?.status).toBe('failed');
    expect(await svc.adminAction({ type: 'reprint', kind: 'item_tickets', orderId: 'order-1', only: 'failed' })).toEqual({ ok: true, message: REPRINT_TEXT.done });
    const all = jobs(svc, 'order-1', 'ticket');
    expect(all).toHaveLength(3);
    const again = JSON.parse(all[2].doc) as TicketDoc;
    const first = JSON.parse(t2.doc) as TicketDoc;
    expect(again).toEqual({ ...first, notice: 'הדפסה חוזרת' });
    // Ticket 2 is on its way again; nothing failed is left: "רק מה שלא הודפס" says so and prints nothing.
    const h = await svc.adminHistory({ days: 1, query: '' });
    expect(h.rows[0].tickets.map((t) => [t.index, t.state, t.prints])).toEqual([[1, 'sent', 1], [2, 'queued', 2]]);
    expect(h.unprintedTickets).toBe(0);
    expect(await svc.adminAction({ type: 'reprint', kind: 'item_tickets', orderId: 'order-1', only: 'failed' })).toEqual({ ok: false, message: REPRINT_TEXT.noFailedTickets });
    expect(jobs(svc, 'order-1', 'ticket')).toHaveLength(3);
    // Recorded: one event, with what, of which sale, by whom.
    const [e] = events(svc);
    expect(events(svc)).toHaveLength(1);
    expect(e).toMatchObject({ type: 'reprint', posUserId: 'boss', transactionId: tx });
    expect(e.details).toMatchObject({ kind: 'item_tickets', source: 'kiosk_admin', orderId: 'order-1', pickupLabel: 'A-4', approvedBy: 'רונית מנהלת', approvedById: 'boss', cornerManager: 'רונית מנהלת', tickets: [2], only: 'failed', failed: false });
    expect(h.log).toEqual([expect.objectContaining({ kind: 'item_tickets', label: 'A-4', by: 'רונית מנהלת', tickets: [2] })]);
    // All of them: both tickets again, each marked.
    expect((await svc.adminAction({ type: 'reprint', kind: 'item_tickets', orderId: 'order-1' })).ok).toBe(true);
    const marked = jobs(svc, 'order-1', 'ticket').slice(3).map((j) => JSON.parse(j.doc) as TicketDoc);
    expect(marked.map((d) => [d.index, d.notice])).toEqual([[1, 'הדפסה חוזרת'], [2, 'הדפסה חוזרת']]);
  });

  it('a sale settled after a restart printed none: its tickets are "לא הודפס", and drawn again from its document', async () => {
    const { svc } = kiosk();
    sale(svc, 'order-9', { recovered: true });
    await svc.adminUnlock('7001');
    const h = await svc.adminHistory({ days: 1, query: '' });
    expect(h.rows[0].tickets).toEqual([
      { index: 1, count: 2, state: 'failed', prints: 0 },
      { index: 2, count: 2, state: 'failed', prints: 0 },
    ]);
    // The corner counts what the printer gave up on, not a page never sent.
    expect(h.unprintedTickets).toBe(0);
    expect((await svc.adminAction({ type: 'reprint', kind: 'item_tickets', orderId: 'order-9', only: 'failed' })).ok).toBe(true);
    expect(jobs(svc, 'order-9', 'ticket').map((j) => (JSON.parse(j.doc) as TicketDoc).notice)).toEqual(['הדפסה חוזרת', 'הדפסה חוזרת']);
  });
});

describe('"הדפסה חוזרת" — under REPRINT', () => {
  it('a menu opened by a shift lead: another manager’s code, a wrong one refused, both names recorded', async () => {
    const { svc } = kiosk();
    sale(svc, 'order-1');
    await svc.adminUnlock('7002');
    expect((await svc.adminHistory({ days: 1, query: '' })).alone).toBe(false);
    expect(await svc.adminAction({ type: 'reprint', kind: 'invoice_copy', orderId: 'order-1' })).toEqual({ ok: false, needsCode: true, message: REPRINT_TEXT.needsManager });
    // The old buttons are gated the same way.
    expect(await svc.adminAction({ type: 'reprintReceipt', orderId: 'order-1' })).toMatchObject({ needsCode: true });
    expect(await svc.adminAction({ type: 'reprintLast' })).toMatchObject({ needsCode: true });
    // The lead's own code is not another manager's with the permission.
    expect(await svc.adminAction({ type: 'reprint', kind: 'invoice_copy', orderId: 'order-1', code: '7002' })).toMatchObject({ ok: false, needsCode: true, message: expect.stringContaining('קוד שגוי') });
    expect(jobs(svc, 'order-1', 'receipt')).toHaveLength(0);
    expect(await svc.adminAction({ type: 'reprint', kind: 'invoice_copy', orderId: 'order-1', code: '7001' })).toEqual({ ok: true, message: REPRINT_TEXT.done });
    expect(jobs(svc, 'order-1', 'receipt')).toHaveLength(1);
    expect(JSON.parse(jobs(svc, 'order-1', 'receipt')[0].doc).ops.some((o: { text?: string }) => typeof o.text === 'string' && o.text.includes('העתק'))).toBe(true);
    expect(events(svc)[0].details).toMatchObject({ kind: 'invoice_copy', approvedBy: 'רונית מנהלת', approvedById: 'boss', cornerManager: 'אחמ״ש' });
  });

  it('what cannot print is said before a code is asked', async () => {
    const { svc } = kiosk();
    sale(svc, 'order-1');
    await svc.adminUnlock('7002');
    expect(await svc.adminAction({ type: 'reprint', kind: 'invoice_copy', orderId: 'nope' })).toEqual({ ok: false, message: 'ההזמנה לא נמצאה' });
    expect(await svc.adminAction({ type: 'reprint', kind: 'item_tickets', orderId: 'order-1', only: 'failed' })).toEqual({ ok: false, message: REPRINT_TEXT.noFailedTickets });
    expect(events(svc)).toHaveLength(0);
  });
});

describe('the kitchen bon again — only where bons are on', () => {
  it('"בון למטבח" and "הדפס שוב את הבון האחרון": a fresh bon marked "הדפסה חוזרת", recorded', async () => {
    for (const bonOnKiosk of [true, 'auto', undefined]) {
      const { svc: k } = kiosk({ printing: bonOnKiosk === undefined ? {} : { bonOnKiosk } });
      await k.adminUnlock('7001');
      // Auto (the default, the owner 17.10.2026): no kitchen printer — the kiosk's own printer takes it.
      expect((await k.adminHistory({ days: 1, query: '' })).bonsOn).toBe(true);
      k.stop();
    }
    const { svc } = kiosk({ printing: { bonOnKiosk: true } });
    sale(svc, 'order-1');
    svc.printBon('order-1', false);
    expect(jobs(svc, 'order-1', 'bon')).toHaveLength(1);
    await svc.adminUnlock('7001');
    const h = await svc.adminHistory({ days: 1, query: '' });
    expect(h.bonsOn).toBe(true);
    expect(h.lastBon).toEqual({ localId: 'order-1', label: 'A-4' });
    expect(h.rows[0].kinds).toEqual(['item_tickets', 'invoice_copy', 'kitchen_bon']);
    expect(await svc.adminAction({ type: 'reprintLastBon' })).toEqual({ ok: true, message: REPRINT_TEXT.lastBonDone('A-4') });
    const bons = jobs(svc, 'order-1', 'bon').map((j) => JSON.parse(j.doc) as BonDoc);
    expect(bons).toHaveLength(2);
    expect(bons[0].notice).toBeNull();
    expect(bons[1].notice).toContain('הדפסה חוזרת');
    expect(events(svc).map((e) => e.details.kind)).toEqual(['kitchen_bon']);
  });

  it('with bons off (chosen) the kiosk offers none', async () => {
    const { svc } = kiosk({ printing: { bonOnKiosk: false } });
    sale(svc, 'order-1');
    await svc.adminUnlock('7001');
    const h = await svc.adminHistory({ days: 1, query: '' });
    expect(h.bonsOn).toBe(false);
    expect(h.rows[0].kinds).not.toContain('kitchen_bon');
    expect(await svc.adminAction({ type: 'reprintLastBon' })).toEqual({ ok: false, message: REPRINT_TEXT.noLastBon });
  });
});

describe('"ישנות יותר" — the cloud’s days before the week the kiosk keeps', () => {
  it('asks GET /sync/{m}/kiosk/orders up to the day before the week, with the search; reprints a sale whose document is here', async () => {
    let txHere = '';
    const cloudRows = () => [
      { localId: 'old-1', paidAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), businessDate: shiftDay(localDate(Date.now()), -10), transactionId: txHere, transactionNumber: '40000077', pickupLabel: 'A-77', customerName: null, totalAgorot: 3000, tipAgorot: 0, fulfillmentMode: 'BON', bonStatus: 'printed', receiptStatus: 'printed' },
      { localId: 'old-2', paidAt: new Date(Date.now() - 12 * 86_400_000).toISOString(), businessDate: shiftDay(localDate(Date.now()), -12), transactionId: 'elsewhere', transactionNumber: '40000078', pickupLabel: 'A-78', totalAgorot: 990, tipAgorot: 0, fulfillmentMode: 'BON', bonStatus: 'printed', receiptStatus: 'printed' },
    ];
    const { svc, calls } = kiosk({ cloud: () => new Response(JSON.stringify(cloudRows()), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
    sale(svc, 'order-1');
    // The old sale's document is in this kiosk's ledger (it keeps its documents), its order no longer.
    txHere = sale(svc, 'old-1', { kept: false });
    await svc.adminUnlock('7001');
    const h = await svc.adminHistory({ days: 7, older: true, query: 'A7' });
    expect(h.cloud).toBe('ok');
    const asked = new URL(calls.find((c) => c.url.includes('/kiosk/orders?'))!.url);
    expect(asked.pathname).toBe(`/api/v1/sync/${MACHINE}/kiosk/orders`);
    expect(asked.searchParams.get('until')).toBe(shiftDay(localDate(Date.now()), -7));
    expect(asked.searchParams.get('days')).toBe('30');
    expect(asked.searchParams.get('q')).toBe('A7');
    expect(h.rows.map((r) => [r.localId, r.source, r.kinds])).toEqual([
      ['old-1', 'cloud', ['item_tickets', 'invoice_copy']],
      ['old-2', 'cloud', []],
    ]);
    // Today's sale is not among the older ones.
    expect(h.rows.some((r) => r.localId === 'order-1')).toBe(false);
    expect(await svc.adminAction({ type: 'reprint', kind: 'invoice_copy', orderId: 'old-1' })).toEqual({ ok: true, message: REPRINT_TEXT.done });
    expect(jobs(svc, 'old-1', 'receipt')).toHaveLength(1);
    expect((await svc.adminAction({ type: 'reprint', kind: 'item_tickets', orderId: 'old-1' })).ok).toBe(true);
    expect(jobs(svc, 'old-1', 'ticket').map((j) => (JSON.parse(j.doc) as TicketDoc).notice)).toEqual(['הדפסה חוזרת', 'הדפסה חוזרת']);
    expect(await svc.adminAction({ type: 'reprint', kind: 'invoice_copy', orderId: 'old-2' })).toEqual({ ok: false, message: REPRINT_TEXT.noDocument });
    expect(await svc.adminAction({ type: 'reprint', kind: 'kitchen_bon', orderId: 'old-1' })).toEqual({ ok: false, message: REPRINT_TEXT.notOnKiosk });
  });

  it('a server from before the route: "unsupported"; no answer: "failed" — the kept days still listed', async () => {
    const old = kiosk({ cloud: () => new Response('{"detail":"Method Not Allowed"}', { status: 405 }) });
    sale(old.svc, 'order-1');
    await old.svc.adminUnlock('7001');
    expect((await old.svc.adminHistory({ days: 7, older: true, query: '' })).cloud).toBe('unsupported');
    expect((await old.svc.adminHistory({ days: 7, query: '' })).rows).toHaveLength(1);
    const down = kiosk({ cloud: () => Promise.reject(new TypeError('fetch failed')) });
    await down.svc.adminUnlock('7001');
    expect((await down.svc.adminHistory({ days: 7, older: true, query: '' })).cloud).toBe('failed');
  });
});
