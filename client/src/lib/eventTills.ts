/**
 * "שיוך קופות מהיר לאירוע" — the tills pickers' rules, pure so `npm test` checks them on their
 * own: the one-tap selectors ("כל הסניף", by area, by device group, "רק קופות" / "רק קיוסקים"),
 * the search, "העתק קופות מאירוע קודם", the overlaps ("העבר לאירוע הזה") and the request body.
 *
 * A till already in an overlapping draft event is never picked by a selector or a copy — it is
 * counted as skipped instead. Picked by hand, it shows the other event inline and stays a
 * conflict, blocking the save, until it is marked to move (or unpicked). Nothing moves silently.
 *
 * No React, no path aliases.
 */

import { isDisplayDevice } from './deviceProfile';
import type { EventTillOption, EventTillsView } from './eventTypes';

export type TillSelector =
  | { kind: 'all' }
  | { kind: 'tills' }
  | { kind: 'kiosks' }
  | { kind: 'area'; areaId: string }
  | { kind: 'group'; groupId: string };

/** "כל הסניף", "רק קופות" and "רק קיוסקים" replace the selection; an area or a group adds to it (or takes away). */
export function selectorReplaces(selector: TillSelector): boolean {
  return selector.kind === 'all' || selector.kind === 'tills' || selector.kind === 'kiosks';
}

/** Every till the selector names, busy or not. */
export function selectorTills(tills: readonly EventTillOption[], selector: TillSelector): EventTillOption[] {
  switch (selector.kind) {
    case 'all':
      return [...tills];
    case 'tills':
      return tills.filter((t) => (t.kind ?? 'till') !== 'kiosk');
    case 'kiosks':
      return tills.filter((t) => t.kind === 'kiosk');
    case 'area':
      return tills.filter((t) => t.areaId === selector.areaId);
    case 'group':
      return tills.filter((t) => (t.groupIds ?? []).includes(selector.groupId));
  }
}

export type SelectorState = 'on' | 'partial' | 'off';

/** For the chip: are all its free tills picked (and, for the replacing ones, nothing else)? */
export function selectorState(
  selected: readonly string[],
  tills: readonly EventTillOption[],
  selector: TillSelector,
): SelectorState {
  const free = selectorTills(tills, selector).filter((t) => !t.busy).map((t) => t.id);
  if (free.length === 0) return 'off';
  const picked = new Set(selected);
  const hits = free.filter((id) => picked.has(id)).length;
  if (hits === 0) return 'off';
  if (hits < free.length) return 'partial';
  if (selectorReplaces(selector)) {
    const own = new Set(free);
    return selected.every((id) => own.has(id)) ? 'on' : 'partial';
  }
  return 'on';
}

export interface PickResult {
  /** The new selection. */
  ids: string[];
  /** Tills the selector named but left out: they are in an overlapping event. */
  skippedBusy: EventTillOption[];
}

/**
 * One tap on a selector. A replacing one ("כל הסניף", "רק קופות", "רק קיוסקים") makes the
 * selection its free tills; an area or a group adds its free tills, or — when they are all
 * picked already — takes them away again. Busy tills are never picked here, only counted.
 * A till picked by hand that is busy (a conflict being resolved) stays when an area is added.
 */
export function applySelector(
  selected: readonly string[],
  tills: readonly EventTillOption[],
  selector: TillSelector,
): PickResult {
  const named = selectorTills(tills, selector);
  const free = named.filter((t) => !t.busy).map((t) => t.id);
  const skippedBusy = named.filter((t) => t.busy && !selected.includes(t.id));
  if (selectorReplaces(selector)) {
    return { ids: orderLike(tills, free), skippedBusy };
  }
  const picked = new Set(selected);
  if (free.length > 0 && free.every((id) => picked.has(id))) {
    const drop = new Set(free);
    return { ids: selected.filter((id) => !drop.has(id)), skippedBusy: [] };
  }
  for (const id of free) picked.add(id);
  return { ids: orderLike(tills, [...picked]), skippedBusy };
}

/** "העתק קופות מאירוע קודם": that event's tills the shop still has, the busy ones left out (counted). */
export function copyFromEvent(
  tills: readonly EventTillOption[],
  machineIds: readonly string[],
): PickResult & { missing: number } {
  const byId = new Map(tills.map((t) => [t.id, t]));
  const present = machineIds.map((id) => byId.get(id)).filter((t): t is EventTillOption => Boolean(t));
  return {
    ids: orderLike(tills, present.filter((t) => !t.busy).map((t) => t.id)),
    skippedBusy: present.filter((t) => t.busy),
    missing: machineIds.length - present.length,
  };
}

/** Hebrew-friendly lower-casing and whitespace folding. */
function fold(text: string): string {
  return text.toLocaleLowerCase('he-IL').replace(/\s+/g, ' ').trim();
}

/**
 * The search box: every word must appear in the till's name, its register number ("3",
 * "קופה 3"), its area or its device groups' names.
 */
export function searchTills(
  tills: readonly EventTillOption[],
  query: string,
  groupNames: ReadonlyMap<string, string> = new Map(),
): EventTillOption[] {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...tills];
  return tills.filter((t) => {
    const hay = fold(
      [
        t.name,
        t.posNumber ?? '',
        t.posNumber ? `קופה ${t.posNumber}` : '',
        t.areaName ?? '',
        ...(t.groupIds ?? []).map((g) => groupNames.get(g) ?? ''),
        t.kind === 'kiosk' ? 'קיוסק kiosk' : '',
      ].join(' '),
    );
    return words.every((w) => hay.includes(w));
  });
}

export interface TillConflict {
  till: EventTillOption;
  eventId: string;
  eventName: string;
  startsAt: string;
  endsAt: string;
  /** Marked "העבר לאירוע הזה": it leaves the other event on save. */
  moving: boolean;
}

/** The picked tills that are in an overlapping draft event — each moving, or still a conflict. */
export function tillConflicts(
  selected: readonly string[],
  tills: readonly EventTillOption[],
  moveIds: readonly string[],
): TillConflict[] {
  const picked = new Set(selected);
  const moving = new Set(moveIds);
  return tills
    .filter((t) => t.busy && picked.has(t.id))
    .map((t) => ({
      till: t,
      eventId: t.busy!.eventId,
      eventName: t.busy!.eventName,
      startsAt: t.busy!.startsAt,
      endsAt: t.busy!.endsAt,
      moving: moving.has(t.id),
    }));
}

/** The conflicts not yet resolved: they block the save. */
export function unresolvedConflicts(conflicts: readonly TillConflict[]): TillConflict[] {
  return conflicts.filter((c) => !c.moving);
}

/** The move list to send: picked, busy and marked — nothing else (a till unpicked or freed drops out). */
export function movesToSend(
  selected: readonly string[],
  tills: readonly EventTillOption[],
  moveIds: readonly string[],
): string[] {
  return tillConflicts(selected, tills, moveIds).filter((c) => c.moving).map((c) => c.till.id);
}

/** The bulk request (`POST /report-events/{id}/tills`): from the event's tills to the picked ones. */
export function tillChanges(
  before: readonly string[],
  after: readonly string[],
  move: readonly string[] = [],
): { add: string[]; remove: string[]; move: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  const moving = new Set(move.filter((id) => now.has(id)));
  return {
    add: after.filter((id) => !was.has(id) && !moving.has(id)),
    remove: before.filter((id) => !now.has(id)),
    move: [...moving],
  };
}

export function hasChanges(changes: { add: string[]; remove: string[]; move: string[] }): boolean {
  return changes.add.length + changes.remove.length + changes.move.length > 0;
}

/** Keep `ids` in the till list's order (register order, from the server). */
function orderLike(tills: readonly EventTillOption[], ids: readonly string[]): string[] {
  const want = new Set(ids);
  const ordered = tills.filter((t) => want.has(t.id)).map((t) => t.id);
  const rest = ids.filter((id) => !ordered.includes(id));
  return [...ordered, ...rest];
}

/** The chips to show: only what the shop has (no "רק קיוסקים" without a kiosk, no lone area). */
export function availableSelectors(view: Pick<EventTillsView, 'tills' | 'areas' | 'groups'>): {
  kinds: Array<'all' | 'tills' | 'kiosks'>;
  areas: { id: string; name: string; count: number }[];
  groups: { id: string; name: string; count: number }[];
} {
  const tills = view.tills;
  const kiosks = tills.filter((t) => t.kind === 'kiosk').length;
  const kinds: Array<'all' | 'tills' | 'kiosks'> = ['all'];
  if (kiosks > 0 && kiosks < tills.length) kinds.push('tills', 'kiosks');
  const count = (selector: TillSelector) => selectorTills(tills, selector).length;
  const areas = (view.areas ?? [])
    .map((a) => ({ ...a, count: count({ kind: 'area', areaId: a.id }) }))
    .filter((a) => a.count > 0);
  const groups = (view.groups ?? [])
    .map((g) => ({ ...g, count: count({ kind: 'group', groupId: g.id }) }))
    .filter((g) => g.count > 0);
  return { kinds, areas: areas.length > 1 || areas.some((a) => a.count < tills.length) ? areas : [], groups };
}

// ── "שייך לאירוע" from the devices page ───────────────────────────────────────

/**
 * The tills picked on the devices page, for "שייך לאירוע": an event's tills come from its one
 * shop, so they must share one; screens (KDS, boards) sell nothing and are left out.
 */
export function assignableSelection<T extends { id: string; shopId?: string | null; fiscal?: boolean | null; deviceRole?: unknown }>(
  machines: readonly T[],
): { shopId: string | null; tills: T[]; screens: T[]; noShop: T[]; mixedShops: boolean } {
  const screens = machines.filter((m) => isDisplayDevice(m));
  const rest = machines.filter((m) => !screens.includes(m));
  const noShop = rest.filter((m) => !m.shopId);
  const tills = rest.filter((m) => m.shopId);
  const shops = new Set(tills.map((m) => m.shopId as string));
  return {
    shopId: shops.size === 1 ? [...shops][0] : null,
    tills,
    screens,
    noShop,
    mixedShops: shops.size > 1,
  };
}

/** Local date and time parts of `now` in `timeZone`. */
export function localParts(now: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/**
 * "אירוע חדש" from the devices page: from now (down to the 5 minutes, the form's step) until the
 * end of the day — 23:59 the same local day.
 */
export function nowUntilEndOfDay(now: Date, timeZone: string): {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
} {
  const { date, time } = localParts(now, timeZone);
  const [h, m] = time.split(':').map(Number);
  const floored = `${String(h).padStart(2, '0')}:${String(m - (m % 5)).padStart(2, '0')}`;
  return { startDate: date, startTime: floored, endDate: date, endTime: '23:59' };
}

/** The draft events a till can still join: not over yet, soonest first. */
export function joinableEvents<T extends { status: string; endsAt: string; startsAt: string }>(
  events: readonly T[],
  now: Date,
): T[] {
  return events
    .filter((e) => e.status === 'draft' && Date.parse(e.endsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
