'use client';

/**
 * Product sales report — units and money per product over a day range, optionally
 * narrowed to the same band of hours on every one of those days.
 *
 * The totals come first and the per-product table second, on purpose: the first
 * question a manager asks is "what did we take", not "what did product #7 do".
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): days, hours, area, cashier
 * (`cashierId`, §4.1), department and a search in the URL, with the row cap and "meals as…".
 * The endpoint has no department filter, so a department narrows the rows on the page (the
 * department's products and its sub-departments') and the totals are then the shown rows'.
 * No tips here: a tip belongs to no item (§2ה).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, Coins, Info, Package, RotateCcw, Wallet } from 'lucide-react';
import { api, fetchProductSalesReport } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { descendantIds } from '@/lib/categoryTree';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ProductSalesReport, ProductSalesRow, ProductSalesTotals } from '@/lib/types';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportTruncatedNotice, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useCategoryOptions,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const LIMIT_OPTIONS = [50, 100, 200, 500, 1000];

const SPEC: ReportFilterSpec = {
  filters: ['hours', 'area', 'cashier', 'category', 'search'],
  clientFilters: ['category', 'search'],
  // A meal as its components (burgers inside meals count as burgers) or as the meal.
  extras: { limit: '200', meals: 'components' },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The totals of the rows a department left. */
function sumRows(rows: ProductSalesRow[]): ProductSalesTotals {
  const sum = (pick: (r: ProductSalesRow) => number) => round2(rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0));
  return {
    unitsSold: sum((r) => r.unitsSold),
    unitsRefunded: sum((r) => r.unitsRefunded),
    unitsNet: sum((r) => r.unitsNet),
    gross: sum((r) => r.gross),
    discounts: sum((r) => r.discounts),
    refunds: sum((r) => r.refunds),
    net: sum((r) => r.net),
    productCount: rows.length,
  };
}

/** The ids of a department's products, its sub-departments' included. */
function useCategoryProductIds(categoryId: string) {
  const { categories } = useCategoryOptions(Boolean(categoryId));
  const ids = useMemo(
    () => (categoryId && categories.length ? [categoryId, ...descendantIds(categories, categoryId)] : []),
    [categories, categoryId],
  );
  return useQuery<Set<string>>({
    queryKey: ['report-category-products', ids],
    queryFn: async () => {
      const rows = await fetchAllPages(async (page, pageSize) => {
        const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
        for (const id of ids) search.append('categoryIds', id);
        const { data } = await api.get<{ items: { id: string }[]; total: number }>(`/products?${search.toString()}`);
        return { items: data.items ?? [], total: data.total ?? 0 };
      });
      return new Set(rows.map((p) => String(p.id)));
    },
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
  });
}

export default function ProductSalesReportPage() {
  const t = useTranslations('productSales');

  // shopId / machineId, or a company (§4.1: and its subsidiaries).
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const params = useMemo(() => {
    if (!filters.apiParams || !filters.applied) return null;
    const ex = filters.applied.extras;
    return {
      ...filters.apiParams,
      ...scopeApiParams(effective),
      limit: Number(ex.limit) || 200,
      meals: ex.meals === 'meals' ? ('meals' as const) : ('components' as const),
    };
  }, [effective, filters.apiParams, filters.applied]);

  const query = useQuery<ProductSalesReport>({
    queryKey: ['report-products', params],
    queryFn: () => fetchProductSalesReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const categoryId = filters.applied?.values.categoryId ?? '';
  const inCategory = useCategoryProductIds(categoryId);
  const byCategory = Boolean(categoryId);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    if (!byCategory) return all;
    const ids = inCategory.data;
    return ids ? all.filter((r) => r.productId && ids.has(r.productId)) : [];
  }, [byCategory, data, inCategory.data]);
  const totals = useMemo(() => (data ? (byCategory ? sumRows(rows) : data.totals) : null), [byCategory, data, rows]);

  const table = useMemo<ReportTableSpec<ProductSalesRow>>(() => {
    const dashZero = (pick: (r: ProductSalesRow) => number, format: (n: number) => string) => (r: ProductSalesRow) =>
      pick(r) ? format(pick(r)) : '—';
    const columns: ReportColumn<ProductSalesRow>[] = [
      { key: 'product', header: t('col.product'), required: true, width: 30, value: (r) => r.productName ?? t('unknownProduct'), className: 'font-medium' },
      { key: 'sku', header: t('col.sku'), width: 14, value: (r) => r.sku ?? null, className: 'text-muted-foreground text-xs' },
      {
        key: 'unitsSold',
        header: t('col.unitsSold'),
        kind: 'number',
        value: (r) => r.unitsSold,
        total: totals?.unitsSold,
        cell: (r) => (
          <>
            {formatQuantity(r.unitsSold)}
            {r.unitsInMeals ? (
              <span className="text-muted-foreground block text-[11px]">
                {t('meals.inMeals', { n: formatQuantity(r.unitsInMeals) })}
              </span>
            ) : null}
          </>
        ),
      },
      {
        key: 'unitsRefunded',
        header: t('col.unitsRefunded'),
        kind: 'number',
        value: (r) => r.unitsRefunded,
        total: totals?.unitsRefunded,
        cell: dashZero((r) => r.unitsRefunded, formatQuantity),
      },
      { key: 'unitsNet', header: t('col.unitsNet'), kind: 'number', value: (r) => r.unitsNet, total: totals?.unitsNet, className: 'font-medium' },
      { key: 'gross', header: t('col.gross'), kind: 'money', value: (r) => r.gross, total: totals?.gross },
      {
        key: 'discounts',
        header: t('col.discounts'),
        kind: 'money',
        value: (r) => r.discounts,
        total: totals?.discounts,
        cell: dashZero((r) => r.discounts, formatCurrency),
      },
      {
        key: 'refunds',
        header: t('col.refunds'),
        kind: 'money',
        value: (r) => r.refunds,
        total: totals?.refunds,
        cell: dashZero((r) => r.refunds, formatCurrency),
      },
      { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: totals?.net, className: 'font-semibold' },
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows,
      rowKey: (r, i) => r.productId ?? `row-${i}`,
      totalsLabel: data?.truncated && !byCategory ? t('footerTotalsTruncated') : t('footerTotals'),
      emptyText: t('noRows'),
    };
  }, [byCategory, data?.truncated, rows, t, totals]);

  const draftExtras = filters.draftExtras;
  const limitItems = LIMIT_OPTIONS.map((n) => ({ value: String(n), label: String(n) }));
  const mealItems = [
    { value: 'components', label: t('meals.components') },
    { value: 'meals', label: t('meals.meals') },
  ];

  return (
    <ReportPage
      reportKey="product-sales"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{
        shopId: effective.shopId,
        children: (
          <>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">{t('rowLimit')}</Label>
              <Select value={draftExtras.limit} onValueChange={(v) => filters.setExtra('limit', String(v ?? '200'))} items={limitItems}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {limitItems.map((o) => (
                    <SelectItem key={o.value} value={o.value} label={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="text-xs">{t('meals.label')}</Label>
              <Select
                value={draftExtras.meals}
                onValueChange={(v) => filters.setExtra('meals', v === 'meals' ? 'meals' : 'components')}
                items={mealItems}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mealItems.map((o) => (
                    <SelectItem key={o.value} value={o.value} label={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        ),
      }}
      query={{
        ...reportQueryState(query),
        isLoading: query.isLoading || (byCategory && inCategory.isLoading),
        isError: query.isError || inCategory.isError,
        error: query.error ?? inCategory.error,
      }}
      prompt={t('selectFilters')}
      export={data ? { tables: [table], from: data.window.from, to: data.window.to } : null}
    >
      {data && totals ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          {/* Totals first — this is the answer to "what did we take". */}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <ReportStatCard
              title={t('totals.net')}
              value={formatCurrency(totals.net)}
              subtitle={t('totals.netFormula')}
              icon={Wallet}
              emphasis
            />
            <ReportStatCard title={t('totals.gross')} value={formatCurrency(totals.gross)} icon={Coins} />
            <ReportStatCard title={t('totals.discounts')} value={formatCurrency(totals.discounts)} icon={BadgePercent} />
            <ReportStatCard
              title={t('totals.refunds')}
              value={formatCurrency(totals.refunds)}
              subtitle={t('totals.refundsNote')}
              icon={RotateCcw}
            />
            <ReportStatCard
              title={t('totals.unitsNet')}
              value={formatQuantity(totals.unitsNet)}
              subtitle={t('totals.unitsBreakdown', {
                sold: formatQuantity(totals.unitsSold),
                refunded: formatQuantity(totals.unitsRefunded),
                products: totals.productCount,
              })}
              icon={Package}
            />
          </div>

          {byCategory ? (
            <p role="note" className="text-muted-foreground flex gap-2 text-xs">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {data.truncated ? t('categoryNoteTruncated', { rowLimit: data.rowLimit }) : t('categoryNote')}
            </p>
          ) : null}

          {data.truncated ? (
            <ReportTruncatedNotice
              rowLimit={data.rowLimit}
              visibleRows={data.rows.length}
              totalCount={data.totals.productCount}
            />
          ) : null}

          <ReportTable table={table} />
        </>
      ) : null}
    </ReportPage>
  );
}
