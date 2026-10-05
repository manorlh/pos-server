'use client';

/**
 * Offline transactions (עסקאות במצב לא מקוון) — the tills' offline authorization runs
 * over a range, newest first.
 *
 * With the acquirer out of reach the terminal approves a card sale on its own; the till
 * later sends the held sales for authorization (Agamento `authorizePendingTransactions`)
 * and reports each run. A declined one is a document the shop issued and money it will
 * not be paid, so the declined figures are the point of the page: red in the totals,
 * and each run expands to the documents it declined. A declined uid that no document of
 * the till carries (yet) is listed as such rather than dropped.
 *
 * Days are on the run's time, not the original sale's — the sale's time is in the list.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleCheck, CircleX, WifiOff } from 'lucide-react';
import { fetchOfflineAuthorizationsReport } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import type { OfflineAuthorizationReport, OfflineAuthorizationRun } from '@/lib/types';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { ReportErrorState, ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

/** Run row + the expander cell. */
const COLS = 7;

function RunRow({ run }: { run: OfflineAuthorizationRun }) {
  const t = useTranslations('offlineTransactions');
  const [open, setOpen] = useState(false);
  const expandable = run.declined.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  const till = run.posNumber ? t('till', { number: run.posNumber, name: run.machineName ?? '' }) : run.machineName;

  return (
    <>
      <TableRow
        className={cn(expandable && 'cursor-pointer')}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <TableCell className="w-8">
          {expandable ? <Chevron className="text-muted-foreground h-4 w-4" aria-hidden /> : null}
        </TableCell>
        <TableCell className="whitespace-nowrap">{formatDateTime(run.authorizedAt)}</TableCell>
        <TableCell className="text-muted-foreground">{run.shopName ?? '—'}</TableCell>
        <TableCell className="font-medium">{till ?? run.machineId.slice(0, 8)}</TableCell>
        <TableCell className="text-end tabular-nums">
          {run.approvedCount}
          <span className="text-muted-foreground ms-2 text-xs">{formatCurrency(run.approvedAmount)}</span>
        </TableCell>
        <TableCell className={cn('text-end tabular-nums', run.declinedCount > 0 && 'text-destructive font-medium')}>
          {run.declinedCount}
        </TableCell>
        <TableCell className={cn('text-end tabular-nums', run.declinedCount > 0 && 'text-destructive font-medium')}>
          {run.declinedCount > 0 ? formatCurrency(run.declinedAmount) : '—'}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={COLS} className="bg-muted/20 p-0">
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
                        <span className="font-mono text-xs" dir="ltr">
                          {d.documentNumber ?? d.transactionId?.slice(0, 8)}
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
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export default function OfflineTransactionsPage() {
  const t = useTranslations('offlineTransactions');
  const tc = useTranslations('common');

  // The endpoint takes shopId and machineId; it has no company filter, so a company in
  // scope is reported as inapplicable rather than quietly ignored.
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const scopeShopId = effective.shopId;
  const scopeMachineId = effective.machineId;

  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  // Shown at once: this is a page one checks, not a query one composes.
  const [applied, setApplied] = useState({ from, to });

  const params = useMemo(
    () => ({
      from: applied.from,
      to: applied.to,
      ...(scopeShopId ? { shopId: scopeShopId } : {}),
      ...(scopeMachineId ? { machineId: scopeMachineId } : {}),
    }),
    [applied, scopeMachineId, scopeShopId],
  );

  const { data, isLoading, isFetching, isError, error } = useQuery<OfflineAuthorizationReport>({
    queryKey: ['report-offline-authorizations', params],
    queryFn: () => fetchOfflineAuthorizationsReport(params),
  });

  const rangeInvalid = from > to;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <Card className="print:hidden">
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="offline-from">{t('filters.from')}</Label>
              <Input id="offline-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="offline-to">{t('filters.to')}</Label>
              <Input id="offline-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button className="w-full" disabled={rangeInvalid || isFetching} onClick={() => setApplied({ from, to })}>
                {isFetching ? tc('loading') : t('filters.run')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {rangeInvalid ? <p className="text-destructive py-2 text-sm">{t('filters.rangeInvalid')}</p> : null}

        {isLoading ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
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
              getSheets={() => [
                {
                  name: t('title'),
                  columns: [
                    { header: t('col.at'), kind: 'datetime' },
                    { header: t('col.shop') },
                    { header: t('col.till') },
                    { header: t('col.approved'), kind: 'number' },
                    { header: `${t('col.approved')} ₪`, kind: 'money' },
                    { header: t('col.declined'), kind: 'number' },
                    { header: t('col.declinedAmount'), kind: 'money' },
                  ],
                  rows: data.items.map((r) => [
                    r.authorizedAt, r.shopName ?? null, r.posNumber ? `${r.posNumber} ${r.machineName ?? ''}` : (r.machineName ?? null),
                    r.approvedCount, Number(r.approvedAmount), r.declinedCount, Number(r.declinedAmount),
                  ]),
                  totals: [
                    null, null, null, data.totals.approvedCount, Number(data.totals.approvedAmount),
                    data.totals.declinedCount, Number(data.totals.declinedAmount),
                  ],
                },
                {
                  name: t('declined.document'),
                  columns: [
                    { header: t('col.till') },
                    { header: t('declined.document') },
                    { header: t('declined.soldAt'), kind: 'datetime' },
                    { header: t('declined.uid') },
                    { header: t('declined.amount'), kind: 'money' },
                  ],
                  rows: data.items.flatMap((r) =>
                    r.declined.map((d) => [
                      r.machineName ?? r.posNumber ?? null, d.matched ? (d.documentNumber ?? null) : t('declined.unmatched'),
                      d.matched ? (d.soldAt ?? null) : null, d.terminalUid, d.amount != null ? Number(d.amount) : null,
                    ]),
                  ),
                },
              ]}
            />
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
              <Card className={cn(data.totals.declinedCount > 0 && 'border-destructive/50 bg-destructive/5')}>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <p className="text-muted-foreground text-sm font-medium">{t('totals.declined')}</p>
                    <CircleX className={cn('h-4 w-4', data.totals.declinedCount > 0 ? 'text-destructive' : 'text-muted-foreground')} />
                  </div>
                  <p className={cn('mt-2 text-2xl font-bold tabular-nums', data.totals.declinedCount > 0 && 'text-destructive')}>
                    {data.totals.declinedCount}
                  </p>
                  {data.totals.declinedUnmatchedCount > 0 ? (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t('totals.unmatched', { count: data.totals.declinedUnmatchedCount })}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
              <Card className={cn(data.totals.declinedCount > 0 && 'border-destructive/50 bg-destructive/5')}>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <p className="text-muted-foreground text-sm font-medium">{t('totals.declinedAmount')}</p>
                    <WifiOff className={cn('h-4 w-4', data.totals.declinedCount > 0 ? 'text-destructive' : 'text-muted-foreground')} />
                  </div>
                  <p className={cn('mt-2 text-2xl font-bold tabular-nums', data.totals.declinedCount > 0 && 'text-destructive')}>
                    {formatCurrency(data.totals.declinedAmount)}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">{t('totals.declinedHint')}</p>
                </CardContent>
              </Card>
            </div>

            {data.truncated ? (
              <p className="rounded-md border bg-muted/40 p-3 text-sm">{t('truncated', { count: data.items.length })}</p>
            ) : null}

            <div className="rounded-lg border bg-card overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t('col.at')}</TableHead>
                    <TableHead>{t('col.shop')}</TableHead>
                    <TableHead>{t('col.till')}</TableHead>
                    <TableHead className="text-end">{t('col.approved')}</TableHead>
                    <TableHead className="text-end">{t('col.declined')}</TableHead>
                    <TableHead className="text-end">{t('col.declinedAmount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLS} className="text-muted-foreground py-10 text-center">
                        {t('noRows')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.items.map((run) => <RunRow key={run.id} run={run} />)
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
