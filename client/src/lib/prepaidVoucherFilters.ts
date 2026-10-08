/**
 * The prepaid vouchers' one filter model (server: app/services/prepaid_voucher_analytics.py), as the
 * dashboard holds it: the same names in the page's URL and in the API's query, so a filtered view is
 * a link, and the batch list, "כל השוברים", a batch's vouchers and "מימושים לפי קופה" all read one
 * set of filters. Pure, so `npm test` covers it (lib/prepaidVoucherFilters.test.ts).
 */

export const VOUCHER_VIEWS = ['batches', 'vouchers', 'tills', 'types'] as const;
export type VoucherView = (typeof VOUCHER_VIEWS)[number];

export const BATCH_STATUSES = ['active', 'not_started', 'expired', 'cancelled', 'fully_redeemed', 'has_open'] as const;
export type BatchStatusFilter = (typeof BATCH_STATUSES)[number];

export const VOUCHER_STATES = ['open', 'partial', 'redeemed', 'cancelled', 'expired'] as const;
export type VoucherState = (typeof VOUCHER_STATES)[number];

export const BATCH_SORTS = ['newest', 'customer', 'event', 'redeemed'] as const;
export type BatchSort = (typeof BATCH_SORTS)[number];

export const ACCOUNTING_FILTERS = ['discount', 'payment', 'zero'] as const;
export const PRICING_FILTERS = ['fixed', 'cover'] as const;
export const KIND_FILTERS = ['items', 'discount'] as const;
export const YES_NO = ['yes', 'no'] as const;

/** Every filter; '' / [] = not filtered. Dates are yyyy-mm-dd (the tenant's days). */
export interface VoucherFilters {
  /** "עבור מי": the production (until the Production entity, the batch's customer). */
  customer: string[];
  event: string[];
  typeId: string[];
  kind: '' | (typeof KIND_FILTERS)[number];
  batchId: string[];
  shopId: string[];
  accounting: '' | (typeof ACCOUNTING_FILTERS)[number];
  pricing: '' | (typeof PRICING_FILTERS)[number];
  override: '' | (typeof YES_NO)[number];
  offline: '' | (typeof YES_NO)[number];
  valueMin: string;
  valueMax: string;
  priceMin: string;
  priceMax: string;
  createdBy: string;
  issuedFrom: string;
  issuedTo: string;
  validOn: string;
  batchStatus: '' | BatchStatusFilter;
  /** Redeemed between (the redemption's day). */
  from: string;
  to: string;
  /** "מומש בקופה". */
  machineId: string[];
  employee: string[];
  /** A voucher's state, group and words (service number, code, note) — the voucher views'. */
  state: '' | VoucherState;
  group: string;
  q: string;
}

export const EMPTY_FILTERS: VoucherFilters = {
  customer: [], event: [], typeId: [], kind: '', batchId: [], shopId: [], accounting: '', pricing: '', override: '',
  offline: '', valueMin: '', valueMax: '', priceMin: '', priceMax: '', createdBy: '', issuedFrom: '', issuedTo: '',
  validOn: '', batchStatus: '', from: '', to: '', machineId: [], employee: [], state: '', group: '', q: '',
};

const LISTS = ['customer', 'event', 'typeId', 'batchId', 'shopId', 'machineId', 'employee'] as const;
const CHOICES: Partial<Record<keyof VoucherFilters, readonly string[]>> = {
  kind: KIND_FILTERS,
  accounting: ACCOUNTING_FILTERS,
  pricing: PRICING_FILTERS,
  override: YES_NO,
  offline: YES_NO,
  batchStatus: BATCH_STATUSES,
  state: VOUCHER_STATES,
};
const DAYS = ['issuedFrom', 'issuedTo', 'validOn', 'from', 'to'] as const;
const NUMBERS = ['valueMin', 'valueMax', 'priceMin', 'priceMax'] as const;
const TEXTS = ['createdBy', 'q'] as const;

/** The filters that belong to a voucher, not a batch: the batch list ignores them. */
export const VOUCHER_ONLY: (keyof VoucherFilters)[] = ['state', 'group'];

type Query = URLSearchParams | string | Record<string, string | string[] | undefined>;

function toParams(q: Query): URLSearchParams {
  if (q instanceof URLSearchParams) return q;
  if (typeof q === 'string') return new URLSearchParams(q.startsWith('?') ? q.slice(1) : q);
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== undefined) p.append(k, v);
  }
  return p;
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isAmount = (s: string) => /^\d+(?:[.,]\d{1,2})?$/.test(s);

/** The filters a URL (or an object of query values) says; anything unreadable is dropped, never guessed. */
export function filtersFromQuery(query: Query): VoucherFilters {
  const p = toParams(query);
  const out: VoucherFilters = { ...EMPTY_FILTERS };
  for (const k of LISTS) {
    const values: string[] = [];
    for (const raw of p.getAll(k)) {
      for (const part of raw.split(',')) {
        const v = part.trim();
        if (v && !values.includes(v)) values.push(v);
      }
    }
    (out[k] as string[]) = values.slice(0, 50);
  }
  for (const [k, allowed] of Object.entries(CHOICES) as [keyof VoucherFilters, readonly string[]][]) {
    const v = (p.get(k) ?? '').trim();
    if (allowed.includes(v)) (out as unknown as Record<string, string>)[k] = v;
  }
  for (const k of DAYS) {
    const v = (p.get(k) ?? '').trim();
    if (isDay(v)) out[k] = v;
  }
  for (const k of NUMBERS) {
    const v = (p.get(k) ?? '').trim();
    if (isAmount(v)) out[k] = v.replace(',', '.');
  }
  for (const k of TEXTS) out[k] = (p.get(k) ?? '').trim().slice(0, 100);
  const g = (p.get('group') ?? '').trim();
  out.group = /^\d{1,6}$/.test(g) && Number(g) > 0 ? g : '';
  return out;
}

/**
 * The filters as query values — only what is set, lists repeated — for the URL and for the API.
 * [omit] leaves some out (the batch list does not send a voucher's state).
 */
export function filtersToQuery(f: VoucherFilters, omit: (keyof VoucherFilters)[] = []): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of Object.keys(EMPTY_FILTERS) as (keyof VoucherFilters)[]) {
    if (omit.includes(k)) continue;
    const v = f[k];
    if (Array.isArray(v)) v.forEach((x) => x && p.append(k, x));
    else if (v) p.set(k, String(v).trim());
  }
  return p;
}

/** How many filters are set (a list counts once) — the "סינונים (3)" badge. */
export function activeFilterCount(f: VoucherFilters, omit: (keyof VoucherFilters)[] = []): number {
  let n = 0;
  for (const k of Object.keys(EMPTY_FILTERS) as (keyof VoucherFilters)[]) {
    if (omit.includes(k)) continue;
    const v = f[k];
    if (Array.isArray(v) ? v.length > 0 : !!v) n += 1;
  }
  return n;
}

/** One filter changed; the rest kept. */
export function withFilter<K extends keyof VoucherFilters>(f: VoucherFilters, key: K, value: VoucherFilters[K]): VoucherFilters {
  return { ...f, [key]: value };
}

/** What the page's URL holds besides the filters: the view and the batch list's sort. */
export interface PageState {
  view: VoucherView;
  sort: BatchSort;
  filters: VoucherFilters;
}

export function pageStateFromQuery(query: Query): PageState {
  const p = toParams(query);
  const view = (VOUCHER_VIEWS as readonly string[]).includes(p.get('view') ?? '') ? (p.get('view') as VoucherView) : 'batches';
  const sort = (BATCH_SORTS as readonly string[]).includes(p.get('sort') ?? '') ? (p.get('sort') as BatchSort) : 'newest';
  return { view, sort, filters: filtersFromQuery(p) };
}

/** The page's URL query: the view and sort only when not the defaults, then the filters. */
export function pageStateToQuery(s: PageState): string {
  const p = new URLSearchParams();
  if (s.view !== 'batches') p.set('view', s.view);
  if (s.sort !== 'newest') p.set('sort', s.sort);
  filtersToQuery(s.filters).forEach((v, k) => p.append(k, v));
  return p.toString();
}

/** "62%" — a rate (0–1) as a whole percent; '—' when there is nothing to divide by. */
export function rateText(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** ₪ from agorot: "₪1,234.50", whole shekels without decimals. */
export function agorotText(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined) return '—';
  const shekels = agorot / 100;
  return `₪${shekels.toLocaleString('he-IL', { minimumFractionDigits: agorot % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Search results' groups in the order the box lists them, the empty ones left out. */
export function searchGroups<T extends object>(result: T, order: (keyof T)[]): (keyof T)[] {
  return order.filter((k) => ((result[k] as unknown[] | undefined) ?? []).length > 0);
}
