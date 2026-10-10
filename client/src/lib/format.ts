/**
 * Shared display formatters.
 *
 * `formatCurrency` was copy-pasted identically into several dashboard pages; it
 * lives here now so every money column in the app renders the same way. Amounts
 * arrive from the API in shekels — as JSON numbers from the older endpoints, and as
 * decimal strings ("123.40") from the shift and Z endpoints. Format them, never do
 * arithmetic on them beyond display.
 */
import { formatDistance, formatDuration, intervalToDuration } from 'date-fns';
import { he } from 'date-fns/locale';

export function formatCurrency(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * A money value as a number, for a sign check or a colour — never for a total.
 * Null stays null: an uncounted drawer is not a balanced one.
 */
export function moneyValue(amount: number | string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return Number.isFinite(n) ? n : null;
}

/** Counts and quantities. Units can be fractional (weighed goods), so keep 3 dp. */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('he-IL', {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 3,
  }).format(n);
}

/* ─────────────────────────────── Dates and times ───────────────────────────────
 *
 * Every date and time on the dashboard reads the Israeli way — 07/10/2026, 14:30 on a
 * 24-hour clock, Hebrew weekday and month names — and in the business's time zone,
 * Asia/Jerusalem, not the browser's: a manager abroad, or a laptop left on UTC, must
 * see the hours the till printed. Intl's `he-IL` writes "7.10.2026", and its output
 * drifts between ICU builds, so the strings are put together here from the zone's
 * numeric parts instead of being left to the browser.
 */

/** The business's clock — the server's default tenant zone too. */
export const BUSINESS_TIME_ZONE = 'Asia/Jerusalem';

/** What a date arrives as: an ISO string (a plain day or a timestamp), epoch ms, or a Date. */
export type DateInput = string | number | Date | null | undefined;

/** Weekday names, Sunday first as the Israeli week runs; "יום" goes in front of all but שבת. */
export const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;
/** A calendar's column heads, Sunday first. */
export const HEBREW_WEEKDAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'] as const;
export const HEBREW_MONTHS = [
  'ינואר',
  'פברואר',
  'מרץ',
  'אפריל',
  'מאי',
  'יוני',
  'יולי',
  'אוגוסט',
  'ספטמבר',
  'אוקטובר',
  'נובמבר',
  'דצמבר',
] as const;

/** A wall-clock reading in one zone. `month` is 1..12, `weekday` 0 = Sunday. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMPTY = '—';
const pad2 = (n: number) => String(n).padStart(2, '0');

const partsFormatters = new Map<string, Intl.DateTimeFormat | null>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (!partsFormatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null = null;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      // An unknown zone string: the caller falls back to Israel rather than blanking out.
      formatter = null;
    }
    partsFormatters.set(timeZone, formatter);
  }
  return partsFormatters.get(timeZone) ?? null;
}

/** "2026-02-30" is not a day; null for it. */
function plainDayParts(year: number, month: number, day: number): ZonedParts | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return { year, month, day, hour: 0, minute: 0, second: 0, weekday: at.getUTCDay() };
}

/** The moment `value` names; null when it is empty or not a date. */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The wall-clock parts of `value` in `timeZone` (Israel unless the caller says otherwise).
 * A plain calendar day ("2026-09-28", a business date) is that day wherever the reader is:
 * `new Date("2026-09-28")` is UTC midnight, which a zone west of UTC would read as the 27th.
 */
export function zonedParts(value: DateInput, timeZone: string = BUSINESS_TIME_ZONE): ZonedParts | null {
  if (typeof value === 'string') {
    const plain = PLAIN_DATE.exec(value.trim());
    if (plain) return plainDayParts(Number(plain[1]), Number(plain[2]), Number(plain[3]));
  }
  const at = toDate(value);
  if (!at) return null;
  const formatter = partsFormatter(timeZone || BUSINESS_TIME_ZONE) ?? partsFormatter(BUSINESS_TIME_ZONE);
  if (!formatter) return null;
  const parts: Record<string, string> = {};
  for (const p of formatter.formatToParts(at)) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    // Some ICU builds write midnight as "24" even under h23.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** "07/10/2026". A plain day ("2026-10-07") is shown as that day; a timestamp in Israel time. */
export function formatDate(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  return p ? `${pad2(p.day)}/${pad2(p.month)}/${p.year}` : EMPTY;
}

/** "07/10/2026 14:30" — 24-hour clock. */
export function formatDateTime(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  return p ? `${pad2(p.day)}/${pad2(p.month)}/${p.year} ${pad2(p.hour)}:${pad2(p.minute)}` : EMPTY;
}

/**
 * Datetime rendered in an explicit IANA zone — used for the report window bounds,
 * which the server resolves in the tenant's timezone and which must therefore not
 * be relabelled into whatever zone the reader's browser happens to sit in. An unknown
 * zone string falls back to Israel time rather than blanking out the panel.
 */
export function formatDateTimeInZone(iso: string | undefined | null, timeZone: string | undefined): string {
  return formatDateTime(iso, timeZone);
}

/** "14:30" — or "14:30:05" with `seconds`. */
export function formatTime(value: DateInput, options: { seconds?: boolean; timeZone?: string } = {}): string {
  const p = zonedParts(value, options.timeZone);
  if (!p) return EMPTY;
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return options.seconds ? `${time}:${pad2(p.second)}` : time;
}

/** "07/10" — for a table that already says which year. */
export function formatShortDate(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  return p ? `${pad2(p.day)}/${pad2(p.month)}` : EMPTY;
}

/** "07/10 14:30". */
export function formatShortDateTime(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  return p ? `${pad2(p.day)}/${pad2(p.month)} ${pad2(p.hour)}:${pad2(p.minute)}` : EMPTY;
}

/** "יום רביעי" (and "שבת"). */
export function formatWeekday(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  if (!p) return EMPTY;
  return p.weekday === 6 ? HEBREW_WEEKDAYS[6] : `יום ${HEBREW_WEEKDAYS[p.weekday]}`;
}

/** "יום רביעי, 7 באוקטובר 2026". */
export function formatLongDate(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  if (!p) return EMPTY;
  return `${formatWeekday(value, timeZone)}, ${p.day} ב${HEBREW_MONTHS[p.month - 1]} ${p.year}`;
}

/** "אוקטובר 2026". */
export function formatMonthYear(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  return p ? `${HEBREW_MONTHS[p.month - 1]} ${p.year}` : EMPTY;
}

/** "לפני 5 דקות" / "בעוד שעה" — relative to `now`. */
export function formatTimeAgo(value: DateInput, now: DateInput = Date.now()): string {
  const at = toDate(value);
  const base = toDate(now);
  if (!at || !base) return EMPTY;
  return formatDistance(at, base, { addSuffix: true, locale: he });
}

/** The calendar day ("2026-10-07") a moment falls on in `timeZone`; '' when it is not a date. */
export function isoDate(value: DateInput, timeZone?: string): string {
  const p = zonedParts(value, timeZone);
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : '';
}

/** Today in Israel (or `timeZone`) as "2026-10-07" — not the browser's today. */
export function businessToday(now: DateInput = Date.now(), timeZone?: string): string {
  return isoDate(toDate(now) ?? new Date(), timeZone);
}

/** "2026-10-07" + 1 → "2026-10-08" — calendar arithmetic, no clocks or DST. '' for a non-day. */
export function addDaysIso(iso: string, days: number): string {
  const p = PLAIN_DATE.exec(iso);
  if (!p) return '';
  const at = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]) + days));
  return `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`;
}

/** A day for a date field: "2026-10-07" → "07/10/2026"; '' for none. */
export function dateInputText(iso: string | null | undefined): string {
  return iso && PLAIN_DATE.test(iso) && zonedParts(iso) ? formatDate(iso) : '';
}

/**
 * A typed day → "2026-10-07"; null when it is not a real day. Takes the ways people type
 * it in Israel — day first: "7/10/2026", "07.10.26", "7-10-2026", "07102026" — and ISO.
 * A two-digit year is this century's.
 */
export function parseDateInput(text: string | null | undefined): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  let day: number;
  let month: number;
  let year: number;
  const iso = PLAIN_DATE.exec(s);
  const dmy = /^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2}|\d{4})$/.exec(s);
  const compact = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(s);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dmy || compact) {
    const m = (dmy ?? compact)!;
    [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[3].length === 2) year += 2000;
  } else {
    return null;
  }
  const p = plainDayParts(year, month, day);
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : null;
}

/** A typed time on the 24-hour clock → "09:05"; null when it is not one. Takes "9", "9:05", "9.05", "905", "21:30". */
export function parseTimeInput(text: string | null | undefined): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2})(?:\s*[:.]\s*(\d{2}))?$/.exec(s) ?? /^(\d{1,2})(\d{2})$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

const DURATION_UNITS = ['years', 'months', 'days', 'hours', 'minutes', 'seconds'] as const;

/**
 * A millisecond span as a Hebrew duration, trimmed to its two largest units
 * ("4 ימים 3 שעות"). Sign is deliberately dropped — callers that care about
 * direction (clock skew) say "ahead"/"behind" in their own wording.
 */
export function formatApproxDuration(ms: number): string {
  const abs = Math.abs(Math.round(ms));
  const duration = intervalToDuration({ start: 0, end: abs });
  const present = DURATION_UNITS.filter((u) => duration[u]);
  if (present.length === 0) {
    return formatDuration({ seconds: 0 }, { locale: he, zero: true });
  }
  return formatDuration(duration, {
    locale: he,
    format: present.slice(0, 2),
    // Hebrew "and" is a bound prefix: "שנה" + " ו" + "חודש" reads "שנה וחודש".
    delimiter: ' ו',
  });
}

/** `18` → `"18:00"`. Hours in the report window are whole hours, 0..24. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * A running number as "#12", isolated left-to-right (U+2066 LRI … U+2069 PDI) for text
 * that sits in a Hebrew line: bare, the "#" is a weak character and could land on the
 * far side of the digits ("משמרת 12#"). The string form of the `dir="ltr"` spans the
 * document numbers use, for places that take a string — interpolated messages, select
 * options, titles.
 */
export function formatHashNumber(n: number | string): string {
  return `\u2066#${n}\u2069`;
}
