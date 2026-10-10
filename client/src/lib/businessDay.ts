/**
 * "שעת סיום יום עסקי" — which business day a moment belongs to, for management reports.
 *
 * The owner (10.10): a bar's 01:00 sale on 1.10 is part of the evening of 30.9. The dynamic
 * parameter `businessDayEndHour` (0–12, default 4 = 04:00, company → shop → area → till) says
 * when a business day ends:
 *
 *     business day of a moment = its local date, minus one day when its local hour < end hour
 *
 * Management only: a Z is dated when it was produced, an invoice or a receipt when it was
 * issued, and VAT and the uniform file (מבנה אחיד) go by the document's date — none of them moves.
 *
 * One rule in three languages, pinned by one golden fixture (pos-server
 * server/tests/fixtures/business_day_golden.json, the same bytes in pos-android):
 * Python app/services/business_day.py, this file, Kotlin domain/BusinessDay.kt.
 *
 * Self-contained (no `@/` imports, no React): `npm test` compiles it on its own.
 */

export const DEFAULT_END_HOUR = 4;
export const MIN_END_HOUR = 0;
export const MAX_END_HOUR = 12;
export const DEFAULT_TIME_ZONE = 'Asia/Jerusalem';

/** A management report's days: the business day (the default) or the document's calendar date. */
export type DayBasis = 'business' | 'document';
export const DAY_BASES: readonly DayBasis[] = ['business', 'document'];
export const DEFAULT_DAY_BASIS: DayBasis = 'business';

/** A whole hour clamped into 0–12; anything else (missing, text, a fraction, a boolean) is 4. */
export function normalizeEndHour(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_END_HOUR;
  return Math.max(MIN_END_HOUR, Math.min(MAX_END_HOUR, value));
}

/** The `dayBasis` query a report sends: nothing for the default (the server's default is the business day). */
export function dayBasisQuery(basis: DayBasis | null | undefined): { dayBasis?: DayBasis } {
  return basis === 'document' ? { dayBasis: 'document' } : {};
}

// ── Wall clock ────────────────────────────────────────────────────────────────

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function toMillis(instant: Date | string | number): number {
  if (instant instanceof Date) return instant.getTime();
  if (typeof instant === 'number') return instant;
  return new Date(instant).getTime();
}

/** The wall clock of `timeZone` at `instant`. */
export function wallClock(instant: Date | string | number, timeZone: string = DEFAULT_TIME_ZONE): WallClock {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(toMillis(instant)))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** "2026-10-01" moved by `days` calendar days — plain date arithmetic, no clocks. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/** The business day ("YYYY-MM-DD") `instant` belongs to in `timeZone`. */
export function businessDayOf(
  instant: Date | string | number,
  timeZone: string = DEFAULT_TIME_ZONE,
  endHour: number = DEFAULT_END_HOUR,
): string {
  const w = wallClock(instant, timeZone);
  const day = isoOf(w.year, w.month, w.day);
  return w.hour < normalizeEndHour(endHour) ? addDays(day, -1) : day;
}

function wallMillis(instantMs: number, timeZone: string): number {
  const w = wallClock(instantMs, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

function offsetAt(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  return wallMillis(whole, timeZone) - whole;
}

/**
 * The instant business day `day` begins: end-hour:00 local on `day` — the first instant after the
 * gap when the clocks skip it, the first of the two when they repeat it (as Python's `fold=0` and
 * java.time).
 */
export function businessDayStart(
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
  endHour: number = DEFAULT_END_HOUR,
): Date {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, normalizeEndHour(endHour));
  const dayMs = 86_400_000;
  const before = wall - offsetAt(wall - dayMs, timeZone);
  if (wallMillis(before, timeZone) === wall) return new Date(before);
  const after = wall - offsetAt(wall + dayMs, timeZone);
  if (wallMillis(after, timeZone) === wall) return new Date(after);
  return new Date(before); // in the gap: the clocks jumped over it — the day starts at the jump
}

// ── "Today" for the management pages ─────────────────────────────────────────

let currentEndHour = DEFAULT_END_HOUR;

/**
 * The end hour the dashboard's "today" uses — the scope's, as `GET /reports/business-day` says
 * (lib/businessDayApi.ts keeps it current); 4 until it has answered.
 */
export function setCurrentEndHour(hour: unknown): void {
  currentEndHour = normalizeEndHour(hour);
}

export function currentBusinessDayEndHour(): number {
  return currentEndHour;
}

/** The business day it is now: at 01:00 still yesterday's (with the default 04:00). */
export function businessDayToday(
  now: Date | string | number = Date.now(),
  timeZone: string = DEFAULT_TIME_ZONE,
  endHour: number = currentEndHour,
): string {
  return businessDayOf(now, timeZone, endHour);
}

/** `days` business days before today ("the last 7 days" ending today's business day). */
export function businessDaysBack(days: number, now: Date | string | number = Date.now()): string {
  return addDays(businessDayToday(now), -days);
}

// ── A Z's documents by calendar month (the cross-month line) ───────────────────

export interface DocumentMonth {
  /** "YYYY-MM" of the documents' DOCUMENT date. */
  month: string;
  /** The month's signed sum, "123.45". */
  total: string;
}

function toAgorot(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === '') return 0;
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function decimalOf(agorot: number): string {
  return (agorot / 100).toFixed(2);
}

/**
 * Documents `{at, amount}` summed per calendar month of their document date in `timeZone`, oldest
 * first. More than one month = the Z shows the cross-month line.
 */
export function documentMonths(
  documents: readonly { at: Date | string | number; amount: string | number }[],
  timeZone: string = DEFAULT_TIME_ZONE,
): DocumentMonth[] {
  const sums = new Map<string, number>();
  for (const doc of documents) {
    const w = wallClock(doc.at, timeZone);
    const key = `${String(w.year).padStart(4, '0')}-${pad2(w.month)}`;
    sums.set(key, (sums.get(key) ?? 0) + toAgorot(doc.amount));
  }
  return [...sums.keys()].sort().map((month) => ({ month, total: decimalOf(sums.get(month) ?? 0) }));
}

export const MONTH_NAMES: Record<'he' | 'en', readonly string[]> = {
  he: ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

const LINE_WORDS: Record<'he' | 'en', { lead: string; part: (money: string, month: string) => string; tail: string }> = {
  he: { lead: 'מתוך ה-Z: ', part: (money, month) => `${money} מסמכי ${month}`, tail: ' (לדיווח לפי תאריך המסמך)' },
  en: { lead: 'Of this Z: ', part: (money, month) => `${money} of ${month} documents`, tail: ' (report by document date)' },
};

/** ₪1,234.50 — a negative as -₪1,234.50 (the Z's own money format). */
export function shekels(amount: string | number): string {
  const agorot = toAgorot(amount);
  const abs = Math.abs(agorot);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${agorot < 0 ? '-' : ''}₪${whole}.${pad2(abs % 100)}`;
}

/**
 * "מתוך ה-Z: ₪X מסמכי ספטמבר · ₪Y מסמכי אוקטובר (לדיווח לפי תאריך המסמך)" — or null when the Z's
 * documents are all of one month (the line is shown only when relevant).
 */
export function crossMonthLine(months: readonly DocumentMonth[] | null | undefined, lang: 'he' | 'en' = 'he'): string | null {
  if (!months || months.length < 2) return null;
  const words = LINE_WORDS[lang];
  const parts = months.map((m) => words.part(shekels(m.total), MONTH_NAMES[lang][Number(m.month.slice(5, 7)) - 1]));
  return `${words.lead}${parts.join(' · ')}${words.tail}`;
}
