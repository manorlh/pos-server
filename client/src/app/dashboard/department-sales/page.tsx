'use client';

/**
 * Sales by department (מכירות לפי מחלקה) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.5.
 *
 * The product report's line money, rolled up to each product's category: units, gross,
 * discounts, refunds, net and each one's share of the net.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, businessDaysBackIso, businessTodayIso, hourQueryParams } from '@/lib/reportWindow';
import { dayBasisQuery } from '@/lib/businessDay';
import { fetchDepartmentReport, type DepartmentReport } from '@/lib/salesReportsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function DepartmentSalesPage() {
  const t = useTranslations('departmentReport');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });

  const [filters, setFilters] = useState<ReportFiltersState>({
    from: businessDaysBackIso(6),
    to: businessTodayIso(),
    hours: WHOLE_DAY,
  });
  const [applied, setApplied] = useState<ReportFiltersState | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      from: applied.from,
      to: applied.to,
      ...(effective.shopId ? { shopId: effective.shopId } : {}),
      ...(effective.machineId ? { machineId: effective.machineId } : {}),
      ...hourQueryParams(applied.hours),
      ...dayBasisQuery(applied.dayBasis),
    };
  }, [applied, effective.shopId, effective.machineId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<DepartmentReport>({
    queryKey: ['report-departments', params],
    queryFn: () => fetchDepartmentReport(params!),
    enabled: params !== null,
  });

  const name = (n?: string | null) => n ?? t('noCategory');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <ReportFilters value={filters} onChange={setFilters} onRun={() => setApplied(filters)} isFetching={isFetching} />

        {!applied ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('selectFilters')}</p>
        ) : isLoading ? (
          <Skeleton className="h-64 w-full" />
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
                  { header: t('col.department'), width: 26 },
                  { header: t('col.units'), kind: 'number' },
                  { header: t('col.gross'), kind: 'money' },
                  { header: t('col.discounts'), kind: 'money' },
                  { header: t('col.refunds'), kind: 'money' },
                  { header: t('col.net'), kind: 'money' },
                  { header: t('col.share'), kind: 'percent' },
                ],
                rows: data.rows.map((r) => [
                  name(r.categoryName), r.units, r.gross, r.discounts, r.refunds, r.net, r.share,
                ]),
                totals: [
                  t('total'), data.totals.units, data.totals.gross, data.totals.discounts,
                  data.totals.refunds, data.totals.net, data.totals.share,
                ],
              })}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.department')}</TableHead>
                    <TableHead className="text-end">{t('col.units')}</TableHead>
                    <TableHead className="text-end">{t('col.gross')}</TableHead>
                    <TableHead className="text-end">{t('col.discounts')}</TableHead>
                    <TableHead className="text-end">{t('col.refunds')}</TableHead>
                    <TableHead className="text-end">{t('col.net')}</TableHead>
                    <TableHead className="w-48">{t('col.share')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                        {t('noRows')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.rows.map((r, i) => (
                      <TableRow key={r.categoryId ?? `none-${i}`}>
                        <TableCell className="font-medium">{name(r.categoryName)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatQuantity(r.units)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(r.gross)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {r.discounts ? formatCurrency(r.discounts) : '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {r.refunds ? formatCurrency(r.refunds) : '—'}
                        </TableCell>
                        <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.net)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                              <div
                                className="bg-primary h-2"
                                style={{ width: `${Math.min(100, Math.max(0, r.share))}%` }}
                              />
                            </div>
                            <span className="w-12 text-end text-xs tabular-nums">{r.share.toFixed(1)}%</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
                {data.rows.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">{t('total')}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatQuantity(data.totals.units)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.gross)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.discounts)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(data.totals.refunds)}</TableCell>
                      <TableCell className="text-end font-bold tabular-nums">{formatCurrency(data.totals.net)}</TableCell>
                      <TableCell />
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
