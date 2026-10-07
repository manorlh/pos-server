/**
 * The date picker's model (components/ui/date-picker.tsx): the month grid, the quick
 * ranges and the min/max rule — pure, so it is tested without a browser.
 *
 * Days are ISO strings ("2026-10-07") throughout: exactly what the pages already send
 * the API. The picker changes how a day is shown and typed (07/10/2026, a Hebrew
 * calendar starting on Sunday), never the value a page receives. "Today" is Israel's
 * today (`businessToday` in lib/format), not the browser's.
 */
import { addDaysIso } from './format';

export interface YearMonth {
  year: number;
  /** 1..12 */
  month: number;
}

export interface CalendarDay {
  iso: string;
  day: number;
  /** False for the leading/trailing days of the neighbouring months. */
  inMonth: boolean;
}

export interface DayRange {
  from: string;
  to: string;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function isoOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The month a day falls in; null for a non-day. */
export function monthOf(iso: string | null | undefined): YearMonth | null {
  const m = ISO_DAY.exec(iso ?? '');
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

export function shiftMonth(at: YearMonth, delta: number): YearMonth {
  const index = at.year * 12 + (at.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** The days of a month, as six Sunday-first weeks (a fixed height, so the popup never jumps). */
export function monthGrid(at: YearMonth): CalendarDay[][] {
  const first = new Date(Date.UTC(at.year, at.month - 1, 1));
  const start = addDaysIso(isoOf(at.year, at.month, 1), -first.getUTCDay());
  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const iso = addDaysIso(start, w * 7 + d);
      const ym = monthOf(iso)!;
      week.push({ iso, day: Number(iso.slice(8, 10)), inMonth: ym.year === at.year && ym.month === at.month });
    }
    weeks.push(week);
  }
  return weeks;
}

/** A day the field must refuse: before `min` or after `max` (ISO days compare as strings). */
export function outOfBounds(iso: string, min?: string | null, max?: string | null): boolean {
  return Boolean((min && iso < min) || (max && iso > max));
}

/** `from`..`to` inclusive; false when either end is missing. */
export function inRange(iso: string, range: Partial<DayRange> | null | undefined): boolean {
  return Boolean(range?.from && range?.to && iso >= range.from && iso <= range.to);
}

/** The quick ranges, in the order the picker lists them (labels: `datePicker.presets.<key>`). */
export const RANGE_PRESETS = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
] as const;
export type RangePresetKey = (typeof RANGE_PRESETS)[number];

/**
 * A quick range relative to `today` (an ISO day). Weeks run Sunday to Saturday; "this
 * week / month / year" end today, since nothing has been sold tomorrow yet. Clamped to
 * `min`/`max` when the field has them.
 */
export function presetRange(key: RangePresetKey, today: string, min?: string | null, max?: string | null): DayRange {
  const t = monthOf(today)!;
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const thisSunday = addDaysIso(today, -weekday);
  let range: DayRange;
  switch (key) {
    case 'today':
      range = { from: today, to: today };
      break;
    case 'yesterday': {
      const y = addDaysIso(today, -1);
      range = { from: y, to: y };
      break;
    }
    case 'last7':
      range = { from: addDaysIso(today, -6), to: today };
      break;
    case 'last30':
      range = { from: addDaysIso(today, -29), to: today };
      break;
    case 'thisWeek':
      range = { from: thisSunday, to: today };
      break;
    case 'lastWeek':
      range = { from: addDaysIso(thisSunday, -7), to: addDaysIso(thisSunday, -1) };
      break;
    case 'thisMonth':
      range = { from: isoOf(t.year, t.month, 1), to: today };
      break;
    case 'lastMonth': {
      const prev = shiftMonth(t, -1);
      range = { from: isoOf(prev.year, prev.month, 1), to: addDaysIso(isoOf(t.year, t.month, 1), -1) };
      break;
    }
    case 'thisYear':
      range = { from: isoOf(t.year, 1, 1), to: today };
      break;
  }
  const clamp = (iso: string) => (min && iso < min ? min : max && iso > max ? max : iso);
  return { from: clamp(range.from), to: clamp(range.to) };
}

/** Which quick range `from`..`to` is, for marking it in the list; null for a hand-picked one. */
export function matchingPreset(range: Partial<DayRange> | null | undefined, today: string): RangePresetKey | null {
  if (!range?.from || !range?.to) return null;
  return RANGE_PRESETS.find((k) => {
    const p = presetRange(k, today);
    return p.from === range.from && p.to === range.to;
  }) ?? null;
}
