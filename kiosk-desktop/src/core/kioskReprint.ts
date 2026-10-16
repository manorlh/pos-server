/**
 * "היסטוריית עסקאות" and "הדפסה חוזרת" in the kiosk's manager menu — the port of pos-android domain/KioskReprint.kt
 * (its words: res/values/strings_kiosk_app.xml `kapp_reprint_*`, strings_kiosk_work_mode.xml `kadmin_history_*`,
 * `kctl_history_*`; P:/specs/kiosk-landscape-till-mode.md §5.12), and the Windows kiosk's own "שובר פריט לא הודפס"
 * (the owner, 16.10.2026: "היסטוריית עסקאות של הקיוסק… וגם אופציה להדפיס שוב שובר פריט שלא הודפס"):
 *
 *  - the paid kiosk sales of today ("היום", the default) or of the last week the kiosk keeps ("7 ימים"), newest first,
 *    and older ones from the cloud when it answers ("ישנות יותר", `GET /sync/{m}/kiosk/orders`); one search for all —
 *    a pickup number or its letters ("A12" ≈ "a 12"), a document number, the customer's name, or an amount
 *    ("45", "45,5", "₪45.50" — the total with the tip);
 *  - per order "שובר פריט" (its item tickets — all of them, or only those that did not print), "חשבונית (העתק)" and
 *    "בון למטבח" where bons are on and it went by bon; each under the till permission "הדפסה חוזרת" (REPRINT): the
 *    menu's manager alone when the role allows it, else another manager's code; each recorded — the cloud's
 *    "הדפסה חוזרת" event (`reprint`) and the day's log; never automatic;
 *  - every reprinted page says "הדפסה חוזרת" (the receipt says "העתק", as the till's copy);
 *  - an item ticket's state is its print job's: "נשלח למדפסת", "בתור להדפסה", "לא הודפס" (the queue gave up).
 *
 * Pure here; main/kiosk/history.ts carries it out.
 */

import { findByPin, lockAt, LOCKOUT_MS, MAX_FAILURES, NO_LOCK, usersAllowed, type BcryptCompare, type ExitLock, type RosterUser } from './desktopExit';
import type { BonStatus, ReceiptStatus } from './kioskOrders';

/** What one reprint prints; the value is the event's `kind` (KioskReprintKind.wire). */
export type ReprintKind = 'item_tickets' | 'invoice_copy' | 'kitchen_bon';

export const REPRINT_KINDS: readonly ReprintKind[] = ['item_tickets', 'invoice_copy', 'kitchen_bon'];

/** The till permission every reprint is under ("הדפסה חוזרת", `table:reprint` on the till). */
export const REPRINT_PERMISSION = 'REPRINT';

/** "7 ימים": what the kiosk keeps of its orders (OrderStore / KioskOrderStore: a week). "היום" is the default. */
export const HISTORY_KEEP_DAYS = 7;
export const HISTORY_DEFAULT_DAYS = 1;
/** "ישנות יותר": the cloud's business days before the kept week (the route's bound is 31). */
export const CLOUD_HISTORY_DAYS = 30;
/** The rows listed (Android MAX_LISTED 40 on the kiosk, 60 on the controlling till): a search narrows them. */
export const HISTORY_SHOWN = 60;

/** The kiosk's words — Android's where it has them (named), the Windows kiosk's own where not. */
export const REPRINT_TEXT = {
  /** kapp_reprint_title */
  title: 'הדפסה חוזרת',
  /** kctl_history */
  history: 'היסטוריית עסקאות',
  /** kadmin_history_sub */
  historySub: 'היסטוריית עסקאות — חיפוש לפי מספר הזמנה, אותיות, מספר מסמך, שם או סכום',
  /** kadmin_history_search */
  search: 'מספר הזמנה, אותיות או סכום',
  /** kadmin_history_today / kadmin_history_week */
  today: 'היום',
  week: '7 ימים',
  older: 'ישנות יותר (מהענן)',
  /** kctl_history_empty / kapp_admin_no_orders */
  empty: 'אין עסקאות',
  noOrdersToday: 'אין הזמנות היום',
  /** kctl_history_failed */
  cloudFailed: 'לא ניתן לקרוא את ההיסטוריה — אין חיבור לענן',
  cloudUnsupported: 'הענן עוד לא מחזיר עסקאות ישנות (נדרש עדכון שרת) — מוצגות העסקאות שבקיוסק',
  /** kapp_reprint_item_tickets / kapp_reprint_invoice / kapp_reprint_bon */
  itemTickets: 'שובר פריט',
  itemTicketsFailed: 'שובר פריט — רק מה שלא הודפס',
  invoice: 'חשבונית (העתק)',
  bon: 'בון למטבח',
  /** kapp_reprint_history */
  log: 'הדפסות חוזרות היום',
  /** kapp_reprint_done */
  done: 'נשלח להדפסה',
  /** kapp_reprint_no_document */
  noDocument: 'אין מסמך להזמנה הזו',
  noTickets: 'אין שוברי פריט להזמנה הזו',
  noFailedTickets: 'כל שוברי הפריט של ההזמנה הודפסו',
  notOnKiosk: 'ההזמנה כבר לא שמורה בקיוסק — אפשר להדפיס רק חשבונית ושובר פריט',
  /** kapp_reprint_needs_manager */
  needsManager: 'להדפסה חוזרת נדרש קוד של מנהל עם הרשאת "הדפסה חוזרת"',
  /** kapp_reprint_approve */
  approve: (kind: string, order: string) => `הדפסה חוזרת — ${kind}, הזמנה ${order}`,
  /** kapp_bon_reprint_notice: the band on a reprinted bon and item ticket. */
  notice: 'הדפסה חוזרת',
  /** kadmin_last_bon / kadmin_last_sale and their answers */
  lastBon: 'הדפס שוב את הבון האחרון',
  lastSale: 'הדפס עסקה אחרונה',
  lastBonDone: (label: string) => `הבון של הזמנה ${label} נשלח שוב להדפסה`,
  noLastBon: 'אין בון להדפסה חוזרת',
  /** The staff label and the menu's line (as "בונים לא הודפסו"). */
  ticketsNotPrinted: 'שובר פריט לא הודפס',
  ticketsAlert: (n: number) => `${n === 1 ? 'שובר פריט אחד לא הודפס' : `${n} שוברי פריט לא הודפסו`} היום — הדפסה חוזרת ב"היסטוריית עסקאות"`,
  /** A ticket's state (as the bon's kapp_bon_*). */
  ticketSent: 'נשלח למדפסת',
  ticketQueued: 'בתור להדפסה',
  ticketFailed: 'לא הודפס',
  /** The approval pad. */
  wrong: (left: number) => `קוד שגוי, או שאין לו הרשאת "הדפסה חוזרת" — ${left === 1 ? 'נותר ניסיון אחד' : `נותרו ${left} ניסיונות`}`,
  locked: (ms: number) => `${MAX_FAILURES} ניסיונות שגויים — נסו שוב בעוד ${Math.max(1, Math.ceil(ms / 1000))} שניות`,
  noManagers: 'לא נמצא בסניף מנהל עם הרשאת "הדפסה חוזרת". מגדירים בדשבורד: קופאים (POS) ← תפקידים והרשאות.',
  blank: 'הקלידו את קוד המנהל',
} as const;

/* --------------------------------------------------------------- who may */

/**
 * The menu's manager reprints alone when their role allows "הדפסה חוזרת" (KioskReprint.mayAlone — `allow`; a cashier's
 * legacy `approval` is not enough), read from the roster now.
 */
export function mayAlone(users: readonly RosterUser[], shopId: string | null | undefined, userId: string | null | undefined): boolean {
  return !!userId && usersAllowed(users, shopId, REPRINT_PERMISSION).some((u) => u.id === userId);
}

export type ApproverOutcome = 'granted' | 'wrong' | 'locked_out' | 'locked' | 'no_managers' | 'blank';

export interface ApproverDecision {
  outcome: ApproverOutcome;
  user: RosterUser | null;
  lock: ExitLock;
  message: string | null;
}

/**
 * Another manager's code for a reprint (LocalManagerSheet, scope REPRINT): checked offline against the roster — an
 * active user of this shop whose role allows "הדפסה חוזרת"; five wrong codes lock the pad for a minute.
 */
export async function decideApprover(input: {
  users: readonly RosterUser[];
  shopId: string | null | undefined;
  code: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  compare: BcryptCompare;
}): Promise<ApproverDecision> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  if (lockedFor > 0) return { outcome: 'locked', user: null, lock, message: REPRINT_TEXT.locked(lockedFor) };
  const candidates = usersAllowed(input.users, input.shopId, REPRINT_PERMISSION);
  if (candidates.length === 0) return { outcome: 'no_managers', user: null, lock, message: REPRINT_TEXT.noManagers };
  const code = String(input.code ?? '');
  if (code.trim() === '') return { outcome: 'blank', user: null, lock, message: REPRINT_TEXT.blank };
  const u = await findByPin(candidates, code, input.compare);
  if (u) return { outcome: 'granted', user: u, lock: NO_LOCK, message: null };
  const failures = lock.failures + 1;
  if (failures >= MAX_FAILURES) return { outcome: 'locked_out', user: null, lock: { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS }, message: REPRINT_TEXT.locked(LOCKOUT_MS) };
  return { outcome: 'wrong', user: null, lock: { failures, lockedUntilMs: 0 }, message: REPRINT_TEXT.wrong(MAX_FAILURES - failures) };
}

/** The button's words for a kind (kindLabel). */
export function kindLabel(kind: ReprintKind): string {
  return kind === 'item_tickets' ? REPRINT_TEXT.itemTickets : kind === 'invoice_copy' ? REPRINT_TEXT.invoice : REPRINT_TEXT.bon;
}

/* ------------------------------------------------------------------ the orders */

/** What the history reads of an order — the kiosk's own (core/kioskOrders.ts KioskOrder) or the cloud's. */
export interface HistoryOrder {
  localId: string;
  /** ms; 0 when unknown (a cloud row with no `paidAt`). */
  createdAtMs: number;
  businessDate: string;
  paid: boolean;
  transactionId: string | null;
  transactionNumber: string | null;
  pickupLabel: string | null;
  customerName: string | null;
  totalAgorot: number;
  tipAgorot: number;
  fulfillmentMode: 'BON' | 'KDS';
  bonStatus: BonStatus;
  bonJobIds?: string[];
  receiptStatus?: ReceiptStatus | string;
  recovered?: boolean;
  /** The cloud's row: "תשלום בקופה", what vouchers paid. */
  payAtTill?: boolean;
  voucherAgorot?: number | null;
}

/** [day] (yyyy-MM-dd) moved by [delta] days; anything unreadable stays as it was. */
export function shiftDay(day: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta));
  if (Number.isNaN(d.getTime())) return day;
  return d.toISOString().slice(0, 10);
}

const newestFirst = <T extends Pick<HistoryOrder, 'createdAtMs'>>(a: T, b: T) => b.createdAtMs - a.createdAtMs;

/** Today's paid kiosk sales, newest first (KioskReprint.todays). */
export function todays<T extends HistoryOrder>(orders: readonly T[], today: string): T[] {
  return orders.filter((o) => o.businessDate === today && o.paid).sort(newestFirst);
}

/** The paid sales of the last [days] business days (today alone with 1), newest first (KioskReprint.recent). */
export function recent<T extends HistoryOrder>(orders: readonly T[], today: string, days: number): T[] {
  const n = Math.max(1, Math.floor(Number.isFinite(days) ? days : 1));
  const keep = new Set(Array.from({ length: n }, (_, i) => shiftDay(today, -i)));
  return orders.filter((o) => o.paid && keep.has(o.businessDate)).sort(newestFirst);
}

/** A pickup label as the search compares it: letters and digits only, upper case (KioskReprint.pickupKey). */
export function pickupKey(label: string): string {
  return Array.from(label)
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join('')
    .toUpperCase();
}

/** An amount as typed ("45", "45.5", "45,50", "₪45.50"), or null. */
export function amountOf(query: string): number | null {
  const raw = query.replace(/₪/g, '').replace(/,/g, '.').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The history's search (KioskReprint.search): a pickup number or its letters ("A12", "a 12", "12"), a document number,
 * the customer's name, or an amount (the sale's total with the tip). Blank: everything.
 */
export function search<T extends HistoryOrder>(orders: readonly T[], query: string): T[] {
  const q = query.trim();
  if (!q) return [...orders];
  const key = pickupKey(q);
  const amount = amountOf(q);
  const lower = q.toLowerCase();
  return orders.filter(
    (o) =>
      (key !== '' && pickupKey(o.pickupLabel ?? '').includes(key)) ||
      (o.transactionNumber ?? '').includes(q) ||
      (o.customerName ?? '').toLowerCase().includes(lower) ||
      (amount !== null && Math.abs((o.totalAgorot + o.tipAgorot) / 100 - amount) < 0.005),
  );
}

/**
 * What [order] may print again (KioskReprint.kinds): its item tickets and its invoice when it has a document here, its
 * kitchen bon where bons are on and it went to the kitchen by bon — only while the kiosk still keeps the order ([kept]).
 */
export function kinds(order: Pick<HistoryOrder, 'transactionId' | 'fulfillmentMode'>, bonsOn: boolean, opts: { hasDocument?: boolean; kept?: boolean } = {}): ReprintKind[] {
  const out: ReprintKind[] = [];
  const doc = opts.hasDocument ?? order.transactionId !== null;
  if (order.transactionId !== null && doc) out.push('item_tickets', 'invoice_copy');
  if (bonsOn && order.fulfillmentMode === 'BON' && opts.kept !== false) out.push('kitchen_bon');
  return out;
}

/** The newest paid sale whose kitchen bon was (or should have been) printed: "הדפס שוב את הבון האחרון" (KioskReprint.lastBon). */
export function lastBon<T extends HistoryOrder>(orders: readonly T[], bonsOn: boolean): T | null {
  if (!bonsOn) return null;
  let best: T | null = null;
  for (const o of orders) {
    if (!o.paid || o.fulfillmentMode !== 'BON' || (o.bonStatus === 'none' && (o.bonJobIds?.length ?? 0) === 0)) continue;
    if (!best || o.createdAtMs > best.createdAtMs) best = o;
  }
  return best;
}

/** The order's name on a button and in the log: its pickup label, else its document number, else its id (reprintLabelOf). */
export function labelOf(o: Pick<HistoryOrder, 'pickupLabel' | 'transactionNumber' | 'localId'>): string {
  const label = o.pickupLabel?.trim();
  if (label) return label;
  if (o.transactionNumber) return `#${o.transactionNumber}`;
  return o.localId.slice(0, 6);
}

/**
 * The cloud's orders (`GET /sync/{m}/kiosk/orders`, the server's order_out) as history rows, so the same search answers
 * them (KioskReprint.parseCloudOrders); anything unreadable left out.
 */
export function parseCloudOrders(body: unknown): HistoryOrder[] {
  if (!Array.isArray(body)) return [];
  const out: HistoryOrder[] = [];
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const localId = text(o.localId);
    if (!localId) continue;
    const paidAt = text(o.paidAt);
    const at = paidAt ? Date.parse(paidAt) : NaN;
    const bon = o.bonStatus;
    out.push({
      localId,
      createdAtMs: Number.isFinite(at) ? at : 0,
      businessDate: text(o.businessDate) ?? '',
      paid: true,
      transactionId: text(o.transactionId),
      transactionNumber: o.transactionNumber === null || o.transactionNumber === undefined ? null : String(o.transactionNumber),
      pickupLabel: text(o.pickupLabel),
      customerName: text(o.customerName),
      totalAgorot: num(o.totalAgorot),
      tipAgorot: num(o.tipAgorot),
      fulfillmentMode: o.fulfillmentMode === 'KDS' ? 'KDS' : 'BON',
      bonStatus: bon === 'queued' || bon === 'sent' || bon === 'printed' || bon === 'failed' ? bon : 'none',
      receiptStatus: text(o.receiptStatus) ?? undefined,
      payAtTill: o.payAtTill === true,
      voucherAgorot: typeof o.voucherAgorot === 'number' ? o.voucherAgorot : null,
    });
  }
  return out;
}

/** The kept rows and the cloud's, once each (the kiosk's own wins: it knows how each page printed), newest first. */
export function mergeHistory<T extends HistoryOrder>(local: readonly T[], cloud: readonly HistoryOrder[]): Array<T | HistoryOrder> {
  const seen = new Set(local.map((o) => o.localId));
  return [...local, ...cloud.filter((o) => !seen.has(o.localId))].sort(newestFirst);
}

/* ------------------------------------------------------------- item tickets */

/** One item-ticket print job of an order (print_jobs kind `ticket`): which ticket, how it went. */
export interface TicketJob {
  /** 1-based, and of how many; null on a job written before they were kept (0.5.5): their order is their index. */
  index: number | null;
  count: number | null;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  createdAt: number;
}

export type TicketState = 'sent' | 'queued' | 'failed';

export interface TicketStatus {
  index: number;
  count: number;
  state: TicketState;
  /** How many times it went to the printer (the first print and every reprint). */
  prints: number;
}

/** One ticket of the sale and its newest job (the first print, or the last reprint of it). */
export interface TicketSlot<J extends TicketJob = TicketJob> {
  index: number;
  count: number;
  latest: J;
  prints: number;
}

/** The sale's tickets by their index, each with its newest job; a job of 0.5.5 (no index) takes its place in order. */
export function ticketSlots<J extends TicketJob>(jobs: readonly J[]): Array<TicketSlot<J>> {
  const ordered = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  const legacy = ordered.filter((j) => j.index === null);
  const byIndex = new Map<number, { latest: J; prints: number; count: number }>();
  for (const j of ordered) {
    const index = j.index ?? legacy.indexOf(j) + 1;
    const count = j.count ?? legacy.length;
    const prev = byIndex.get(index);
    byIndex.set(index, { latest: j, prints: (prev?.prints ?? 0) + 1, count: Math.max(prev?.count ?? 0, count) });
  }
  const total = Math.max(0, ...[...byIndex.values()].map((v) => v.count), ...byIndex.keys());
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, v]) => ({ index, count: total, latest: v.latest, prints: v.prints }));
}

/**
 * Each ticket's state now: its newest job's — "נשלח למדפסת" (the queue sent it; "printed" is never claimed for a page no
 * printer confirmed), "בתור להדפסה" (queued or on its way), "לא הודפס" (the queue gave up after its tries).
 */
export function ticketStates(jobs: readonly TicketJob[]): TicketStatus[] {
  return ticketSlots(jobs).map((s) => ({
    index: s.index,
    count: s.count,
    state: s.latest.status === 'sent' ? 'sent' : s.latest.status === 'failed' ? 'failed' : 'queued',
    prints: s.prints,
  }));
}

/** Which tickets a reprint prints: every one, or only those that did not print ("רק מה שלא הודפס"). */
export function ticketsToReprint<J extends TicketJob>(jobs: readonly J[], only: 'all' | 'failed'): Array<TicketSlot<J>> {
  const slots = ticketSlots(jobs);
  return only === 'failed' ? slots.filter((s) => s.latest.status === 'failed') : slots;
}

/** The tickets that did not print: "רק מה שלא הודפס". */
export function failedTickets(states: readonly TicketStatus[]): number[] {
  return states.filter((s) => s.state === 'failed').map((s) => s.index);
}

export interface TicketSummary {
  total: number;
  sent: number;
  queued: number;
  failed: number;
}

export function ticketSummary(states: readonly TicketStatus[]): TicketSummary {
  return {
    total: states.length,
    sent: states.filter((s) => s.state === 'sent').length,
    queued: states.filter((s) => s.state === 'queued').length,
    failed: states.filter((s) => s.state === 'failed').length,
  };
}

/** A ticket's state in words. */
export function ticketStateText(state: TicketState): string {
  return state === 'sent' ? REPRINT_TEXT.ticketSent : state === 'queued' ? REPRINT_TEXT.ticketQueued : REPRINT_TEXT.ticketFailed;
}

/** "שוברים: 3 · לא הודפס 2/3" — a row's item tickets in a few words; null for an order with none. */
export function ticketsLine(states: readonly TicketStatus[]): string | null {
  const s = ticketSummary(states);
  if (s.total === 0) return null;
  if (s.failed > 0) return `${REPRINT_TEXT.ticketFailed}: ${states.filter((t) => t.state === 'failed').map((t) => `${t.index}/${t.count}`).join(', ')}`;
  if (s.queued > 0) return `${REPRINT_TEXT.ticketQueued} (${s.queued})`;
  return `${REPRINT_TEXT.ticketSent} (${s.total})`;
}

/* ---------------------------------------------------------------- the pages */

/** The bon's state in words (strings_kiosk_app.xml kapp_bon_*); a KDS order has none. */
export function bonText(o: Pick<HistoryOrder, 'fulfillmentMode' | 'bonStatus'>): string {
  if (o.fulfillmentMode === 'KDS') return 'מסך מטבח';
  switch (o.bonStatus) {
    case 'queued':
      return 'בתור להדפסה';
    case 'sent':
      return 'נשלח למדפסת';
    case 'printed':
      return 'הודפס';
    case 'failed':
      return 'לא הודפס';
    default:
      return 'ללא בון';
  }
}

/**
 * The receipt in words: its print job's state when one went to the printer, else the order's receipt status — the
 * customer said no ("לא ביקשו"), none by the kiosk's policy or for a sale settled later ("לא הודפסה").
 */
export function receiptText(jobs: ReadonlyArray<{ status: TicketJob['status']; createdAt: number }>, status: string | null | undefined): string {
  const last = [...jobs].sort((a, b) => a.createdAt - b.createdAt).pop();
  if (last) return last.status === 'sent' ? 'נשלחה למדפסת' : last.status === 'failed' ? 'לא הודפסה' : 'בתור להדפסה';
  if (status === 'declined') return 'לא ביקשו';
  if (status === 'failed') return 'לא הודפסה';
  return status === 'printed' ? 'נשלחה למדפסת' : 'לא הודפסה';
}

/** How a sale was paid, in a word or two ("אשראי ···4242", "מזומן", "שובר", "בקופה"); null when unknown. */
export function paymentText(doc: {
  card?: { last4?: string | null } | null;
  cash?: { splitAgorot?: number | null } | null;
  voucherLegs?: ReadonlyArray<unknown> | null;
  creditLegs?: ReadonlyArray<unknown> | null;
  payments?: ReadonlyArray<{ method: string }> | null;
} | null, cloud?: Pick<HistoryOrder, 'payAtTill' | 'voucherAgorot'>): string | null {
  if (!doc) {
    if (cloud?.payAtTill) return 'בקופה';
    if ((cloud?.voucherAgorot ?? 0) > 0) return 'שובר';
    return null;
  }
  const parts: string[] = [];
  const methods = new Set((doc.payments ?? []).map((p) => p.method));
  if (doc.cash || methods.has('cash')) parts.push('מזומן');
  if (doc.card || methods.has('card')) parts.push(doc.card?.last4 ? `אשראי ···${doc.card.last4}` : 'אשראי');
  if ((doc.voucherLegs?.length ?? 0) > 0 || methods.has('production_voucher')) parts.push('שובר');
  if ((doc.creditLegs?.length ?? 0) > 0 || methods.has('cash_credit')) parts.push('זיכוי');
  return parts.length > 0 ? parts.join(' + ') : 'ללא תשלום';
}

/* ------------------------------------------------------------ the record */

/** The cloud's "הדפסה חוזרת" event's details for one reprint (KioskReprint.eventDetails, TillEventRecorder.REPRINT). */
export function eventDetails(
  kind: ReprintKind,
  order: Pick<HistoryOrder, 'localId' | 'pickupLabel' | 'transactionNumber'>,
  approvedBy: string | null,
  approvedById: string | null,
  cornerManager: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind,
    source: 'kiosk_admin',
    orderId: order.localId,
    pickupLabel: order.pickupLabel,
    documentNumber: order.transactionNumber,
    approvedBy,
    approvedById,
    cornerManager,
    ...extra,
  };
}

/** One line of the menu's reprint log: what, of which sale, by whom, when (KioskReprintEntry). */
export interface ReprintEntry {
  atMs: number;
  businessDate: string;
  kind: ReprintKind;
  orderId: string;
  pickupLabel: string | null;
  documentNumber: string | null;
  by: string | null;
  /** Windows: the item tickets reprinted ("רק מה שלא הודפס": which), and whether it failed to queue. */
  tickets?: number[] | null;
  failed?: boolean;
}

export const LOG_KEEP = 300;

/** The kept log, oldest first; unreadable entries dropped (KioskReprintEntry.listOf). */
export function parseLog(json: string | null | undefined): ReprintEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ReprintEntry[] = [];
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (!REPRINT_KINDS.includes(o.kind as ReprintKind)) continue;
    out.push({
      atMs: typeof o.atMs === 'number' ? o.atMs : 0,
      businessDate: typeof o.businessDate === 'string' ? o.businessDate : '',
      kind: o.kind as ReprintKind,
      orderId: typeof o.orderId === 'string' ? o.orderId : '',
      pickupLabel: text(o.pickupLabel),
      documentNumber: text(o.documentNumber),
      by: text(o.by),
      ...(Array.isArray(o.tickets) ? { tickets: o.tickets.filter((n): n is number => typeof n === 'number') } : {}),
      ...(o.failed === true ? { failed: true } : {}),
    });
  }
  return out;
}

/** [log] with [entry] added, the last LOG_KEEP kept (KioskReprintEntry.append). */
export function appendLog(log: readonly ReprintEntry[], entry: ReprintEntry): string {
  return JSON.stringify([...log, entry].slice(-LOG_KEEP));
}
