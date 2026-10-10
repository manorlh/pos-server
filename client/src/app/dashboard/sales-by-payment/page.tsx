'use client';

/**
 * Sales by payment method (מכירות לפי אמצעי תשלום) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.1.
 *
 * Net takings per tender, from the tender legs (a credit note's legs subtract), so the
 * total is the per-cashier report's net for the same window. The breakdown is per local
 * day, shop and till; the cards are the window's totals per method.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, daysBackIso, hourQueryParams, todayIso } from '@/lib/reportWindow';
import { fetchPaymentMethodsReport, type PaymentMethodsReport } from '@/lib/salesReportsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { Card, CardContent } from '@/components/ui/card';
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

const BAR = { cash: 'bg-emerald-500', card: 'bg-blue-500', exchange: 'bg-slate-400', production_voucher: 'bg-violet-500', other: 'bg-amber-500' };

export default function SalesByPaymentPage() {
  const t = useTranslations('paymentReport');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });

  const [filters, setFilters] = useState<ReportFiltersState>({
    from: daysBackIso(6),
    to: todayIso(),
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
    };
  }, [applied, effective.shopId, effective.machineId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<PaymentMethodsReport>({
    queryKey: ['report-payment-methods', params],
    queryFn: () => fetchPaymentMethodsReport(params!),
    enabled: params !== null,
  });

  const methodLabel = (m: string) => (t.has(`method.${m}`) ? t(`method.${m}`) : m);

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
          onRun={() => setApplied(filters)}
          isFetching={isFetching}
        />

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
                {
                  name: t('totalsTitle'),
                  columns: [
                    { header: t('col.method') },
                    { header: t('col.amount'), kind: 'money' },
                    { header: t('col.documents'), kind: 'number' },
                    { header: t('col.share'), kind: 'percent' },
                  ],
                  rows: data.totals.map((r) => [methodLabel(r.method), r.amount, r.documents, r.share]),
                  totals: [t('total'), data.total, null, 100],
                },
                {
                  name: t('breakdownTitle'),
                  columns: [
                    { header: t('col.day'), kind: 'date' },
                    { header: t('col.shop') },
                    { header: t('col.till') },
                    { header: t('col.method') },
                    { header: t('col.amount'), kind: 'money' },
                    { header: t('col.documents'), kind: 'number' },
                  ],
                  rows: data.rows.map((r) => [
                    r.day, r.shopName ?? null, r.machineName ?? null, methodLabel(r.method), r.amount, r.documents,
                  ]),
                  totals: [t('total'), null, null, null, data.total, null],
                },
              ]}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {data.totals.map((m) => (
                <Card key={m.method}>
                  <CardContent className="space-y-2 pt-6">
                    <div className="text-muted-foreground text-sm">{methodLabel(m.method)}</div>
                    <div className="text-2xl font-bold tabular-nums">{formatCurrency(m.amount)}</div>
                    <div className="bg-muted h-2 overflow-hidden rounded-full">
                      <div
                        className={`h-2 ${BAR[m.bucket] ?? BAR.other}`}
                        style={{ width: `${Math.min(100, Math.max(0, m.share))}%` }}
                      />
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {t('shareOf', { share: m.share.toFixed(1), documents: m.documents })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.day')}</TableHead>
                    <TableHead>{t('col.shop')}</TableHead>
                    <TableHead>{t('col.till')}</TableHead>
                    <TableHead>{t('col.method')}</TableHead>
                    <TableHead className="text-end">{t('col.amount')}</TableHead>
                    <TableHead className="text-end">{t('col.documents')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                        {t('noRows')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.rows.map((r, i) => (
                      <TableRow key={`${r.day}-${r.machineId}-${r.method}-${i}`}>
                        <TableCell className="whitespace-nowrap">{formatDate(r.day)}</TableCell>
                        <TableCell className="text-muted-foreground">{r.shopName ?? '—'}</TableCell>
                        <TableCell>{r.machineName ?? '—'}</TableCell>
                        <TableCell>{methodLabel(r.method)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(r.amount)}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatQuantity(r.documents)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
                {data.rows.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={4} className="font-semibold">
                        {t('total')}
                      </TableCell>
                      <TableCell className="text-end font-bold tabular-nums">
                        {formatCurrency(data.total)}
                      </TableCell>
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
