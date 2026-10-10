'use client';

/**
 * Clearing report (דוח סליקה) — card takings per brand (מותג) and per acquirer
 * (חברת סליקה), sales and credit notes apart, per shop. For reconciling with the card
 * companies' settlement reports. Server: `GET /reports/card-brands`.
 *
 * The brand and acquirer come from the terminal's reply (`mutag` / `solek`), else the
 * card's BIN; "לא ידוע" is a leg whose reply named neither. Tips are not card legs, so
 * the net is the card total of "sales by payment method" for the same window.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, businessDaysBackIso, businessTodayIso, hourQueryParams } from '@/lib/reportWindow';
import { dayBasisQuery } from '@/lib/businessDay';
import { useCardBrandLabels } from '@/lib/cardBrands';
import { fetchCardBrandsReport, type CardBrandTotal, type CardBrandsReport } from '@/lib/salesReportsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportErrorState, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

function TotalsTable({
  title,
  rows,
  label,
  report,
}: {
  title: string;
  rows: CardBrandTotal[];
  label: (code: string) => string;
  report: CardBrandsReport;
}) {
  const t = useTranslations('cardBrandsReport');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{title}</TableHead>
              <TableHead className="text-end">{t('col.salesCount')}</TableHead>
              <TableHead className="text-end">{t('col.salesAmount')}</TableHead>
              <TableHead className="text-end">{t('col.refundsCount')}</TableHead>
              <TableHead className="text-end">{t('col.refundsAmount')}</TableHead>
              <TableHead className="text-end">{t('col.net')}</TableHead>
              <TableHead className="text-end">{t('col.share')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{label(r.key)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatQuantity(r.salesCount)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatCurrency(r.salesAmount)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatQuantity(r.refundsCount)}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {r.refundsAmount ? formatCurrency(-r.refundsAmount) : '—'}
                </TableCell>
                <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.net)}</TableCell>
                <TableCell className="text-end tabular-nums">{r.share.toFixed(1)}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{t('total')}</TableCell>
              <TableCell className="text-end tabular-nums">{formatQuantity(report.salesCount)}</TableCell>
              <TableCell className="text-end tabular-nums">{formatCurrency(report.salesAmount)}</TableCell>
              <TableCell className="text-end tabular-nums">{formatQuantity(report.refundsCount)}</TableCell>
              <TableCell className="text-end tabular-nums">
                {report.refundsAmount ? formatCurrency(-report.refundsAmount) : '—'}
              </TableCell>
              <TableCell className="text-end font-bold tabular-nums">{formatCurrency(report.net)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function CardBrandsReportPage() {
  const t = useTranslations('cardBrandsReport');
  const tc = useTranslations('common');
  const labels = useCardBrandLabels();
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

  const { data, isLoading, isFetching, isError, error } = useQuery<CardBrandsReport>({
    queryKey: ['report-card-brands', params],
    queryFn: () => fetchCardBrandsReport(params!),
    enabled: params !== null,
  });

  const totalsSheet = (name: string, rows: CardBrandTotal[], label: (c: string) => string, report: CardBrandsReport) => ({
    name,
    columns: [
      { header: name },
      { header: t('col.salesCount'), kind: 'number' as const },
      { header: t('col.salesAmount'), kind: 'money' as const },
      { header: t('col.refundsCount'), kind: 'number' as const },
      { header: t('col.refundsAmount'), kind: 'money' as const },
      { header: t('col.net'), kind: 'money' as const },
      { header: t('col.share'), kind: 'percent' as const },
    ],
    rows: rows.map((r) => [label(r.key), r.salesCount, r.salesAmount, r.refundsCount, r.refundsAmount, r.net, r.share]),
    totals: [t('total'), report.salesCount, report.salesAmount, report.refundsCount, report.refundsAmount, report.net, 100],
  });

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
              getSheets={() => [
                totalsSheet(t('byAcquirer'), data.byAcquirer, labels.acquirer, data),
                totalsSheet(t('byBrand'), data.byBrand, labels.brand, data),
                {
                  name: t('breakdownTitle'),
                  columns: [
                    { header: t('col.shop') },
                    { header: t('col.acquirer') },
                    { header: t('col.brand') },
                    { header: t('col.salesCount'), kind: 'number' },
                    { header: t('col.salesAmount'), kind: 'money' },
                    { header: t('col.refundsCount'), kind: 'number' },
                    { header: t('col.refundsAmount'), kind: 'money' },
                    { header: t('col.net'), kind: 'money' },
                  ],
                  rows: data.rows.map((r) => [
                    r.shopName ?? null,
                    labels.acquirer(r.acquirer),
                    labels.brand(r.brand),
                    r.salesCount,
                    r.salesAmount,
                    r.refundsCount,
                    r.refundsAmount,
                    r.net,
                  ]),
                  totals: [t('total'), null, null, data.salesCount, data.salesAmount, data.refundsCount, data.refundsAmount, data.net],
                },
              ]}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            {data.rows.length === 0 ? (
              <p className="text-muted-foreground py-10 text-center text-sm">{t('noRows')}</p>
            ) : (
              <>
                <TotalsTable title={t('byAcquirer')} rows={data.byAcquirer} label={labels.acquirer} report={data} />
                <TotalsTable title={t('byBrand')} rows={data.byBrand} label={labels.brand} report={data} />

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{t('breakdownTitle')}</CardTitle>
                  </CardHeader>
                  <CardContent className="overflow-x-auto p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('col.shop')}</TableHead>
                          <TableHead>{t('col.acquirer')}</TableHead>
                          <TableHead>{t('col.brand')}</TableHead>
                          <TableHead className="text-end">{t('col.salesAmount')}</TableHead>
                          <TableHead className="text-end">{t('col.refundsAmount')}</TableHead>
                          <TableHead className="text-end">{t('col.net')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.rows.map((r, i) => (
                          <TableRow key={`${r.shopId}-${r.acquirer}-${r.brand}-${i}`}>
                            <TableCell className="text-muted-foreground">{r.shopName ?? '—'}</TableCell>
                            <TableCell>{labels.acquirer(r.acquirer)}</TableCell>
                            <TableCell>{labels.brand(r.brand)}</TableCell>
                            <TableCell className="text-end tabular-nums">
                              {formatCurrency(r.salesAmount)}{' '}
                              <span className="text-muted-foreground text-xs">({r.salesCount})</span>
                            </TableCell>
                            <TableCell className="text-end tabular-nums">
                              {r.refundsCount ? (
                                <>
                                  {formatCurrency(-r.refundsAmount)}{' '}
                                  <span className="text-muted-foreground text-xs">({r.refundsCount})</span>
                                </>
                              ) : (
                                '—'
                              )}
                            </TableCell>
                            <TableCell className="text-end font-medium tabular-nums">{formatCurrency(r.net)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
