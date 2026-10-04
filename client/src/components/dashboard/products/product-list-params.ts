'use client';

/**
 * The products page's search, filters and paging, kept in the URL query so they survive
 * a reload and the back button. The dashboard scope's own params (company / shop /
 * machine) sit beside these and are left alone.
 *
 * Every key is short and prefixed-free on purpose — they are read by people pasting
 * links — but none collides with `SCOPE_PARAM`.
 */

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { OrgScope } from '@/components/dashboard/org-scope-cascade';
import { deepestOrgScope, EMPTY_ORG_SCOPE } from '@/components/dashboard/org-scope-cascade';

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 50;

/** The "category" filter's id for products whose category is gone. */
export const UNCATEGORIZED = '__none__';

export type StatusFilter = 'all' | 'active' | 'inactive';
export type LevelFilter = 'all' | 'global' | 'local';

export interface ProductListFilters {
  q: string;
  /** Category ids, plus `UNCATEGORIZED`. Empty = every category. */
  categories: string[];
  status: StatusFilter;
  level: LevelFilter;
  /** "Available at": company › shop › area › till; the deepest one chosen counts. */
  availableAt: OrgScope;
  page: number;
  pageSize: PageSize;
}

const KEYS = {
  q: 'q',
  categories: 'cat',
  status: 'status',
  level: 'level',
  company: 'atCompany',
  shop: 'atShop',
  area: 'atArea',
  machine: 'atTill',
  page: 'page',
  pageSize: 'size',
} as const;

function readFilters(params: URLSearchParams): ProductListFilters {
  const status = params.get(KEYS.status);
  const level = params.get(KEYS.level);
  const size = Number(params.get(KEYS.pageSize));
  const page = Number(params.get(KEYS.page));
  return {
    q: params.get(KEYS.q) ?? '',
    categories: (params.get(KEYS.categories) ?? '').split(',').filter(Boolean),
    status: status === 'active' || status === 'inactive' ? status : 'all',
    level: level === 'global' || level === 'local' ? level : 'all',
    availableAt: {
      companyId: params.get(KEYS.company) ?? '',
      shopId: params.get(KEYS.shop) ?? '',
      areaId: params.get(KEYS.area) ?? '',
      machineId: params.get(KEYS.machine) ?? '',
    },
    page: Number.isInteger(page) && page > 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? (size as PageSize) : DEFAULT_PAGE_SIZE,
  };
}

/** `availableAt` as the API takes it — `"shop:<id>"` — or undefined. */
export function availableAtParam(scope: OrgScope): string | undefined {
  const deepest = deepestOrgScope(scope);
  if (!deepest || deepest.level === 'tenant' || !deepest.id) return undefined;
  return `${deepest.level}:${deepest.id}`;
}

/** The `GET /products` query for these filters. */
export function productListQuery(f: ProductListFilters): Record<string, unknown> {
  const params: Record<string, unknown> = { page: f.page, pageSize: f.pageSize };
  if (f.q.trim()) params.search = f.q.trim();
  const ids = f.categories.filter((c) => c !== UNCATEGORIZED);
  if (ids.length) params.categoryIds = ids;
  if (f.categories.includes(UNCATEGORIZED)) params.uncategorized = true;
  if (f.status !== 'all') params.status = f.status;
  if (f.level !== 'all') params.catalogLevel = f.level;
  const at = availableAtParam(f.availableAt);
  if (at) params.availableAt = at;
  return params;
}

/** How many filters (not search, not paging) are set — for the mobile "filters" button. */
export function activeFilterCount(f: ProductListFilters): number {
  return (
    (f.categories.length ? 1 : 0) +
    (f.status !== 'all' ? 1 : 0) +
    (f.level !== 'all' ? 1 : 0) +
    (availableAtParam(f.availableAt) ? 1 : 0)
  );
}

export function useProductListParams() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = useMemo(() => readFilters(new URLSearchParams(searchParams.toString())), [searchParams]);

  /** Change some filters. Anything but `page` itself starts over at page 1. */
  const setFilters = useCallback(
    (patch: Partial<ProductListFilters>) => {
      const next = new URLSearchParams(searchParams.toString());
      const put = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
      if ('q' in patch) put(KEYS.q, patch.q?.trim() ? patch.q : null);
      if ('categories' in patch) put(KEYS.categories, patch.categories?.length ? patch.categories.join(',') : null);
      if ('status' in patch) put(KEYS.status, patch.status && patch.status !== 'all' ? patch.status : null);
      if ('level' in patch) put(KEYS.level, patch.level && patch.level !== 'all' ? patch.level : null);
      if ('availableAt' in patch) {
        const at = patch.availableAt ?? EMPTY_ORG_SCOPE;
        put(KEYS.company, at.companyId || null);
        put(KEYS.shop, at.shopId || null);
        put(KEYS.area, at.areaId || null);
        put(KEYS.machine, at.machineId || null);
      }
      if ('pageSize' in patch) {
        put(KEYS.pageSize, patch.pageSize && patch.pageSize !== DEFAULT_PAGE_SIZE ? String(patch.pageSize) : null);
      }
      const nextPage = 'page' in patch ? (patch.page ?? 1) : 1;
      put(KEYS.page, nextPage > 1 ? String(nextPage) : null);
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const clearFilters = useCallback(
    () =>
      setFilters({ q: '', categories: [], status: 'all', level: 'all', availableAt: EMPTY_ORG_SCOPE }),
    [setFilters],
  );

  return { filters, setFilters, clearFilters };
}
