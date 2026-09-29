/**
 * Shared display formatters.
 *
 * `formatCurrency` was copy-pasted identically into several dashboard pages; it
 * lives here now so every money column in the app renders the same way. Amounts
 * arrive from the API in shekels — as JSON numbers from the older endpoints, and as
 * decimal strings ("123.40") from the shift and Z endpoints. Format them, never do
 * arithmetic on them beyond display.
 */
import { formatDuration, intervalToDuration } from 'date-fns';
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

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date for display. A plain calendar date ("2026-09-28", a business date) is shown as
 * that day wherever the reader is: `new Date("2026-09-28")` is UTC midnight, which a
 * browser west of UTC would render as the 27th.
 */
export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const plain = PLAIN_DATE.exec(iso);
  if (plain) {
    const d = new Date(Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])));
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('he-IL', { timeZone: 'UTC' });
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('he-IL');
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('he-IL', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Datetime rendered in an explicit IANA zone — used for the report window bounds,
 * which the server resolves in the tenant's timezone and which must therefore not
 * be relabelled into whatever zone the reader's browser happens to sit in.
 */
export function formatDateTimeInZone(
  iso: string | undefined | null,
  timeZone: string | undefined,
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return d.toLocaleString('he-IL', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    // An unknown zone string must not blank out the whole panel.
    return formatDateTime(iso);
  }
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
