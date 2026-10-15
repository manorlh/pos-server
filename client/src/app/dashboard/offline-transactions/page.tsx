'use client';

/**
 * Offline transactions (עסקאות במצב לא מקוון) — the tills' offline authorization runs
 * over a range, newest first.
 *
 * With the acquirer out of reach the terminal approves a card sale on its own; the till
 * later sends the held sales for authorization (Agamento `authorizePendingTransactions`)
 * and reports each run. A declined one is a document the shop issued and money it will
 * not be paid, so the declined figures are the point of the page: red in the totals,
 * and each run opens to the documents it declined. A declined uid that no document of
 * the till carries (yet) is listed as such rather than dropped.
 *
 * Days are on the run's time, not the original sale's — the sale's time is in the list.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days and a search in the
 * URL; the shop and the till from the scope (no company). Shown at once on the first visit
 * (the last 7 days) — this is a page one checks, not a query one composes.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, WifiOff } from 'lucide-react';
import { fetchOfflineAuthorizationsReport } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { defaultReportFilters, reportApiParams, scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { todayIso } from '@/lib/reportWindow';
import { offlineDeclinedRows } from '@/lib/auditReports';
import { kpiNumber, previousWindow, type PreviousPeriod, type ReportKpi } from '@/lib/designedReport';
import type {
  OfflineAuthorizationReport,
  OfflineAuthorizationRun,
  OfflineAuthorizationTotals,
  OfflineDeclinedLeg,
} from '@/lib/types';
import { RemoteCreditQuickButton } from '@/components/dashboard/remote-credit/remote-credit-actions';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: ['search'], clientFilters: ['search'] };

type DeclinedRow = { key: string; run: OfflineAuthorizationRun; leg: OfflineDeclinedLeg };

/** The cards as the designed PDF shows them (and the period before's), by KPI key. */
function totalsFigures(tot: OfflineAuthorizationTotals): Record<string, number | null> {
  return {
    approved: tot.approvedCount,
    approvedAmount: kpiNumber(tot.approvedAmount),
    declined: tot.declinedCount,
    declinedAmount: kpiNumber(tot.declinedAmount),
    runs: tot.authorizationCount,
  };
}

/** The documents one run declined (the run's drill-down). */
function DeclinedList({ run }: { run: OfflineAuthorizationRun }) {
  const t = useTranslations('offlineTransactions');
  if (run.declined.length === 0) return <p className="text-muted-foreground px-4 py-3 text-xs">{t('declined.none')}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('declined.document')}</TableHead>
          <TableHead>{t('declined.soldAt')}</TableHead>
          <TableHead>{t('declined.uid')}</TableHead>
          <TableHead className="text-end">{t('declined.amount')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.declined.map((d) => (
          <TableRow key={d.terminalUid}>
            <TableCell>
              {d.matched ? (
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono text-xs" dir="ltr">
                    {d.documentNumber ?? d.transactionId?.slice(0, 8)}
                  </span>
                  {/* A declined sale is still a tax document: credit it (docs/SPEC_REMOTE_CREDIT.md). */}
                  {d.transactionId ? (
                    <RemoteCreditQuickButton transactionId={d.transactionId} documentNumber={d.documentNumber} />
                  ) : null}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">{t('declined.unmatched')}</span>
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap">{d.matched ? formatDateTime(d.soldAt) : '—'}</TableCell>
            <TableCell className="text-muted-foreground font-mono text-xs" dir="ltr">
              {d.terminalUid}
            </TableCell>
            <TableCell className="text-destructive text-end tabular-nums">
              {d.amount != null ? formatCurrency(d.amount) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function OfflineTransactionsPage() {
  const t = useTranslations('offlineTransactions');

  // The endpoint takes shopId and machineId; it has no company filter, so a company in
  // scope is reported as inapplicable rather than quietly ignored.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const filters = useReportFilters(SPEC);
  const today = todayIso();

  // Shown at once: before the first "הפק דוח" the default range runs.
  const params = useMemo(
    () => ({
      ...(filters.apiParams ?? reportApiParams(defaultReportFilters(SPEC, today), SPEC)),
      ...scopeApiParams(effective, false),
    }),
    [effective, filters.apiParams, today],
  );

  const query = useQuery<OfflineAuthorizationReport>({
    queryKey: ['report-offline-authorizations', params],
    queryFn: () => fetchOfflineAuthorizationsReport(params),
  });
  const data = query.data;

  const tillOf = useMemo(
    () => (r: OfflineAuthorizationRun) =>
      (r.posNumber ? t('till', { number: r.posNumber, name: r.machineName ?? '' }) : r.machineName) || r.machineId.slice(0, 8),
    [t],
  );

  const runs = useMemo<ReportTableSpec<OfflineAuthorizationRun>>(() => {
    const declinedTone = (r: { declinedCount: number }) => (r.declinedCount > 0 ? 'text-destructive font-medium' : undefined);
    const tot = data?.totals;
    return {
      id: 'main',
      title: t('runsTitle'),
      rows: data?.items ?? [],
      rowKey: (r) => r.id,
      totalsLabel: t('total'),
      emptyText: t('noRows'),
      expand: (r) => <DeclinedList run={r} />,
      columns: [
        { key: 'at', header: t('col.at'), kind: 'datetime', required: true, value: (r) => r.authorizedAt },
        { key: 'shop', header: t('col.shop'), value: (r) => r.shopName ?? null, className: 'text-muted-foreground' },
        { key: 'till', header: t('col.till'), value: tillOf, className: 'font-medium' },
        {
          key: 'approved',
          header: t('col.approved'),
          kind: 'number',
          value: (r) => r.approvedCount,
          // The screen writes the approved amount beside the count; the export has it as a column.
          cell: (r) => (
            <>
              {r.approvedCount}
              <span className="text-muted-foreground ms-2 text-xs">{formatCurrency(r.approvedAmount)}</span>
            </>
          ),
          total: tot?.approvedCount,
          totalCell: tot ? (
            <>
              {tot.approvedCount}
              <span className="text-muted-foreground ms-2 text-xs">{formatCurrency(tot.approvedAmount)}</span>
            </>
          ) : undefined,
        },
        {
          key: 'approvedAmount',
          header: t('col.approvedAmount'),
          kind: 'money',
          exportOnly: true,
          value: (r) => Number(r.approvedAmount),
          total: tot ? Number(tot.approvedAmount) : undefined,
        },
        {
          key: 'declined',
          header: t('col.declined'),
          kind: 'number',
          value: (r) => r.declinedCount,
          cell: (r) => <span className={declinedTone(r)}>{r.declinedCount}</span>,
          total: tot?.declinedCount,
          totalCell: tot ? <span className={declinedTone(tot)}>{tot.declinedCount}</span> : undefined,
        },
        {
          key: 'declinedAmount',
          header: t('col.declinedAmount'),
          kind: 'money',
          value: (r) => Number(r.declinedAmount),
          cell: (r) => <span className={declinedTone(r)}>{r.declinedCount > 0 ? formatCurrency(r.declinedAmount) : '—'}</span>,
          total: tot ? Number(tot.declinedAmount) : undefined,
          totalCell: tot ? (
            <span className={declinedTone(tot)}>{tot.declinedCount > 0 ? formatCurrency(tot.declinedAmount) : '—'}</span>
          ) : undefined,
        },
      ],
    };
  }, [data, t, tillOf]);

  /** Every declined document, one row each — the Excel's second sheet (on screen: a run's drill-down). */
  const declined = useMemo<ReportTableSpec<DeclinedRow>>(
    () => ({
      id: 'declined',
      title: t('declinedTitle'),
      rows: offlineDeclinedRows<OfflineDeclinedLeg, OfflineAuthorizationRun>(data?.items ?? []),
      rowKey: (d) => d.key,
      columns: [
        { key: 'till', header: t('col.till'), required: true, value: (d) => tillOf(d.run) },
        { key: 'at', header: t('col.at'), kind: 'datetime', value: (d) => d.run.authorizedAt },
        {
          key: 'document',
          header: t('declined.document'),
          value: (d) => (d.leg.matched ? (d.leg.documentNumber ?? null) : t('declined.unmatched')),
        },
        { key: 'soldAt', header: t('declined.soldAt'), kind: 'datetime', value: (d) => (d.leg.matched ? (d.leg.soldAt ?? null) : null) },
        { key: 'uid', header: t('declined.uid'), value: (d) => d.leg.terminalUid },
        { key: 'amount', header: t('declined.amount'), kind: 'money', value: (d) => (d.leg.amount != null ? Number(d.leg.amount) : null) },
      ],
    }),
    [data, t, tillOf],
  );

  const declinedTone = data && data.totals.declinedCount > 0;

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the cards — the declined figures are
  // the news — and the runs of the period before.
  const figures = data ? totalsFigures(data.totals) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'declined', label: t('totals.declined'), value: figures.declined, kind: 'count', better: 'down', icon: 'alert' },
        { key: 'declinedAmount', label: t('totals.declinedAmount'), value: figures.declinedAmount, kind: 'money', better: 'down' },
        { key: 'approved', label: t('totals.approved'), value: figures.approved, kind: 'count', icon: 'card' },
        { key: 'approvedAmount', label: t('col.approvedAmount'), value: figures.approvedAmount, kind: 'money' },
      ]
    : [];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(data?.window.from, data?.window.to);
    if (!w) return null;
    const before = await fetchOfflineAuthorizationsReport({ ...params, ...w });
    return { rows: before.items, kpis: totalsFigures(before.totals), ...w };
  };

  return (
    <ReportPage
      reportKey="offline-transactions"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      ready
      export={
        data
          ? {
              tables: [runs, declined] as ReportTableSpec<unknown>[],
              from: data.window.from,
              to: data.window.to,
              reportType: 'offline-transactions',
              kpis,
              insightKeys: { label: 'till', value: 'declinedAmount', count: 'declined' },
              groupBy: ['shop', 'till'],
              previous,
            }
          : null
      }
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />

          <div className="grid gap-4 md:grid-cols-3">
            <ReportStatCard
              title={t('totals.approved')}
              value={String(data.totals.approvedCount)}
              subtitle={t('totals.approvedAmount', {
                amount: formatCurrency(data.totals.approvedAmount),
                runs: data.totals.authorizationCount,
              })}
              icon={CircleCheck}
            />
            <Card className={cn(declinedTone && 'border-destructive/50 bg-destructive/5')}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-sm font-medium">{t('totals.declined')}</p>
                  <CircleX className={cn('h-4 w-4', declinedTone ? 'text-destructive' : 'text-muted-foreground')} />
                </div>
                <p className={cn('mt-2 text-2xl font-bold tabular-nums', declinedTone && 'text-destructive')}>
                  {data.totals.declinedCount}
                </p>
                {data.totals.declinedUnmatchedCount > 0 ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('totals.unmatched', { count: data.totals.declinedUnmatchedCount })}
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <Card className={cn(declinedTone && 'border-destructive/50 bg-destructive/5')}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <p className="text-muted-foreground text-sm font-medium">{t('totals.declinedAmount')}</p>
                  <WifiOff className={cn('h-4 w-4', declinedTone ? 'text-destructive' : 'text-muted-foreground')} />
                </div>
                <p className={cn('mt-2 text-2xl font-bold tabular-nums', declinedTone && 'text-destructive')}>
                  {formatCurrency(data.totals.declinedAmount)}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">{t('totals.declinedHint')}</p>
              </CardContent>
            </Card>
          </div>

          {data.truncated ? (
            <p className="rounded-md border bg-muted/40 p-3 text-sm">{t('truncated', { count: data.items.length })}</p>
          ) : null}

          <ReportTable table={runs} />
        </>
      ) : null}
    </ReportPage>
  );
}
