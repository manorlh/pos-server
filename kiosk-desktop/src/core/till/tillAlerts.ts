/**
 * "התראות" on the Windows till — the port of pos-android domain/TillAlerts.kt (and the till's side of domain/KioskAlerts.kt,
 * data/repo/TillAlertCenter.kt `gather`, ui/alerts/TillAlertsUi.kt's words): the till's alerts, quietly.
 *
 *  - Never a modal. Every alert that is not this till's own action — a kiosk's printer, card terminal, help request, a device's
 *    battery or a cash station (the cloud's "התראות לקופות", `GET /sync/{m}/kiosk/alerts`), this till's kitchen bons that did
 *    not print, the change a cash station owes a customer — is an item ([TillAlertItem]) in one list.
 *  - One quiet notice per new problem ([alertStep]); the same problem (device, key, reason — [problemKey]) is not told again
 *    while it lasts; again only once it was resolved for at least [RESOLVED_MIN_MS] and came back, or after
 *    [QUIET_RENOTIFY_MS] of quiet; a help request's re-ping is told. Never over a payment: the notice waits.
 *  - One slim line while any is unseen ([alertLine]); "ראיתי" lets it go until something new arrives.
 *  - What was told and seen is kept on the till ([TillAlertBook]), so a restart tells nothing old again.
 *
 * Pure.
 */

import { bonReason, titleOf, type BonReason } from '../kitchen/alerts';
import type { KitchenJob } from '../kitchen/queue';
import type { WireTicket } from '../kitchen/tickets';
import { owedLine, type CashOwedNotice } from './cashOwed';

/* ------------------------------------------------------------------ words */

/** pos-android strings (talert_*, kalert_*, kcash_*, bon_reason_*), word for word. */
export const ALERTS_TEXT = {
  title: 'התראות',
  line: (n: number) => `התראות (${n})`,
  seen: 'ראיתי',
  seenAll: 'ראיתי הכול',
  none: 'אין התראות פתוחות',
  menuOpen: (n: number) => `${n} פתוחות`,
  close: 'סגירה',
  newMany: (n: number) => `${n} התראות חדשות`,
  thisTill: 'קופה זו',
  printServerTitle: 'מדפסת לא מגיבה',
  printServerDown: (name: string) => `${name} לא מגיבה — בדקו חשמל, נייר וכבל רשת`,
  networkTitle: 'רשת',
  printers: 'מדפסות',
  kioskControl: 'ניהול הקיוסק',
  bonTitle: 'בון לא הודפס',
  bonOne: (printer: string, title: string) => `בון לא הודפס — ${printer}, ${title}`,
  bonMany: (printer: string, n: number) => `${printer}: ${n} בונים לא הודפסו`,
  bonOther: 'בון',
  printQueue: 'תור הדפסה',
  helpTitle: 'בקשת עזרה מקיוסק',
  printerTitle: 'תקלה במדפסת של קיוסק',
  terminalTitle: 'תקלה במסופון של קיוסק',
  batteryTitle: 'סוללה חלשה במכשיר',
  batteryCriticalTitle: 'סוללה קריטית במכשיר',
  cashTitle: 'מכשיר מזומן',
  owedTitle: 'עודף חייב ללקוח',
  heldTitle: 'זיכוי מוחזק',
  pay: 'שולם ללקוח',
  onMyWay: 'בדרך',
  pinged: (n: number) => `קריאה מספר ${n}`,
  ackedBy: (who: string) => `ראו: ${who}`,
  viaLan: 'התקבלה ברשת המקומית',
  bonReason: {
    no_paper: 'אין נייר',
    cover_open: 'המכסה פתוח',
    printer_error: 'תקלת מדפסת',
    offline: 'המדפסת לא מגיבה',
    uncertain: 'נקטע באמצע — ייתכן שהודפס חלקית; לא יודפס שוב לבד',
    unconfirmed: 'השליחה לא אושרה בענן — לא ידוע אם הגיע למטבח',
    kds_not_taken: 'מסך המטבח לא קיבל את ההזמנה',
    host_silent: 'קופת ההדפסה לא עונה',
    slow: 'ממתין בקופת ההדפסה',
    expired: 'אף קופה לא לקחה את הבון',
    refused: 'אין לאן לשלוח (כתובת או מכשיר חסרים)',
    error: 'תקלה',
  } satisfies Record<BonReason, string>,
} as const;

/* ------------------------------------------------------------------ the model */

/** Where an alert comes from — each source says, once it has answered, which of its alerts ended. */
export type TillAlertSource = 'kiosk' | 'print_server' | 'network' | 'kitchen' | 'cash';
export type TillAlertSeverity = 'info' | 'urgent';
/** What the till is busy with: a notice waits while it is a payment (or a table's order screen). */
export type TillActivity = 'idle' | 'working' | 'order_screen' | 'payment';
export type TillAlertSound = 'none' | 'beep' | 'battery' | 'battery_critical';
const SOUND_ORDER: readonly TillAlertSound[] = ['none', 'beep', 'battery', 'battery_critical'];
const SOURCES: readonly TillAlertSource[] = ['kiosk', 'print_server', 'network', 'kitchen', 'cash'];

export type KioskAlertKind = 'printer' | 'terminal' | 'help' | 'battery' | 'cash';
const KINDS: readonly KioskAlertKind[] = ['printer', 'terminal', 'help', 'battery', 'cash'];

export const holdsNotices = (a: TillActivity): boolean => a === 'order_screen' || a === 'payment';

/** An alert as a till gets it (`GET /sync/{m}/kiosk/alerts`). */
export interface KioskTillAlert {
  id: string;
  kioskMachineId: string;
  kioskName: string | null;
  kind: KioskAlertKind;
  key: string;
  reason: string;
  text: string;
  raisedAt: string | null;
  pingCount: number;
  acknowledgedBy: string | null;
  /** "everyone" signed in, or "managers" only. */
  audience: 'everyone' | 'managers';
  /** Came over the LAN from the kiosk (no cloud): answered here only. */
  viaLan: boolean;
}

/** One open alert, whatever its source. */
export interface TillAlertItem {
  source: TillAlertSource;
  /** The alert itself (the cloud's id, …): what its actions answer. */
  id: string;
  /** The device it is about — the list's group ("k1", "printer:p7", "cash:s1"). */
  device: string;
  deviceName: string;
  /** The problem on that device ("printer:receipt", "terminal", "kitchen"). */
  key: string;
  reason: string;
  text: string;
  severity: TillAlertSeverity;
  /** When it was raised (the cloud's raisedAt); null: since this till first saw it. */
  sinceMs: number | null;
  /** A help request's taps. */
  ping: number;
  managersOnly: boolean;
  /** A kiosk alert's kind; null for the till's own sources. */
  kind: KioskAlertKind | null;
}

/** The same problem: the same device, key and reason — a help request is its own problem per request. */
export function problemKey(i: TillAlertItem): string {
  return i.kind === 'help' ? `${i.device}|${i.key}|${i.id}` : `${i.device}|${i.key}|${i.reason}`;
}

/* ------------------------------------------------------------------ the kiosks' alerts */

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : o[k] === null || o[k] === undefined ? '' : String(o[k]));

/** `GET kiosk/alerts` → its alerts (an unknown kind or no id: left out). */
export function parseKioskTillAlerts(body: unknown): KioskTillAlert[] {
  const arr = body && typeof body === 'object' ? (body as { alerts?: unknown }).alerts : null;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x): KioskTillAlert | null => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      const kind = str(o, 'kind') as KioskAlertKind;
      const id = str(o, 'id');
      if (!KINDS.includes(kind) || !id.trim()) return null;
      const name = str(o, 'kioskName').trim();
      const raised = str(o, 'raisedAt').trim();
      const acked = str(o, 'acknowledgedBy').trim();
      return {
        id,
        kioskMachineId: str(o, 'kioskMachineId'),
        kioskName: name || null,
        kind,
        key: str(o, 'key'),
        reason: str(o, 'reason'),
        text: str(o, 'text'),
        raisedAt: raised || null,
        pingCount: typeof o.pingCount === 'number' && Number.isFinite(o.pingCount) ? Math.trunc(o.pingCount) : 0,
        acknowledgedBy: acked || null,
        audience: o.audience === 'managers' ? 'managers' : 'everyone',
        viaLan: false,
      };
    })
    .filter((a): a is KioskTillAlert => a !== null);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "ראיתי" on a printer / terminal / battery alert tells the cloud too ("הבנתי") — once, for an alert the cloud keeps (its
 * own id, a battery's, a cash station's). Not a help request ("בדרך" answers that), not the LAN's, not the computed ones.
 */
export function ackOnSeen(a: KioskTillAlert): boolean {
  return !a.viaLan && a.kind !== 'help' && a.acknowledgedBy === null && (a.id.startsWith('battery:') || a.id.startsWith('cash:') || UUID.test(a.id));
}

/* ------------------------------------------------------------------ the rules */

/** "2026-10-07T09:12:00Z" / "…+03:00" / no zone (UTC) → epoch ms; null when absent or unreadable. */
export function isoMs(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s)) return null;
  const t = s.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Only what needs someone now is urgent: a customer asking for help, a card payment not decided. */
export function severityOf(kind: KioskAlertKind, reason: string): TillAlertSeverity {
  return kind === 'help' || (kind === 'terminal' && reason === 'card_unknown') ? 'urgent' : 'info';
}

export function fromKiosk(a: KioskTillAlert): TillAlertItem {
  return {
    source: 'kiosk',
    id: a.id,
    device: a.kioskMachineId.trim() || 'kiosk',
    deviceName: a.kioskName?.trim() ?? '',
    key: a.key.trim() || a.kind,
    reason: a.reason,
    text: a.text,
    severity: severityOf(a.kind, a.reason),
    sinceMs: isoMs(a.raisedAt),
    ping: a.pingCount,
    managersOnly: a.audience === 'managers',
    kind: a.kind,
  };
}

/** Change owed by a cash station, or a credit it held (§11.8): grouped by its station, urgent — a customer waits. */
export function fromCashOwed(n: CashOwedNotice, line: string = owedLine(n)): TillAlertItem {
  return {
    source: 'cash',
    id: n.id,
    device: `cash:${n.stationId ?? 'station'}`,
    deviceName: n.stationName?.trim() ?? '',
    key: `cash:${n.kind}:${n.id}`,
    reason: n.kind,
    text: line,
    severity: 'urgent',
    sinceMs: isoMs(n.createdAt),
    ping: 0,
    managersOnly: false,
    kind: null,
  };
}

/** A printer this till prints for the others that does not answer ("שרת הדפסות"). */
export function fromPrintServer(printer: { id: string; name: string }): TillAlertItem {
  return {
    source: 'print_server',
    id: `print-server:${printer.id}`,
    device: `printer:${printer.id}`,
    deviceName: printer.name,
    key: 'print-server',
    reason: 'down',
    text: ALERTS_TEXT.printServerDown(printer.name),
    severity: 'info',
    sinceMs: null,
    ping: 0,
    managersOnly: false,
    kind: null,
  };
}

/** Android's BonReason order: the reason that needs a person most — uncertain / unconfirmed / KDS — first. */
const BON_ORDER: readonly BonReason[] = ['no_paper', 'cover_open', 'printer_error', 'offline', 'uncertain', 'unconfirmed', 'kds_not_taken', 'host_silent', 'slow', 'expired', 'refused', 'error'];
const BON_URGENT = new Set<BonReason>(['uncertain', 'unconfirmed', 'kds_not_taken']);
const bonRank = (r: BonReason) => (BON_URGENT.has(r) ? -1 : BON_ORDER.indexOf(r));

/**
 * This till's own bons that did not print (PrintQueueView.printerAlertGroups / printerAlertOf, TillAlertCenter.gather): one
 * item per printer — how many wait on it, its oldest ticket's title, the reason that needs a person most. Test pages and
 * handled tickets are not alerts.
 */
export function kitchenItems(jobs: readonly KitchenJob[]): TillAlertItem[] {
  const open = jobs.filter((j) => j.kind !== 'test' && j.dismissed === 0);
  const by = new Map<string, KitchenJob[]>();
  for (const j of open) by.set(j.printerId, [...(by.get(j.printerId) ?? []), j]);
  const groups = [...by.entries()].map(([printerId, list]) => {
    const first = list.reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
    const reasons = list.map((j) => bonReason(j)).filter((r): r is BonReason => r !== null);
    const reason = reasons.length === 0 ? null : reasons.reduce((a, b) => (bonRank(b) < bonRank(a) ? b : a));
    return { printerId, printerName: first.printerName, count: list.length, first, reason };
  });
  groups.sort((a, b) => (a.printerName < b.printerName ? -1 : a.printerName > b.printerName ? 1 : 0));
  return groups.map((g) => {
    let ticket: WireTicket | null = null;
    try {
      ticket = JSON.parse(g.first.ticketJson) as WireTicket;
    } catch {
      ticket = null;
    }
    const head = g.count === 1 ? ALERTS_TEXT.bonOne(g.printerName, titleOf(ticket) ?? ALERTS_TEXT.bonOther) : ALERTS_TEXT.bonMany(g.printerName, g.count);
    return {
      source: 'kitchen' as const,
      id: `kitchen:${g.printerId}`,
      device: `printer:${g.printerId}`,
      deviceName: g.printerName,
      key: 'kitchen',
      reason: g.reason ?? 'error',
      text: g.reason ? `${head} (${ALERTS_TEXT.bonReason[g.reason]})` : head,
      severity: 'urgent' as const,
      sinceMs: null,
      ping: 0,
      managersOnly: false,
      kind: null,
    };
  });
}

/**
 * Who sees it. A kiosk's: anyone signed in, or — for managers only — a shop manager; nobody signed in, nobody. The till's
 * own: whoever stands at it.
 */
export function visibleTo(item: TillAlertItem, role: string | null): boolean {
  if (item.source !== 'kiosk') return true;
  if (role === null) return false;
  return !item.managersOnly || role.trim().toLowerCase() === 'shop_manager';
}

/** A notice's sound: a battery's own alarm, a beep for what is urgent, the print server's printer and an unprinted bon. */
export function soundOf(item: TillAlertItem): TillAlertSound {
  if (item.kind === 'battery') return item.reason === 'battery_critical' ? 'battery_critical' : 'battery';
  if (item.severity === 'urgent' || item.source === 'print_server' || item.source === 'kitchen') return 'beep';
  return 'none';
}

/** One sound for notices told together: the strongest of theirs. */
export function soundOfAll(items: readonly TillAlertItem[]): TillAlertSound {
  return items.map(soundOf).reduce<TillAlertSound>((a, b) => (SOUND_ORDER.indexOf(b) > SOUND_ORDER.indexOf(a) ? b : a), 'none');
}

/* ------------------------------------------------------------------ the book */

/** What the till keeps of one problem: this occurrence, its notice and "ראיתי". */
export interface TillAlertTrack {
  source: TillAlertSource;
  since: number;
  gone: number | null;
  notified: number | null;
  notifiedPing: number;
  seen: number | null;
}

/** Every problem the till keeps, by its problem key; kept on the till across restarts. */
export type TillAlertBook = Record<string, TillAlertTrack>;

export const unseen = (book: TillAlertBook, item: TillAlertItem): boolean => (book[problemKey(item)]?.seen ?? null) === null;

/** When it began: the cloud's time, else when this till first saw it. */
export const timeOf = (book: TillAlertBook, item: TillAlertItem): number | null => item.sinceMs ?? book[problemKey(item)]?.since ?? null;

/** Android `TillAlertBook.toJson` (the same shape). */
export function bookToJson(book: TillAlertBook): string {
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(book)) out[k] = { source: t.source, since: t.since, gone: t.gone, notified: t.notified, ping: t.notifiedPing, seen: t.seen };
  return JSON.stringify(out);
}

/** Android `TillAlertBook.parse`: anything unreadable — an empty book. */
export function parseBook(raw: string | null | undefined): TillAlertBook {
  if (!raw) return {};
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out: TillAlertBook = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const t = v as Record<string, unknown>;
    const source = t.source as TillAlertSource;
    const since = num(t.since);
    if (!SOURCES.includes(source) || since === null) continue;
    out[k] = { source, since, gone: num(t.gone), notified: num(t.notified), notifiedPing: num(t.ping) ?? 0, seen: num(t.seen) };
  }
  return out;
}

/* ------------------------------------------------------------------ the notices */

/** A problem that lasts is told again after this much quiet (4 h). */
export const QUIET_RENOTIFY_MS = 4 * 60 * 60_000;
/** Gone for less than this and back is a flap — the same problem; gone this long, it is forgotten. */
export const RESOLVED_MIN_MS = 5 * 60_000;

/**
 * One step: [items] are every open alert now; [reported] the sources that have answered since the till started (only their
 * missing alerts count as resolved). Returns the book to keep and what to tell now.
 */
export function alertStep(book: TillAlertBook, items: readonly TillAlertItem[], reported: ReadonlySet<TillAlertSource>, nowMs: number, activity: TillActivity, role: string | null): { book: TillAlertBook; notify: TillAlertItem[] } {
  const present = new Map<string, TillAlertItem>();
  for (const i of items) if (!present.has(problemKey(i))) present.set(problemKey(i), i);
  const out: TillAlertBook = {};
  const notify: TillAlertItem[] = [];
  for (const [key, item] of present) {
    const before = book[key];
    const gone = before?.gone ?? null;
    let track: TillAlertTrack;
    if (!before) track = { source: item.source, since: nowMs, gone: null, notified: null, notifiedPing: 0, seen: null };
    else if (gone !== null && (item.severity === 'urgent' || nowMs - gone >= RESOLVED_MIN_MS)) track = { source: item.source, since: nowMs, gone: null, notified: null, notifiedPing: 0, seen: null };
    else if (gone !== null) track = { ...before, gone: null };
    else track = before;
    const due = track.notified === null || nowMs - track.notified >= QUIET_RENOTIFY_MS || item.ping > track.notifiedPing;
    if (due && !holdsNotices(activity) && visibleTo(item, role)) {
      notify.push(item);
      track = { ...track, notified: nowMs, notifiedPing: item.ping, seen: null };
    }
    out[key] = track;
  }
  for (const [key, track] of Object.entries(book)) {
    if (present.has(key)) continue;
    if (!reported.has(track.source)) out[key] = track;
    else if (track.gone === null) out[key] = { ...track, gone: nowMs };
    else if (nowMs - track.gone < RESOLVED_MIN_MS) out[key] = track;
    // Gone long enough: forgotten.
  }
  return { book: out, notify };
}

/** "ראיתי" on [items]: the line lets them go until something new arrives; a notice not told yet is not told after it. */
export function markSeen(book: TillAlertBook, items: readonly TillAlertItem[], nowMs: number): TillAlertBook {
  if (items.length === 0) return book;
  const out = { ...book };
  for (const i of items) {
    const k = problemKey(i);
    const t = out[k] ?? { source: i.source, since: nowMs, gone: null, notified: null, notifiedPing: 0, seen: null };
    out[k] = { ...t, seen: nowMs, notified: t.notified ?? nowMs, notifiedPing: Math.max(t.notifiedPing, i.ping) };
  }
  return out;
}

export interface TillAlertLine {
  count: number;
  unseen: number;
  top: TillAlertItem;
  /** Coloured: what is urgent, never during a payment. */
  strong: boolean;
}

/** The visible alerts' line, or null when every one was seen: urgent first, then the newest. */
export function alertLine(book: TillAlertBook, visible: readonly TillAlertItem[], activity: TillActivity): TillAlertLine | null {
  const un = visible.filter((i) => unseen(book, i));
  if (un.length === 0) return null;
  const top = un
    .map((i, n) => ({ i, n }))
    .sort((a, b) => {
      const u = (b.i.severity === 'urgent' ? 1 : 0) - (a.i.severity === 'urgent' ? 1 : 0);
      if (u !== 0) return u;
      const t = (timeOf(book, b.i) ?? 0) - (timeOf(book, a.i) ?? 0);
      return t !== 0 ? t : a.n - b.n;
    })[0].i;
  return { count: visible.length, unseen: un.length, top, strong: top.severity === 'urgent' && activity !== 'payment' };
}

export interface TillAlertGroup {
  device: string;
  deviceName: string;
  items: TillAlertItem[];
}

const byNewest = (book: TillAlertBook) => (a: { v: TillAlertItem; n: number }, b: { v: TillAlertItem; n: number }) => (timeOf(book, b.v) ?? 0) - (timeOf(book, a.v) ?? 0) || a.n - b.n;

/** The list: by device — the one with the newest alert first — each newest first. */
export function alertGroups(book: TillAlertBook, visible: readonly TillAlertItem[]): TillAlertGroup[] {
  const by = new Map<string, TillAlertItem[]>();
  for (const i of visible) by.set(i.device, [...(by.get(i.device) ?? []), i]);
  const groups = [...by.entries()].map(([device, list]) => {
    const sorted = list
      .map((v, n) => ({ v, n }))
      .sort(byNewest(book))
      .map((x) => x.v);
    return { device, deviceName: sorted.find((i) => i.deviceName.trim())?.deviceName ?? '', items: sorted };
  });
  return groups
    .map((g, n) => ({ g, n }))
    .sort((a, b) => (timeOf(book, b.g.items[0]) ?? 0) - (timeOf(book, a.g.items[0]) ?? 0) || a.n - b.n)
    .map((x) => x.g);
}

/* ------------------------------------------------------------------ the view */

/** The row's title (TillAlertsUi `AlertRow`). */
export function titleOfItem(i: TillAlertItem): string {
  if (i.source === 'print_server') return ALERTS_TEXT.printServerTitle;
  if (i.source === 'kitchen') return ALERTS_TEXT.bonTitle;
  if (i.source === 'network') return ALERTS_TEXT.networkTitle;
  if (i.source === 'cash') return i.reason === 'held_credit' ? ALERTS_TEXT.heldTitle : ALERTS_TEXT.owedTitle;
  if (i.kind === 'help') return ALERTS_TEXT.helpTitle;
  if (i.kind === 'printer') return ALERTS_TEXT.printerTitle;
  if (i.kind === 'battery') return i.reason === 'battery_critical' ? ALERTS_TEXT.batteryCriticalTitle : ALERTS_TEXT.batteryTitle;
  if (i.kind === 'cash') return ALERTS_TEXT.cashTitle;
  return ALERTS_TEXT.terminalTitle;
}

const two = (n: number) => String(n).padStart(2, '0');

/** "14:05", or "06.10 14:05" for an earlier day (the till's own time zone). */
export function timeLabel(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  const hm = `${two(at.getHours())}:${two(at.getMinutes())}`;
  return sameDay ? hm : `${two(at.getDate())}.${two(at.getMonth() + 1)} ${hm}`;
}

export interface AlertItemView {
  /** The problem key: what "ראיתי", "בדרך" and "שולם ללקוח" name. */
  key: string;
  source: TillAlertSource;
  title: string;
  text: string;
  time: string | null;
  unseen: boolean;
  urgent: boolean;
  help: boolean;
  /** "קריאה מספר 2" (a help request tapped again). */
  pinged: string | null;
  /** "ראו: דנה" (the cloud heard "הבנתי" from someone). */
  ackedBy: string | null;
  /** "בדרך": a kiosk's help request. */
  onMyWay: boolean;
  /** "ראיתי": a button (it tells the cloud too), a quiet text button (a help request — "בדרך" answers it), or none (seen). */
  seen: 'button' | 'text' | null;
  /** "שולם ללקוח": a cash station's change owed / held credit. */
  pay: boolean;
  /** "תור הדפסה": this till's kitchen bons. */
  queue: boolean;
  /** "מדפסות": a printer this till prints for the others. */
  printers: boolean;
}

export interface AlertGroupView {
  device: string;
  name: string;
  /** A kiosk this till controls: "ניהול הקיוסק". */
  kioskControl: boolean;
  items: AlertItemView[];
}

/** `TillState.alerts` — the list (AlertsScreen), the slim line, the menu row's second line, the notice's sound. */
export interface TillAlertsState {
  /** The open alerts the signed-in person sees. */
  count: number;
  unseen: number;
  /** The menu row's second line: "אין התראות פתוחות" / "3 פתוחות". */
  subtitle: string;
  /** The slim line over the till while anything is unseen: "התראות (3) · …"; coloured when strong (blue for a help request). */
  line: { text: string; strong: boolean; help: boolean } | null;
  groups: AlertGroupView[];
  /** The last notice's sound (a new `seq`: play it once). */
  beep: { seq: number; sound: Exclude<TillAlertSound, 'none'> } | null;
}

export function alertsView(o: {
  book: TillAlertBook;
  visible: readonly TillAlertItem[];
  activity: TillActivity;
  nowMs: number;
  kiosks: ReadonlyMap<string, KioskTillAlert>;
  controlled: ReadonlySet<string>;
  beep: TillAlertsState['beep'];
}): TillAlertsState {
  const line = alertLine(o.book, o.visible, o.activity);
  const groups = alertGroups(o.book, o.visible).map(
    (g): AlertGroupView => ({
      device: g.device,
      name: g.deviceName.trim() || '—',
      kioskControl: o.controlled.has(g.device),
      items: g.items.map((i): AlertItemView => {
        const un = unseen(o.book, i);
        const k = i.source === 'kiosk' ? (o.kiosks.get(i.id) ?? null) : null;
        const at = timeOf(o.book, i);
        return {
          key: problemKey(i),
          source: i.source,
          title: titleOfItem(i),
          text: i.text,
          time: at === null ? null : timeLabel(at, o.nowMs),
          unseen: un,
          urgent: i.severity === 'urgent',
          help: i.kind === 'help',
          pinged: i.kind === 'help' && i.ping > 1 ? ALERTS_TEXT.pinged(i.ping) : null,
          ackedBy: k?.acknowledgedBy ? ALERTS_TEXT.ackedBy(k.acknowledgedBy) : null,
          onMyWay: i.kind === 'help' && k !== null,
          seen: !un ? null : i.kind === 'help' ? 'text' : 'button',
          pay: i.source === 'cash',
          queue: i.source === 'kitchen',
          printers: i.source === 'print_server',
        };
      }),
    }),
  );
  return {
    count: o.visible.length,
    unseen: o.visible.filter((i) => unseen(o.book, i)).length,
    subtitle: o.visible.length === 0 ? ALERTS_TEXT.none : ALERTS_TEXT.menuOpen(o.visible.length),
    line: line ? { text: `${ALERTS_TEXT.line(line.count)} · ${line.top.text}`, strong: line.strong, help: line.top.kind === 'help' } : null,
    groups,
    beep: o.beep,
  };
}

/** The notice's words: one alert's line, or "3 התראות חדשות · …" (the urgent one named). */
export function noticeText(items: readonly TillAlertItem[]): string {
  const top = [...items].sort((a, b) => (b.severity === 'urgent' ? 1 : 0) - (a.severity === 'urgent' ? 1 : 0))[0];
  return items.length > 1 ? `${ALERTS_TEXT.newMany(items.length)} · ${top.text}` : top.text;
}
