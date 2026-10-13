/**
 * The live sales-by-item board (`/dashboard/live-items`, מכירות לפי פריט — חי): its state in
 * the URL — the board's own scope (company › shop › area › till), the period, the custom
 * range, the search, the sort and "show all" — so a refresh, Back and a shared link land on
 * the same board (P:\specs\reports-upgrade.md §2א). The board keeps its own scope, which has
 * an area, so its keys are not the dashboard scope's (`company`, `shop`, `machine`).
 *
 * Also the board's rows as it shows and exports them: the search, the sort and the totals
 * (the scope's own, from the server, or — while searching — the sums of the rows found).
 *
 * Pure (no React, no `@/` imports), tested in reportFramework.test.ts.
 */

export type LivePeriod = 'today' | 'shift' | 'custom';
export type LiveSortKey = 'net' | 'qty' | 'gross' | 'name';

export const LIVE_PERIODS: LivePeriod[] = ['today', 'shift', 'custom'];
export const LIVE_SORTS: LiveSortKey[] = ['net', 'qty', 'gross', 'name'];

export interface LiveItemsState {
  /** null: every company the user sees. */
  companyId: string | null;
  shopId: string;
  /** An area id, `none` (no area), or ''. */
  areaId: string;
  machineId: string;
  period: LivePeriod;
  /** The custom range (`YYYY-MM-DD`), only with `period: 'custom'`. */
  from: string;
  to: string;
  q: string;
  sort: LiveSortKey;
  desc: boolean;
  /** Every product, not just the top ones. */
  all: boolean;
}

/** URL keys. Not the dashboard scope's (`company`, `shop`, `machine`). */
export const LIVE_ITEMS_PARAMS = {
  companyId: 'companyId',
  shopId: 'shopId',
  areaId: 'areaId',
  machineId: 'machineId',
  period: 'period',
  from: 'from',
  to: 'to',
  q: 'q',
  sort: 'sort',
  dir: 'dir',
  all: 'all',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function id(raw: string | null): string {
  const v = (raw ?? '').trim();
  return UUID.test(v) ? v : '';
}

export function defaultLiveItemsState(today: string): LiveItemsState {
  return {
    companyId: null,
    shopId: '',
    areaId: '',
    machineId: '',
    period: 'today',
    from: today,
    to: today,
    q: '',
    sort: 'net',
    desc: true,
    all: false,
  };
}

/** The URL → the board; defaults where it says nothing (or nonsense). */
export function parseLiveItemsState(params: URLSearchParams, today: string): LiveItemsState {
  const P = LIVE_ITEMS_PARAMS;
  const state = defaultLiveItemsState(today);
  state.companyId = id(params.get(P.companyId)) || null;
  state.shopId = id(params.get(P.shopId));
  const area = (params.get(P.areaId) ?? '').trim();
  state.areaId = area === 'none' || UUID.test(area) ? area : '';
  state.machineId = id(params.get(P.machineId));
  const period = params.get(P.period) as LivePeriod | null;
  if (period && LIVE_PERIODS.includes(period)) state.period = period;
  if (state.period === 'custom') {
    const from = params.get(P.from) ?? '';
    const to = params.get(P.to) ?? '';
    if (DAY.test(from)) state.from = from;
    if (DAY.test(to)) state.to = to;
  }
  state.q = (params.get(P.q) ?? '').slice(0, 120);
  const sort = params.get(P.sort) as LiveSortKey | null;
  if (sort && LIVE_SORTS.includes(sort)) state.sort = sort;
  state.desc = params.get(P.dir) !== 'asc';
  state.all = params.get(P.all) === '1';
  return state;
}

/**
 * The board → the URL: a copy of `params` with the board's keys rewritten, each only when it
 * is not the default, and every other key (the dashboard scope) left as it was.
 */
export function writeLiveItemsState(params: URLSearchParams, state: LiveItemsState, today: string): URLSearchParams {
  const P = LIVE_ITEMS_PARAMS;
  const next = new URLSearchParams(params.toString());
  for (const key of Object.values(P)) next.delete(key);
  const put = (key: string, value: string | null | undefined) => {
    if (value) next.set(key, value);
  };
  put(P.companyId, state.companyId);
  put(P.shopId, state.shopId);
  put(P.areaId, state.areaId);
  put(P.machineId, state.machineId);
  if (state.period !== 'today') put(P.period, state.period);
  if (state.period === 'custom') {
    put(P.from, state.from || today);
    put(P.to, state.to || today);
  }
  put(P.q, state.q.trim() ? state.q : '');
  if (state.sort !== 'net') put(P.sort, state.sort);
  if (!state.desc) put(P.dir, 'asc');
  if (state.all) put(P.all, '1');
  return next;
}

export interface LiveItemsApiParams {
  from?: string;
  to?: string;
  shift?: 'open';
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  limit: number;
}

/** What `GET /reports/live-items` gets: the scope (each only narrows), the period, the row limit. */
export function liveItemsApiParams(state: LiveItemsState, limit: number): LiveItemsApiParams {
  const out: LiveItemsApiParams = { limit };
  if (state.companyId) out.companyId = state.companyId;
  if (state.shopId) out.shopId = state.shopId;
  if (state.areaId) out.areaId = state.areaId;
  if (state.machineId) out.machineId = state.machineId;
  if (state.period === 'shift') out.shift = 'open';
  if (state.period === 'custom') {
    if (state.from) out.from = state.from;
    if (state.to) out.to = state.to;
  }
  return out;
}

/** The row figures the board sorts and sums. */
export interface LiveRowFigures {
  name?: string | null;
  sku?: string | null;
  qty: number;
  unitsSold: number;
  unitsRefunded: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
}

/** The board's order: by a figure (or the name, Hebrew order), largest first unless `desc` is off. */
export function sortLiveRows<R extends LiveRowFigures>(rows: readonly R[], key: LiveSortKey, desc: boolean): R[] {
  const sign = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (key === 'name') return sign * (a.name ?? '').localeCompare(b.name ?? '', 'he');
    return sign * (a[key] - b[key]);
  });
}

/** The rows whose name or SKU holds the search (`normalize`: the sidebar's own folding). */
export function searchLiveRows<R extends LiveRowFigures>(rows: readonly R[], q: string, normalize: (s: string) => string): R[] {
  const needle = normalize(q);
  if (!needle) return [...rows];
  return rows.filter((r) => normalize(r.name ?? '').includes(needle) || normalize(r.sku ?? '').includes(needle));
}

export type LiveTotals = Record<'qty' | 'unitsSold' | 'unitsRefunded' | 'gross' | 'discounts' | 'refunds' | 'net', number | null>;

/**
 * The totals row: the scope's own (every product, even past the row limit — the units sold
 * and refunded are not in them, so they stay empty) or, while searching, the sums of the
 * rows found.
 */
export function liveItemsTotals(
  rows: readonly LiveRowFigures[],
  scope: { qty: number; gross: number; discounts: number; refunds: number; net: number },
  searching: boolean,
): LiveTotals {
  if (!searching) {
    return {
      qty: scope.qty,
      unitsSold: null,
      unitsRefunded: null,
      gross: scope.gross,
      discounts: scope.discounts,
      refunds: scope.refunds,
      net: scope.net,
    };
  }
  const sum = (pick: (r: LiveRowFigures) => number) => Math.round(rows.reduce((n, r) => n + pick(r), 0) * 1000) / 1000;
  return {
    qty: sum((r) => r.qty),
    unitsSold: sum((r) => r.unitsSold),
    unitsRefunded: sum((r) => r.unitsRefunded),
    gross: sum((r) => r.gross),
    discounts: sum((r) => r.discounts),
    refunds: sum((r) => r.refunds),
    net: sum((r) => r.net),
  };
}
