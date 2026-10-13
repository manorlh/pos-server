'use client';

/**
 * Cash differences (הפרשי קופה) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.8.
 *
 * Expected vs counted for every closed shift in the range, and per cashier the overs,
 * the shorts and the net. An uncounted shift (closed with nobody at the drawer) has no
 * difference — it is shown as such, never as a balanced zero.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days (the last 30 by
 * default) and a search in the URL. The endpoint takes the shop and the till, no company and
 * no hours (a shift is counted whole). No tips column here, on purpose (§2ה).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { formatCurrency } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { cashVarianceTotals, varianceTone } from '@/lib/auditReports';
import {
  fetchCashVarianceReport,
  type CashVarianceCashier,
  type CashVarianceReport,
  type CashVarianceShift,
} from '@/lib/salesReportsApi';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: ['search'], clientFilters: ['search'], defaultDaysBack: 29 };

function Variance({ value, uncounted }: { value?: number | null; uncounted: string }) {
  if (value == null) return <span className="text-muted-foreground text-xs">{uncounted}</span>;
  const tone = varianceTone(value);
  return (
    <span className={`tabular-nums ${tone === 'over' ? 'text-emerald-700' : tone === 'short' ? 'text-destructive' : ''}`}>
      {tone === 'over' ? '+' : ''}
      {formatCurrency(value)}
    </span>
  );
}

export default function CashVariancePage() {
  const t = useTranslations('cashVarianceReport');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective, false) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<CashVarianceReport>({
    queryKey: ['report-cash-variance', params],
    queryFn: () => fetchCashVarianceReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const byCashier = useMemo<ReportTableSpec<CashVarianceCashier>>(() => {
    const who = (c?: string | null) => c || t('unknownCashier');
    const tot = data ? cashVarianceTotals(data.byCashier, data.shifts.length, data.uncounted, data.totalVariance) : null;
    return {
      id: 'main',
      title: t('byCashierTitle'),
      rows: data?.byCashier ?? [],
      rowKey: (r, i) => `${r.cashier ?? '__none__'}-${i}`,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      columns: [
        { key: 'cashier', header: t('col.cashier'), required: true, value: (r) => who(r.cashier), className: 'font-medium' },
        { key: 'shifts', header: t('col.shifts'), kind: 'number', value: (r) => r.shifts, total: tot?.shifts },
        { key: 'counted', header: t('col.counted'), kind: 'number', value: (r) => r.countedShifts, total: tot?.counted },
        {
          key: 'over',
          header: t('col.over'),
          kind: 'money',
          value: (r) => r.over,
          cell: (r) => (r.over ? formatCurrency(r.over) : '—'),
          total: tot?.over,
          className: 'text-emerald-700',
        },
        {
          key: 'short',
          header: t('col.short'),
          kind: 'money',
          value: (r) => r.short,
          cell: (r) => (r.short ? formatCurrency(r.short) : '—'),
          total: tot?.short,
          className: 'text-destructive',
        },
        {
          key: 'net',
          header: t('col.net'),
          kind: 'money',
          value: (r) => r.net,
          cell: (r) => <Variance value={r.net} uncounted="" />,
          total: tot?.net,
          totalCell: tot ? <Variance value={tot.net} uncounted="" /> : undefined,
          className: 'font-semibold',
        },
      ],
    };
  }, [data, t]);

  const shifts = useMemo<ReportTableSpec<CashVarianceShift>>(() => {
    const who = (c?: string | null) => c || t('unknownCashier');
    const notCounted = (s: CashVarianceShift) => (s.unattended ? t('unattended') : t('uncounted'));
    return {
      id: 'shifts',
      title: t('shiftsTitle'),
      rows: data?.shifts ?? [],
      rowKey: (s) => s.shiftId,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      columns: [
        { key: 'date', header: t('col.date'), kind: 'date', required: true, value: (s) => s.businessDate },
        // The screen folds the shop and the shift number into the till's cell; Excel keeps them apart.
        { key: 'shop', header: t('col.shop'), exportOnly: true, value: (s) => s.shopName ?? null },
        {
          key: 'till',
          header: t('col.till'),
          value: (s) => s.machineName ?? null,
          cell: (s) => (
            <>
              <div>
                {s.machineName ?? '—'}
                {s.sequenceNumber != null ? (
                  <span className="text-muted-foreground ms-1 text-xs">#{s.sequenceNumber}</span>
                ) : null}
              </div>
              {s.shopName ? <div className="text-muted-foreground text-xs">{s.shopName}</div> : null}
            </>
          ),
        },
        { key: 'shift', header: t('col.shift'), kind: 'number', exportOnly: true, value: (s) => s.sequenceNumber ?? null },
        { key: 'cashier', header: t('col.cashier'), value: (s) => who(s.cashier) },
        { key: 'closedAt', header: t('col.closedAt'), kind: 'datetime', value: (s) => s.closedAt ?? null, className: 'text-xs' },
        { key: 'expected', header: t('col.expected'), kind: 'money', value: (s) => s.expectedCash ?? null },
        { key: 'countedCash', header: t('col.countedCash'), kind: 'money', value: (s) => s.countedCash ?? null },
        {
          key: 'variance',
          header: t('col.variance'),
          kind: 'money',
          value: (s) => s.variance ?? null,
          cell: (s) => <Variance value={s.variance} uncounted={notCounted(s)} />,
          total: data?.totalVariance,
          totalCell: data ? (
            <span className="font-bold">
              <Variance value={data.totalVariance} uncounted="" />
            </span>
          ) : undefined,
        },
        // Why a shift has no difference ("לא נספר" / "נסגרה מרחוק") — the screen says it in the variance cell.
        { key: 'countStatus', header: t('col.countStatus'), exportOnly: true, value: (s) => (s.variance == null ? notCounted(s) : null) },
      ],
    };
  }, [data, t]);

  const tables = [byCashier, shifts] as ReportTableSpec<unknown>[];

  return (
    <ReportPage
      reportKey="cash-variance"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ hint: t('dateHint') }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={data ? { tables, from: data.window.from, to: data.window.to } : null}
    >
      {data ? (
        <>
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

          <ReportTable table={byCashier} />
          <ReportTable table={shifts} />
        </>
      ) : null}
    </ReportPage>
  );
}
