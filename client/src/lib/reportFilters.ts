/**
 * The reports' one filter model (P:\specs\reports-upgrade.md §2א): what a report can be
 * narrowed by, how it sits in the URL, and what goes to the server.
 *
 * Every applied filter lives in the URL, so a link is the report: refresh, Back and a
 * pasted link all land on the same figures. The shop and the till are not here — they are
 * the dashboard's shared scope (`?company=&shop=&machine=`, lib/scope.tsx), which already
 * lives in the URL; these helpers keep every key they do not own.
 *
 * A report declares which filters its endpoint takes (`filters`) and which of those it
 * applies to the rows on the page instead (`clientFilters`, e.g. the free-text search):
 * nothing it does not declare is read from the URL or sent.
 *
 * "Applied" is a URL with `from` and `to`: a fresh visit shows the bar and waits for
 * "הפק דוח", as every report always has; a shared link runs at once.
 *
 * Pure — no React, no network — so the round trip is tested in node.
 */
import { addDaysIso } from './format';

export type ReportFilterKey =
  | 'hours'
  | 'area'
  | 'cashier'
  | 'method'
  | 'category'
  | 'product'
  | 'docType'
  | 'search';

/** Every filter a report can take. The day range is always there. */
export const REPORT_FILTER_KEYS: readonly ReportFilterKey[] = [
  'hours',
  'area',
  'cashier',
  'method',
  'category',
  'product',
  'docType',
  'search',
];

export interface ReportFilterValues {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  to: string;
  /** 0..23 inclusive / 1..24 exclusive; 0/24 = the whole day (lib/reportWindow.ts). */
  fromHour: number;
  toHour: number;
  /** An area id, `none` (no area), or '' (all). */
  areaId: string;
  cashierId: string;
  method: string;
  categoryId: string;
  productId: string;
  /** A document type number as text ("320"), '' for all. */
  docType: string;
  /** Free text. */
  q: string;
}

export interface ReportFilterSpec {
  /** The filters the report offers (besides the day range). */
  filters: readonly ReportFilterKey[];
  /** Of those, the ones applied on the page rather than sent to the server. */
  clientFilters?: readonly ReportFilterKey[];
  /** Days back from today for the default range (6 = the last 7 days, 0 = today). */
  defaultDaysBack?: number;
  /**
   * The report's own options, by URL key, with their defaults (e.g. `{ limit: '200' }`).
   * Kept in the URL only when they differ from the default.
   */
  extras?: Readonly<Record<string, string>>;
}

/** URL keys. None of them is a scope key (`company`, `shop`, `machine`). */
export const REPORT_FILTER_PARAMS = {
  from: 'from',
  to: 'to',
  fromHour: 'fromHour',
  toHour: 'toHour',
  areaId: 'area',
  cashierId: 'cashier',
  method: 'method',
  categoryId: 'category',
  productId: 'product',
  docType: 'docType',
  q: 'q',
} as const satisfies Record<keyof ReportFilterValues, string>;

/** The value each filter key carries. */
const KEY_FIELDS: Record<ReportFilterKey, (keyof ReportFilterValues)[]> = {
  hours: ['fromHour', 'toHour'],
  area: ['areaId'],
  cashier: ['cashierId'],
  method: ['method'],
  category: ['categoryId'],
  product: ['productId'],
  docType: ['docType'],
  search: ['q'],
};

const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 120;

export function defaultReportFilters(spec: ReportFilterSpec, today: string): ReportFilterValues {
  return {
    from: addDaysIso(today, -(spec.defaultDaysBack ?? 6)) || today,
    to: today,
    fromHour: 0,
    toHour: 24,
    areaId: '',
    cashierId: '',
    method: '',
    categoryId: '',
    productId: '',
    docType: '',
    q: '',
  };
}

function offers(spec: ReportFilterSpec, key: ReportFilterKey): boolean {
  return spec.filters.includes(key);
}

function text(raw: string | null): string {
  return (raw ?? '').trim().slice(0, MAX_TEXT);
}

function hour(raw: string | null, min: number, max: number): number | null {
  if (raw === null || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export interface ParsedReportFilters {
  values: ReportFilterValues;
  extras: Record<string, string>;
  /** The URL names a range: the report runs. */
  applied: boolean;
}

/** The URL → the filters, defaults where it says nothing (or nonsense). */
export function parseReportFilters(
  params: URLSearchParams,
  spec: ReportFilterSpec,
  today: string,
): ParsedReportFilters {
  const values = defaultReportFilters(spec, today);
  const from = params.get(REPORT_FILTER_PARAMS.from);
  const to = params.get(REPORT_FILTER_PARAMS.to);
  const applied = Boolean(from && to && PLAIN_DAY.test(from) && PLAIN_DAY.test(to));
  if (applied) {
    values.from = from!;
    values.to = to!;
  }
  if (offers(spec, 'hours')) {
    const fh = hour(params.get(REPORT_FILTER_PARAMS.fromHour), 0, 23);
    const th = hour(params.get(REPORT_FILTER_PARAMS.toHour), 1, 24);
    // Both or neither, and never the same hour: what the server accepts.
    if (fh !== null && th !== null && fh !== th) {
      values.fromHour = fh;
      values.toHour = th;
    }
  }
  if (offers(spec, 'area')) values.areaId = text(params.get(REPORT_FILTER_PARAMS.areaId));
  if (offers(spec, 'cashier')) values.cashierId = text(params.get(REPORT_FILTER_PARAMS.cashierId));
  if (offers(spec, 'method')) values.method = text(params.get(REPORT_FILTER_PARAMS.method));
  if (offers(spec, 'category')) values.categoryId = text(params.get(REPORT_FILTER_PARAMS.categoryId));
  if (offers(spec, 'product')) values.productId = text(params.get(REPORT_FILTER_PARAMS.productId));
  if (offers(spec, 'docType')) {
    const d = text(params.get(REPORT_FILTER_PARAMS.docType));
    values.docType = /^-?\d{1,4}$/.test(d) ? d : '';
  }
  if (offers(spec, 'search')) values.q = text(params.get(REPORT_FILTER_PARAMS.q));

  const extras: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(spec.extras ?? {})) {
    extras[key] = text(params.get(key)) || fallback;
  }
  return { values, extras, applied };
}

/**
 * The filters → the URL: a copy of `params` with the report's keys rewritten and every
 * other key (the scope, a page's own `shiftId`) left as it was. The range is always written
 * (it is what marks the report as run); the rest only when it narrows something.
 */
export function writeReportFilters(
  params: URLSearchParams,
  values: ReportFilterValues,
  extras: Record<string, string>,
  spec: ReportFilterSpec,
): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const key of Object.values(REPORT_FILTER_PARAMS)) next.delete(key);
  next.set(REPORT_FILTER_PARAMS.from, values.from);
  next.set(REPORT_FILTER_PARAMS.to, values.to);
  const whole = values.fromHour === 0 && values.toHour === 24;
  if (offers(spec, 'hours') && !whole && values.fromHour !== values.toHour) {
    next.set(REPORT_FILTER_PARAMS.fromHour, String(values.fromHour));
    next.set(REPORT_FILTER_PARAMS.toHour, String(values.toHour));
  }
  for (const key of REPORT_FILTER_KEYS) {
    if (key === 'hours' || !offers(spec, key)) continue;
    const field = KEY_FIELDS[key][0];
    const value = String(values[field] ?? '').trim();
    if (value) next.set(REPORT_FILTER_PARAMS[field], value);
  }
  for (const [key, fallback] of Object.entries(spec.extras ?? {})) {
    const value = extras[key];
    if (value && value !== fallback) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

/** "נקה הכל": the defaults, the range included. */
export function clearedReportFilters(spec: ReportFilterSpec, today: string): ParsedReportFilters {
  return {
    values: defaultReportFilters(spec, today),
    extras: { ...(spec.extras ?? {}) },
    applied: true,
  };
}

/** The filters that narrow anything right now (the range does not count). */
export function activeReportFilters(values: ReportFilterValues, spec: ReportFilterSpec): ReportFilterKey[] {
  return spec.filters.filter((key) => {
    if (key === 'hours') return !(values.fromHour === 0 && values.toHour === 24);
    return KEY_FIELDS[key].some((field) => String(values[field] ?? '').trim() !== '');
  });
}

/** Query parameter names the endpoints take (P:\specs\reports-upgrade.md §4). */
export const REPORT_API_PARAMS: Record<Exclude<ReportFilterKey, 'hours'>, string> = {
  area: 'areaId',
  cashier: 'cashierId',
  method: 'paymentMethod',
  category: 'categoryId',
  product: 'productId',
  docType: 'documentType',
  search: 'q',
};

/**
 * What the server gets: the range, the hour band (both or neither), and each server-side
 * filter that is set. Client-side filters never leave the page.
 */
export function reportApiParams(
  values: ReportFilterValues,
  spec: ReportFilterSpec,
): Record<string, string | number> {
  const out: Record<string, string | number> = { from: values.from, to: values.to };
  const client = new Set(spec.clientFilters ?? []);
  const whole = values.fromHour === 0 && values.toHour === 24;
  if (offers(spec, 'hours') && !client.has('hours') && !whole && values.fromHour !== values.toHour) {
    out.fromHour = values.fromHour;
    out.toHour = values.toHour;
  }
  for (const key of REPORT_FILTER_KEYS) {
    if (key === 'hours' || !offers(spec, key) || client.has(key)) continue;
    const value = String(values[KEY_FIELDS[key][0]] ?? '').trim();
    if (value) out[REPORT_API_PARAMS[key]] = value;
  }
  return out;
}

/**
 * The free-text search over a row's text: every word must appear somewhere (case-free,
 * Hebrew niqqud-free, so "קפה שחור" finds "שחור, קפה").
 */
export function matchesSearch(haystack: readonly (string | number | null | undefined)[], q: string): boolean {
  const words = normalizeSearch(q).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const text = normalizeSearch(haystack.filter((v) => v !== null && v !== undefined).join(' '));
  return words.every((w) => text.includes(w));
}

function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[״"׳'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
