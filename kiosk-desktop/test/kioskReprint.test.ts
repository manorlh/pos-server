/**
 * "היסטוריית עסקאות" and "הדפסה חוזרת" in the kiosk's manager menu (core/kioskReprint.ts) — the cases of pos-android's
 * KioskReprintTest (today's sales newest first; item tickets / the invoice's copy / the kitchen bon where bons are on;
 * a manager reprints alone, a cashier's code is not enough; every reprint the cloud's event; the day's log), its
 * history's search (P:/specs/kiosk-landscape-till-mode.md §5.12: "A12" ≈ "a 12", a document number, a name, ₪45.50 /
 * 45,5 with the tip), the cloud's rows, and the Windows kiosk's "שובר פריט לא הודפס" per ticket.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import type { RosterUser } from '../src/core/desktopExit';
import {
  amountOf,
  appendLog,
  bonText,
  decideApprover,
  eventDetails,
  failedTickets,
  kinds,
  labelOf,
  lastBon,
  LOG_KEEP,
  mayAlone,
  mergeHistory,
  parseCloudOrders,
  parseLog,
  paymentText,
  pickupKey,
  receiptText,
  recent,
  REPRINT_TEXT,
  search,
  shiftDay,
  ticketsLine,
  ticketSlots,
  ticketStates,
  ticketsToReprint,
  todays,
  type HistoryOrder,
  type ReprintEntry,
  type TicketJob,
} from '../src/core/kioskReprint';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function order(id: string, at: number, over: Partial<HistoryOrder> & { date?: string; unpaid?: boolean } = {}): HistoryOrder {
  const { date, unpaid, ...rest } = over;
  return {
    localId: id,
    createdAtMs: at,
    businessDate: date ?? '2026-10-08',
    paid: !unpaid,
    transactionId: unpaid ? null : `tx-${id}`,
    transactionNumber: unpaid ? null : `10${id}`,
    pickupLabel: `A-${id}`,
    customerName: null,
    totalAgorot: 1000,
    tipAgorot: 0,
    fulfillmentMode: 'BON',
    bonStatus: 'sent',
    ...rest,
  };
}

describe('the history (KioskReprint.todays / recent / search)', () => {
  it("today's paid sales, newest first — the first one is picked", () => {
    const list = todays([order('1', 1_000), order('2', 3_000), order('3', 2_000, { unpaid: true }), order('4', 5_000, { date: '2026-10-07' })], '2026-10-08');
    expect(list.map((o) => o.localId)).toEqual(['2', '1']);
  });

  it('"היום" is today alone, "7 ימים" the week the kiosk keeps — across a month, newest first', () => {
    const orders = [
      order('a', 1, { date: '2026-10-01' }),
      order('b', 2, { date: '2026-09-30' }),
      order('c', 3, { date: '2026-09-24' }),
      order('d', 4, { date: '2026-09-25' }),
      order('e', 5, { date: '2026-10-01', unpaid: true }),
    ];
    expect(recent(orders, '2026-10-01', 1).map((o) => o.localId)).toEqual(['a']);
    expect(recent(orders, '2026-10-01', 7).map((o) => o.localId)).toEqual(['d', 'b', 'a']);
    expect(recent(orders, '2026-10-01', 0).map((o) => o.localId)).toEqual(['a']);
    expect(shiftDay('2026-10-01', -7)).toBe('2026-09-24');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('not a day', -1)).toBe('not a day');
  });

  it('the search: a pickup number or its letters, a document number, a name, an amount with the tip', () => {
    const orders = [
      order('12', 3, { pickupLabel: 'A-12', transactionNumber: '40000057', customerName: 'רונית Cohen', totalAgorot: 4500, tipAgorot: 50 }),
      order('7', 2, { pickupLabel: 'B-7', transactionNumber: '40000058', totalAgorot: 1200 }),
      order('112', 1, { pickupLabel: 'A-112', transactionNumber: '40000059', totalAgorot: 990 }),
    ];
    const ids = (q: string) => search(orders, q).map((o) => o.localId);
    expect(ids('')).toEqual(['12', '7', '112']);
    expect(ids('A12')).toEqual(['12']);
    expect(ids('a 12')).toEqual(['12']);
    expect(ids('a-12')).toEqual(['12']);
    expect(ids('A1')).toEqual(['12', '112']);
    expect(ids('B7')).toEqual(['7']);
    expect(ids('0000058')).toEqual(['7']);
    expect(ids('רונית')).toEqual(['12']);
    expect(ids('cohen')).toEqual(['12']);
    for (const q of ['45.5', '45,5', '45.50', '₪45.50', ' ₪45,50 ']) expect(ids(q)).toEqual(['12']);
    expect(ids('12')).toEqual(['12', '7', '112']); // "12" in A-12 / A-112, and ₪12.00
    expect(ids('אין כזה')).toEqual([]);
    expect(pickupKey('a - 12')).toBe('A12');
    expect(amountOf('₪45,50')).toBe(45.5);
    expect(amountOf('A12')).toBeNull();
    expect(amountOf('0')).toBeNull();
  });
});

describe('what prints again (KioskReprint.kinds / lastBon)', () => {
  it('item tickets and the invoice for a sale, the bon only where bons are on and it went by bon', () => {
    expect(kinds(order('1', 1), true)).toEqual(['item_tickets', 'invoice_copy', 'kitchen_bon']);
    expect(kinds(order('1', 1), false)).toEqual(['item_tickets', 'invoice_copy']);
    expect(kinds(order('1', 1, { fulfillmentMode: 'KDS' }), true)).not.toContain('kitchen_bon');
    expect(kinds(order('1', 1, { unpaid: true }), false)).toEqual([]);
    // The cloud's row of a sale whose document is not on this kiosk: nothing; no bon once the kiosk no longer keeps it.
    expect(kinds(order('1', 1), true, { hasDocument: false, kept: false })).toEqual([]);
    expect(kinds(order('1', 1), true, { hasDocument: true, kept: false })).toEqual(['item_tickets', 'invoice_copy']);
  });

  it('"הדפס שוב את הבון האחרון": the newest paid sale with a bon — none with bons off', () => {
    const orders = [order('1', 1), order('2', 5, { fulfillmentMode: 'KDS' }), order('3', 3, { bonStatus: 'none', bonJobIds: [] }), order('4', 9, { unpaid: true }), order('5', 2, { bonStatus: 'failed' })];
    expect(lastBon(orders, true)?.localId).toBe('5');
    expect(lastBon(orders, false)).toBeNull();
    expect(labelOf(order('9', 1))).toBe('A-9');
    expect(labelOf({ localId: 'abcdefgh', pickupLabel: null, transactionNumber: '40000001' })).toBe('#40000001');
    expect(labelOf({ localId: 'abcdefgh', pickupLabel: ' ', transactionNumber: null })).toBe('abcdef');
  });
});

describe('who may (KioskReprint.mayAlone, LocalManagerSheet REPRINT)', () => {
  const SHOP = 'shop-1';
  const hash = (pin: string) => bcrypt.hashSync(pin, 4);
  const person = (id: string, pin: string, role: string, permissions: Record<string, string> | null = null): RosterUser => ({
    id,
    username: id,
    firstName: id,
    lastName: null,
    pinHash: hash(pin),
    role,
    isActive: true,
    shopId: SHOP,
    permissions,
  });
  const manager = person('mgr', '7001', 'shop_manager');
  const cashier = person('cash', '7002', 'cashier');
  const denied = person('no', '7003', 'shop_manager', { REPRINT: 'deny' });
  const users = [manager, cashier, denied];
  const compare = (p: string, h: string) => bcrypt.compare(p, h);

  it('a manager reprints alone, a cashier’s code is not enough', () => {
    expect(mayAlone(users, SHOP, 'mgr')).toBe(true);
    expect(mayAlone(users, SHOP, 'cash')).toBe(false);
    expect(mayAlone(users, SHOP, 'no')).toBe(false);
    expect(mayAlone(users, SHOP, null)).toBe(false);
  });

  it('another manager’s code: granted to one whose role allows it; wrong five times locks the pad', async () => {
    const ok = await decideApprover({ users, shopId: SHOP, code: '7001', lock: null, nowMs: 0, compare });
    expect(ok).toMatchObject({ outcome: 'granted', user: { id: 'mgr' } });
    // A cashier's own code (its "approval" is someone else's) and a role denied it: no.
    expect((await decideApprover({ users, shopId: SHOP, code: '7002', lock: null, nowMs: 0, compare })).outcome).toBe('wrong');
    expect((await decideApprover({ users, shopId: SHOP, code: '7003', lock: null, nowMs: 0, compare })).outcome).toBe('wrong');
    expect((await decideApprover({ users, shopId: SHOP, code: ' ', lock: null, nowMs: 0, compare })).outcome).toBe('blank');
    let lock = null as Parameters<typeof decideApprover>[0]['lock'];
    let last = null as Awaited<ReturnType<typeof decideApprover>> | null;
    for (let i = 0; i < 5; i++) {
      last = await decideApprover({ users, shopId: SHOP, code: '0000', lock, nowMs: 1_000, compare });
      lock = last.lock;
    }
    expect(last?.outcome).toBe('locked_out');
    expect(last?.message).toContain('ניסיונות שגויים');
    expect((await decideApprover({ users, shopId: SHOP, code: '7001', lock, nowMs: 2_000, compare })).outcome).toBe('locked');
    expect((await decideApprover({ users, shopId: SHOP, code: '7001', lock, nowMs: 62_000, compare })).outcome).toBe('granted');
    expect((await decideApprover({ users: [cashier], shopId: SHOP, code: '7002', lock: null, nowMs: 0, compare })).outcome).toBe('no_managers');
  });
});

describe('the record (KioskReprint.eventDetails, KioskReprintEntry)', () => {
  it('every reprint is the cloud’s reprint event, with what and who', () => {
    const d = eventDetails('invoice_copy', order('7', 1), 'רן', 'u-2', 'דנה');
    expect(d).toMatchObject({ kind: 'invoice_copy', source: 'kiosk_admin', orderId: '7', pickupLabel: 'A-7', documentNumber: '107', approvedBy: 'רן', approvedById: 'u-2', cornerManager: 'דנה' });
    expect(eventDetails('item_tickets', order('7', 1), null, null, null, { failed: false, tickets: [2] })).toMatchObject({ kind: 'item_tickets', tickets: [2], failed: false });
  });

  it('the day’s log keeps what was printed again, read back as written', () => {
    const e: ReprintEntry = { atMs: 1_000, businessDate: '2026-10-08', kind: 'item_tickets', orderId: 'o-1', pickupLabel: 'A-1', documentNumber: '101', by: 'רן' };
    expect(parseLog(appendLog([], e))).toEqual([e]);
    let many: ReprintEntry[] = [];
    for (let i = 1; i <= LOG_KEEP + 5; i++) many = parseLog(appendLog(many, { ...e, atMs: i }));
    expect(many).toHaveLength(LOG_KEEP);
    expect(many[many.length - 1].atMs).toBe(LOG_KEEP + 5);
    expect(parseLog('not json')).toEqual([]);
    expect(parseLog(JSON.stringify([{ kind: 'nonsense' }, { ...e, tickets: [1, 'x', 3], failed: true }]))).toEqual([{ ...e, tickets: [1, 3], failed: true }]);
  });
});

describe('the cloud’s rows (GET /sync/{m}/kiosk/orders, the server’s order_out)', () => {
  it('read as the kiosk’s own, so the same search answers them; anything unreadable left out', () => {
    const rows = parseCloudOrders([
      { localId: 'c-1', paidAt: '2026-10-01T09:05:00Z', businessDate: '2026-10-01', transactionId: 'tx-c1', transactionNumber: 40000057, pickupLabel: 'A-12', customerName: 'רונית', totalAgorot: 4500, tipAgorot: 50, fulfillmentMode: 'BON', bonStatus: 'failed', receiptStatus: 'printed', payAtTill: false, voucherAgorot: null },
      { localId: '', totalAgorot: 1 },
      'junk',
      { localId: 'c-2', paidAt: null, businessDate: '2026-09-30', transactionId: null, pickupLabel: null, fulfillmentMode: 'KDS', bonStatus: 'weird', payAtTill: true },
    ]);
    expect(rows.map((r) => r.localId)).toEqual(['c-1', 'c-2']);
    expect(rows[0]).toMatchObject({ createdAtMs: Date.parse('2026-10-01T09:05:00Z'), transactionNumber: '40000057', bonStatus: 'failed', paid: true });
    expect(rows[1]).toMatchObject({ createdAtMs: 0, transactionId: null, fulfillmentMode: 'KDS', bonStatus: 'none', payAtTill: true });
    expect(search(rows, '₪45.50').map((r) => r.localId)).toEqual(['c-1']);
    expect(parseCloudOrders({ not: 'a list' })).toEqual([]);
    // The kiosk's own row wins over the cloud's copy of it (it knows how each page printed).
    const merged = mergeHistory([order('c-1', 5, { bonStatus: 'sent' })], rows);
    expect(merged.map((r) => [r.localId, r.bonStatus])).toEqual([['c-1', 'sent'], ['c-2', 'none']]);
  });
});

describe('"שובר פריט לא הודפס" — each ticket by its print job', () => {
  const job = (index: number | null, status: TicketJob['status'], createdAt: number, count: number | null = 3): TicketJob => ({ index, count, status, createdAt });

  it('each ticket’s newest job: sent, on its way, or given up ("לא הודפס")', () => {
    const jobs = [job(1, 'sent', 1), job(2, 'failed', 2), job(3, 'failed', 3)];
    expect(ticketStates(jobs)).toEqual([
      { index: 1, count: 3, state: 'sent', prints: 1 },
      { index: 2, count: 3, state: 'failed', prints: 1 },
      { index: 3, count: 3, state: 'failed', prints: 1 },
    ]);
    expect(failedTickets(ticketStates(jobs))).toEqual([2, 3]);
    expect(ticketsLine(ticketStates(jobs))).toBe('לא הודפס: 2/3, 3/3');
    // "רק מה שלא הודפס": 2 and 3 again; then 2 is on its way, 3 still not printed.
    expect(ticketsToReprint(jobs, 'failed').map((s) => s.index)).toEqual([2, 3]);
    expect(ticketsToReprint(jobs, 'all').map((s) => s.index)).toEqual([1, 2, 3]);
    const after = [...jobs, job(2, 'queued', 10), job(3, 'sending', 11)];
    expect(ticketStates(after).map((s) => [s.index, s.state, s.prints])).toEqual([[1, 'sent', 1], [2, 'queued', 2], [3, 'queued', 2]]);
    expect(ticketsLine(ticketStates(after))).toBe('בתור להדפסה (2)');
    const done = [...after, job(2, 'sent', 20), job(3, 'sent', 21)];
    expect(failedTickets(ticketStates(done))).toEqual([]);
    expect(ticketsLine(ticketStates(done))).toBe('נשלח למדפסת (3)');
    expect(ticketsLine([])).toBeNull();
  });

  it('a page from 0.5.5 (no index kept): its place among them is its index', () => {
    const legacy = [job(null, 'sent', 1, null), job(null, 'failed', 2, null)];
    expect(ticketSlots(legacy).map((s) => [s.index, s.count, s.latest.status])).toEqual([[1, 2, 'sent'], [2, 2, 'failed']]);
    // Its reprint is kept with its index: it takes the old page's place.
    expect(ticketStates([...legacy, job(2, 'sent', 5, 2)]).map((s) => s.state)).toEqual(['sent', 'sent']);
  });
});

describe('the row’s words', () => {
  it('the bon, the receipt and the payment as the staff read them', () => {
    expect(bonText({ fulfillmentMode: 'BON', bonStatus: 'failed' })).toBe('לא הודפס');
    expect(bonText({ fulfillmentMode: 'BON', bonStatus: 'sent' })).toBe('נשלח למדפסת');
    expect(bonText({ fulfillmentMode: 'BON', bonStatus: 'none' })).toBe('ללא בון');
    expect(bonText({ fulfillmentMode: 'KDS', bonStatus: 'none' })).toBe('מסך מטבח');
    expect(receiptText([{ status: 'failed', createdAt: 1 }, { status: 'sent', createdAt: 2 }], 'printed')).toBe('נשלחה למדפסת');
    expect(receiptText([{ status: 'failed', createdAt: 2 }], 'printed')).toBe('לא הודפסה');
    expect(receiptText([], 'declined')).toBe('לא ביקשו');
    expect(receiptText([], 'skipped')).toBe('לא הודפסה');
    expect(paymentText({ card: { last4: '4242' } })).toBe('אשראי ···4242');
    expect(paymentText({ card: null, cash: { splitAgorot: 500 }, payments: [{ method: 'cash' }, { method: 'card' }] })).toBe('מזומן + אשראי');
    expect(paymentText({ card: { last4: '1881' }, voucherLegs: [{}] })).toBe('אשראי ···1881 + שובר');
    expect(paymentText({ card: null })).toBe('ללא תשלום');
    expect(paymentText(null, { payAtTill: true })).toBe('בקופה');
    expect(paymentText(null, { voucherAgorot: 1000 })).toBe('שובר');
    expect(paymentText(null, {})).toBeNull();
  });

  it('Android’s words where it has them (strings_kiosk_app.xml / strings_kiosk_work_mode.xml)', () => {
    expect(REPRINT_TEXT.title).toBe('הדפסה חוזרת');
    expect(REPRINT_TEXT.itemTickets).toBe('שובר פריט');
    expect(REPRINT_TEXT.invoice).toBe('חשבונית (העתק)');
    expect(REPRINT_TEXT.bon).toBe('בון למטבח');
    expect(REPRINT_TEXT.log).toBe('הדפסות חוזרות היום');
    expect(REPRINT_TEXT.done).toBe('נשלח להדפסה');
    expect(REPRINT_TEXT.noDocument).toBe('אין מסמך להזמנה הזו');
    expect(REPRINT_TEXT.needsManager).toBe('להדפסה חוזרת נדרש קוד של מנהל עם הרשאת "הדפסה חוזרת"');
    expect(REPRINT_TEXT.approve('שובר פריט', 'A-12')).toBe('הדפסה חוזרת — שובר פריט, הזמנה A-12');
    expect(REPRINT_TEXT.historySub).toBe('היסטוריית עסקאות — חיפוש לפי מספר הזמנה, אותיות, מספר מסמך, שם או סכום');
    expect(REPRINT_TEXT.search).toBe('מספר הזמנה, אותיות או סכום');
    expect([REPRINT_TEXT.today, REPRINT_TEXT.week]).toEqual(['היום', '7 ימים']);
    expect(REPRINT_TEXT.cloudFailed).toBe('לא ניתן לקרוא את ההיסטוריה — אין חיבור לענן');
    expect(REPRINT_TEXT.notice).toBe('הדפסה חוזרת');
  });
});

describe('the menu shows the history, gated and recorded, and prints nothing again without it', () => {
  const src = (p: string) => readFileSync(path.join(here, '..', 'src', p), 'utf8');

  it('the old ungated buttons are gone: a bon, a receipt or a ticket prints again only as a recorded reprint', () => {
    const staff = src('renderer/staff/StaffLayer.tsx');
    expect(staff).toContain('<KioskHistoryPanel m={m} onDone={refresh} />');
    expect(staff).not.toContain("type: 'reprintBon'");
    expect(staff).not.toContain("type: 'reprintReceipt'");
    const svc = src('main/service.ts');
    expect(svc).toContain("return this.adminReprint('kitchen_bon', a.orderId, 'all', a.code);");
    expect(svc).toContain("return this.adminReprint('invoice_copy', a.orderId, 'all', a.code);");
    expect(svc).toContain("type: 'reprint',");
    // "הדפסה חוזרת של מה שנכשל" never sends an item ticket out again unmarked.
    expect(svc).toContain("this.printQueue.retryFailed(undefined, ['ticket']);");
  });
});
