'use client';

/**
 * Per-cashier (worker) sales report.
 *
 * `cashNet + cardNet + otherNet === net` is an identity the server guarantees, and
 * it is the thing this report is actually used for — "did this worker's till add
 * up". So it is surfaced as an explicit equation and a proportional bar rather
 * than left as three numeric columns for the reader to add up by eye.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): days, hours, area, cashier
 * (`cashierId`, §4.1) and a search in the URL; tips split by tender when the server sends
 * it (§4.2) — apart from the tender columns, never inside them.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  Coins,
  CreditCard,
  Equal,
  ReceiptText,
  RotateCcw,
  Ticket,
  Wallet,
} from 'lucide-react';
import { fetchCashierSalesReport } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import type { CashierSalesReport, CashierSalesRow } from '@/lib/types';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

/** Column tint marking the tender columns as one group that sums to `net`. */
const TENDER = 'bg-muted/40';

const SPEC: ReportFilterSpec = {
  filters: ['hours', 'area', 'cashier', 'search'],
  clientFilters: ['search'],
};

/**
 * Proportional split of net takings across the tenders.
 *
 * Widths only — no attempt to re-derive `net` from the parts. The server already
 * guarantees the identity, and re-adding JSON floats here would only invent
 * rounding noise to display.
 */
function TenderBar({ row, className = '' }: { row: CashierSalesRow; className?: string }) {
  const t = useTranslations('cashierSales');
  const voucher = row.productionVoucherNet ?? 0;
  const magnitude = Math.abs(row.cashNet) + Math.abs(row.cardNet) + Math.abs(voucher) + Math.abs(row.otherNet);
  if (magnitude === 0) {
    return <div className={`h-2 rounded-full bg-muted ${className}`} aria-hidden />;
  }
  const pct = (v: number) => `${(Math.abs(v) / magnitude) * 100}%`;
  return (
    <div
      className={`flex h-2 overflow-hidden rounded-full bg-muted ${className}`}
      role="img"
      aria-label={t('tenderBarLabel', {
        cash: formatCurrency(row.cashNet),
        card: formatCurrency(row.cardNet),
        voucher: formatCurrency(voucher),
        other: formatCurrency(row.otherNet),
      })}
    >
      <div className="bg-emerald-500" style={{ width: pct(row.cashNet) }} />
      <div className="bg-blue-500" style={{ width: pct(row.cardNet) }} />
      <div className="bg-violet-500" style={{ width: pct(voucher) }} />
      <div className="bg-amber-500" style={{ width: pct(row.otherNet) }} />
    </div>
  );
}

function cashierLabel(row: CashierSalesRow, unknownLabel: string): string {
  return row.cashierName ?? (row.cashierId ? row.cashierId : unknownLabel);
}

/** A money column whose zero reads "—" on screen (still 0 in the export). */
function money(
  key: string,
  header: string,
  value: (r: CashierSalesRow) => number,
  total: number | undefined,
  opts: { dashZero?: boolean; className?: string; headClassName?: string } = {},
): ReportColumn<CashierSalesRow> {
  return {
    key,
    header,
    kind: 'money',
    value,
    total,
    className: opts.className,
    headClassName: opts.headClassName,
    cell: opts.dashZero ? (r) => (value(r) ? formatCurrency(value(r)) : '—') : undefined,
  };
}

export default function CashierSalesReportPage() {
  const t = useTranslations('cashierSales');

  // shopId / machineId, or a company (§4.1: and its subsidiaries).
  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const params = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective) } : null),
    [effective, filters.apiParams],
  );

  const query = useQuery<CashierSalesReport>({
    queryKey: ['report-cashiers', params],
    queryFn: () => fetchCashierSalesReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  const table = useMemo<ReportTableSpec<CashierSalesRow>>(() => {
    const tot = data?.totals;
    const hasTipSplit = Boolean(data && (tot?.tipsCash !== undefined || data.rows.some((r) => r.tipsCash !== undefined)));
    const columns: ReportColumn<CashierSalesRow>[] = [
      {
        key: 'cashier',
        header: t('col.cashier'),
        required: true,
        value: (r) => cashierLabel(r, t('unknownCashier')),
        className: 'font-medium',
        cell: (r) => (
          <div className="space-y-1">
            <div>{cashierLabel(r, t('unknownCashier'))}</div>
            <TenderBar row={r} className="max-w-32" />
          </div>
        ),
      },
      {
        key: 'workerNumber',
        header: t('col.workerNumber'),
        width: 10,
        value: (r) => r.workerNumber ?? null,
        className: 'text-muted-foreground text-xs',
      },
      { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documentCount, total: tot?.documentCount },
      money('gross', t('col.gross'), (r) => r.gross, tot?.gross),
      money('discounts', t('col.discounts'), (r) => r.discounts, tot?.discounts, { dashZero: true }),
      money(
        'productionVoucherDeductions',
        t('col.productionVoucherDeductions'),
        (r) => r.productionVoucherDeductions ?? 0,
        tot ? (tot.productionVoucherDeductions ?? 0) : undefined,
        { dashZero: true },
      ),
      money('refunds', t('col.refunds'), (r) => r.refunds, tot?.refunds, { dashZero: true }),
      money('net', t('col.net'), (r) => r.net, tot?.net, { className: 'font-semibold' }),
      money('cashNet', t('col.cashNet'), (r) => r.cashNet, tot?.cashNet, { className: TENDER, headClassName: TENDER }),
      money('cardNet', t('col.cardNet'), (r) => r.cardNet, tot?.cardNet, { className: TENDER, headClassName: TENDER }),
      money(
        'productionVoucherNet',
        t('col.productionVoucherNet'),
        (r) => r.productionVoucherNet ?? 0,
        tot ? (tot.productionVoucherNet ?? 0) : undefined,
        { className: TENDER, headClassName: TENDER },
      ),
      money('otherNet', t('col.otherNet'), (r) => r.otherNet, tot?.otherNet, { className: TENDER, headClassName: TENDER }),
      money('tips', t('col.tips'), (r) => r.tips, tot?.tips, { dashZero: true }),
      ...(hasTipSplit
        ? [
            money('tipsCash', t('col.tipsCash'), (r) => r.tipsCash ?? 0, tot?.tipsCash, { dashZero: true }),
            money('tipsCard', t('col.tipsCard'), (r) => r.tipsCard ?? 0, tot?.tipsCard, { dashZero: true }),
            money('tipsOther', t('col.tipsOther'), (r) => r.tipsOther ?? 0, tot?.tipsOther, { dashZero: true }),
          ]
        : []),
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: data?.rows ?? [],
      rowKey: (r, i) => r.cashierId ?? `row-${i}`,
      totalsLabel: t('footerTotals'),
      emptyText: t('noRows'),
    };
  }, [data, t]);

  return (
    <ReportPage
      reportKey="cashier-sales"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{ shopId: effective.shopId }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      export={data ? { tables: [table], from: data.window.from, to: data.window.to } : null}
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <ReportStatCard
              title={t('totals.net')}
              value={formatCurrency(data.totals.net)}
              subtitle={t('totals.netFormula')}
              icon={Wallet}
              emphasis
            />
            <ReportStatCard title={t('totals.gross')} value={formatCurrency(data.totals.gross)} icon={Coins} />
            <ReportStatCard
              title={t('totals.refunds')}
              value={formatCurrency(data.totals.refunds)}
              subtitle={t('totals.refundsCount', { count: data.totals.refundsCount })}
              icon={RotateCcw}
            />
            <ReportStatCard
              title={t('totals.documents')}
              value={formatQuantity(data.totals.documentCount)}
              subtitle={t('totals.documentsBreakdown', {
                sales: data.totals.salesCount,
                refunds: data.totals.refundsCount,
              })}
              icon={ReceiptText}
            />
            <ReportStatCard
              title={t('totals.averageBasket')}
              value={formatCurrency(data.totals.averageBasket)}
              subtitle={
                data.totals.tipsCash !== undefined
                  ? t('totals.tipsSplit', {
                      tips: formatCurrency(data.totals.tips),
                      cash: formatCurrency(data.totals.tipsCash),
                      card: formatCurrency(data.totals.tipsCard ?? 0),
                    })
                  : t('totals.tips', { tips: formatCurrency(data.totals.tips) })
              }
              icon={Banknote}
            />
          </div>

          {/* The reconciliation, stated as an equation rather than implied by columns. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Equal className="h-4 w-4 text-muted-foreground" aria-hidden />
                {t('reconcile.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-lg font-semibold tabular-nums">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden />
                  {formatCurrency(data.totals.cashNet)}
                </span>
                <span className="text-muted-foreground">+</span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500" aria-hidden />
                  {formatCurrency(data.totals.cardNet)}
                </span>
                <span className="text-muted-foreground">+</span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-violet-500" aria-hidden />
                  {formatCurrency(data.totals.productionVoucherNet ?? 0)}
                </span>
                <span className="text-muted-foreground">+</span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500" aria-hidden />
                  {formatCurrency(data.totals.otherNet)}
                </span>
                <span className="text-muted-foreground">=</span>
                <span className="text-primary">{formatCurrency(data.totals.net)}</span>
              </div>
              <TenderBar row={data.totals} className="h-3" />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Banknote className="h-3.5 w-3.5" aria-hidden /> {t('col.cashNet')}
                </span>
                <span className="flex items-center gap-1.5">
                  <CreditCard className="h-3.5 w-3.5" aria-hidden /> {t('col.cardNet')}
                </span>
                <span className="flex items-center gap-1.5">
                  <Ticket className="h-3.5 w-3.5" aria-hidden /> {t('col.productionVoucherNet')}
                </span>
                <span className="flex items-center gap-1.5">
                  <Coins className="h-3.5 w-3.5" aria-hidden /> {t('col.otherNet')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t('reconcile.note')}</p>
            </CardContent>
          </Card>

          <ReportTable table={table} />
        </>
      ) : null}
    </ReportPage>
  );
}
