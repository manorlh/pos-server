/**
 * "הזמנות להכנה" on the Windows till — the port of pos-android domain/ReadyOrders.kt (pos-server docs/SPEC_KDS.md §15) and
 * the words of ui/readyorders/ReadyOrdersScreen.kt / ReadyOrderMenu.kt:
 *
 *  - where the menu offers it ([readyOrdersOffered] — `ReadyOrders.offeredOn(KdsWorkflowConfig)`): the KDS workflow is on and
 *    a board or a kitchen screen is a target, or the order process is one of the modes;
 *  - the list as the cloud sends it (`GET /sync/{m}/kds/ready-orders`), the order's headline, which buttons each state offers,
 *    the three sections ("בהכנה", "מוכן לאיסוף", "נמסרו לאחרונה"), a tap shown before the cloud confirms it — never twice —,
 *    the minutes since it went to the kitchen by the cloud's clock;
 *  - a tap on the wire (`POST /sync/{m}/kds/ready-actions`, idempotent by its id), the cloud's answers and refusals in Hebrew;
 *  - an order's ⋮ elsewhere on the till (`GET kds/orders/status`): only what its state allows, in an order process only;
 *  - the view the screen draws ([readyOrdersView]).
 *
 * Pure.
 */

import { kdsWorkflowOf } from '../kitchen/kds';

/* ------------------------------------------------------------------ words */

/** pos-android res/values/strings_ready_orders.xml, word for word. */
export const READY_TEXT = {
  title: 'הזמנות להכנה',
  sectionWaiting: 'בהכנה',
  sectionReady: 'מוכן לאיסוף',
  sectionHanded: 'נמסרו לאחרונה',
  actionReady: 'מוכן',
  actionHandover: 'נמסר',
  actionUndo: 'החזר',
  retry: 'נסו שוב',
  discard: 'ביטול הסימון',
  sending: 'שולח…',
  loading: 'טוען הזמנות…',
  emptyTitle: 'אין הזמנות בהכנה',
  emptyBody: 'הזמנות שנשלחות להכנה יופיעו כאן. מסמנים "מוכן" כשההזמנה מוכנה, ו"נמסר" כשהלקוח קיבל אותה.',
  hasKds: 'יש מסכי מטבח בסניף — אפשר לסמן גם כאן',
  offline: 'אין חיבור לשרת — הרשימה אולי לא מעודכנת',
  failed: 'לא נשלח — אין חיבור לשרת. הלוח לא עודכן.',
  minutes: (n: number) => `${n} דק׳`,
  minutesNow: 'עכשיו',
  headlineTable: (t: string) => `שולחן ${t}`,
  sourceTable: 'שולחן',
  sourceQuick: 'קופה',
  sourceKiosk: 'קיוסק',
  sourceExternal: 'הזמנה חיצונית',
  serviceEatIn: 'לשבת',
  serviceTakeAway: 'לקחת',
  noItems: 'ללא פריטים',
  close: 'סגירה',
  dismiss: 'סגירת ההודעה',
  doneReady: 'ההזמנה סומנה כמוכנה',
  doneHandover: 'ההזמנה סומנה כנמסרה',
  doneUndo: 'ההזמנה הוחזרה שלב אחד',
  offlineTitle: 'הפעולה לא נשלחה',
  offlineBody: 'אין חיבור לשרת. אפשר לנסות שוב — הפעולה תירשם פעם אחת בלבד.',
  refusedTitle: 'הפעולה לא בוצעה',
  msg: {
    not_order_process: 'ההזמנה לא נמצאת בתהליך הכנה, ואין לה סימון מוכן',
    already_handed_over: 'ההזמנה כבר נמסרה',
    cancelled: 'ההזמנה בוטלה',
    order_not_found: 'ההזמנה לא נמצאה בסניף',
    not_a_till: 'המכשיר הזה אינו קופה — אי אפשר לסמן ממנו הזמנות',
    device_not_fiscal: 'מכשיר תצוגה אינו קופה — אי אפשר לסמן ממנו הזמנות',
    no_shop: 'הקופה לא משויכת לסניף',
    area_locked: 'ההזמנה שייכת לנקודת מכירה אחרת',
    refused: 'השרת דחה את הפעולה',
  },
} as const;

/* ------------------------------------------------------------------ the model */

/** Where the order's fulfillment group is (the cloud's `groupState`). */
export type ReadyGroup = 'waiting' | 'ready_for_pickup' | 'handed_over';
const GROUPS: readonly ReadyGroup[] = ['waiting', 'ready_for_pickup', 'handed_over'];

/** A tap: "מוכן", "נמסר", or "החזר" (back one step). The wire's `type`. */
export type ReadyAction = 'ready' | 'handover' | 'undo';
export const READY_ACTIONS: readonly ReadyAction[] = ['ready', 'handover', 'undo'];

export type ReadySource = 'table' | 'quick' | 'kiosk' | 'external' | 'other';
export type ReadyService = 'eat_in' | 'take_away';

export interface ReadyItem {
  name: string;
  qty: number;
  ready: boolean;
}

export interface ReadyOrder {
  orderId: string;
  source: ReadySource;
  sourceRef: string | null;
  displayRef: string | null;
  pickupNumber: number | null;
  tableRef: string | null;
  service: ReadyService | null;
  pickupName: string | null;
  group: ReadyGroup;
  status: string | null;
  trackHandover: boolean;
  firstReleasedAt: string | null;
  readyAt: string | null;
  handedOverAt: string | null;
  machineId: string | null;
  areaId: string | null;
  items: ReadyItem[];
  /** A kiosk order's label as its slip printed it ("A-17"); null for any other. */
  pickupLabel: string | null;
}

export interface ReadyOrdersList {
  serverTime: string | null;
  /** A station / expo / manager screen works in the shop: the till's list is a backup there. */
  hasKds: boolean;
  hasBoard: boolean;
  orders: ReadyOrder[];
}

/** A tap the cloud has not confirmed yet ([id]: the idempotency key, the same on a retry). */
export interface ReadyPending {
  id: string;
  action: ReadyAction;
  orderId: string;
  from: ReadyGroup;
  /** No answer (no network, a timeout, a server fault): "נסו שוב" with the same id. */
  failed: boolean;
}

export type ReadyMessage = keyof (typeof READY_TEXT)['msg'];

export type ReadyOutcome = { kind: 'done' } | { kind: 'rejected'; message: ReadyMessage };

export type HeadlineKind = 'pickup_number' | 'display_ref' | 'table' | 'short_id';

/* ------------------------------------------------------------------ where it is offered */

function csv(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map((x) => x.trim().replace(/^[[\]"\s]+|[[\]"\s]+$/g, ''))
    .filter(Boolean);
}

function modeOf(v: unknown): 'DIRECT_SALE' | 'ORDER_PROCESS' | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return s === 'DIRECT_SALE' || s === 'ORDER_PROCESS' ? s : null;
}

const SCREEN_TARGETS = new Set(['kds', 'kds_view', 'expo', 'pickup_screen']);

/**
 * `ReadyOrders.offeredOn(KdsWorkflowConfig.of(params))`: orders reach the kitchen engine in an order process — a board or a
 * kitchen screen is a target, or the order process is one of the modes (the default mode counts as allowed).
 */
export function readyOrdersOffered(params: Record<string, unknown>): boolean {
  const wf = kdsWorkflowOf(params);
  if (!wf.enabled) return false;
  const allowed = csv(params.workflowAllowedModes)
    .map(modeOf)
    .filter((m): m is 'DIRECT_SALE' | 'ORDER_PROCESS' => m !== null);
  const dflt = modeOf(params.workflowMode) ?? allowed[0] ?? 'DIRECT_SALE';
  const usesScreens = wf.targets.some((t) => SCREEN_TARGETS.has(t)) || dflt === 'ORDER_PROCESS';
  return usesScreens || allowed.includes('ORDER_PROCESS');
}

/* ------------------------------------------------------------------ the list */

function text(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null || v === undefined) return null;
  const s = (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').trim();
  return s.length > 0 ? s : null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function groupOf(code: unknown): ReadyGroup | null {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
  return (GROUPS as readonly string[]).includes(c) ? (c as ReadyGroup) : null;
}

export function sourceOf(code: unknown): ReadySource {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
  return c === 'table' || c === 'quick' || c === 'kiosk' || c === 'external' ? c : 'other';
}

export function serviceOf(code: unknown): ReadyService | null {
  const c = typeof code === 'string' ? code.trim().toLowerCase() : '';
  return c === 'eat_in' || c === 'take_away' ? c : null;
}

/** One order; null without an id or with a state this till does not know (a missing state is the cloud's default). */
export function parseReadyOrder(raw: unknown): ReadyOrder | null {
  const o = obj(raw);
  if (!o) return null;
  const orderId = text(o, 'orderId');
  if (!orderId) return null;
  const g = text(o, 'groupState');
  const group = g === null ? 'waiting' : groupOf(g);
  if (!group) return null;
  let pickupNumber: number | null = null;
  if (o.pickupNumber !== null && o.pickupNumber !== undefined) {
    const n = typeof o.pickupNumber === 'number' ? Math.trunc(o.pickupNumber) : /^-?\d+$/.test(String(o.pickupNumber).trim()) ? Number(String(o.pickupNumber).trim()) : NaN;
    pickupNumber = Number.isFinite(n) ? n : null;
  }
  const items: ReadyItem[] = (Array.isArray(o.items) ? o.items : [])
    .map((x) => {
      const it = obj(x);
      const name = it ? text(it, 'name') : null;
      if (!it || !name) return null;
      const q = typeof it.qty === 'number' && Number.isFinite(it.qty) ? it.qty : typeof it.qty === 'string' && Number.isFinite(Number(it.qty)) && it.qty.trim() !== '' ? Number(it.qty) : 1;
      return { name, qty: q, ready: it.ready === true };
    })
    .filter((x): x is ReadyItem => x !== null);
  return {
    orderId,
    source: sourceOf(o.source),
    sourceRef: text(o, 'sourceRef'),
    displayRef: text(o, 'displayRef'),
    pickupNumber,
    tableRef: text(o, 'tableRef'),
    service: serviceOf(o.serviceType),
    pickupName: text(o, 'pickupName'),
    group,
    status: text(o, 'status'),
    trackHandover: o.trackHandover === null || o.trackHandover === undefined ? true : o.trackHandover !== false,
    firstReleasedAt: text(o, 'firstReleasedAt'),
    readyAt: text(o, 'readyAt'),
    handedOverAt: text(o, 'handedOverAt'),
    machineId: text(o, 'machineId'),
    areaId: text(o, 'areaId'),
    items,
    pickupLabel: text(o, 'pickupLabel'),
  };
}

/** `GET kds/ready-orders`. Anything missing reads as null / the default. */
export function parseReadyOrders(body: unknown): ReadyOrdersList {
  const o = obj(body) ?? {};
  return {
    serverTime: text(o, 'serverTime'),
    hasKds: o.hasKds === true,
    hasBoard: o.hasBoard === true,
    orders: (Array.isArray(o.orders) ? o.orders : []).map(parseReadyOrder).filter((x): x is ReadyOrder => x !== null),
  };
}

/** The row's big text: a kiosk's label as its slip printed it, else the pickup number, the order's ref, the table, a short id. */
export function headline(order: ReadyOrder): { kind: HeadlineKind; text: string } {
  if (order.pickupLabel?.trim()) return { kind: 'pickup_number', text: order.pickupLabel.trim() };
  if (order.pickupNumber !== null) return { kind: 'pickup_number', text: String(order.pickupNumber) };
  if (order.displayRef?.trim()) return { kind: 'display_ref', text: order.displayRef.trim() };
  if (order.tableRef?.trim()) return { kind: 'table', text: order.tableRef.trim() };
  return { kind: 'short_id', text: order.orderId.slice(0, 6).toUpperCase() };
}

/** The order's own ref beside a pickup number (what the receipt says), when it has one. */
export function secondaryRef(order: ReadyOrder): string | null {
  const r = order.displayRef?.trim();
  return r && headline(order).kind === 'pickup_number' ? r : null;
}

/** "מוכן" while in preparation; "נמסר" and "החזר" once ready; "החזר" once handed over. */
export function actionsFor(group: ReadyGroup): ReadyAction[] {
  if (group === 'waiting') return ['ready'];
  if (group === 'ready_for_pickup') return ['handover', 'undo'];
  return ['undo'];
}

/** Where a tap takes the order. */
export function after(group: ReadyGroup, action: ReadyAction): ReadyGroup {
  if (action === 'ready') return group === 'waiting' ? 'ready_for_pickup' : group;
  if (action === 'handover') return group === 'ready_for_pickup' ? 'handed_over' : group;
  if (group === 'handed_over') return 'ready_for_pickup';
  return 'waiting';
}

/** [order] after [action]: "מוכן" also marks every item ready (the till has no stations). */
export function applyAction(order: ReadyOrder, action: ReadyAction): ReadyOrder {
  const next = after(order.group, action);
  if (next === order.group) return order;
  return { ...order, group: next, items: action === 'ready' ? order.items.map((i) => ({ ...i, ready: true })) : order.items };
}

/** The cloud's list with this till's unconfirmed taps shown — only while the cloud still has the order where it was tapped. */
export function withPending(orders: readonly ReadyOrder[], pending: ReadonlyMap<string, ReadyPending> | Record<string, ReadyPending>): ReadyOrder[] {
  const get = (id: string): ReadyPending | undefined => (pending instanceof Map ? pending.get(id) : (pending as Record<string, ReadyPending>)[id]);
  return orders.map((o) => {
    const p = get(o.orderId);
    return p && o.group === p.from ? applyAction(o, p.action) : o;
  });
}

/** The three sections, each oldest first. */
export function sections(orders: readonly ReadyOrder[]): { waiting: ReadyOrder[]; ready: ReadyOrder[]; handedOver: ReadyOrder[] } {
  const of = (g: ReadyGroup) =>
    orders
      .map((o, i) => ({ o, i }))
      .filter((x) => x.o.group === g)
      .sort((a, b) => {
        const x = a.o.firstReleasedAt ?? '';
        const y = b.o.firstReleasedAt ?? '';
        return x < y ? -1 : x > y ? 1 : a.i - b.i;
      })
      .map((x) => x.o);
  return { waiting: of('waiting'), ready: of('ready_for_pickup'), handedOver: of('handed_over') };
}

/* ------------------------------------------------------------------ time */

function epochMs(iso: string | null): number | null {
  if (!iso) return null;
  // Python's micro-seconds ("…00.000000+00:00"): milliseconds are enough.
  const s = iso.trim().replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** How far the cloud's clock is ahead of this till's, from its `serverTime` received at [receivedAtMs]. */
export function skewMs(serverTime: string | null, receivedAtMs: number): number {
  const server = epochMs(serverTime);
  return server === null ? 0 : server - receivedAtMs;
}

/** Whole minutes since [iso] by the cloud's clock (never negative); null without a stamp. */
export function minutesSince(iso: string | null, nowMs: number, skew = 0): number | null {
  const at = epochMs(iso);
  if (at === null) return null;
  return Math.max(0, Math.floor((nowMs + skew - at) / 60_000));
}

/* ------------------------------------------------------------------ a tap */

/** `POST kds/ready-actions`: [id] is a new UUID per tap and stays the same on a retry. */
export function actionBody(id: string, action: ReadyAction, orderId: string, actorName: string | null, occurredAt: string | null): Record<string, unknown> {
  return { id, type: action, orderId, actorName: actorName?.trim() ? actorName.trim() : null, occurredAt: occurredAt ?? null };
}

/** A `rejected` outcome's `reason`. */
export function reasonMessage(reason: unknown): ReadyMessage {
  const r = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (r === 'not_order_process') return 'not_order_process';
  if (r === 'group_handed_over') return 'already_handed_over';
  if (r === 'group_cancelled') return 'cancelled';
  return 'refused';
}

/** The answer of a 2xx: `applied` and `noop` (and a replay) are done; `rejected` says why. */
export function outcomeOf(body: unknown): ReadyOutcome {
  const o = obj(body) ?? {};
  const outcome = typeof o.outcome === 'string' ? o.outcome.toLowerCase() : '';
  return outcome === 'rejected' ? { kind: 'rejected', message: reasonMessage(o.reason) } : { kind: 'done' };
}

/** The `detail` code of a refusal (a string, or `{code}`). */
export function refusalCode(body: unknown): string | null {
  const d = obj(body)?.detail;
  if (typeof d === 'string') return d || null;
  const c = obj(d)?.code;
  return typeof c === 'string' && c ? c : null;
}

/** A refusal (4xx) of either call, by its `detail` code. */
export function refusalMessage(status: number, code: string | null): ReadyMessage {
  switch ((code ?? '').trim().toLowerCase()) {
    case 'order_not_found':
      return 'order_not_found';
    case 'not_a_till':
      return 'not_a_till';
    case 'device_not_fiscal':
      return 'device_not_fiscal';
    case 'machine_has_no_shop':
      return 'no_shop';
    case 'not_order_process':
      return 'not_order_process';
    case 'group_handed_over':
      return 'already_handed_over';
    case 'group_cancelled':
      return 'cancelled';
    case 'area_locked':
      return 'area_locked';
    default:
      return status === 404 ? 'order_not_found' : 'refused';
  }
}

/** Refusals of the list itself that no retry fixes: the screen says so instead of an empty list. */
export function blocksList(m: ReadyMessage): boolean {
  return m === 'not_a_till' || m === 'device_not_fiscal' || m === 'no_shop';
}

export function actionLabel(a: ReadyAction): string {
  return a === 'ready' ? READY_TEXT.actionReady : a === 'handover' ? READY_TEXT.actionHandover : READY_TEXT.actionUndo;
}

/** The toast after a tap from an order's ⋮. */
export function doneText(a: ReadyAction): string {
  return a === 'ready' ? READY_TEXT.doneReady : a === 'handover' ? READY_TEXT.doneHandover : READY_TEXT.doneUndo;
}

/* ------------------------------------------------------------------ the order's ⋮ elsewhere */

export interface ReadyOrderRef {
  orderId: string;
  group: ReadyGroup | null;
  workflowMode: string | null;
}

/** One ref of `GET kds/orders/status` (`orders[ref]`); null when the kitchen does not have it. */
export function statusOf(body: unknown, ref: string): ReadyOrderRef | null {
  const o = obj(obj(obj(body)?.orders)?.[ref]);
  if (!o) return null;
  const orderId = text(o, 'orderId');
  if (!orderId) return null;
  return { orderId, group: groupOf(o.groupState), workflowMode: text(o, 'workflowMode') };
}

/** The ⋮ items of that order: only in an order process, only those its state allows. */
export function menuActions(ref: ReadyOrderRef | null): ReadyAction[] {
  if (!ref) return [];
  if (ref.workflowMode !== null && ref.workflowMode.toUpperCase() !== 'ORDER_PROCESS') return [];
  return ref.group ? actionsFor(ref.group) : [];
}

/* ------------------------------------------------------------------ the view */

/** "2" / "1.50" (Android `receiptQty`). */
export function qtyText(q: number): string {
  return q % 1 === 0 ? String(Math.trunc(q)) : q.toFixed(2);
}

function sourceText(s: ReadySource): string | null {
  return s === 'table' ? READY_TEXT.sourceTable : s === 'quick' ? READY_TEXT.sourceQuick : s === 'kiosk' ? READY_TEXT.sourceKiosk : s === 'external' ? READY_TEXT.sourceExternal : null;
}

export interface ReadyRowView {
  orderId: string;
  headline: string;
  /** The headline is a number / ref (drawn left-to-right inside the Hebrew). */
  headlineLtr: boolean;
  minutes: string | null;
  /** "קיוסק · לקחת · דנה · 20000057". */
  meta: string;
  items: Array<{ text: string; ready: boolean }>;
  handed: boolean;
  /** What the row's foot shows: its buttons, "שולח…", or "לא נשלח" with "נסו שוב" / "ביטול הסימון". */
  mode: 'actions' | 'sending' | 'failed';
  actions: Array<{ action: ReadyAction; label: string; primary: boolean }>;
}

export interface ReadySectionView {
  key: 'waiting' | 'ready' | 'handed';
  title: string;
  count: number;
  rows: ReadyRowView[];
}

/** `TillState.readyOrders` — what ReadyOrdersScreen draws. */
export interface ReadyOrdersState {
  /** The first answer (or failure) is in: until then "טוען הזמנות…". */
  loaded: boolean;
  /** The last poll had no answer: the list shown is the last one. */
  offline: boolean;
  /** The cloud refuses this device the list: said instead of a list. */
  blocked: string | null;
  hasKds: boolean;
  /** A refused tap, said once at the top (dismissible). */
  notice: string | null;
  empty: boolean;
  sections: ReadySectionView[];
}

/** Rows drawn per section (the cloud keeps the list short; a flood never freezes a Celeron). */
export const READY_ROWS_CAP = 80;

export function rowView(order: ReadyOrder, pending: ReadyPending | undefined, nowMs: number, skew: number): ReadyRowView {
  const h = headline(order);
  const m = minutesSince(order.firstReleasedAt, nowMs, skew);
  const meta = [sourceText(order.source), order.service === 'eat_in' ? READY_TEXT.serviceEatIn : order.service === 'take_away' ? READY_TEXT.serviceTakeAway : null, order.pickupName, secondaryRef(order)]
    .filter((x): x is string => !!x)
    .join(' · ');
  return {
    orderId: order.orderId,
    headline: h.kind === 'table' ? READY_TEXT.headlineTable(h.text) : h.text,
    headlineLtr: h.kind !== 'table',
    minutes: m === null ? null : m < 1 ? READY_TEXT.minutesNow : READY_TEXT.minutes(m),
    meta,
    items: order.items.map((i) => ({ text: `${qtyText(i.qty)} × ${i.name}`, ready: i.ready })),
    handed: order.group === 'handed_over',
    mode: pending?.failed ? 'failed' : pending ? 'sending' : 'actions',
    actions: actionsFor(order.group).map((a) => ({ action: a, label: actionLabel(a), primary: a !== 'undo' })),
  };
}

export function readyOrdersView(o: {
  list: ReadyOrdersList | null;
  loaded: boolean;
  offline: boolean;
  blocked: ReadyMessage | null;
  pending: ReadonlyMap<string, ReadyPending>;
  notice: ReadyMessage | null;
  nowMs: number;
  skewMs: number;
}): ReadyOrdersState {
  const orders = withPending(o.list?.orders ?? [], o.pending);
  const s = sections(orders);
  const sec = (key: ReadySectionView['key'], title: string, list: ReadyOrder[]): ReadySectionView => ({
    key,
    title,
    count: list.length,
    rows: list.slice(0, READY_ROWS_CAP).map((x) => rowView(x, o.pending.get(x.orderId), o.nowMs, o.skewMs)),
  });
  const all = [sec('waiting', READY_TEXT.sectionWaiting, s.waiting), sec('ready', READY_TEXT.sectionReady, s.ready), sec('handed', READY_TEXT.sectionHanded, s.handedOver)];
  return {
    loaded: o.loaded,
    offline: o.offline,
    blocked: o.blocked ? READY_TEXT.msg[o.blocked] : null,
    hasKds: o.list?.hasKds === true,
    notice: o.notice ? READY_TEXT.msg[o.notice] : null,
    empty: orders.length === 0,
    sections: all.filter((x) => x.count > 0),
  };
}
