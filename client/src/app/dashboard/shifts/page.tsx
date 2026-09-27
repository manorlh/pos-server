'use client';

/**
 * Shifts (משמרות) — every till's shifts and their X figures, newest first.
 *
 * A shift is what a Z is made of: a till opens one, sells into it, and closes it with
 * a cash count and an X report. The cloud accepts the close only when it holds every
 * document of the shift, and a closed shift then waits here until a Z takes it — the
 * "awaiting Z" filter is the to-do list for whoever produces the shop's Z.
 *
 * Shop and till come from the shared scope bar, as on the transactions and Z pages;
 * `GET /shifts` has no company filter, so a company in scope is called out rather
 * than silently widened to the whole organization.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilePlus2 } from 'lucide-react';
import { fetchShifts, type ShiftListParams } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import type { ShiftListResponse, ShiftStatus } from '@/lib/types';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  CountedCash,
  OverShort,
  ShiftBadges,
  useShiftLabel,
} from '@/components/dashboard/shifts/shift-parts';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 50;
const COLS = 11;

type StatusFilter = 'all' | ShiftStatus;

export default function ShiftsPage() {
  const t = useTranslations('shifts');
  const tc = useTranslations('common');
  const router = useRouter();
  const shiftLabel = useShiftLabel();
  const canProduceZ = useCanProduceZ();
  const { scope, resolution, effective } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const shopId = effective.shopId;
  const machineId = effective.machineId;

  // `?awaitingZ=1` is how the machines page's "closed shifts awaiting a Z" flag lands here.
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<StatusFilter>(
    searchParams.get('status') === 'open' ? 'open' : searchParams.get('status') === 'closed' ? 'closed' : 'all',
  );
  const [awaitingZ, setAwaitingZ] = useState(searchParams.get('awaitingZ') === '1');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  // A new scope is a new result set; reset the page during render, not an effect later.
  const scopeKey = `${shopId ?? ''}|${machineId ?? ''}`;
  const [pageScopeKey, setPageScopeKey] = useState(scopeKey);
  if (pageScopeKey !== scopeKey) {
    setPageScopeKey(scopeKey);
    setPage(1);
  }

  const params = useMemo<ShiftListParams>(() => {
    const p: ShiftListParams = { page, pageSize: PAGE_SIZE };
    if (shopId) p.shopId = shopId;
    if (machineId) p.machineId = machineId;
    if (status !== 'all') p.status = status;
    if (awaitingZ) p.awaitingZ = true;
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [shopId, machineId, status, awaitingZ, from, to, page]);

  const { data, isLoading, isFetching, isError, error } = useQuery<ShiftListResponse>({
    queryKey: ['shifts', params],
    queryFn: () => fetchShifts(params),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const statusItems = [
    { value: 'all', label: t('filter.statusAll') },
    { value: 'open', label: t('status.open') },
    { value: 'closed', label: t('status.closed') },
  ];

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
            {t('produceZ')}
          </Link>
        ) : null}
      </div>

      <ScopeGate resolution={resolution}>
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-xs">{t('filter.status')}</Label>
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus((v ?? 'all') as StatusFilter);
                  setPage(1);
                }}
                items={statusItems}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusItems.map((item) => (
                    <SelectItem key={item.value} value={item.value} label={item.label}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('filter.from')}</Label>
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('filter.to')}</Label>
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={awaitingZ}
                onChange={(e) => {
                  setAwaitingZ(e.target.checked);
                  setPage(1);
                }}
              />
              {t('filter.awaitingZ')}
            </label>
          </div>
          <p className="text-muted-foreground text-xs">{t('filter.dateHint')}</p>
        </div>

        {isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.shift')}</TableHead>
                  <TableHead>{t('col.businessDate')}</TableHead>
                  <TableHead>{t('col.till')}</TableHead>
                  <TableHead>{t('col.opened')}</TableHead>
                  <TableHead>{t('col.closed')}</TableHead>
                  <TableHead className="text-end">{t('col.sales')}</TableHead>
                  <TableHead className="text-end">{t('col.cash')}</TableHead>
                  <TableHead className="text-end">{t('col.expected')}</TableHead>
                  <TableHead className="text-end">{t('col.counted')}</TableHead>
                  <TableHead className="text-end">{t('col.overShort')}</TableHead>
                  <TableHead>{t('col.state')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={COLS}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : !data || data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={COLS} className="py-6 text-center text-muted-foreground">
                      {t('empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.items.map((s) => {
                    const machineName =
                      s.machineName ?? findBySameId(scope.machines, s.machineId)?.name ?? '—';
                    const shopName = s.shopName ?? findBySameId(scope.shops, s.shopId)?.name;
                    return (
                      <TableRow
                        key={s.id}
                        className="cursor-pointer"
                        onClick={() => router.push(`/dashboard/shifts/${s.id}`)}
                      >
                        <TableCell className="font-medium whitespace-nowrap">
                          <Link
                            href={`/dashboard/shifts/${s.id}`}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {shiftLabel(s)}
                          </Link>
                        </TableCell>
                        <TableCell>{formatDate(s.businessDate)}</TableCell>
                        <TableCell>
                          <div>{machineName}</div>
                          {shopName ? (
                            <div className="text-muted-foreground text-xs">{shopName}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          <div>{formatDateTime(s.openedAt)}</div>
                          {s.openedByName ? (
                            <div className="text-muted-foreground">{s.openedByName}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {s.status === 'open' ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              <div>{formatDateTime(s.closedAt)}</div>
                              <div className="text-muted-foreground">
                                {s.unattended ? t('closedRemotely') : (s.closedByName ?? '')}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-end font-medium">
                          {formatCurrency(s.serverTotals?.totalSales)}
                        </TableCell>
                        <TableCell className="text-end">
                          {formatCurrency(s.serverTotals?.totalCash)}
                        </TableCell>
                        <TableCell className="text-end">{formatCurrency(s.expectedCash)}</TableCell>
                        <TableCell className="text-end">
                          {s.status === 'open' ? '—' : <CountedCash value={s.countedCash} />}
                        </TableCell>
                        <TableCell className="text-end">
                          {s.status === 'open' ? '—' : <OverShort value={s.discrepancy} />}
                        </TableCell>
                        <TableCell>
                          <ShiftBadges shift={s} />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {data && data.total > 0 ? (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label={t('prevPage')}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span className="text-muted-foreground tabular-nums">
              {page} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label={t('nextPage')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </ScopeGate>
    </div>
  );
}
