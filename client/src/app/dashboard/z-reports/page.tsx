'use client';

/**
 * Z reports (דוחות Z) — one per shop per run, built in the cloud from the documents of
 * the shifts it took. Each row opens the Z's own page, which also prints it.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchZReports, type ZReportListParams } from '@/lib/api';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { ZReport, ZReportListResponse } from '@/lib/types';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button, buttonVariants } from '@/components/ui/button';
import { OverShort } from '@/components/dashboard/shifts/shift-parts';
import { ZBadges } from '@/components/dashboard/z-report/z-badges';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ChevronLeft, ChevronRight, FilePlus2 } from 'lucide-react';

const PAGE_SIZE = 50;
const COLS = 11;

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
  const router = useRouter();
  const canProduceZ = useCanProduceZ();
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

  /*
   * `?zReportId=` used to open a dialog here; the Z now has its own page. Old links
   * (the day summary, bookmarks) are forwarded rather than broken.
   */
  const searchParams = useSearchParams();
  const linkedId = searchParams.get('zReportId');
  useEffect(() => {
    if (linkedId) router.replace(`/dashboard/z-reports/${linkedId}`);
  }, [linkedId, router]);

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
    // The endpoint takes a repeatable machineIds (a Z containing that till); the scope
    // names one device, so it goes in as a single-element list.
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
  const open = (z: ZReport) => router.push(`/dashboard/z-reports/${z.id}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canProduceZ ? (
          <Link href={zWizardHref(shopId, machineId)} className={buttonVariants({ size: 'sm' })}>
            <FilePlus2 className="h-4 w-4 me-1" aria-hidden />
            {t('produce')}
          </Link>
        ) : null}
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
        <p className="text-muted-foreground text-xs">{t('businessDateFilterHint')}</p>

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
              {/* First column: it is the document's name, not an attribute of it. */}
              <TableHead>{t('zNumber')}</TableHead>
              <TableHead>{t('businessDate')}</TableHead>
              <TableHead>{t('shop')}</TableHead>
              <TableHead>{t('period')}</TableHead>
              <TableHead className="text-end">{t('tills')}</TableHead>
              <TableHead className="text-end">{t('shiftsCount')}</TableHead>
              <TableHead className="text-end">{t('totalSales')}</TableHead>
              <TableHead className="text-end">{t('totalRefunds')}</TableHead>
              <TableHead className="text-end">{t('cash')}</TableHead>
              <TableHead className="text-end">{t('card')}</TableHead>
              <TableHead className="text-end">{t('discrepancy')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={COLS}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLS} className="text-center text-muted-foreground py-6">
                  {t('noReports')}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((z) => {
                const shopName = z.shopName ?? findBySameId(scope.shops, z.shopId)?.name;
                return (
                  <TableRow key={z.id} className="cursor-pointer" onClick={() => open(z)}>
                    <TableCell className="font-medium tabular-nums whitespace-nowrap">
                      <Link
                        href={`/dashboard/z-reports/${z.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* An em dash, not a 0: a shopless legacy Z has no number. */}
                        {z.shopSequenceNumber ?? '—'}
                      </Link>
                      <ZBadges z={z} />
                    </TableCell>
                    <TableCell>{formatDate(z.businessDate)}</TableCell>
                    <TableCell>
                      {shopName ?? '—'}
                      {z.legacy && z.machineName ? (
                        <div className="text-muted-foreground text-xs">{z.machineName}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {z.periodStart || z.periodEnd
                        ? `${formatDateTime(z.periodStart)} – ${formatDateTime(z.periodEnd)}`
                        : formatDateTime(z.closedAt)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {z.machineCount ?? (z.legacy ? 1 : '—')}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{z.shiftCount ?? '—'}</TableCell>
                    <TableCell className="text-end font-medium">{formatCurrency(z.totalSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalRefunds)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCashSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCardSales)}</TableCell>
                    <TableCell className="text-end">
                      {/* Withheld, not zero, when any of its shifts was not counted. */}
                      <OverShort value={z.discrepancy} uncountedLabel={t('discrepancyWithheld')} />
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
    </div>
  );
}
