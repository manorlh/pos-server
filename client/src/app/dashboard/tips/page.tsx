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
 *   it answers ("what do the evening shifts collect") is an hourly question.
 *
 * The two modes need different things from the shared scope, so the page's scope
 * spec follows the mode: distribution *requires* a shop, range accepts a shop or a
 * device and cannot express a company. The scope bar re-labels itself accordingly
 * when the mode switches.
 */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Coins, CreditCard, Wallet } from 'lucide-react';
import { fetchTipsRangeReport, fetchTipsReport } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { WHOLE_DAY, businessDaysBackIso, businessTodayIso, hourQueryParams } from '@/lib/reportWindow';
import { dayBasisQuery } from '@/lib/businessDay';
import type { TipMethod, TipsRangeReport, TipsReport } from '@/lib/types';
import { ReportFilters, type ReportFiltersState } from '@/components/dashboard/report-filters';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import {
  ReportErrorState,
  ReportWindowSummary,
} from '@/components/dashboard/report-window-summary';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

type Mode = 'distribution' | 'range';

const METHOD_ICON: Record<TipMethod, React.ElementType> = {
  cash: Banknote,
  card: CreditCard,
  other: Coins,
};

export default function TipsReportPage() {
  const t = useTranslations('tips');
  const tc = useTranslations('common');
  const [mode, setMode] = useState<Mode>('distribution');

  const { resolution, effective } = usePageScope(
    mode === 'distribution'
      ? { maxLevel: 'shop', minLevel: 'shop' }
      : { maxLevel: 'machine', unsupported: ['company'] },
  );
  const shopId = effective.shopId ?? '';
  const scopeMachineId = effective.machineId;

  // ── Distribution report (per shop, per date range) ──
  const [from, setFrom] = useState(businessTodayIso());
  const [to, setTo] = useState(businessTodayIso());
  const [runKey, setRunKey] = useState(0);
  /*
   * `?shiftId=` — one shift's tips, which is how a shift's X links here. The report
   * then runs at once on that shift instead of a date range, until the operator
   * picks dates again.
   */
  const searchParams = useSearchParams();
  const [shiftId, setShiftId] = useState<string | null>(() => searchParams.get('shiftId'));

  // ── Range report (day range × hour band) ──
  const [rangeFilters, setRangeFilters] = useState<ReportFiltersState>({
    from: businessDaysBackIso(6),
    to: businessTodayIso(),
    hours: WHOLE_DAY,
  });
  const [appliedRange, setAppliedRange] = useState<ReportFiltersState | null>(null);

  const {
    data: report,
    isLoading,
    isFetching,
    isError,
    error,
  } = useQuery<TipsReport>({
    queryKey: ['tips-report', shopId, shiftId ?? `${from}|${to}`, runKey],
    queryFn: () => fetchTipsReport(shopId, shiftId ? { shiftId } : { from, to }),
    enabled:
      mode === 'distribution' &&
      Boolean(shopId) &&
      (shiftId ? true : Boolean(from) && Boolean(to) && runKey > 0),
  });

  const rangeParams = useMemo(() => {
    if (!appliedRange) return null;
    return {
      from: appliedRange.from,
      to: appliedRange.to,
      ...(shopId ? { shopId } : {}),
      ...(scopeMachineId ? { machineId: scopeMachineId } : {}),
      ...hourQueryParams(appliedRange.hours),
      ...dayBasisQuery(appliedRange.dayBasis),
      ...(appliedRange.areaId ? { areaId: appliedRange.areaId } : {}),
    };
  }, [appliedRange, scopeMachineId, shopId]);

  const rangeQuery = useQuery<TipsRangeReport>({
    queryKey: ['report-tips', rangeParams],
    queryFn: () => fetchTipsRangeReport(rangeParams!),
    enabled: mode === 'range' && rangeParams !== null,
  });

  const distLabel = (d: string) => {
    if (d === 'equal_pool') return t('distEqual');
    if (d === 'by_sales') return t('distBySales');
    return t('distDirect');
  };

  const methodLabel = (m: TipMethod) => {
    if (m === 'cash') return t('cashTips');
    if (m === 'card') return t('cardTips');
    return t('otherTips');
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

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

      <ScopeGate resolution={resolution}>
        {mode === 'distribution' ? (
          <>
            <div className="flex flex-wrap gap-4 items-end print:hidden">
              <div className="space-y-1">
                <Label>{t('from')}</Label>
                <DatePicker
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('to')}</Label>
                <DatePicker
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }}
                />
              </div>
              <Button
                disabled={!shopId || !from || !to || isFetching}
                onClick={() => {
                  setShiftId(null);
                  setRunKey((k) => k + 1);
                }}
              >
                {isFetching ? tc('loading') : t('runReport')}
              </Button>
            </div>
            {shiftId ? (
              <p className="text-muted-foreground text-xs">{t('forShift')}</p>
            ) : null}

            {runKey === 0 && !shiftId ? (
              <p className="text-muted-foreground text-sm py-8 text-center">{t('selectFilters')}</p>
            ) : isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : isError ? (
              <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
            ) : report ? (
              <div className="space-y-4">
                <ReportExportToolbar
                  title={`${t('title')} · ${t('modeDistribution')}`}
                  from={from}
                  to={to}
                  getSheets={() => ({
                    name: t('modeDistribution'),
                    columns: [
                      { header: t('cashier') },
                      { header: t('workerNumber'), width: 10 },
                      { header: t('tipsCollected'), kind: 'money' },
                      { header: t('cashTips'), kind: 'money' },
                      { header: t('cardTips'), kind: 'money' },
                      { header: t('sales'), kind: 'money' },
                      { header: t('amountOwed'), kind: 'money' },
                    ],
                    rows: report.cashiers.map((r) => [
                      r.cashierName ?? null, r.workerNumber ?? null, r.tipsCollected, r.cashTips, r.cardTips,
                      r.salesTotal, r.amountOwed,
                    ]),
                    totals: [
                      tc('total'), null, report.totalTips, report.totalCashTips, report.totalCardTips, null,
                      report.cashiers.reduce((sum, r) => sum + r.amountOwed, 0),
                    ],
                  })}
                />
                <div className="flex flex-wrap gap-2 items-center">
                  <Badge variant="outline">{distLabel(report.distribution)}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {t('summary', {
                      tips: formatCurrency(report.totalTips),
                      cash: formatCurrency(report.totalCashTips),
                      card: formatCurrency(report.totalCardTips),
                    })}
                  </span>
                </div>
                <div className="rounded-lg border bg-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('cashier')}</TableHead>
                        <TableHead>{t('workerNumber')}</TableHead>
                        <TableHead>{t('tipsCollected')}</TableHead>
                        <TableHead>{t('cashTips')}</TableHead>
                        <TableHead>{t('cardTips')}</TableHead>
                        <TableHead>{t('sales')}</TableHead>
                        <TableHead>{t('amountOwed')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.cashiers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            {tc('noResults')}
                          </TableCell>
                        </TableRow>
                      ) : (
                        report.cashiers.map((row, i) => (
                          <TableRow key={row.cashierId ?? `row-${i}`}>
                            <TableCell className="font-medium">{row.cashierName ?? '—'}</TableCell>
                            <TableCell>{row.workerNumber ?? '—'}</TableCell>
                            <TableCell>{formatCurrency(row.tipsCollected)}</TableCell>
                            <TableCell>{formatCurrency(row.cashTips)}</TableCell>
                            <TableCell>{formatCurrency(row.cardTips)}</TableCell>
                            <TableCell>{formatCurrency(row.salesTotal)}</TableCell>
                            <TableCell className="font-semibold">{formatCurrency(row.amountOwed)}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <ReportFilters
              value={rangeFilters}
              onChange={setRangeFilters}
              onRun={() => setAppliedRange(rangeFilters)}
              showArea
              areaShopId={shopId || null}
              isFetching={rangeQuery.isFetching}
            />

            {!appliedRange ? (
              <p className="text-muted-foreground py-12 text-center text-sm">{t('rangeSelectFilters')}</p>
            ) : rangeQuery.isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-24 w-full" />
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full" />
                  ))}
                </div>
                <Skeleton className="h-64 w-full" />
              </div>
            ) : rangeQuery.isError ? (
              <ReportErrorState message={axiosErrorToToastMessage(rangeQuery.error, tc('error'))} />
            ) : rangeQuery.data ? (
              <div className="space-y-4">
                <ReportExportToolbar
                  title={`${t('title')} · ${t('modeRange')}`}
                  from={rangeQuery.data.window.from}
                  to={rangeQuery.data.window.to}
                  getSheets={() => {
                    const d = rangeQuery.data!;
                    return [
                      {
                        name: t('cashier'),
                        columns: [
                          { header: t('cashier') },
                          { header: t('workerNumber'), width: 10 },
                          { header: t('tipsTotal'), kind: 'money' },
                          { header: t('cashTips'), kind: 'money' },
                          { header: t('cardTips'), kind: 'money' },
                          { header: t('otherTips'), kind: 'money' },
                          { header: t('tippedDocuments'), kind: 'number' },
                          { header: t('salesNet'), kind: 'money' },
                        ],
                        rows: d.byCashier.map((r) => [
                          r.cashierName ?? t('unknownCashier'), r.workerNumber ?? null, r.tipsTotal, r.tipsCash,
                          r.tipsCard, r.tipsOther, r.tippedDocumentCount, r.salesNet,
                        ]),
                        totals: [
                          tc('total'), null, d.tipsTotal, d.tipsCash, d.tipsCard, d.tipsOther,
                          d.byCashier.reduce((sum, r) => sum + r.tippedDocumentCount, 0),
                          d.byCashier.reduce((sum, r) => sum + r.salesNet, 0),
                        ],
                      },
                      {
                        name: t('method'),
                        columns: [
                          { header: t('method') },
                          { header: t('amount'), kind: 'money' },
                          { header: t('tippedDocuments'), kind: 'number' },
                        ],
                        rows: d.byMethod.map((r) => [methodLabel(r.method), r.amount, r.documentCount]),
                        totals: [tc('total'), d.tipsTotal, d.byMethod.reduce((sum, r) => sum + r.documentCount, 0)],
                      },
                    ];
                  }}
                />
                <ReportWindowSummary
                  window={rangeQuery.data.window}
                  generatedAt={rangeQuery.data.generatedAt}
                />

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <ReportStatCard
                    title={t('tipsTotal')}
                    value={formatCurrency(rangeQuery.data.tipsTotal)}
                    icon={Wallet}
                    emphasis
                  />
                  <ReportStatCard
                    title={t('cashTips')}
                    value={formatCurrency(rangeQuery.data.tipsCash)}
                    icon={Banknote}
                  />
                  <ReportStatCard
                    title={t('cardTips')}
                    value={formatCurrency(rangeQuery.data.tipsCard)}
                    icon={CreditCard}
                  />
                  <ReportStatCard
                    title={t('otherTips')}
                    value={formatCurrency(rangeQuery.data.tipsOther)}
                    icon={Coins}
                  />
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="rounded-lg border bg-card overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('method')}</TableHead>
                          <TableHead className="text-end">{t('amount')}</TableHead>
                          <TableHead className="text-end">{t('tippedDocuments')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rangeQuery.data.byMethod.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                              {t('rangeNoRows')}
                            </TableCell>
                          </TableRow>
                        ) : (
                          rangeQuery.data.byMethod.map((row) => {
                            const Icon = METHOD_ICON[row.method] ?? Coins;
                            return (
                              <TableRow key={row.method}>
                                <TableCell className="font-medium">
                                  <span className="flex items-center gap-2">
                                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                                    {methodLabel(row.method)}
                                  </span>
                                </TableCell>
                                <TableCell className="text-end tabular-nums">
                                  {formatCurrency(row.amount)}
                                </TableCell>
                                <TableCell className="text-end tabular-nums">
                                  {formatQuantity(row.documentCount)}
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="rounded-lg border bg-card overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('cashier')}</TableHead>
                          <TableHead>{t('workerNumber')}</TableHead>
                          <TableHead className="text-end">{t('tipsTotal')}</TableHead>
                          <TableHead className="text-end">{t('cashTips')}</TableHead>
                          <TableHead className="text-end">{t('cardTips')}</TableHead>
                          <TableHead className="text-end">{t('otherTips')}</TableHead>
                          <TableHead className="text-end">{t('tippedDocuments')}</TableHead>
                          <TableHead className="text-end">{t('salesNet')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rangeQuery.data.byCashier.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                              {t('rangeNoRows')}
                            </TableCell>
                          </TableRow>
                        ) : (
                          rangeQuery.data.byCashier.map((row, i) => (
                            <TableRow key={row.cashierId ?? `row-${i}`}>
                              <TableCell className="font-medium">
                                {row.cashierName ?? t('unknownCashier')}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {row.workerNumber ?? '—'}
                              </TableCell>
                              <TableCell className="text-end font-semibold tabular-nums">
                                {formatCurrency(row.tipsTotal)}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatCurrency(row.tipsCash)}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatCurrency(row.tipsCard)}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatCurrency(row.tipsOther)}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatQuantity(row.tippedDocumentCount)}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {formatCurrency(row.salesNet)}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </ScopeGate>
    </div>
  );
}
