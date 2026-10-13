/**
 * The kitchen screen's layouts (docs/SPEC_KDS.md §14) — which card goes where, pure (tested in
 * kdsLayouts.test.ts; the screens draw it in kiosk-shared/roles/kds/layouts.tsx):
 *
 *  - "tickets": today's cards in balanced columns (kdsBoard.ts `layoutColumns`);
 *  - "columns": a lane per station (or per course), each with that lane's items of every order, and
 *    on the Expo / manager screen a last lane "לאיסוף" with the orders whose items are all ready;
 *  - "rail":    one row of cards in time order (the oldest at the start of the reading direction);
 *  - "list":    a dense row per order (the Expo / a manager's screen);
 *  - "big":     the first few cards large, the rest waiting in a strip.
 *
 * Shared by the Windows app and the browser KDS; self-contained (no `@/` imports).
 */

import type { KdsBehaviour, KdsField, KdsOrder, KdsOrderType, KdsTask } from './kdsScreenTypes';
import {
  epochMs,
  hasWork,
  isCancelled,
  isFinished,
  isHeld,
  isLive,
  isReady,
  openTasks,
  qtyText,
  remaining,
  screenOf,
  type KdsButton,
  type KdsScreenRole,
} from './kdsBoard';

/* -------------------------------------------------------------------- lanes */

export type LaneKind = 'station' | 'course' | 'pickup';

export interface LaneEntry {
  order: KdsOrder;
  /** The order's items in this lane (live, released); none in the pickup lane. */
  tasks: KdsTask[];
}

export interface Lane {
  key: string;
  kind: LaneKind;
  title: string;
  stationId: string | null;
  entries: LaneEntry[];
  /** Items still to prepare in the lane (its header's count). */
  open: number;
}

export const NO_STATION = 'ללא תחנה';
export const NO_COURSE = 'כללי';
export const PICKUP_LANE = 'לאיסוף';

/** Live, released items (held and cancelled ones stay on the card, not in a lane). */
function laneTasks(order: KdsOrder): KdsTask[] {
  return order.tasks.filter((t) => isLive(t));
}

/** In the lane until every one of its items is ready; a lane's finished orders go to its end. */
function sortEntries(entries: LaneEntry[]): LaneEntry[] {
  const open = (e: LaneEntry) => (e.tasks.some((t) => !isReady(t)) ? 0 : 1);
  return entries.map((e, i) => ({ e, i })).sort((a, b) => open(a.e) - open(b.e) || a.i - b.i).map((x) => x.e);
}

/**
 * The lanes of the "columns" layout, from the screen's cards (already in screen order). By station:
 * the device's stations first (in its order), then any other station the cards name, then "ללא
 * תחנה" — a station screen with one station is split by course instead (one lane says nothing). By
 * course: in the order the courses first appear. The Expo and the manager get "לאיסוף" last.
 */
export function lanesOf(
  cards: readonly KdsOrder[],
  by: 'station' | 'course',
  role: KdsScreenRole,
  deviceStations: ReadonlyArray<{ id: string; name: string }> = [],
): Lane[] {
  const pickupLane = role !== 'station';
  // Ready orders on the Expo go to "לאיסוף", not to the work lanes.
  const working = pickupLane ? cards.filter((o) => !inPickupLane(o)) : [...cards];
  const stationIds = new Set<string>();
  for (const o of working) for (const t of laneTasks(o)) if (t.stationId) stationIds.add(t.stationId);
  const effective = by === 'station' && role === 'station' && deviceStations.length <= 1 && stationIds.size <= 1 ? 'course' : by;

  const order: string[] = [];
  const meta = new Map<string, { kind: LaneKind; title: string; stationId: string | null }>();
  const add = (key: string, m: { kind: LaneKind; title: string; stationId: string | null }) => {
    if (!meta.has(key)) {
      meta.set(key, m);
      order.push(key);
    }
  };
  const keyOf = (t: KdsTask): string => (effective === 'station' ? `s:${t.stationId ?? ''}` : `c:${t.course ?? ''}`);
  if (effective === 'station') for (const s of deviceStations) if (stationIds.has(s.id)) add(`s:${s.id}`, { kind: 'station', title: s.name, stationId: s.id });
  const buckets = new Map<string, LaneEntry[]>();
  for (const o of working) {
    const byLane = new Map<string, KdsTask[]>();
    for (const t of laneTasks(o)) {
      const key = keyOf(t);
      if (effective === 'station') add(key, { kind: 'station', title: t.stationName ?? (t.stationId ? '—' : NO_STATION), stationId: t.stationId });
      else add(key, { kind: 'course', title: t.course ?? NO_COURSE, stationId: null });
      byLane.set(key, [...(byLane.get(key) ?? []), t]);
    }
    for (const [key, tasks] of byLane) buckets.set(key, [...(buckets.get(key) ?? []), { order: o, tasks }]);
  }
  // "ללא תחנה" / "כללי" last among the work lanes.
  const rest = order.filter((k) => k === 's:' || k === 'c:');
  const keys = [...order.filter((k) => k !== 's:' && k !== 'c:'), ...rest];
  const lanes: Lane[] = keys.map((key) => {
    const m = meta.get(key)!;
    const entries = sortEntries(buckets.get(key) ?? []);
    return { key, ...m, entries, open: entries.reduce((n, e) => n + e.tasks.filter((t) => !isReady(t)).length, 0) };
  });
  if (pickupLane) {
    const ready = cards.filter(inPickupLane).map((o) => ({ order: o, tasks: [] as KdsTask[] }));
    lanes.push({ key: 'pickup', kind: 'pickup', title: PICKUP_LANE, stationId: null, entries: ready, open: ready.length });
  }
  return lanes;
}

/** An Expo's order that waits only for "מוכן לאיסוף" / "נמסר": every item ready, or already ready for pickup. */
export function inPickupLane(o: KdsOrder): boolean {
  if (o.viewOnly || isFinished(o)) return false;
  if (o.groupState === 'ready_for_pickup') return true;
  return openTasks(o).length === 0 && o.tasks.some((t) => isLive(t)) && !hasPendingWork(o);
}

function hasPendingWork(o: KdsOrder): boolean {
  return o.changes.some((c) => c.requiresAck && !c.acked) || o.tasks.some((t) => !!t.fallbackPrinted && !t.fallbackResolved && !isCancelled(t));
}

/**
 * The lane's "הכול מוכן": a station lane — that station's `station_ready`; a course lane — every
 * open item of the course ("התחל" first where the order requires a start). Null when nothing is left.
 */
export function laneButton(order: KdsOrder, lane: Pick<Lane, 'kind' | 'stationId' | 'key'>, tasks: readonly KdsTask[]): KdsButton | null {
  if (isFinished(order) || lane.kind === 'pickup') return null;
  const open = tasks.filter((t) => isLive(t) && !isReady(t) && !(t.fallbackPrinted && !t.fallbackResolved));
  if (open.length === 0) return null;
  const key = `lane:${lane.key}:${order.id}`;
  const queued = open.filter((t) => t.state === 'queued');
  if (order.requireStart && queued.length > 0) {
    return { key, label: queued.length === open.length ? 'התחל הכול' : `התחל (${queued.length})`, tone: 'start', actions: queued.map((t) => ({ type: 'start' as const, taskId: t.id })), primary: true };
  }
  if (lane.kind === 'station' && lane.stationId) {
    return { key, label: 'הכול מוכן', tone: 'ready', actions: [{ type: 'station_ready', orderId: order.id, stationId: lane.stationId }], primary: true };
  }
  return { key, label: 'הכול מוכן', tone: 'ready', actions: open.map((t) => ({ type: 'item_ready' as const, taskId: t.id })), primary: true };
}

/* --------------------------------------------------------------------- rail */

/** The rail's order: by time only (the oldest first; `lifo` — the newest); on a station, what is done goes to the end. */
export function railOrder(cards: readonly KdsOrder[], role: KdsScreenRole, lifo = false): KdsOrder[] {
  const at = (o: KdsOrder) => epochMs(o.firstReleasedAt ?? o.createdAt) ?? Number.MAX_SAFE_INTEGER;
  const done = (o: KdsOrder) => (role === 'station' && !hasWork(o) ? 1 : 0);
  return [...cards].sort((a, b) => done(a) - done(b) || (lifo ? at(b) - at(a) : at(a) - at(b)) || a.id.localeCompare(b.id));
}

/* --------------------------------------------------------------------- list */

export interface SummaryPart {
  /** "2 × המבורגר (גבינה · בלי בצל · בצד)". */
  text: string;
  /** "אלרגיה: גלוטן" — drawn apart, in red; null when none (or the screen hides allergens). */
  allergyText: string | null;
  done: boolean;
  allergy: boolean;
  note: boolean;
}

/**
 * The list row's items in one line: "2 × המבורגר" per live item (ready ones marked done), what the
 * screen shows of it (modifiers, notes, allergies — by the screen's fields), held items not listed.
 */
export function itemsSummary(order: KdsOrder, fields: Partial<Record<KdsField, boolean>> = {}): SummaryPart[] {
  const show = (f: KdsField) => fields[f] !== false;
  return order.tasks
    .filter((t) => !isHeld(t) && !isCancelled(t))
    .map((t) => {
      const extra: string[] = [];
      if (show('modifiers')) {
        extra.push(...t.mods);
        extra.push(...t.removals.map((r) => `בלי ${r}`));
      }
      if (show('notes') && t.notes) extra.push(t.notes);
      const allergy = show('allergens') && t.allergies.length > 0;
      return {
        text: `${qtyText(t.activeQty)} × ${t.name}${extra.length ? ` (${extra.join(' · ')})` : ''}`,
        allergyText: allergy ? `אלרגיה: ${t.allergies.join(', ')}` : null,
        done: isReady(t),
        allergy,
        note: show('notes') && !!t.notes,
      };
    });
}

/* ---------------------------------------------------------------------- big */

/** How many big cards fit: three on a landscape screen, two on a narrow / portrait one, one on a phone. */
export function bigCapacity(width: number, height: number): number {
  if (!Number.isFinite(width) || width <= 0) return 3;
  if (width < 700) return 1;
  if (width < 1200 || height > width) return 2;
  return 3;
}

/** The big cards and the ones waiting behind them (the strip). */
export function bigSplit<T>(cards: readonly T[], capacity: number): { shown: T[]; queue: T[] } {
  const n = Math.max(1, capacity);
  return { shown: cards.slice(0, n), queue: cards.slice(n) };
}

/* ------------------------------------- what the screen shows (docs/SPEC_KDS.md §16) */

/** An order's type as the filters know it: a table's without one is eaten in; none = always shown. */
export function orderTypeOf(o: Pick<KdsOrder, 'serviceType' | 'source'>): KdsOrderType | null {
  if (o.serviceType === 'eat_in') return 'eatIn';
  if (o.serviceType === 'take_away') return 'takeAway';
  if (o.serviceType === 'delivery') return 'delivery';
  return o.source === 'table' ? 'eatIn' : null;
}

/** Whether the screen's filters let the order on: its type (`orderTypes`) and external orders (`externalOrders`). */
export function passesFilters(o: KdsOrder, b: Pick<KdsBehaviour, 'orderTypes' | 'externalOrders'>): boolean {
  const external = o.source === 'external';
  if (b.externalOrders === 'hide' && external) return false;
  if (b.externalOrders === 'only' && !external) return false;
  const type = orderTypeOf(o);
  return type === null || b.orderTypes[type] !== false;
}

/** The ticket header's band (`serviceTint`): take away / delivery, or none. */
export function tintOf(o: Pick<KdsOrder, 'serviceType' | 'source'>, b: Pick<KdsBehaviour, 'serviceTint'>): 'takeAway' | 'delivery' | null {
  const type = orderTypeOf(o);
  if (type === 'takeAway' && b.serviceTint.takeAway) return 'takeAway';
  if (type === 'delivery' && b.serviceTint.delivery) return 'delivery';
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The same item by name (the "להכנה" panel's key). */
export function sameItem(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export interface AllDayItem {
  name: string;
  /** Still to prepare, over every card. */
  qty: number;
  /** On how many cards. */
  orders: number;
}

/** "להכנה": every item still to prepare on the cards (live, released, not ready), by name A–Z, with how many are left. */
export function allDayCounts(cards: readonly KdsOrder[]): AllDayItem[] {
  const by = new Map<string, { name: string; qty: number; orders: Set<string> }>();
  for (const o of cards) {
    for (const t of openTasks(o)) {
      const key = norm(t.name);
      if (!key) continue;
      const e = by.get(key) ?? { name: t.name.trim(), qty: 0, orders: new Set<string>() };
      e.qty += remaining(t);
      e.orders.add(o.id);
      by.set(key, e);
    }
  }
  return [...by.values()]
    .filter((e) => e.qty > 1e-6)
    .map((e) => ({ name: e.name, qty: Math.round(e.qty * 1000) / 1000, orders: e.orders.size }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

/** "חיפוש פריט": the panel's items whose name has the text. */
export function searchItems(items: readonly AllDayItem[], text: string): AllDayItem[] {
  const q = norm(text);
  return q ? items.filter((i) => norm(i.name).includes(q)) : [...items];
}

/** Filtering by an item: the cards on which it is still to prepare. */
export function cardsWithItem(cards: readonly KdsOrder[], name: string): KdsOrder[] {
  return cards.filter((o) => openTasks(o).some((t) => sameItem(t.name, name)));
}

/**
 * Nothing left for this screen to do on the card (§16 "בון נשאר פתוח"): a station — no work left;
 * the Expo — ready for pickup without handover tracking (the pickup screen holds the number).
 */
export function isDoneCard(o: KdsOrder, role: KdsScreenRole): boolean {
  if (hasWork(o)) return false;
  if (role === 'station') return true;
  return o.groupState === 'ready_for_pickup' && !o.trackHandover && !o.pending;
}

/** "מוכנות": the cards whose items are all ready (a station's done cards; the Expo's "לאיסוף"). */
export function isReadyCard(o: KdsOrder, role: KdsScreenRole): boolean {
  if (role === 'station') return openTasks(o).length === 0 && o.tasks.some((t) => isLive(t));
  return inPickupLane(o);
}

/** `keepReadyOpen` off: the done cards leave the screen at once (they are in the history). */
export function splitDone(cards: readonly KdsOrder[], role: KdsScreenRole, keep: boolean): { cards: KdsOrder[]; gone: KdsOrder[] } {
  if (keep) return { cards: [...cards], gone: [] };
  const out: KdsOrder[] = [];
  const gone: KdsOrder[] = [];
  for (const o of cards) (isDoneCard(o, role) ? gone : out).push(o);
  return { cards: out, gone };
}

/** "השהה": the cards that were on the screen when it paused stay (and update); the new ones wait. */
export function pausedView(cards: readonly KdsOrder[], shown: ReadonlySet<string> | null): { cards: KdsOrder[]; waiting: number } {
  if (!shown) return { cards: [...cards], waiting: 0 };
  const keep = cards.filter((o) => shown.has(o.id));
  return { cards: keep, waiting: cards.length - keep.length };
}

/** Overflow (`overflowAt`): more cards than this and the screen switches to the dense list. */
export function overflowing(count: number, overflowAt: number | null): boolean {
  return overflowAt !== null && overflowAt > 0 && count > overflowAt;
}

export interface HistoryEntry {
  order: KdsOrder;
  /** When it was first seen done (epoch ms). */
  at: number;
}

export const HISTORY_KEEP_MS = 30 * 60_000;
export const HISTORY_MAX = 40;

/**
 * The history (§16): the orders that finished on this screen in the last half hour, each in its last
 * known state (the cloud stops sending a station's ready items after a few minutes). `done`: the
 * finished orders seen now; `active`: the ids that have work again (they leave the history).
 */
export function nextHistory(
  prev: ReadonlyMap<string, HistoryEntry>,
  done: readonly KdsOrder[],
  active: ReadonlySet<string>,
  nowMs: number,
  keepMs = HISTORY_KEEP_MS,
  max = HISTORY_MAX,
): Map<string, HistoryEntry> {
  const next = new Map<string, HistoryEntry>();
  for (const [id, e] of prev) if (!active.has(id) && nowMs - e.at <= keepMs) next.set(id, e);
  for (const o of done) if (!active.has(o.id)) next.set(o.id, { order: o, at: prev.get(o.id)?.at ?? nowMs });
  if (next.size <= max) return next;
  return new Map([...next.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, max));
}

/**
 * The history after a new board (the screen calls it when the board arrives): the orders this
 * screen shows (its filters) that are done here now — a station's finished cards, the Expo's ready
 * ones it has nothing left to do on, the recently handed over.
 */
export function historyAfter(
  prev: ReadonlyMap<string, HistoryEntry>,
  orders: readonly KdsOrder[],
  role: KdsScreenRole,
  filters: Pick<KdsBehaviour, 'orderTypes' | 'externalOrders'>,
  nowMs: number,
): Map<string, HistoryEntry> {
  const shown = orders.filter((o) => passesFilters(o, filters));
  const { cards, recent } = screenOf(shown, role, nowMs);
  const done = [...cards.filter((o) => isDoneCard(o, role)), ...recent];
  const active = new Set(cards.filter(hasWork).map((o) => o.id));
  return nextHistory(prev, done, active, nowMs);
}

/** The history's rows, the newest first, without the cards still on the screen. */
export function historyRows(history: ReadonlyMap<string, HistoryEntry>, onScreen: ReadonlySet<string>): HistoryEntry[] {
  return [...history.values()].filter((e) => !onScreen.has(e.order.id)).sort((a, b) => b.at - a.at || a.order.id.localeCompare(b.order.id));
}
