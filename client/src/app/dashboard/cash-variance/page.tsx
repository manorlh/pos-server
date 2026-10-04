'use client';

/**
 * Cash differences (הפרשי קופה) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.8.
 *
 * Expected vs counted for every closed shift in the range, and per cashier the overs,
 * the shorts and the net. An uncounted shift (closed with nobody at the drawer) has no
 * difference — it is shown as such, never as a balanced zero.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchCashVarianceReport, type CashVarianceReport } from '@/lib/salesReportsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { RangeFilter, type DayRange } from '@/components/dashboard/range-filter';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { Scale } from 'lucide-react';
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

function Variance({ value, uncounted }: { value?: number | null; uncounted: string }) {
  if (value == null) return <span className="text-muted-foreground text-xs">{uncounted}</span>;
  const tone = value === 0 ? '' : value > 0 ? 'text-emerald-700' : 'text-destructive';
  return (
    <span className={`tabular-nums ${tone}`}>
      {value > 0 ? '+' : ''}
      {formatCurrency(value)}
    </span>
  );
}

export default function CashVariancePage() {
  const t = useTranslations('cashVarianceReport');
  const tc = useTranslations('common');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });

  const [range, setRange] = useState<DayRange>({ from: daysBackIso(29), to: todayIso() });
  const [applied, setApplied] = useState<DayRange | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      ...applied,
      ...(effective.shopId ? { shopId: effective.shopId } : {}),
      ...(effective.machineId ? { machineId: effective.machineId } : {}),
    };
  }, [applied, effective.shopId, effective.machineId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<CashVarianceReport>({
    queryKey: ['report-cash-variance', params],
    queryFn: () => fetchCashVarianceReport(params!),
    enabled: params !== null,
  });

  const who = (c?: string | null) => c || t('unknownCashier');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <RangeFilter
          value={range}
          onChange={setRange}
          onRun={() => setApplied(range)}
          isFetching={isFetching}
          hint={t('dateHint')}
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
                  name: t('byCashierTitle'),
                  columns: [
                    { header: t('col.cashier') },
                    { header: t('col.shifts'), kind: 'number' },
                    { header: t('col.counted'), kind: 'number' },
                    { header: t('col.over'), kind: 'money' },
                    { header: t('col.short'), kind: 'money' },
                    { header: t('col.net'), kind: 'money' },
                  ],
                  rows: data.byCashier.map((r) => [who(r.cashier), r.shifts, r.countedShifts, r.over, r.short, r.net]),
                  totals: [
                    t('total'), data.shifts.length, data.shifts.length - data.uncounted,
                    data.byCashier.reduce((s, r) => s + r.over, 0),
                    data.byCashier.reduce((s, r) => s + r.short, 0), data.totalVariance,
                  ],
                },
                {
                  name: t('shiftsTitle'),
                  columns: [
                    { header: t('col.date'), kind: 'date' },
                    { header: t('col.shop') },
                    { header: t('col.till') },
                    { header: t('col.shift'), kind: 'number' },
                    { header: t('col.cashier') },
                    { header: t('col.closedAt'), kind: 'datetime' },
                    { header: t('col.expected'), kind: 'money' },
                    { header: t('col.countedCash'), kind: 'money' },
                    { header: t('col.variance'), kind: 'money' },
                  ],
                  rows: data.shifts.map((s) => [
                    s.businessDate, s.shopName ?? null, s.machineName ?? null, s.sequenceNumber ?? null,
                    who(s.cashier), s.closedAt ?? null, s.expectedCash ?? null, s.countedCash ?? null,
                    s.variance ?? null,
                  ]),
                  totals: [t('total'), null, null, null, null, null, null, null, data.totalVariance],
                },
              ]}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

            <div className="grid gap-4 md:grid-cols-3">
              <ReportStatCard
                title={t('totalVariance')}
                value={formatCurrency(data.totalVariance)}
                subtitle={t('uncountedNote', { count: data.uncounted })}
                icon={Scale}
                emphasis
              />
            </div>

            <div className="rounded-lg border bg-card overflow-x-auto">
              <h2 className="px-4 pt-3 text-sm font-medium">{t('byCashierTitle')}</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.cashier')}</TableHead>
                    <TableHead className="text-end">{t('col.shifts')}</TableHead>
                    <TableHead className="text-end">{t('col.counted')}</TableHead>
                    <TableHead className="text-end">{t('col.over')}</TableHead>
                    <TableHead className="text-end">{t('col.short')}</TableHead>
                    <TableHead className="text-end">{t('col.net')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byCashier.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                        {t('noRows')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.byCashier.map((r) => (
                      <TableRow key={r.cashier ?? '__none__'}>
                        <TableCell className="font-medium">{who(r.cashier)}</TableCell>
                        <TableCell className="text-end tabular-nums">{r.shifts}</TableCell>
                        <TableCell className="text-end tabular-nums">{r.countedShifts}</TableCell>
                        <TableCell className="text-end tabular-nums text-emerald-700">
                          {r.over ? formatCurrency(r.over) : '—'}
                        </TableCell>
                        <TableCell className="text-destructive text-end tabular-nums">
                          {r.short ? formatCurrency(r.short) : '—'}
                        </TableCell>
                        <TableCell className="text-end font-semibold">
                          <Variance value={r.net} uncounted="" />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-lg border bg-card overflow-x-auto">
              <h2 className="px-4 pt-3 text-sm font-medium">{t('shiftsTitle')}</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.date')}</TableHead>
                    <TableHead>{t('col.till')}</TableHead>
                    <TableHead>{t('col.cashier')}</TableHead>
                    <TableHead>{t('col.closedAt')}</TableHead>
                    <TableHead className="text-end">{t('col.expected')}</TableHead>
                    <TableHead className="text-end">{t('col.countedCash')}</TableHead>
                    <TableHead className="text-end">{t('col.variance')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.shifts.map((s) => (
                    <TableRow key={s.shiftId}>
                      <TableCell className="whitespace-nowrap">{formatDate(s.businessDate)}</TableCell>
                      <TableCell>
                        <div>
                          {s.machineName ?? '—'}
                          {s.sequenceNumber != null ? (
                            <span className="text-muted-foreground ms-1 text-xs">#{s.sequenceNumber}</span>
                          ) : null}
                        </div>
                        {s.shopName ? <div className="text-muted-foreground text-xs">{s.shopName}</div> : null}
                      </TableCell>
                      <TableCell>{who(s.cashier)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(s.closedAt)}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCurrency(s.expectedCash)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {s.countedCash != null ? formatCurrency(s.countedCash) : '—'}
                      </TableCell>
                      <TableCell className="text-end">
                        <Variance value={s.variance} uncounted={s.unattended ? t('unattended') : t('uncounted')} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                {data.shifts.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={6} className="font-semibold">
                        {t('total')}
                      </TableCell>
                      <TableCell className="text-end font-bold">
                        <Variance value={data.totalVariance} uncounted="" />
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
