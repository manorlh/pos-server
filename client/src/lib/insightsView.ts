/**
 * The insights dashboards' view in the URL ("תובנות", "ביצועי קיוסקים"), so a link
 * reproduces what the reader sees (P:\specs\reports-upgrade.md §2א):
 *
 * * the period — 7 / 28 / 90 complete business days (`days`), or a custom `from`–`to`;
 * * the page's own org scope (company › shop › area › till), under keys of its own
 *   (`orgCompany`…) — never the dashboard's shared `company` / `shop` / `machine`, which
 *   these pages do not follow and must not move;
 * * the sections' options (an event, the dead-stock days, the menu's category…) as
 *   `extras` with their defaults.
 *
 * A value at its default stays out of the URL; anything malformed reads as its default;
 * keys the view does not own are kept as they are.
 *
 * Pure — no React — so the round trip is tested in node (src/lib/kioskInsights.test.ts).
 */
import { addDaysIso } from './format';

export type InsightsRange = '7' | '28' | '90' | 'custom';
export const INSIGHTS_DEFAULT_RANGE: InsightsRange = '28';

/** URL keys. None of them is a dashboard scope key (`company`, `shop`, `machine`). */
export const INSIGHTS_VIEW_PARAMS = {
  days: 'days',
  from: 'from',
  to: 'to',
  company: 'orgCompany',
  shop: 'orgShop',
  area: 'orgArea',
  machine: 'orgMachine',
} as const;

export interface InsightsViewSpec {
  /** The scope picker's "all companies" value: the default company. */
  allCompanies: string;
  /** The page's own options by URL key, with their defaults. */
  extras: Readonly<Record<string, string>>;
  /** Options with a fixed set of values. Any other option holds an id. */
  choices?: Readonly<Record<string, readonly string[]>>;
}

export interface InsightsScope {
  companyId: string;
  shopId: string;
  areaId: string;
  machineId: string;
}

export interface InsightsView {
  range: InsightsRange;
  /** The custom period; when none is chosen, the last 28 complete days (what "מותאם" opens with). */
  from: string;
  to: string;
  scope: InsightsScope;
  extras: Record<string, string>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A real `YYYY-MM-DD` day (not 2026-02-31). */
function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && addDaysIso(value, 0) === value;
}

/** "מותאם" before a range is picked: the 28 complete days before today. */
export function defaultCustomPeriod(today: string): { from: string; to: string } {
  return { from: addDaysIso(today, -28), to: addDaysIso(today, -1) };
}

/** The view a URL describes. `today` is the business day (lib/reportWindow.ts `todayIso`). */
export function readInsightsView(params: URLSearchParams, spec: InsightsViewSpec, today: string): InsightsView {
  const P = INSIGHTS_VIEW_PARAMS;
  const id = (key: string) => {
    const v = params.get(key) ?? '';
    return ID.test(v) ? v : '';
  };

  let range: InsightsRange = INSIGHTS_DEFAULT_RANGE;
  let period = defaultCustomPeriod(today);
  const from = params.get(P.from) ?? '';
  const to = params.get(P.to) ?? '';
  // A custom range ends today at the latest (the server's limit).
  const end = isDay(to) && to > today ? today : to;
  if (isDay(from) && isDay(end) && from <= end) {
    range = 'custom';
    period = { from, to: end };
  } else {
    const days = params.get(P.days);
    if (days === '7' || days === '28' || days === '90') range = days;
  }

  const extras: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(spec.extras)) {
    const v = params.get(key);
    const choices = spec.choices?.[key];
    extras[key] = v === null ? fallback : choices ? (choices.includes(v) ? v : fallback) : ID.test(v) ? v : fallback;
  }

  return {
    range,
    from: period.from,
    to: period.to,
    scope: {
      companyId: id(P.company) || spec.allCompanies,
      shopId: id(P.shop),
      areaId: id(P.area),
      machineId: id(P.machine),
    },
    extras,
  };
}

/** `base` with the view written in (defaults left out); every key the view does not own is kept. */
export function writeInsightsView(base: URLSearchParams, view: InsightsView, spec: InsightsViewSpec): URLSearchParams {
  const P = INSIGHTS_VIEW_PARAMS;
  const out = new URLSearchParams(base);
  const put = (key: string, value: string | undefined, fallback = '') => {
    if (value && value !== fallback) out.set(key, value);
    else out.delete(key);
  };
  out.delete(P.days);
  out.delete(P.from);
  out.delete(P.to);
  if (view.range === 'custom') {
    out.set(P.from, view.from);
    out.set(P.to, view.to);
  } else put(P.days, view.range, INSIGHTS_DEFAULT_RANGE);
  put(P.company, view.scope.companyId, spec.allCompanies);
  put(P.shop, view.scope.shopId);
  put(P.area, view.scope.areaId);
  put(P.machine, view.scope.machineId);
  for (const [key, fallback] of Object.entries(spec.extras)) put(key, view.extras[key], fallback);
  return out;
}

/**
 * The period and the scope alone, as a query string ('' at the defaults): the way from one
 * insights page to the other keeps what the reader is looking at, not the page's own options.
 */
export function insightsViewQuery(view: InsightsView, allCompanies: string): string {
  return writeInsightsView(new URLSearchParams(), { ...view, extras: {} }, { allCompanies, extras: {} }).toString();
}

/** The period as the insights endpoints take it: `days`, or `from` + `to`. */
export function insightsPeriodParams(view: Pick<InsightsView, 'range' | 'from' | 'to'>): { days?: number; from?: string; to?: string } {
  return view.range === 'custom' ? { from: view.from, to: view.to } : { days: Number(view.range) };
}

/**
 * After the organization (tenant) changed: the scope and the options name the previous
 * organization's entities, so only the period stays.
 */
export function insightsViewForNewTenant(view: InsightsView, spec: InsightsViewSpec): InsightsView {
  return {
    ...view,
    scope: { companyId: spec.allCompanies, shopId: '', areaId: '', machineId: '' },
    extras: { ...spec.extras },
  };
}
