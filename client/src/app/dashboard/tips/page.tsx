'use client';

/**
 * Two tip reports that answer different questions, kept on one page behind a
 * mode switch:
 *
 * * **Distribution** (`GET /shops/{id}/tips/report`) — "who is owed what" under the
 *   shop's tip-distribution policy. Keyed on a date range (or one shift), with no
 *   meaningful hour dimension, and meaningless without a shop.
 * * **Range** (`GET /reports/tips`) — "how much tip money came in, on what tender,
 *   when". This is the one that takes the hour-of-day window, because the question
 *   it answers ("what do the evening shifts collect") is an hourly question. Viewed by
 *   cashier (with the tenders), by day, by till and by shift (P:\specs\reports-upgrade.md
 *   §4.2) — every view sums to the same totals, shown on top.
 *
 * The two modes need different things from the shared scope, so the page's scope
 * spec follows the mode: distribution *requires* a shop, range accepts a company (§4.1),
 * a shop or a device. The mode is in the URL (`?mode=range`) with the filters (§5).
 */

import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Coins, CreditCard, Wallet } from 'lucide-react';
import { fetchTipsRangeReport, fetchTipsReport } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatHashNumber } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import type {
  TipCashierRow,
  TipMethod,
  TipMethodRow,
  TipsByCashierRow,
  TipsByDayRow,
  TipsByMachineRow,
  TipsByShiftRow,
  TipsRangeReport,
  TipsReport,
  TipsSliceFigures,
} from '@/lib/types';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

type Mode = 'distribution' | 'range';
type View = 'cashier' | 'day' | 'till' | 'shift';

const METHOD_ICON: Record<TipMethod, React.ElementType> = {
  cash: Banknote,
  card: CreditCard,
  other: Coins,
};

/** Distribution: a range of trading days (today by default), no hours. */
const DIST_SPEC: ReportFilterSpec = { filters: [], defaultDaysBack: 0 };
const RANGE_SPEC: ReportFilterSpec = {
  filters: ['hours', 'area', 'cashier', 'search'],
  clientFilters: ['search'],
};

type Figures = Pick<TipsSliceFigures, 'tipsTotal' | 'tipsCash' | 'tipsCard' | 'tipsOther' | 'tippedDocumentCount' | 'salesNet'>;

export default function TipsReportPage() {
  const t = useTranslations('tips');
  const tc = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode: Mode = searchParams.get('mode') === 'range' ? 'range' : 'distribution';
  const setMode = (next: Mode) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'range') params.set('mode', 'range');
    else params.delete('mode');
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  const { resolution, effective } = usePageScope(
    mode === 'distribution' ? { maxLevel: 'shop', minLevel: 'shop' } : { maxLevel: 'machine' },
  );
  const shopId = effective.shopId ?? '';

  const dist = useReportFilters(DIST_SPEC);
  const range = useReportFilters(RANGE_SPEC);

  /*
   * `?shiftId=` — one shift's tips, which is how a shift's X links here. The report
   * then runs at once on that shift instead of a date range, until the operator
   * picks dates again.
   */
  const [shiftId, setShiftId] = useState<string | null>(() => searchParams.get('shiftId'));
  const distFilters = useMemo(
    () => ({
      ...dist,
      run: () => {
        setShiftId(null);
        dist.run();
      },
    }),
    [dist],
  );

  // ── Distribution ──
  const distParams = dist.applied?.values;
  const distQuery = useQuery<TipsReport>({
    queryKey: ['tips-report', shopId, shiftId ?? `${distParams?.from}|${distParams?.to}`],
    queryFn: () => fetchTipsReport(shopId, shiftId ? { shiftId } : { from: distParams!.from, to: distParams!.to }),
    enabled: mode === 'distribution' && Boolean(shopId) && (Boolean(shiftId) || Boolean(distParams)),
  });
  const report = distQuery.data;

  const distLabel = (d: string) => {
    if (d === 'equal_pool') return t('distEqual');
    if (d === 'by_sales') return t('distBySales');
    return t('distDirect');
  };

  const distTable = useMemo<ReportTableSpec<TipCashierRow>>(
    () => ({
      id: 'main',
      title: t('modeDistribution'),
      columns: [
        { key: 'cashier', header: t('cashier'), required: true, value: (r) => r.cashierName ?? null, className: 'font-medium' },
        { key: 'workerNumber', header: t('workerNumber'), width: 10, value: (r) => r.workerNumber ?? null },
        { key: 'tipsCollected', header: t('tipsCollected'), kind: 'money', value: (r) => r.tipsCollected, total: report?.totalTips },
        { key: 'cashTips', header: t('cashTips'), kind: 'money', value: (r) => r.cashTips, total: report?.totalCashTips },
        { key: 'cardTips', header: t('cardTips'), kind: 'money', value: (r) => r.cardTips, total: report?.totalCardTips },
        { key: 'sales', header: t('sales'), kind: 'money', value: (r) => r.salesTotal },
        {
          key: 'amountOwed',
          header: t('amountOwed'),
          kind: 'money',
          value: (r) => r.amountOwed,
          total: report ? report.cashiers.reduce((sum, r) => sum + r.amountOwed, 0) : undefined,
          className: 'font-semibold',
        },
      ],
      rows: report?.cashiers ?? [],
      rowKey: (r, i) => r.cashierId ?? `row-${i}`,
      totalsLabel: tc('total'),
      emptyText: tc('noResults'),
    }),
    [report, t, tc],
  );

  // ── Range ──
  const rangeParams = useMemo(
    () => (range.apiParams ? { ...range.apiParams, ...scopeApiParams(effective) } : null),
    [effective, range.apiParams],
  );
  const rangeQuery = useQuery<TipsRangeReport>({
    queryKey: ['report-tips', rangeParams],
    queryFn: () => fetchTipsRangeReport(rangeParams!),
    enabled: mode === 'range' && rangeParams !== null,
  });
  const d = rangeQuery.data;
  const [view, setView] = useState<View>('cashier');

  const methodLabel = (m: TipMethod) => {
    if (m === 'cash') return t('cashTips');
    if (m === 'card') return t('cardTips');
    return t('otherTips');
  };

  const rangeTables = useMemo(() => {
    if (!d) return null;
    const sum = (pick: (r: TipsByCashierRow) => number) => d.byCashier.reduce((s, r) => s + pick(r), 0);
    const tot: Figures = {
      tipsTotal: d.tipsTotal,
      tipsCash: d.tipsCash,
      tipsCard: d.tipsCard,
      tipsOther: d.tipsOther,
      tippedDocumentCount: d.tippedDocumentCount ?? sum((r) => r.tippedDocumentCount),
      salesNet: d.salesNet ?? sum((r) => r.salesNet),
    };
    /** The figures every view shares, with the report's totals. */
    function figures<R extends Figures>(): ReportColumn<R>[] {
      return [
        { key: 'tipsTotal', header: t('tipsTotal'), kind: 'money', value: (r) => r.tipsTotal, total: tot.tipsTotal, className: 'font-semibold' },
        { key: 'tipsCash', header: t('cashTips'), kind: 'money', value: (r) => r.tipsCash, total: tot.tipsCash },
        { key: 'tipsCard', header: t('cardTips'), kind: 'money', value: (r) => r.tipsCard, total: tot.tipsCard },
        { key: 'tipsOther', header: t('otherTips'), kind: 'money', value: (r) => r.tipsOther, total: tot.tipsOther },
        { key: 'tippedDocuments', header: t('tippedDocuments'), kind: 'number', value: (r) => r.tippedDocumentCount, total: tot.tippedDocumentCount },
        { key: 'salesNet', header: t('salesNet'), kind: 'money', value: (r) => r.salesNet, total: tot.salesNet },
      ];
    }
    const tillName = (r: { machineName?: string | null; posNumber?: string | null; machineId?: string | null }) =>
      r.machineName
        ? r.posNumber
          ? t('tillName', { name: r.machineName, n: r.posNumber })
          : r.machineName
        : (r.machineId ?? '—');

    const cashier: ReportTableSpec<TipsByCashierRow> = {
      id: 'main',
      title: t('cashier'),
      columns: [
        { key: 'cashier', header: t('cashier'), required: true, value: (r) => r.cashierName ?? t('unknownCashier'), className: 'font-medium' },
        { key: 'workerNumber', header: t('workerNumber'), width: 10, value: (r) => r.workerNumber ?? null, className: 'text-muted-foreground text-xs' },
        ...figures<TipsByCashierRow>(),
      ],
      rows: d.byCashier,
      rowKey: (r, i) => r.cashierId ?? `row-${i}`,
      totalsLabel: tc('total'),
      emptyText: t('rangeNoRows'),
    };
    const methods: ReportTableSpec<TipMethodRow> = {
      id: 'methods',
      title: t('method'),
      columns: [
        {
          key: 'method',
          header: t('method'),
          required: true,
          value: (r) => methodLabel(r.method),
          className: 'font-medium',
          cell: (r) => {
            const Icon = METHOD_ICON[r.method] ?? Coins;
            return (
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                {methodLabel(r.method)}
              </span>
            );
          },
        },
        { key: 'amount', header: t('amount'), kind: 'money', value: (r) => r.amount, total: d.tipsTotal },
        {
          key: 'tippedDocuments',
          header: t('tippedDocuments'),
          kind: 'number',
          value: (r) => r.documentCount,
          total: d.byMethod.reduce((s, r) => s + r.documentCount, 0),
        },
      ],
      rows: d.byMethod,
      rowKey: (r) => r.method,
      totalsLabel: tc('total'),
      emptyText: t('rangeNoRows'),
    };
    const days: ReportTableSpec<TipsByDayRow> | null = d.byDay
      ? {
          id: 'days',
          title: t('view.day'),
          columns: [{ key: 'day', header: t('col.day'), kind: 'date', required: true, value: (r) => r.day }, ...figures<TipsByDayRow>()],
          rows: d.byDay,
          rowKey: (r) => r.day,
          totalsLabel: tc('total'),
          emptyText: t('rangeNoRows'),
        }
      : null;
    const tills: ReportTableSpec<TipsByMachineRow> | null = d.byMachine
      ? {
          id: 'tills',
          title: t('view.till'),
          columns: [
            { key: 'till', header: t('col.till'), required: true, value: tillName, className: 'font-medium' },
            { key: 'shop', header: t('col.shop'), value: (r) => r.shopName ?? null, className: 'text-muted-foreground' },
            ...figures<TipsByMachineRow>(),
          ],
          rows: d.byMachine,
          rowKey: (r, i) => r.machineId ?? `none-${i}`,
          totalsLabel: tc('total'),
          emptyText: t('rangeNoRows'),
        }
      : null;
    const shifts: ReportTableSpec<TipsByShiftRow> | null = d.byShift
      ? {
          id: 'shifts',
          title: t('view.shift'),
          columns: [
            {
              key: 'shift',
              header: t('col.shift'),
              required: true,
              value: (r) => (r.shiftId ? (r.sequenceNumber != null ? formatHashNumber(r.sequenceNumber) : r.shiftId) : t('noShift')),
              className: 'font-medium',
            },
            { key: 'businessDate', header: t('col.businessDate'), kind: 'date', value: (r) => r.businessDate ?? null },
            { key: 'till', header: t('col.till'), value: tillName },
            { key: 'shop', header: t('col.shop'), value: (r) => r.shopName ?? null, className: 'text-muted-foreground', defaultHidden: true },
            { key: 'openedAt', header: t('col.openedAt'), kind: 'datetime', value: (r) => r.openedAt ?? null },
            { key: 'closedAt', header: t('col.closedAt'), kind: 'datetime', value: (r) => r.closedAt ?? null },
            { key: 'openedBy', header: t('col.openedBy'), value: (r) => r.openedByName ?? null },
            ...figures<TipsByShiftRow>(),
          ],
          rows: d.byShift,
          rowKey: (r, i) => r.shiftId ?? `none-${i}`,
          totalsLabel: tc('total'),
          emptyText: t('rangeNoRows'),
        }
      : null;
    return { tot, cashier, methods, days, tills, shifts };
    // `methodLabel` only reads `t`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, t, tc]);

  const views: { id: View; label: string }[] = [
    { id: 'cashier', label: t('view.cashier') },
    ...(rangeTables?.days ? [{ id: 'day' as const, label: t('view.day') }] : []),
    ...(rangeTables?.tills ? [{ id: 'till' as const, label: t('view.till') }] : []),
    ...(rangeTables?.shifts ? [{ id: 'shift' as const, label: t('view.shift') }] : []),
  ];
  const shownView: View = views.some((v) => v.id === view) ? view : 'cashier';
  const pdfTableId = { cashier: 'main', day: 'days', till: 'tills', shift: 'shifts' }[shownView];

  const header = (
    <>
      <div className="flex flex-wrap gap-2 print:hidden" role="tablist" aria-label={t('modeLabel')}>
        <Button
          role="tab"
          aria-selected={mode === 'distribution'}
          variant={mode === 'distribution' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('distribution')}
        >
          {t('modeDistribution')}
        </Button>
        <Button
          role="tab"
          aria-selected={mode === 'range'}
          variant={mode === 'range' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('range')}
        >
          {t('modeRange')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {mode === 'distribution' ? t('modeDistributionHint') : t('modeRangeHint')}
      </p>
    </>
  );

  if (mode === 'distribution') {
    return (
      <ReportPage
        reportKey="tips-distribution"
        title={t('title')}
        subtitle={t('subtitle')}
        headerExtra={header}
        resolution={resolution}
        filters={distFilters}
        bar={{ shopId, hint: shiftId ? t('forShift') : undefined }}
        query={reportQueryState(distQuery)}
        ready={Boolean(shiftId) || dist.applied !== null}
        prompt={t('selectFilters')}
        loading="table"
        export={
          report
            ? {
                title: `${t('title')} · ${t('modeDistribution')}`,
                tables: [distTable],
                from: shiftId ? (report.fromDate ?? null) : distParams?.from,
                to: shiftId ? (report.toDate ?? null) : distParams?.to,
              }
            : null
        }
      >
        {report ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{distLabel(report.distribution)}</Badge>
              <span className="text-sm text-muted-foreground">
                {t('summary', {
                  tips: formatCurrency(report.totalTips),
                  cash: formatCurrency(report.totalCashTips),
                  card: formatCurrency(report.totalCardTips),
                })}
              </span>
            </div>
            <ReportTable table={distTable} />
          </>
        ) : null}
      </ReportPage>
    );
  }

  const exportTables = rangeTables
    ? ([
        rangeTables.cashier,
        rangeTables.methods,
        ...(rangeTables.days ? [rangeTables.days] : []),
        ...(rangeTables.tills ? [rangeTables.tills] : []),
        ...(rangeTables.shifts ? [rangeTables.shifts] : []),
      ] as ReportTableSpec<unknown>[])
    : [];

  return (
    <ReportPage
      reportKey="tips"
      title={t('title')}
      subtitle={t('subtitle')}
      headerExtra={header}
      resolution={resolution}
      filters={range}
      bar={{ shopId: shopId || null }}
      query={reportQueryState(rangeQuery)}
      prompt={t('rangeSelectFilters')}
      export={
        d
          ? {
              title: `${t('title')} · ${t('modeRange')}`,
              tables: exportTables,
              pdfTableId,
              from: d.window.from,
              to: d.window.to,
            }
          : null
      }
    >
      {d && rangeTables ? (
        <>
          <ReportWindowSummary window={d.window} generatedAt={d.generatedAt} />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <ReportStatCard
              title={t('tipsTotal')}
              value={formatCurrency(d.tipsTotal)}
              subtitle={t('totalsLine', {
                count: rangeTables.tot.tippedDocumentCount,
                sales: formatCurrency(rangeTables.tot.salesNet),
              })}
              icon={Wallet}
              emphasis
            />
            <ReportStatCard title={t('cashTips')} value={formatCurrency(d.tipsCash)} icon={Banknote} />
            <ReportStatCard title={t('cardTips')} value={formatCurrency(d.tipsCard)} icon={CreditCard} />
            <ReportStatCard title={t('otherTips')} value={formatCurrency(d.tipsOther)} icon={Coins} />
          </div>

          {views.length > 1 ? (
            <div className="flex flex-wrap gap-2 print:hidden" role="tablist" aria-label={t('viewLabel')}>
              {views.map((v) => (
                <Button
                  key={v.id}
                  role="tab"
                  aria-selected={shownView === v.id}
                  variant={shownView === v.id ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </Button>
              ))}
            </div>
          ) : null}

          {shownView === 'cashier' ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <ReportTable table={rangeTables.methods} />
              <ReportTable table={rangeTables.cashier} />
            </div>
          ) : shownView === 'day' && rangeTables.days ? (
            <ReportTable table={rangeTables.days} />
          ) : shownView === 'till' && rangeTables.tills ? (
            <ReportTable table={rangeTables.tills} />
          ) : shownView === 'shift' && rangeTables.shifts ? (
            <>
              {d.byShiftTruncated ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('shiftsTruncated')}</p> : null}
              <ReportTable table={rangeTables.shifts} />
            </>
          ) : null}
        </>
      ) : null}
    </ReportPage>
  );
}
