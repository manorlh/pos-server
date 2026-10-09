/**
 * Temporary events ("אירועים", docs/SPEC_EVENTS.md) — the pure rules the dashboard
 * applies to the event report: re-bucketing the 15-minute timeline into 30 / 60 minutes,
 * clock labels in the event's timezone, the create form's validation, insight ordering.
 *
 * Kept free of React and of the `@/` alias so `npm test` can compile and run them on
 * their own (src/lib/eventReport.test.ts).
 */

import { formatShortDateTime, formatTime } from './format';
import type {
  BucketMinutes,
  EventFormValues,
  EventInsight,
  EventThresholds,
  InsightLevel,
  TimelineBucket,
} from './eventTypes';

export const MAX_EVENT_DAYS = 14;

export const DEFAULT_THRESHOLDS: EventThresholds = {
  weakTillPct: 60,
  highTipPct: 20,
  highTipAmount: null,
  idleGapMinutes: 30,
  minActiveMinutes: 30,
};

const LEVEL_ORDER: Record<InsightLevel, number> = { alert: 0, warning: 1, info: 2 };

/**
 * The server's 15-minute buckets as `minutes`-long ones, aligned to the clock (a 60-minute
 * bucket starts on the hour). Money is summed in agorot so 0.1 + 0.2 stays 0.30.
 */
export function rebucket(timeline: TimelineBucket[], minutes: BucketMinutes): TimelineBucket[] {
  if (minutes <= 15) return timeline.map((b) => ({ ...b, byTill: { ...b.byTill } }));
  const size = minutes * 60_000;
  const out = new Map<number, { start: string; net: number; count: number; byTill: Record<string, number> }>();
  for (const b of timeline) {
    const t = Date.parse(b.start);
    const key = t - (((t % size) + size) % size);
    let agg = out.get(key);
    if (!agg) {
      agg = { start: new Date(key).toISOString(), net: 0, count: 0, byTill: {} };
      out.set(key, agg);
    }
    agg.net += Math.round(b.net * 100);
    agg.count += b.count;
    for (const [till, value] of Object.entries(b.byTill)) {
      agg.byTill[till] = (agg.byTill[till] ?? 0) + Math.round(value * 100);
    }
  }
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, agg]) => ({
      start: agg.start,
      net: agg.net / 100,
      count: agg.count,
      byTill: Object.fromEntries(Object.entries(agg.byTill).map(([k, v]) => [k, v / 100])),
    }));
}

/** The running total along the timeline, for the "how far along are we" line. */
export function cumulative(timeline: TimelineBucket[]): number[] {
  let sum = 0;
  return timeline.map((b) => {
    sum += Math.round(b.net * 100);
    return sum / 100;
  });
}

/** A chart's rows: one per bucket, a label, the total and a column per till. */
export function timelineRows(
  timeline: TimelineBucket[],
  tillIds: string[],
  label: (iso: string) => string,
): Array<Record<string, number | string>> {
  const running = cumulative(timeline);
  return timeline.map((b, i) => {
    const row: Record<string, number | string> = { label: label(b.start), start: b.start, net: b.net, count: b.count, cumulative: running[i] };
    for (const id of tillIds) row[id] = b.byTill[id] ?? 0;
    return row;
  });
}

/** "18:30" — or "27/09 18:30" for an event over several days — in the event's timezone. */
export function clockLabel(iso: string | null | undefined, timeZone: string, withDate = false): string {
  return withDate ? formatShortDateTime(iso, timeZone) : formatTime(iso, { timeZone });
}

/** Minutes as "45 דק׳" / "2:05 שע׳". */
export function durationText(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} דק׳`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} שע׳`;
}

/** The local date + hour parts as minutes since the epoch, read as UTC (a duration check). */
function localMinutes(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) / 60_000;
}

export type EventFormError =
  | 'nameRequired'
  | 'startRequired'
  | 'endRequired'
  | 'endBeforeStart'
  | 'tooLong'
  | 'tillsRequired'
  | 'thresholdRange';

/**
 * What the form must fix before it may be sent. The server checks it all again (in the
 * tenant's timezone, DST included); this is so the user hears it before pressing save.
 */
export function validateEventForm(f: EventFormValues): EventFormError[] {
  const errors: EventFormError[] = [];
  if (!f.name.trim()) errors.push('nameRequired');
  const start = f.startDate && f.startTime ? localMinutes(f.startDate, f.startTime) : null;
  const end = f.endDate && f.endTime ? localMinutes(f.endDate, f.endTime) : null;
  if (start === null) errors.push('startRequired');
  if (end === null) errors.push('endRequired');
  if (start !== null && end !== null) {
    if (end <= start) errors.push('endBeforeStart');
    else if (end - start > MAX_EVENT_DAYS * 24 * 60) errors.push('tooLong');
  }
  if (f.machineIds.length === 0) errors.push('tillsRequired');
  const th = f.thresholds;
  const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  if (
    !inRange(th.weakTillPct, 1, 100) ||
    !inRange(th.highTipPct, 1, 1000) ||
    !inRange(th.idleGapMinutes, 5, 1440) ||
    !inRange(th.minActiveMinutes, 0, 1440) ||
    (th.highTipAmount !== null && !inRange(th.highTipAmount, 1, 100000))
  ) {
    errors.push('thresholdRange');
  }
  return errors;
}

/** The form's length in minutes, or null while a part is missing. */
export function formDurationMinutes(f: Pick<EventFormValues, 'startDate' | 'startTime' | 'endDate' | 'endTime'>): number | null {
  const start = localMinutes(f.startDate, f.startTime);
  const end = localMinutes(f.endDate, f.endTime);
  return start === null || end === null ? null : end - start;
}

/** Alerts first, then warnings, then the rest — stable within a level. */
export function sortInsights(insights: EventInsight[]): EventInsight[] {
  return insights
    .map((insight, index) => ({ insight, index }))
    .sort((a, b) => LEVEL_ORDER[a.insight.level] - LEVEL_ORDER[b.insight.level] || a.index - b.index)
    .map((x) => x.insight);
}

export function countByLevel(insights: EventInsight[]): Record<InsightLevel, number> {
  const out: Record<InsightLevel, number> = { alert: 0, warning: 0, info: 0 };
  for (const i of insights) out[i.level] += 1;
  return out;
}

/** The ids chosen for comparing, as the compare page's `ids` parameter (2 or more). */
export function compareIds(selected: Iterable<string>): string | null {
  const ids = [...new Set(selected)].filter(Boolean);
  return ids.length >= 2 ? ids.join(',') : null;
}
