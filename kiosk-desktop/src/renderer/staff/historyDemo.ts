/**
 * "ניהול הקיוסק" in `npm run dev:web` (the browser demo, no Electron): a manager's menu with demo data — the history
 * of a few sales (one with an item ticket that did not print), "הדפסה חוזרת" asking another manager's code (1234) —
 * to look at the screens. Nothing is printed, nothing leaves the page.
 */

import type { AdminAction, AdminActionResult, AdminHistory, AdminInfo, HistoryRow } from '../../shared/bridge';
import { recent, REPRINT_TEXT, search, type HistoryOrder } from '../../core/kioskReprint';

const DAY = 86_400_000;

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type DemoOrder = HistoryOrder & { row: Omit<HistoryRow, 'localId' | 'at' | 'businessDate' | 'label' | 'pickupLabel' | 'number' | 'customerName' | 'totalAgorot' | 'source'> };

function demoOrders(now: number): DemoOrder[] {
  const order = (i: number, agoMs: number, label: string, total: number, row: DemoOrder['row'], name: string | null = null): DemoOrder => ({
    localId: `demo-${i}`,
    createdAtMs: now - agoMs,
    businessDate: dayOf(now - agoMs),
    paid: true,
    transactionId: `tx-${i}`,
    transactionNumber: `4000005${i}`,
    pickupLabel: label,
    customerName: name,
    totalAgorot: total,
    tipAgorot: 0,
    fulfillmentMode: 'BON',
    bonStatus: row.bonFailed ? 'failed' : 'sent',
    row,
  });
  const ok = { sent: 'נשלחה למדפסת', bon: 'נשלח למדפסת' };
  return [
    order(1, 4 * 60_000, 'A-17', 4550, {
      payment: 'אשראי ···4242',
      receipt: ok.sent,
      bon: ok.bon,
      bonFailed: false,
      tickets: [
        { index: 1, count: 3, state: 'sent', prints: 1 },
        { index: 2, count: 3, state: 'failed', prints: 1 },
        { index: 3, count: 3, state: 'failed', prints: 1 },
      ],
      kinds: ['item_tickets', 'invoice_copy', 'kitchen_bon'],
    }, 'רונית'),
    order(2, 38 * 60_000, 'A-16', 1200, {
      payment: 'מזומן',
      receipt: 'לא ביקשו',
      bon: 'לא הודפס',
      bonFailed: true,
      tickets: [{ index: 1, count: 1, state: 'sent', prints: 2 }],
      kinds: ['item_tickets', 'invoice_copy', 'kitchen_bon'],
    }),
    order(3, 2 * DAY + 3_600_000, 'A-41', 3000, {
      payment: 'שובר + אשראי ···1881',
      receipt: ok.sent,
      bon: ok.bon,
      bonFailed: false,
      tickets: [],
      kinds: ['item_tickets', 'invoice_copy', 'kitchen_bon'],
    }),
  ];
}

export function demoAdminInfo(): AdminInfo {
  return {
    operator: { id: 'kiosk:demo', name: 'קיוסק הדגמה' },
    shift: { open: true, number: 12, openedAt: new Date().toISOString() },
    terminal: { kind: 'nayax_lan', address: '192.168.1.40:8080', state: 'ready', lastOkAt: Date.now(), lastError: null, unresolved: [] },
    printer: { target: 'Windows: POS-80 (USB · אוטומטי)', health: 'ok', lastError: null, queues: [], usb: 'מדפסת USB: POS-80 מחוברת', auto: true },
    sync: { lastBeatOkAt: Date.now(), lastKioskSyncAt: Date.now(), lastError: null, outbox: 0, configVersion: 'demo' },
    media: { files: 0, bytes: 0, missing: 0 },
    orders: [],
    zs: [],
    zOwed: false,
    zMode: 'shop',
    offlineSince: null,
    desktopExit: { allowed: false, reason: 'web demo' },
    // `&admin=full` (the layout audit): every panel of the menu — "מצב עבודה", "משמרת ו-Z", the Zs, the cash devices.
    ...(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('admin') === 'full' ? fullAdminExtras() : {}),
  };
}

function fullAdminExtras(): Partial<AdminInfo> {
  const now = Date.now();
  return {
    workMode: { enabled: true, mode: 'kiosk', toTill: true, toKiosk: false, openerHolds: true },
    kioskZ: { kind: 'own', shiftOpen: true, owed: true, customerBusy: false },
    zOwed: true,
    zs: [
      { number: 1187, closedAt: new Date(now - 86_400_000).toISOString(), state: 'sent' },
      { number: 1186, closedAt: new Date(now - 2 * 86_400_000).toISOString(), state: 'sent' },
    ],
    orders: [{ localId: 'demo-1', label: 'A-17', at: now - 600_000, totalAgorot: 9_999_990, bon: 'printed', receipt: 'sent', number: '40000123' }],
    cash: { station: 'עמדת מזומן ראשית', address: '192.168.1.60', usable: true, reason: null, pending: [{ txShort: 'A7F3', amountAgorot: 9_999_990, startedAt: now - 120_000, final: null }] },
    cashmag: {
      address: '192.168.1.61:8080',
      protocol: 'json',
      terminal: 'KIOSK-01',
      userCodeSet: true,
      sources: { address: 'machine', protocol: 'shop' },
      usable: false,
      reason: 'המכונה לא עונה (בדיקה אחרונה לפני 2 דקות)',
      connection: 'disconnected',
      lastError: 'ECONNREFUSED 192.168.1.61:8080',
      unresolved: [{ txId: 'cm-1', txShort: 'C9D1', amountAgorot: 4_590, startedAt: now - 3_600_000, outcome: 'paid_unconfirmed', heldAgorot: 2_000, reason: 'החיבור נותק באמצע התשלום' }],
    },
  };
}

let demoLog: AdminHistory['log'] = [];

export function demoHistory(input: { days: number; query: string; older?: boolean }): AdminHistory {
  const now = Date.now();
  const all = demoOrders(now);
  const older = input.older === true;
  const days = older ? 7 : input.days >= 7 ? 7 : 1;
  const found = older ? [] : (search(recent(all, dayOf(now), days), input.query) as DemoOrder[]);
  return {
    days,
    older,
    query: input.query,
    rows: found.map((o) => ({
      ...o.row,
      localId: o.localId,
      at: o.createdAtMs,
      businessDate: o.businessDate,
      label: o.pickupLabel ?? o.localId,
      pickupLabel: o.pickupLabel,
      number: o.transactionNumber,
      customerName: o.customerName,
      totalAgorot: o.totalAgorot,
      source: 'kiosk',
    })),
    total: found.length,
    cloud: older ? 'unsupported' : 'off',
    alone: false,
    bonsOn: true,
    lastBon: { localId: 'demo-1', label: 'A-17' },
    unprintedTickets: 2,
    log: demoLog,
  };
}

/** The demo's reprints: another manager's code (1234) first, then "נשלח להדפסה" — and the day's log. */
export function demoAdminAction(a: AdminAction): AdminActionResult {
  const reprint = a.type === 'reprint' || a.type === 'reprintLast' || a.type === 'reprintLastBon' || a.type === 'reprintBon' || a.type === 'reprintReceipt';
  if (!reprint) return { ok: false, message: 'web demo' };
  const code = 'code' in a ? a.code : undefined;
  if (!code) return { ok: false, needsCode: true, message: REPRINT_TEXT.needsManager };
  if (code !== '1234') return { ok: false, needsCode: true, message: REPRINT_TEXT.wrong(4) };
  if (a.type === 'reprint') {
    demoLog = [{ at: Date.now(), kind: a.kind, label: a.orderId.replace('demo-', 'A-1'), by: 'מנהל הדגמה', tickets: a.kind === 'item_tickets' && a.only === 'failed' ? [2, 3] : null }, ...demoLog];
  }
  return { ok: true, message: REPRINT_TEXT.done };
}
