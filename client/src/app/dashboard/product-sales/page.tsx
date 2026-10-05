'use client';

/**
 * Product sales report — units and money per product over a day range, optionally
 * narrowed to the same band of hours on every one of those days.
 *
 * The totals come first and the per-product table second, on purpose: the first
 * question a manager asks is "what did we take", not "what did product #7 do".
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, Coins, Package, RotateCcw, Wallet } from 'lucide-react';
import { fetchProductSalesReport } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, daysBackIso, hourQueryParams, todayIso } from '@/lib/reportWindow';
import type { ProductSalesReport } from '@/lib/types';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import {
  ReportErrorState,
  ReportTruncatedNotice,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

const LIMIT_OPTIONS = [50, 100, 200, 500, 1000];
const COLS = 9;

export default function ProductSalesReportPage() {
  const t = useTranslations('productSales');
  const tc = useTranslations('common');

  // `GET /reports/products` takes shopId and machineId; it has no company filter,
  // so a company in scope is reported as inapplicable rather than quietly ignored.
  const { resolution, effective } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const scopeShopId = effective.shopId;
  const scopeMachineId = effective.machineId;

  const [filters, setFilters] = useState<ReportFiltersState>({
    from: daysBackIso(6),
    to: todayIso(),
    hours: WHOLE_DAY,
  });
  const [limit, setLimit] = useState(200);
  // A meal as its components (burgers inside meals count as burgers) or as the meal.
  const [meals, setMeals] = useState<'components' | 'meals'>('components');
  const [applied, setApplied] = useState<{ filters: ReportFiltersState; limit: number; meals: 'components' | 'meals' } | null>(
    null,
  );

  const params = useMemo(() => {
    if (!applied) return null;
    const f = applied.filters;
    return {
      from: f.from,
      to: f.to,
      ...(scopeShopId ? { shopId: scopeShopId } : {}),
      ...(scopeMachineId ? { machineId: scopeMachineId } : {}),
      ...hourQueryParams(f.hours),
      ...(f.areaId ? { areaId: f.areaId } : {}),
      limit: applied.limit,
      meals: applied.meals,
    };
  }, [applied, scopeMachineId, scopeShopId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<ProductSalesReport>({
    queryKey: ['report-products', params],
    queryFn: () => fetchProductSalesReport(params!),
    enabled: params !== null,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <ReportFilters
          value={filters}
          onChange={setFilters}
          onRun={() => setApplied({ filters, limit, meals })}
          isFetching={isFetching}
          showArea
          areaShopId={scopeShopId}
        >
          <div className="space-y-1">
            <Label className="text-xs">{t('rowLimit')}</Label>
            <Select
              value={String(limit)}
              onValueChange={(v) => setLimit(Number(v ?? 200))}
              items={LIMIT_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)} label={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('meals.label')}</Label>
            <Select
              value={meals}
              onValueChange={(v) => setMeals(v === 'meals' ? 'meals' : 'components')}
              items={[
                { value: 'components', label: t('meals.components') },
                { value: 'meals', label: t('meals.meals') },
              ]}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="components" label={t('meals.components')}>
                  {t('meals.components')}
                </SelectItem>
                <SelectItem value="meals" label={t('meals.meals')}>
                  {t('meals.meals')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </ReportFilters>

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('selectFilters')}</p>
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : data ? (
          <div className="space-y-4">
            <ReportExportToolbar
              title={t('title')}
              from={data.window.from}
              to={data.window.to}
              getSheets={() => ({
                name: t('title'),
                columns: [
                  { header: t('col.product'), width: 30 },
                  { header: t('col.sku'), width: 14 },
                  { header: t('col.unitsSold'), kind: 'number' },
                  { header: t('col.unitsRefunded'), kind: 'number' },
                  { header: t('col.unitsNet'), kind: 'number' },
                  { header: t('col.gross'), kind: 'money' },
                  { header: t('col.discounts'), kind: 'money' },
                  { header: t('col.refunds'), kind: 'money' },
                  { header: t('col.net'), kind: 'money' },
                ],
                rows: data.rows.map((r) => [
                  r.productName ?? t('unknownProduct'), r.sku ?? null, r.unitsSold, r.unitsRefunded,
                  r.unitsNet, r.gross, r.discounts, r.refunds, r.net,
                ]),
                totals: [
                  data.truncated ? t('footerTotalsTruncated') : t('footerTotals'), null,
                  data.totals.unitsSold, data.totals.unitsRefunded, data.totals.unitsNet,
                  data.totals.gross, data.totals.discounts, data.totals.refunds, data.totals.net,
                ],
              })}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            {/* Totals first — this is the answer to "what did we take". */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <ReportStatCard
                title={t('totals.net')}
                value={formatCurrency(data.totals.net)}
                subtitle={t('totals.netFormula')}
                icon={Wallet}
                emphasis
              />
              <ReportStatCard
                title={t('totals.gross')}
                value={formatCurrency(data.totals.gross)}
                icon={Coins}
              />
              <ReportStatCard
                title={t('totals.discounts')}
                value={formatCurrency(data.totals.discounts)}
                icon={BadgePercent}
              />
              <ReportStatCard
                title={t('totals.refunds')}
                value={formatCurrency(data.totals.refunds)}
                subtitle={t('totals.refundsNote')}
                icon={RotateCcw}
              />
              <ReportStatCard
                title={t('totals.unitsNet')}
                value={formatQuantity(data.totals.unitsNet)}
                subtitle={t('totals.unitsBreakdown', {
                  sold: formatQuantity(data.totals.unitsSold),
                  refunded: formatQuantity(data.totals.unitsRefunded),
                  products: data.totals.productCount,
                })}
                icon={Package}
              />
            </div>

            {data.truncated ? (
              <ReportTruncatedNotice
                rowLimit={data.rowLimit}
                visibleRows={data.rows.length}
                totalCount={data.totals.productCount}
              />
            ) : null}

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.product')}</TableHead>
                    <TableHead>{t('col.sku')}</TableHead>
                    <TableHead className="text-end">{t('col.unitsSold')}</TableHead>
                    <TableHead className="text-end">{t('col.unitsRefunded')}</TableHead>
                    <TableHead className="text-end">{t('col.unitsNet')}</TableHead>
                    <TableHead className="text-end">{t('col.gross')}</TableHead>
                    <TableHead className="text-end">{t('col.discounts')}</TableHead>
                    <TableHead className="text-end">{t('col.refunds')}</TableHead>
                    <TableHead className="text-end">{t('col.net')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLS} className="text-muted-foreground py-10 text-center">
                        {t('noRows')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.rows.map((row, i) => (
                      <TableRow key={row.productId ?? `row-${i}`}>
                        <TableCell className="font-medium">
                          {row.productName ?? t('unknownProduct')}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {row.sku ?? '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatQuantity(row.unitsSold)}
                          {row.unitsInMeals ? (
                            <span className="text-muted-foreground block text-[11px]">
                              {t('meals.inMeals', { n: formatQuantity(row.unitsInMeals) })}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.unitsRefunded ? formatQuantity(row.unitsRefunded) : '—'}
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums">
                          {formatQuantity(row.unitsNet)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatCurrency(row.gross)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.discounts ? formatCurrency(row.discounts) : '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.refunds ? formatCurrency(row.refunds) : '—'}
                        </TableCell>
                        <TableCell className="text-end font-semibold tabular-nums">
                          {formatCurrency(row.net)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
                {data.rows.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">
                        {data.truncated ? t('footerTotalsTruncated') : t('footerTotals')}
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-end tabular-nums">
                        {formatQuantity(data.totals.unitsSold)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatQuantity(data.totals.unitsRefunded)}
                      </TableCell>
                      <TableCell className="text-end font-medium tabular-nums">
                        {formatQuantity(data.totals.unitsNet)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(data.totals.gross)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(data.totals.discounts)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(data.totals.refunds)}
                      </TableCell>
                      <TableCell className="text-end font-bold tabular-nums">
                        {formatCurrency(data.totals.net)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                ) : null}
              </Table>
            </div>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
