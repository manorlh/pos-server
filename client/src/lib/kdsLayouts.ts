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

import type { KdsField, KdsOrder, KdsTask } from './kdsScreenTypes';
import { epochMs, hasWork, isCancelled, isFinished, isHeld, isLive, isReady, openTasks, qtyText, type KdsButton, type KdsScreenRole } from './kdsBoard';

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

/** The rail's order: by time only (the oldest first); on a station, what is done goes to the end. */
export function railOrder(cards: readonly KdsOrder[], role: KdsScreenRole): KdsOrder[] {
  const at = (o: KdsOrder) => epochMs(o.firstReleasedAt ?? o.createdAt) ?? Number.MAX_SAFE_INTEGER;
  const done = (o: KdsOrder) => (role === 'station' && !hasWork(o) ? 1 : 0);
  return [...cards].sort((a, b) => done(a) - done(b) || at(a) - at(b) || a.id.localeCompare(b.id));
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
