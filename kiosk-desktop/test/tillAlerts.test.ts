/**
 * "התראות" on the Windows till (core/till/tillAlerts.ts, main/till/tillAlertsService.ts, AlertsScreen): pos-android
 * TillAlertsTest's cases — one quiet notice per new problem, never again while it lasts, a flap is the same problem, the long
 * quiet, urgent ones on every return and a help request's re-ping, never over a payment, who sees what, a restart tells
 * nothing old, the line and "ראיתי", severity, sounds, the list by device, the cloud's times — then the sources (the kiosks'
 * alerts, the kitchen's bons, the change owed), the engine (a fake cloud: the list, "ראיתי" telling the cloud "הבנתי",
 * "בדרך", the notice as a toast) and the screen's markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALERTS_TEXT,
  QUIET_RENOTIFY_MS,
  RESOLVED_MIN_MS,
  ackOnSeen,
  alertGroups,
  alertLine,
  alertStep,
  alertsView,
  bookToJson,
  fromCashOwed,
  fromKiosk,
  fromPrintServer,
  holdsNotices,
  isoMs,
  kitchenItems,
  markSeen,
  noticeText,
  parseBook,
  parseKioskTillAlerts,
  problemKey,
  severityOf,
  soundOf,
  soundOfAll,
  timeLabel,
  unseen,
  visibleTo,
  type KioskAlertKind,
  type KioskTillAlert,
  type TillActivity,
  type TillAlertBook,
  type TillAlertItem,
  type TillAlertSource,
  type TillAlertsState,
} from '../src/core/till/tillAlerts';
import type { KitchenJob } from '../src/core/kitchen/queue';
import { TillAlertsService } from '../src/main/till/tillAlertsService';
import { AlertsLine, AlertsScreen } from '../src/renderer/roles/till/screens/AlertsScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { MANAGER_PIN, PIN, harness, type Harness } from './tillEngineHarness';

const t0 = 1_791_360_000_000;
const minute = 60_000;
const all: ReadonlySet<TillAlertSource> = new Set(['kiosk', 'print_server', 'network', 'kitchen', 'cash']);

function kioskAlert(o: Partial<KioskTillAlert> = {}): KioskTillAlert {
  return {
    id: 'a1',
    kioskMachineId: 'k1',
    kioskName: 'קיוסק רויאל',
    kind: 'terminal',
    key: 'terminal',
    reason: 'unreachable',
    text: 'קיוסק רויאל — אין תקשורת למסופון האשראי',
    raisedAt: null,
    pingCount: 0,
    acknowledgedBy: null,
    audience: 'everyone',
    viaLan: false,
    ...o,
  };
}

function kiosk(o: { id?: string; kind?: KioskAlertKind; key?: string; reason?: string; kioskId?: string; pings?: number; audience?: 'everyone' | 'managers'; raisedAt?: string | null } = {}): TillAlertItem {
  return fromKiosk(
    kioskAlert({ id: o.id ?? 'a1', kind: o.kind ?? 'terminal', key: o.key ?? 'terminal', reason: o.reason ?? 'unreachable', kioskMachineId: o.kioskId ?? 'k1', pingCount: o.pings ?? 0, audience: o.audience ?? 'everyone', raisedAt: o.raisedAt ?? null }),
  );
}

const printerDown = () => fromPrintServer({ id: 'p7', name: 'בר' });

const step = (book: TillAlertBook, items: TillAlertItem[], at: number, activity: TillActivity = 'working', role: string | null = 'cashier', reported: ReadonlySet<TillAlertSource> = all) =>
  alertStep(book, items, reported, at, activity, role);

describe('one notice per new problem (TillAlertsTest)', () => {
  it('a new problem is told once, and not again while it lasts', () => {
    const a = kiosk();
    const first = step({}, [a], t0);
    expect(first.notify).toEqual([a]);
    let book = first.book;
    for (let i = 1; i <= 200; i++) {
      const s = step(book, [a], t0 + i * minute);
      expect(s.notify).toEqual([]);
      book = s.book;
    }
  });

  it('the same device and reason under a new alert id is the same problem', () => {
    const book = step({}, [kiosk({ id: 'a1' })], t0).book;
    expect(step(book, [kiosk({ id: 'a2' })], t0 + minute).notify).toEqual([]);
    expect(step(book, [kiosk({ id: 'a3', reason: 'not_ready' })], t0 + minute).notify).toHaveLength(1);
    expect(step(book, [kiosk({ id: 'a4', kioskId: 'k2' })], t0 + minute).notify).toHaveLength(1);
  });

  it('told again once resolved and back — a short flap is the same problem', () => {
    const a = kiosk();
    let book = step({}, [a], t0).book;
    book = step(book, [], t0 + minute).book;
    const flap = step(book, [a], t0 + 2 * minute);
    expect(flap.notify).toEqual([]);
    book = flap.book;
    book = step(book, [], t0 + 3 * minute).book;
    book = step(book, [], t0 + 3 * minute + RESOLVED_MIN_MS).book;
    expect(step(book, [a], t0 + 4 * minute + RESOLVED_MIN_MS).notify).toEqual([a]);
  });

  it('a problem that lasts is told again after the long quiet period only', () => {
    expect(QUIET_RENOTIFY_MS).toBe(4 * 60 * 60_000);
    const a = kiosk();
    const book = step({}, [a], t0).book;
    expect(step(book, [a], t0 + QUIET_RENOTIFY_MS - 1).notify).toEqual([]);
    expect(step(book, [a], t0 + QUIET_RENOTIFY_MS).notify).toEqual([a]);
    const seen = markSeen(book, [a], t0 + minute);
    expect(unseen(step(seen, [a], t0 + QUIET_RENOTIFY_MS).book, a)).toBe(true);
  });

  it('urgent problems are told on every return and a help request on each re-ping', () => {
    const card = kiosk({ id: 'c1', key: 'terminal:card', reason: 'card_unknown' });
    let book = step({}, [card], t0).book;
    book = step(book, [], t0 + minute).book;
    expect(step(book, [card], t0 + 2 * minute).notify).toEqual([card]);
    const help = kiosk({ id: 'h1', kind: 'help', key: 'help', reason: 'help', pings: 1 });
    book = step({}, [help], t0).book;
    expect(step(book, [help], t0 + minute).notify).toEqual([]);
    expect(step(book, [{ ...help, ping: 2 }], t0 + minute).notify).toHaveLength(1);
    book = step(book, [], t0 + 2 * minute).book;
    expect(step(book, [kiosk({ id: 'h2', kind: 'help', key: 'help', reason: 'help', pings: 1 })], t0 + 3 * minute).notify).toHaveLength(1);
  });
});

describe('never over a payment; who; a restart', () => {
  it('a notice waits for the payment to end, then is told', () => {
    const a = kiosk();
    const during = step({}, [a], t0, 'payment');
    expect(during.notify).toEqual([]);
    const still = step(during.book, [a], t0 + minute, 'payment');
    expect(still.notify).toEqual([]);
    expect(step(still.book, [a], t0 + minute, 'order_screen').notify).toEqual([]);
    const after = step(still.book, [a], t0 + 2 * minute, 'idle');
    expect(after.notify).toEqual([a]);
    expect(step(after.book, [a], t0 + 3 * minute).notify).toEqual([]);
  });

  it('selling never holds a notice; a problem gone before the payment ended is never told', () => {
    expect(holdsNotices('working') || holdsNotices('idle')).toBe(false);
    expect(holdsNotices('payment') && holdsNotices('order_screen')).toBe(true);
    expect(step({}, [kiosk()], t0, 'working').notify).toHaveLength(1);
    const a = kiosk();
    let book = step({}, [a], t0, 'payment').book;
    book = step(book, [], t0 + minute, 'payment').book;
    const after = step(book, [], t0 + 2 * minute, 'idle');
    expect(after.notify).toEqual([]);
    expect(step(after.book, [], t0 + 2 * minute + RESOLVED_MIN_MS).book).toEqual({});
  });

  it("a kiosk's alert is told to whoever may see it, the till's own to anyone at it", () => {
    const managers = kiosk({ audience: 'managers' });
    expect(step({}, [managers], t0, 'working', 'cashier').notify).toEqual([]);
    const held = step({}, [managers], t0, 'working', 'cashier').book;
    expect(step(held, [managers], t0 + minute, 'working', 'shop_manager').notify).toHaveLength(1);
    expect(step({}, [kiosk()], t0, 'working', null).notify).toEqual([]);
    expect(visibleTo(printerDown(), null)).toBe(true);
    expect(step({}, [printerDown()], t0, 'working', null).notify).toHaveLength(1);
  });

  it('what was told and seen survives a restart — nothing old is told again', () => {
    const a = kiosk();
    let book = step({}, [a], t0).book;
    book = markSeen(book, [a], t0 + minute);
    const restored = parseBook(bookToJson(book));
    expect(restored).toEqual(book);
    const before = step(restored, [], t0 + 10 * minute, 'working', 'cashier', new Set());
    expect(before.book[problemKey(a)].gone).toBeNull();
    const answered = step(before.book, [a], t0 + 30 * minute);
    expect(answered.notify).toEqual([]);
    expect(unseen(answered.book, a)).toBe(false);
    expect(parseBook('not json')).toEqual({});
    expect(parseBook(null)).toEqual({});
    // Android's own JSON reads the same.
    expect(parseBook('{"k1|terminal|unreachable":{"source":"kiosk","since":5,"gone":null,"notified":5,"ping":0,"seen":null}}')).toEqual({
      'k1|terminal|unreachable': { source: 'kiosk', since: 5, gone: null, notified: 5, notifiedPing: 0, seen: null },
    });
  });
});

describe('the line, "ראיתי", severity, sounds, the list', () => {
  it('one slim line while anything is unseen, gone after seen until something new', () => {
    const a = kiosk();
    const b = printerDown();
    let book = step({}, [a, b], t0).book;
    const line = alertLine(book, [a, b], 'working')!;
    expect(line.count).toBe(2);
    expect(line.strong).toBe(false);
    book = markSeen(book, [a, b], t0 + minute);
    expect(alertLine(book, [a, b], 'working')).toBeNull();
    const c = kiosk({ id: 'x', key: 'printer:receipt', kind: 'printer', reason: 'no_paper' });
    book = step(book, [a, b, c], t0 + 2 * minute).book;
    const next = alertLine(book, [a, b, c], 'working')!;
    expect(next.count).toBe(3);
    expect(next.unseen).toBe(1);
    expect(next.top).toEqual(c);
  });

  it('seen before its notice was told — the notice is not told after it', () => {
    const a = kiosk();
    const held = step({}, [a], t0, 'payment').book;
    expect(step(markSeen(held, [a], t0 + minute), [a], t0 + 2 * minute, 'idle').notify).toEqual([]);
  });

  it('only a waiting customer or an undecided card payment is urgent — coloured, never during a payment', () => {
    expect(severityOf('help', 'help')).toBe('urgent');
    expect(severityOf('terminal', 'card_unknown')).toBe('urgent');
    for (const [k, r] of [
      ['terminal', 'unreachable'],
      ['terminal', 'offline'],
      ['printer', 'no_paper'],
      ['printer', 'kds_down'],
      ['battery', 'battery_critical'],
    ] as Array<[KioskAlertKind, string]>)
      expect(severityOf(k, r)).toBe('info');
    const help = kiosk({ id: 'h', kind: 'help', key: 'help', reason: 'help', pings: 1 });
    const info = kiosk();
    const book = step({}, [info, help], t0, 'payment').book;
    const paying = alertLine(book, [info, help], 'payment')!;
    expect(paying.top).toEqual(help);
    expect(paying.strong).toBe(false);
    expect(alertLine(book, [info, help], 'idle')!.strong).toBe(true);
  });

  it("sounds — a beep for what is urgent and the print server's printer, the battery's own alarm, else silence", () => {
    expect(soundOf(kiosk())).toBe('none');
    expect(soundOf(kiosk({ kind: 'help', key: 'help', reason: 'help' }))).toBe('beep');
    expect(soundOf(printerDown())).toBe('beep');
    const critical = kiosk({ kind: 'battery', key: 'battery', reason: 'battery_critical' });
    expect(soundOf(critical)).toBe('battery_critical');
    expect(soundOfAll([kiosk(), printerDown(), critical])).toBe('battery_critical');
    expect(soundOfAll([])).toBe('none');
  });

  it('the list is by device, the newest device first, each newest first', () => {
    const old = kiosk({ id: '1', key: 'printer:bon', kind: 'printer', reason: 'offline', raisedAt: '2026-10-07T08:00:00Z' });
    const newer = kiosk({ id: '2', raisedAt: '2026-10-07T09:00:00Z' });
    const other = kiosk({ id: '3', kioskId: 'k2', raisedAt: '2026-10-07T08:30:00+03:00' });
    const groups = alertGroups({}, [old, other, newer]);
    expect(groups.map((g) => g.device)).toEqual(['k1', 'k2']);
    expect(groups[0].items).toEqual([newer, old]);
    expect(groups[0].deviceName).toBe('קיוסק רויאל');
  });

  it("the cloud's times are read in any ISO form", () => {
    expect(isoMs('2026-10-07T08:00:00Z')).toBe(1_791_360_000_000);
    expect(isoMs('2026-10-07T11:00:00+03:00')).toBe(1_791_360_000_000);
    expect(isoMs('2026-10-07T08:00:00')).toBe(1_791_360_000_000);
    expect(isoMs('2026-10-07T08:00:00.123456+00:00')).toBe(1_791_360_000_123);
    expect(isoMs(null)).toBeNull();
    expect(isoMs('yesterday')).toBeNull();
  });
});

describe('the sources', () => {
  it("the kiosks' alerts as the cloud sends them; who is told \"הבנתי\" on ראיתי", () => {
    const list = parseKioskTillAlerts({
      alerts: [
        { id: '6f1d0c1e-1111-4222-8333-444455556666', kioskMachineId: 'k1', kioskName: 'קיוסק רויאל', kind: 'printer', key: 'printer:receipt', reason: 'no_paper', text: 'קיוסק רויאל — מדפסת קבלות: אין נייר', raisedAt: '2026-10-07T08:00:00Z', pingCount: 0, acknowledgedBy: null, audience: 'everyone' },
        { id: 'battery:m2', kioskMachineId: 'm2', kind: 'battery', key: 'battery', reason: 'battery_low', text: 'קופה 3 — סוללה 14%', audience: 'managers' },
        { id: 'offline:k3', kioskMachineId: 'k3', kind: 'terminal', key: 'terminal', reason: 'offline', text: 'x' },
        { id: 'h-1', kioskMachineId: 'k1', kind: 'help', key: 'help', reason: 'help', text: 'קיוסק רויאל מבקש עזרה', pingCount: 2 },
        { id: 'z', kind: 'fax' },
        { kind: 'printer' },
      ],
    });
    expect(list.map((a) => a.id)).toEqual(['6f1d0c1e-1111-4222-8333-444455556666', 'battery:m2', 'offline:k3', 'h-1']);
    expect(list[1]).toMatchObject({ audience: 'managers', kioskName: null, pingCount: 0 });
    expect(list.map(ackOnSeen)).toEqual([true, true, false, false]);
    expect(ackOnSeen({ ...list[0], acknowledgedBy: 'אבי' })).toBe(false);
    expect(ackOnSeen({ ...list[0], viaLan: true })).toBe(false);
    expect(ackOnSeen(kioskAlert({ id: 'cash:s1' }))).toBe(true);
    expect(fromKiosk(list[3])).toMatchObject({ source: 'kiosk', device: 'k1', severity: 'urgent', ping: 2, kind: 'help' });
    expect(parseKioskTillAlerts({})).toEqual([]);
  });

  it("this till's bons that did not print: one per printer, the oldest's title, the reason that needs a person most", () => {
    const job = (o: Partial<KitchenJob>): KitchenJob =>
      ({
        id: 'j',
        printerId: 'p1',
        printerName: 'בר',
        printerJson: '{}',
        ticketJson: JSON.stringify({ tableName: '12', lines: [] }),
        route: 'DIRECT',
        kind: 'ticket',
        state: 'failed',
        attempts: 3,
        lastError: 'no_paper',
        queuedAt: 0,
        createdAt: 10,
        updatedAt: 0,
        nextAttemptAt: 0,
        finishedAt: null,
        relayVia: null,
        relayHost: null,
        relayJobId: null,
        ackStatus: null,
        lanOrigin: 0,
        dismissed: 0,
        discardReason: null,
        ...o,
      }) as KitchenJob;
    const items = kitchenItems([
      job({ id: 'a' }),
      job({ id: 'b', printerId: 'p2', printerName: 'מטבח', createdAt: 5, ticketJson: JSON.stringify({ orderRef: '20000057', lines: [] }), lastError: 'uncertain' }),
      job({ id: 'c', printerId: 'p2', printerName: 'מטבח', createdAt: 9, lastError: 'connect ECONNREFUSED' }),
      job({ id: 't', kind: 'test' }),
      job({ id: 'd', dismissed: 1 }),
    ]);
    expect(items.map((i) => i.text)).toEqual(['בון לא הודפס — בר, שולחן 12 (אין נייר)', 'מטבח: 2 בונים לא הודפסו (נקטע באמצע — ייתכן שהודפס חלקית; לא יודפס שוב לבד)']);
    expect(items[0]).toMatchObject({ source: 'kitchen', id: 'kitchen:p1', device: 'printer:p1', deviceName: 'בר', key: 'kitchen', reason: 'no_paper', severity: 'urgent' });
    expect(kitchenItems([job({ ticketJson: '{' })])[0].text).toBe('בון לא הודפס — בר, בון (אין נייר)');
  });

  it('the change a cash station owes: by its station, urgent', () => {
    const item = fromCashOwed({ id: 'o1', kind: 'change_owed', txId: 't1', amountAgorot: 1300, stationId: 's1', stationName: 'עמדת מזומן 2', slipCode: null, orderLabel: '57', clientName: null, createdAt: '2026-10-07T08:00:00Z' });
    expect(item).toMatchObject({ source: 'cash', device: 'cash:s1', deviceName: 'עמדת מזומן 2', key: 'cash:change_owed:o1', reason: 'change_owed', severity: 'urgent', sinceMs: 1_791_360_000_000 });
    expect(item.text).toBe('עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪');
  });

  it('the view: titles, actions, the line, the subtitle, the times', () => {
    const help = kiosk({ id: 'h1', kind: 'help', key: 'help', reason: 'help', pings: 3, raisedAt: '2026-10-07T08:00:00Z' });
    const printer = kiosk({ id: 'p', kind: 'printer', key: 'printer:receipt', reason: 'no_paper', raisedAt: '2026-10-06T08:00:00Z' });
    const book = step({}, [help, printer], t0).book;
    const v = alertsView({ book, visible: [help, printer], activity: 'idle', nowMs: t0, kiosks: new Map([['h1', kioskAlert({ id: 'h1', kind: 'help', acknowledgedBy: 'אבי' })]]), controlled: new Set(['k1']), beep: null });
    expect(v.subtitle).toBe('2 פתוחות');
    expect(v.line).toMatchObject({ strong: true, help: true });
    expect(v.line!.text.startsWith('התראות (2) · ')).toBe(true);
    expect(v.groups[0]).toMatchObject({ device: 'k1', name: 'קיוסק רויאל', kioskControl: true });
    const [h, p] = v.groups[0].items;
    expect(h).toMatchObject({ title: 'בקשת עזרה מקיוסק', pinged: 'קריאה מספר 3', ackedBy: 'ראו: אבי', onMyWay: true, seen: 'text', help: true, urgent: true });
    expect(p).toMatchObject({ title: 'תקלה במדפסת של קיוסק', onMyWay: false, seen: 'button', pay: false, queue: false });
    expect(p.time).toBe(timeLabel(Date.parse('2026-10-06T08:00:00Z'), t0));
    expect(alertsView({ book: {}, visible: [], activity: 'idle', nowMs: t0, kiosks: new Map(), controlled: new Set(), beep: null }).subtitle).toBe('אין התראות פתוחות');
    expect(noticeText([kiosk(), help])).toBe(`2 התראות חדשות · ${help.text}`);
    expect(timeLabel(new Date(2026, 9, 7, 14, 5).getTime(), new Date(2026, 9, 7, 20, 0).getTime())).toBe('14:05');
    expect(timeLabel(new Date(2026, 9, 6, 14, 5).getTime(), new Date(2026, 9, 7, 20, 0).getTime())).toBe('06.10 14:05');
    expect(ALERTS_TEXT.title).toBe('התראות');
  });
});

/* ------------------------------------------------------------------ the engine */

const op = (name: string) => name as TillOp;

describe('the engine', () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.stop();
    h = null;
  });

  const HELP_ID = 'h-1';
  const PRINTER_ID = '6f1d0c1e-1111-4222-8333-444455556666';
  function cloudList(): Record<string, unknown> {
    return {
      alerts: [
        { id: PRINTER_ID, kioskMachineId: 'k1', kioskName: 'קיוסק רויאל', kind: 'printer', key: 'printer:receipt', reason: 'no_paper', text: 'קיוסק רויאל — מדפסת קבלות: אין נייר', audience: 'everyone' },
        { id: HELP_ID, kioskMachineId: 'k1', kioskName: 'קיוסק רויאל', kind: 'help', key: 'help', reason: 'help', text: 'קיוסק רויאל מבקש עזרה', pingCount: 1, audience: 'everyone' },
        { id: 'battery:m2', kioskMachineId: 'm2', kioskName: 'קופה 3', kind: 'battery', key: 'battery', reason: 'battery_low', text: 'קופה 3 — סוללה 14%', audience: 'managers' },
      ],
    };
  }

  it("nothing while nobody is signed in; the kiosks' alerts by role; a notice once as a toast; ראיתי tells the cloud; בדרך", async () => {
    let helpOpen = true;
    h = harness({
      answers: {
        'GET sync/m/kiosk/alerts': () => {
          const l = cloudList();
          if (!helpOpen) l.alerts = (l.alerts as Array<{ id: string }>).filter((a) => a.id !== HELP_ID);
          return l;
        },
        'POST sync/m/kiosk/alerts/*': () => ({ ok: true }),
      },
    });
    const f = h.engine.register(new TillAlertsService(h.engine.ctx, { timers: false, kitchenJobs: () => [] }));
    const view = () => (h!.state() as unknown as { alerts?: TillAlertsState }).alerts;
    expect(view()).toBeUndefined();
    await h.ok('session.login', { pin: PIN });
    await f.fetchKioskAlerts(true);
    // A cashier: the managers' battery is not theirs.
    expect(view()!.count).toBe(2);
    expect(view()!.line?.strong).toBe(true);
    const toasts = h.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts).toContain('2 התראות חדשות · קיוסק רויאל מבקש עזרה');
    expect(view()!.beep).toMatchObject({ seq: 1, sound: 'beep' });
    // Not told again on the next step.
    f.step();
    expect(h.events.filter((e) => e.ev === 'toast')).toHaveLength(toasts.length);
    // "ראיתי" on the printer: kept, and the cloud hears "הבנתי".
    const printerKey = 'k1|printer:receipt|no_paper';
    await h.ok(op('alerts.seen'), { keys: [printerKey] });
    await f.lastWork;
    expect(h.sent.some((s) => s.method === 'POST' && s.path === `sync/m/kiosk/alerts/${PRINTER_ID}/ack` && (s.body as { posUserName?: string }).posUserName === 'דנה כהן')).toBe(true);
    expect(view()!.groups[0].items.find((i) => i.key === printerKey)?.seen).toBeNull();
    // "בדרך" on the help request: answered in the cloud, off the list.
    const helpKey = `k1|help|${HELP_ID}`;
    helpOpen = false;
    await h.ok(op('alerts.onMyWay'), { key: helpKey });
    await f.lastWork;
    expect(h.sent.some((s) => s.method === 'POST' && s.path === `sync/m/kiosk/alerts/${HELP_ID}/ack`)).toBe(true);
    expect(view()!.groups.flatMap((g) => g.items).map((i) => i.key)).toEqual([printerKey]);
    expect(view()!.line).toBeNull();
    // "בדרך" on what is not a help request: refused.
    expect((await h.fail(op('alerts.onMyWay'), { key: printerKey })).code).toBe('invalid_args');
    // The book is on the disk.
    expect(h.svc.kv.get('till.alertsBook')).toContain(printerKey);
  });

  it('a manager sees the managers\' alerts; "ראיתי הכול"; an older cloud without kiosk alerts — none', async () => {
    h = harness({ answers: { 'GET sync/m/kiosk/alerts': () => cloudList(), 'POST sync/m/kiosk/alerts/*': () => ({}) } });
    const f = h.engine.register(new TillAlertsService(h.engine.ctx, { timers: false, kitchenJobs: () => [] }));
    await h.ok('session.login', { pin: MANAGER_PIN });
    await f.fetchKioskAlerts(true);
    const view = () => (h!.state() as unknown as { alerts: TillAlertsState }).alerts;
    expect(view().count).toBe(3);
    await h.ok(op('alerts.seenAll'));
    await f.lastWork;
    expect(view().unseen).toBe(0);
    // Only those the cloud keeps were told "הבנתי" (not the help request).
    const acks = h.sent.filter((s) => s.method === 'POST').map((s) => s.path);
    expect(acks).toContain(`sync/m/kiosk/alerts/${PRINTER_ID}/ack`);
    expect(acks).toContain('sync/m/kiosk/alerts/battery%3Am2/ack');
    expect(acks).not.toContain(`sync/m/kiosk/alerts/${HELP_ID}/ack`);
    h.stop();
    h = harness({});
    const g = h.engine.register(new TillAlertsService(h.engine.ctx, { timers: false, kitchenJobs: () => [] }));
    await h.ok('session.login', { pin: PIN });
    await g.fetchKioskAlerts(true);
    expect((h.state() as unknown as { alerts: TillAlertsState }).alerts).toMatchObject({ count: 0, subtitle: 'אין התראות פתוחות', line: null });
  });

  it('the change owed and the bons as items; never told during a payment; "שולם ללקוח" is the engine\'s owed.pay', async () => {
    h = harness({ answers: { 'GET sync/m/kiosk/alerts': () => ({ alerts: [] }) } });
    let paying = true;
    const owed = { id: 'o1', kind: 'change_owed' as const, txId: 't1', amountAgorot: 1300, stationId: 's1', stationName: 'עמדת מזומן 2', slipCode: null, orderLabel: '57', clientName: null, createdAt: null };
    const f = h.engine.register(
      new TillAlertsService(h.engine.ctx, {
        timers: false,
        kitchenJobs: () => [],
        owed: () => ({ items: [owed], loaded: true }),
        activity: () => (paying ? 'payment' : 'working'),
      }),
    );
    await h.ok('session.login', { pin: PIN });
    await f.fetchKioskAlerts(true);
    const toasts = () => h!.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts()).toEqual([]);
    const view = () => (h!.state() as unknown as { alerts: TillAlertsState }).alerts;
    expect(view().line?.strong).toBe(false);
    paying = false;
    f.step();
    expect(toasts()).toEqual(['עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪']);
    const item = view().groups[0].items[0];
    expect(item).toMatchObject({ title: 'עודף חייב ללקוח', pay: true });
    // Not in TillCash's own list (the fake): the engine's owed.pay refuses it — it was asked.
    expect((await h.fail(op('alerts.pay'), { key: item.key })).code).toBe('invalid_args');
    expect((await h.fail(op('alerts.pay'), { key: 'nope' })).code).toBe('invalid_args');
  });
});

/* ------------------------------------------------------------------ the screen */

describe('the screen', () => {
  const actions = { refresh: () => undefined, seen: () => undefined, seenAll: () => undefined, onMyWay: () => undefined, pay: () => undefined, openQueue: () => undefined, openKiosks: () => undefined };

  it('the list by device with its actions; nothing open', () => {
    const help = kiosk({ id: 'h1', kind: 'help', key: 'help', reason: 'help', pings: 2 });
    const owed = fromCashOwed({ id: 'o1', kind: 'held_credit', txId: 't1', amountAgorot: 500, stationId: 's1', stationName: 'עמדת מזומן 2', slipCode: null, orderLabel: null, clientName: null, createdAt: null });
    const bon = kitchenItems([
      { id: 'a', printerId: 'p1', printerName: 'בר', printerJson: '{}', ticketJson: '{"tableName":"4","lines":[]}', route: 'DIRECT', kind: 'ticket', state: 'failed', attempts: 2, lastError: 'cover_open', queuedAt: 0, createdAt: 1, updatedAt: 0, nextAttemptAt: 0, finishedAt: null, relayVia: null, relayHost: null, relayJobId: null, ackStatus: null, lanOrigin: 0, dismissed: 0, discardReason: null } as unknown as KitchenJob,
    ])[0];
    const view = alertsView({ book: {}, visible: [help, owed, bon], activity: 'idle', nowMs: t0, kiosks: new Map([['h1', kioskAlert({ id: 'h1', kind: 'help' })]]), controlled: new Set(['k1']), beep: null });
    const html = renderToStaticMarkup(createElement(AlertsScreen, { view, actions, back: () => undefined }));
    for (const w of ['התראות', 'ראיתי הכול', 'קיוסק רויאל', 'ניהול הקיוסק', 'בקשת עזרה מקיוסק', 'בדרך', 'קריאה מספר 2', 'זיכוי מוחזק', 'שולם ללקוח', 'בון לא הודפס', 'תור הדפסה', 'בון לא הודפס — בר, שולחן 4 (המכסה פתוח)', 'חזרה']) expect(html).toContain(w);
    const hidden = renderToStaticMarkup(createElement(AlertsScreen, { view, actions: { ...actions, openQueue: undefined, openKiosks: undefined }, back: () => undefined }));
    expect(hidden).not.toContain('תור הדפסה');
    expect(hidden).not.toContain('ניהול הקיוסק');
    const empty = alertsView({ book: {}, visible: [], activity: 'idle', nowMs: t0, kiosks: new Map(), controlled: new Set(), beep: null });
    expect(renderToStaticMarkup(createElement(AlertsScreen, { view: empty, actions, back: () => undefined }))).toContain('אין התראות פתוחות');
  });

  it('the slim line: coloured for a customer waiting, gone once seen', () => {
    const help = kiosk({ id: 'h1', kind: 'help', key: 'help', reason: 'help' });
    const view = alertsView({ book: {}, visible: [help], activity: 'idle', nowMs: t0, kiosks: new Map(), controlled: new Set(), beep: null });
    const html = renderToStaticMarkup(createElement(AlertsLine, { view, onOpen: () => undefined, onSeenAll: () => undefined }));
    expect(html).toContain('t-alerts-line-help');
    expect(html).toContain('התראות (1) · ');
    expect(html).toContain('ראיתי');
    const seen = alertsView({ book: markSeen({}, [help], t0), visible: [help], activity: 'idle', nowMs: t0, kiosks: new Map(), controlled: new Set(), beep: null });
    expect(renderToStaticMarkup(createElement(AlertsLine, { view: seen, onSeenAll: () => undefined }))).toBe('');
  });
});
