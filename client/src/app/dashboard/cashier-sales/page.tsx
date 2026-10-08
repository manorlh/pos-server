'use client';

/**
 * Per-cashier (worker) sales report.
 *
 * `cashNet + cardNet + otherNet === net` is an identity the server guarantees, and
 * it is the thing this report is actually used for — "did this worker's till add
 * up". So it is surfaced as an explicit equation and a proportional bar rather
 * than left as three numeric columns for the reader to add up by eye.
 */

import { useMemo, useState } from 'react';
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
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, daysBackIso, hourQueryParams, todayIso } from '@/lib/reportWindow';
import type { CashierSalesReport, CashierSalesRow } from '@/lib/types';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
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

const COLS = 11;

/** Column tint marking the three tender columns as one group that sums to `net`. */
const TENDER_CELL = 'text-end tabular-nums bg-muted/40';

/**
 * Proportional split of net takings across the three tenders.
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

export default function CashierSalesReportPage() {
  const t = useTranslations('cashierSales');
  const tc = useTranslations('common');

  // Same shape as the product report: shopId / machineId only, no company filter.
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
  const [applied, setApplied] = useState<ReportFiltersState | null>(null);

  const params = useMemo(() => {
    if (!applied) return null;
    return {
      from: applied.from,
      to: applied.to,
      ...(scopeShopId ? { shopId: scopeShopId } : {}),
      ...(scopeMachineId ? { machineId: scopeMachineId } : {}),
      ...hourQueryParams(applied.hours),
      ...(applied.areaId ? { areaId: applied.areaId } : {}),
    };
  }, [applied, scopeMachineId, scopeShopId]);

  const { data, isLoading, isFetching, isError, error } = useQuery<CashierSalesReport>({
    queryKey: ['report-cashiers', params],
    queryFn: () => fetchCashierSalesReport(params!),
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
          onRun={() => setApplied(filters)}
          showArea
          areaShopId={scopeShopId}
          isFetching={isFetching}
        />

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
                  { header: t('col.cashier') },
                  { header: t('col.workerNumber'), width: 10 },
                  { header: t('col.documents'), kind: 'number' },
                  { header: t('col.gross'), kind: 'money' },
                  { header: t('col.discounts'), kind: 'money' },
                  { header: t('col.refunds'), kind: 'money' },
                  { header: t('col.net'), kind: 'money' },
                  { header: t('col.cashNet'), kind: 'money' },
                  { header: t('col.cardNet'), kind: 'money' },
                  { header: t('col.productionVoucherNet'), kind: 'money' },
                  { header: t('col.otherNet'), kind: 'money' },
                  { header: t('col.tips'), kind: 'money' },
                ],
                rows: data.rows.map((r) => [
                  cashierLabel(r, t('unknownCashier')), r.workerNumber ?? null, r.documentCount,
                  r.gross, r.discounts, r.refunds, r.net, r.cashNet, r.cardNet, r.productionVoucherNet ?? 0, r.otherNet, r.tips,
                ]),
                totals: [
                  t('footerTotals'), null, data.totals.documentCount, data.totals.gross,
                  data.totals.discounts, data.totals.refunds, data.totals.net, data.totals.cashNet,
                  data.totals.cardNet, data.totals.productionVoucherNet ?? 0, data.totals.otherNet, data.totals.tips,
                ],
              })}
            />
            <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

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
                subtitle={t('totals.tips', { tips: formatCurrency(data.totals.tips) })}
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

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.cashier')}</TableHead>
                    <TableHead>{t('col.workerNumber')}</TableHead>
                    <TableHead className="text-end">{t('col.documents')}</TableHead>
                    <TableHead className="text-end">{t('col.gross')}</TableHead>
                    <TableHead className="text-end">{t('col.discounts')}</TableHead>
                    <TableHead className="text-end">{t('col.refunds')}</TableHead>
                    <TableHead className="text-end">{t('col.net')}</TableHead>
                    <TableHead className="text-end bg-muted/40">{t('col.cashNet')}</TableHead>
                    <TableHead className="text-end bg-muted/40">{t('col.cardNet')}</TableHead>
                    <TableHead className="text-end bg-muted/40">{t('col.productionVoucherNet')}</TableHead>
                    <TableHead className="text-end bg-muted/40">{t('col.otherNet')}</TableHead>
                    <TableHead className="text-end">{t('col.tips')}</TableHead>
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
                      <TableRow key={row.cashierId ?? `row-${i}`}>
                        <TableCell className="font-medium">
                          <div className="space-y-1">
                            <div>{cashierLabel(row, t('unknownCashier'))}</div>
                            <TenderBar row={row} className="max-w-32" />
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {row.workerNumber ?? '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatQuantity(row.documentCount)}
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
                        <TableCell className={TENDER_CELL}>{formatCurrency(row.cashNet)}</TableCell>
                        <TableCell className={TENDER_CELL}>{formatCurrency(row.cardNet)}</TableCell>
                        <TableCell className={TENDER_CELL}>{formatCurrency(row.productionVoucherNet ?? 0)}</TableCell>
                        <TableCell className={TENDER_CELL}>{formatCurrency(row.otherNet)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.tips ? formatCurrency(row.tips) : '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
                {data.rows.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell className="font-semibold">{t('footerTotals')}</TableCell>
                      <TableCell />
                      <TableCell className="text-end tabular-nums">
                        {formatQuantity(data.totals.documentCount)}
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
                      <TableCell className={TENDER_CELL}>
                        {formatCurrency(data.totals.cashNet)}
                      </TableCell>
                      <TableCell className={TENDER_CELL}>
                        {formatCurrency(data.totals.cardNet)}
                      </TableCell>
                      <TableCell className={TENDER_CELL}>
                        {formatCurrency(data.totals.productionVoucherNet ?? 0)}
                      </TableCell>
                      <TableCell className={TENDER_CELL}>
                        {formatCurrency(data.totals.otherNet)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(data.totals.tips)}
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
