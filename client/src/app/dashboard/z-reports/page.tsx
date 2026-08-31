'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchZReports, type ZReportListParams } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { ZReport, ZReportListResponse } from '@/lib/types';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 50;

/** The zone a `datetime-local` input's value is read in — the browser's own. */
const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
})();

/**
 * `datetime-local` gives a wall-clock string with no zone ("2026-08-27T18:00").
 * The server reads a naive datetime as UTC, so sending it through untouched would
 * shift an Israeli user's filter by two or three hours without saying so. Convert
 * to an absolute instant here instead, and label the field with the zone used.
 */
function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export default function ZReportsPage() {
  const t = useTranslations('zReports');
  const tc = useTranslations('common');
  // `GET /z-reports` filters by shopId and machineIds; there is no company filter.
  const { scope, resolution, effective } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const shopId = effective.shopId;
  const machineId = effective.machineId;

  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [closedFrom, setClosedFrom] = useState<string>('');
  const [closedTo, setClosedTo] = useState<string>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ZReport | null>(null);

  // Same reasoning as the transactions list: a new scope is a new result set, so
  // the page number resets during render rather than one frame later.
  const scopeKey = `${shopId ?? ''}|${machineId ?? ''}`;
  const [pageScopeKey, setPageScopeKey] = useState(scopeKey);
  if (pageScopeKey !== scopeKey) {
    setPageScopeKey(scopeKey);
    setPage(1);
  }

  const params = useMemo<ZReportListParams>(() => {
    const p: ZReportListParams = { page, pageSize: PAGE_SIZE };
    // The endpoint takes a repeatable machineIds; the scope names one device, so
    // it goes in as a single-element list rather than through a second parameter.
    if (machineId) p.machineIds = [machineId];
    if (shopId) p.shopId = shopId;
    if (from) p.from = from;
    if (to) p.to = to;
    const cf = localInputToIso(closedFrom);
    const ct = localInputToIso(closedTo);
    if (cf) p.closedFrom = cf;
    if (ct) p.closedTo = ct;
    return p;
  }, [machineId, shopId, from, to, closedFrom, closedTo, page]);

  const { data, isLoading, isFetching, isError, error } = useQuery<ZReportListResponse>({
    queryKey: ['z-reports', params],
    queryFn: () => fetchZReports(params),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const resetPage = () => setPage(1);

  const hasClosedFilter = Boolean(closedFrom || closedTo);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('filterFrom')}</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => { setFrom(e.target.value); resetPage(); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('filterTo')}</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => { setTo(e.target.value); resetPage(); }}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">{t('dayDateFilterHint')}</p>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('filterClosedFrom')}</Label>
            <Input
              type="datetime-local"
              value={closedFrom}
              onChange={(e) => { setClosedFrom(e.target.value); resetPage(); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('filterClosedTo')}</Label>
            <Input
              type="datetime-local"
              value={closedTo}
              onChange={(e) => { setClosedTo(e.target.value); resetPage(); }}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t('closedAtFilterHint', { tz: BROWSER_TZ })}
        </p>

        {hasClosedFilter ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setClosedFrom(''); setClosedTo(''); resetPage(); }}
            >
              {t('clearClosedFilter')}
            </Button>
          </div>
        ) : null}
      </div>

      {isError ? (
        <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
      ) : (
      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('dayDate')}</TableHead>
              <TableHead>{t('machine')}</TableHead>
              <TableHead>{t('shop')}</TableHead>
              <TableHead>{t('closedAt')}</TableHead>
              <TableHead className="text-end">{t('totalSales')}</TableHead>
              <TableHead className="text-end">{t('totalRefunds')}</TableHead>
              <TableHead className="text-end">{t('cash')}</TableHead>
              <TableHead className="text-end">{t('card')}</TableHead>
              <TableHead className="text-end">{t('transactionsCount')}</TableHead>
              <TableHead className="text-end">{t('discrepancy')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={11}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-muted-foreground py-6">
                  {t('noReports')}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((z) => {
                const disc = z.discrepancy ?? 0;
                const machineName =
                  z.machineName ?? findBySameId(scope.machines, z.machineId)?.name;
                const shopName = z.shopName ?? findBySameId(scope.shops, z.shopId)?.name;
                return (
                  <TableRow key={z.id} className="cursor-pointer" onClick={() => setSelected(z)}>
                    <TableCell>{formatDate(z.dayDate)}</TableCell>
                    <TableCell>{machineName ?? z.machineId.slice(0, 8)}</TableCell>
                    <TableCell className="text-muted-foreground">{shopName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatDateTime(z.closedAt)}
                    </TableCell>
                    <TableCell className="text-end font-medium">{formatCurrency(z.totalSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalRefunds)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCashSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCardSales)}</TableCell>
                    <TableCell className="text-end">{z.transactionsCount ?? 0}</TableCell>
                    <TableCell className={`text-end font-medium ${disc < 0 ? 'text-destructive' : disc > 0 ? 'text-emerald-600' : ''}`}>
                      {formatCurrency(disc)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setSelected(z); }}>
                        {t('viewDetails')}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            size="sm" variant="outline"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground tabular-nums">{page} / {totalPages}</span>
          <Button
            size="sm" variant="outline"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      )}
      </ScopeGate>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('details')}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t('dayDate')}</Label>
                  <div>{formatDate(selected.dayDate)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('closedAt')}</Label>
                  <div>{formatDateTime(selected.closedAt)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('machine')}</Label>
                  <div>
                    {selected.machineName
                      ?? findBySameId(scope.machines, selected.machineId)?.name
                      ?? selected.machineId.slice(0, 8)}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">{t('shop')}</Label>
                  <div>
                    {selected.shopName
                      ?? findBySameId(scope.shops, selected.shopId)?.name
                      ?? '—'}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">{t('openingCash')}</Label>
                  <div>{formatCurrency(selected.openingCash)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('closingCash')}</Label>
                  <div>{formatCurrency(selected.closingCash)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('expectedCash')}</Label>
                  <div>{formatCurrency(selected.expectedCash)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('actualCash')}</Label>
                  <div>{formatCurrency(selected.actualCash)}</div>
                </div>
              </div>

              <div className="rounded border bg-muted/40 p-3 space-y-1">
                <div className="flex justify-between"><span>{t('totalSales')}</span><span className="font-bold">{formatCurrency(selected.totalSales)}</span></div>
                <div className="flex justify-between"><span>{t('totalRefunds')}</span><span>{formatCurrency(selected.totalRefunds)}</span></div>
                <div className="flex justify-between"><span>{t('cash')}</span><span>{formatCurrency(selected.totalCashSales)}</span></div>
                <div className="flex justify-between"><span>{t('card')}</span><span>{formatCurrency(selected.totalCardSales)}</span></div>
                <div className="flex justify-between"><span>{t('transactionsCount')}</span><span>{selected.transactionsCount ?? 0}</span></div>
                <div className="flex justify-between"><span>{t('discrepancy')}</span><span>{formatCurrency(selected.discrepancy)}</span></div>
              </div>

              {selected.payload && (
                <details className="rounded border p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">{t('rawPayload')}</summary>
                  <pre className="text-xs mt-2 max-h-72 overflow-auto bg-muted/40 p-2 rounded">{JSON.stringify(selected.payload, null, 2)}</pre>
                </details>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
