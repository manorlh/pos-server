/**
 * Client-side model of the report window the `/reports/*` endpoints accept.
 *
 * The semantic worth restating, because it is the one a reader gets wrong:
 * `from`/`to` are **calendar days**, and `fromHour`/`toHour` narrow **every one of
 * those days** to the same hour band. "18:00–22:00 from the 1st to the 14th" is
 * fourteen separate evenings, not one continuous 336-hour stretch. `fromHour` is
 * inclusive, `toHour` exclusive (1..24), and `fromHour > toHour` wraps past
 * midnight (22 → 2 is a late shift). 0/24 means "no hour filter".
 *
 * Everything the UI needs to *say* that out loud is derived here so the three
 * report pages cannot drift apart on how they explain it.
 */

/** Sentinel pair meaning "whole day"; the server drops the filter for 0/24. */
export const WHOLE_DAY_FROM_HOUR = 0;
export const WHOLE_DAY_TO_HOUR = 24;

/** Mirrors MAX_REPORT_DAYS in app/services/reports.py. */
export const MAX_REPORT_DAYS = 366;

export interface HourWindow {
  /** 0..23, inclusive. */
  fromHour: number;
  /** 1..24, exclusive. */
  toHour: number;
}

export const WHOLE_DAY: HourWindow = {
  fromHour: WHOLE_DAY_FROM_HOUR,
  toHour: WHOLE_DAY_TO_HOUR,
};

export function isWholeDay(w: HourWindow): boolean {
  return w.fromHour === WHOLE_DAY_FROM_HOUR && w.toHour === WHOLE_DAY_TO_HOUR;
}

/** 22 → 2. The band runs into the following calendar day. */
export function wrapsMidnight(w: HourWindow): boolean {
  return !isWholeDay(w) && w.fromHour > w.toHour;
}

/** The server rejects fromHour === toHour outright; catch it before the request. */
export function isValidHourWindow(w: HourWindow): boolean {
  if (isWholeDay(w)) return true;
  if (w.fromHour < 0 || w.fromHour > 23) return false;
  if (w.toHour < 1 || w.toHour > 24) return false;
  return w.fromHour !== w.toHour;
}

/** Hours covered on each day of the range. */
export function hoursPerDay(w: HourWindow): number {
  if (isWholeDay(w)) return 24;
  return wrapsMidnight(w) ? 24 - w.fromHour + w.toHour : w.toHour - w.fromHour;
}

/**
 * Query params for the hour filter. The server 400s when only one of the pair is
 * present, and treats 0/24 as "no filter" — so send both or neither.
 */
export function hourQueryParams(w: HourWindow): { fromHour?: number; toHour?: number } {
  if (isWholeDay(w) || !isValidHourWindow(w)) return {};
  return { fromHour: w.fromHour, toHour: w.toHour };
}

/** Inclusive day count between two `YYYY-MM-DD` strings; 0 when unparseable. */
export function dayCount(from: string, to: string): number {
  if (!from || !to) return 0;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Total hours actually covered — days × hours per day. */
export function totalHoursCovered(from: string, to: string, w: HourWindow): number {
  return dayCount(from, to) * hoursPerDay(w);
}

/**
 * 24 booleans, one per hour of a day, true where the band covers that hour.
 * Drives the "this band, on every day" strip in the filter bar.
 */
export function hourSlots(w: HourWindow): boolean[] {
  const slots = new Array<boolean>(24).fill(false);
  if (isWholeDay(w)) return slots.fill(true);
  // An invalid window (fromHour === toHour) covers nothing; showing a full strip
  // next to the "hours must differ" error would contradict it.
  if (!isValidHourWindow(w)) return slots;
  if (wrapsMidnight(w)) {
    for (let h = w.fromHour; h < 24; h += 1) slots[h] = true;
    for (let h = 0; h < w.toHour; h += 1) slots[h] = true;
  } else {
    for (let h = w.fromHour; h < w.toHour; h += 1) slots[h] = true;
  }
  return slots;
}

export const HOUR_OPTIONS_FROM = Array.from({ length: 24 }, (_, h) => h); // 0..23
export const HOUR_OPTIONS_TO = Array.from({ length: 24 }, (_, i) => i + 1); // 1..24

/** Today as `YYYY-MM-DD` in the browser's local zone. */
export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** `daysBack(6)` → the ISO date six days before today. */
export function daysBackIso(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() - days);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
