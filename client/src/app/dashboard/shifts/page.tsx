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

import { useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilePlus2 } from 'lucide-react';
import { AREA_NONE, fetchShifts, type ShiftListParams } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope, useScopeQuery } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { formatCurrency, formatDate, formatDateTimeInZone } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import type { ShiftListResponse, ShiftStatus } from '@/lib/types';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { AreaFilterSelect, AreaName } from '@/components/dashboard/areas/area-filter';
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
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

const PAGE_SIZE = 50;
const COLS = 12;

type StatusFilter = 'all' | ShiftStatus;

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The page's filters, from the URL — so Back, a reload and a shared link keep them. */
function filtersFrom(sp: URLSearchParams | { get(name: string): string | null }) {
  const rawStatus = sp.get('status');
  const awaitingZ = sp.get('awaitingZ') === '1';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const page = Math.max(1, Math.floor(Number(sp.get('page') ?? '1')) || 1);
  // `none` = shifts stamped with no area; otherwise an area id of the shop in scope.
  const area = sp.get('area') ?? '';
  const status: StatusFilter = awaitingZ
    ? // Awaiting a Z means closed: an open shift is never waiting for one.
      'closed'
    : rawStatus === 'open' || rawStatus === 'closed'
      ? rawStatus
      : 'all';
  return {
    status,
    awaitingZ,
    from: PLAIN_DATE.test(from) ? from : '',
    to: PLAIN_DATE.test(to) ? to : '',
    area,
    page,
  };
}

export default function ShiftsPage() {
  const t = useTranslations('shifts');
  const tc = useTranslations('common');
  const router = useRouter();
  const shiftLabel = useShiftLabel();
  const canProduceZ = useCanProduceZ();
  const { scope, resolution, effective, ready } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const shopId = effective.shopId;
  const machineId = effective.machineId;
  const tz = useTenantTimeZone();

  // `?awaitingZ=1` is how the machines page's "closed shifts awaiting a Z" flag lands here.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { status, awaitingZ, from, to, area, page } = filtersFrom(searchParams);
  const rangeInvalid = !!from && !!to && from > to;
  // A shift's page links back to exactly this list — scope and filters — and carries the
  // scope itself so the bar above it keeps naming the same shop and till.
  const scopeQuery = useScopeQuery((st) => st.query);
  const detailHref = (id: string) => {
    const q = new URLSearchParams(scopeQuery.replace(/^\?/, ''));
    q.set('list', searchParams.toString());
    return `/dashboard/shifts/${id}?${q.toString()}`;
  };

  /** Change filters in the URL, keeping the scope's own params beside them. */
  const setFilters = useCallback(
    (
      patch: Partial<{
        status: StatusFilter;
        awaitingZ: boolean;
        from: string;
        to: string;
        area: string;
        page: number;
      }>,
    ) => {
      const next = new URLSearchParams(searchParams.toString());
      const put = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
      if ('status' in patch) put('status', patch.status && patch.status !== 'all' ? patch.status : null);
      if ('awaitingZ' in patch) put('awaitingZ', patch.awaitingZ ? '1' : null);
      if ('from' in patch) put('from', patch.from ?? null);
      if ('to' in patch) put('to', patch.to ?? null);
      if ('area' in patch) put('area', patch.area ?? null);
      // Any filter change is a new result set: back to its first page.
      const nextPage = 'page' in patch ? (patch.page ?? 1) : 1;
      put('page', nextPage > 1 ? String(nextPage) : null);
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // A new scope is a new result set too. An area belongs to one shop, so another shop
  // drops the area filter (keeping "no area", which means the same thing anywhere).
  const scopeKey = `${shopId ?? ''}|${machineId ?? ''}`;
  const shopKey = shopId ?? '';
  const lastScopeKey = useRef(scopeKey);
  const lastShopKey = useRef(shopKey);
  useEffect(() => {
    if (lastScopeKey.current === scopeKey) return;
    lastScopeKey.current = scopeKey;
    const shopChanged = lastShopKey.current !== shopKey;
    lastShopKey.current = shopKey;
    if (shopChanged && area && area !== AREA_NONE) setFilters({ area: '' });
    else if (page > 1) setFilters({ page: 1 });
  }, [area, page, scopeKey, setFilters, shopKey]);

  const params = useMemo<ShiftListParams>(() => {
    const p: ShiftListParams = { page, pageSize: PAGE_SIZE };
    // A till is enough on its own: sending its shop too would hide the shifts it took
    // before it was moved to another shop.
    if (machineId) p.machineId = machineId;
    else if (shopId) p.shopId = shopId;
    if (status !== 'all') p.status = status;
    if (awaitingZ) p.awaitingZ = true;
    if (from) p.from = from;
    if (to) p.to = to;
    if (area) p.areaId = area;
    return p;
  }, [shopId, machineId, status, awaitingZ, from, to, area, page]);

  const { data, isLoading, isFetching, isError, error } = useQuery<ShiftListResponse>({
    queryKey: ['shifts', params],
    queryFn: () => fetchShifts(params),
    placeholderData: (prev) => prev,
    enabled: ready && !rangeInvalid,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // A page past the end (a bookmarked ?page=9, or rows taken into a Z meanwhile) is
  // moved to the last page that has rows.
  useEffect(() => {
    if (data && !isFetching && page > totalPages) setFilters({ page: totalPages });
  }, [data, isFetching, page, setFilters, totalPages]);
  const statusItems = [
    { value: 'all', label: t('filter.statusAll') },
    { value: 'open', label: t('status.open') },
    { value: 'closed', label: t('status.closed') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
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
        <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
          <div className="grid gap-3 md:grid-cols-5">
            <div className="space-y-1">
              <Label className="text-xs">{t('filter.status')}</Label>
              <Select
                value={status}
                onValueChange={(v) => setFilters({ status: (v ?? 'all') as StatusFilter })}
                items={statusItems}
                // "Awaiting a Z" already means closed.
                disabled={awaitingZ}
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
                max={to || undefined}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => setFilters({ from: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('filter.to')}</Label>
              <Input
                type="date"
                value={to}
                min={from || undefined}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => setFilters({ to: e.target.value })}
              />
            </div>
            <AreaFilterSelect
              shopId={shopId}
              value={area}
              onChange={(next) => setFilters({ area: next })}
            />
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={awaitingZ}
                onChange={(e) => setFilters({ awaitingZ: e.target.checked })}
              />
              {t('filter.awaitingZ')}
            </label>
          </div>
          {rangeInvalid ? (
            <p className="text-destructive text-xs">{t('filter.rangeInvalid')}</p>
          ) : null}
          <p className="text-muted-foreground text-xs">{t('filter.dateHint')}</p>
        </div>

        {!rangeInvalid && data && data.items.length > 0 ? (
          <ReportExportToolbar
            title={t('title')}
            from={from || undefined}
            to={to || undefined}
            getSheets={() => ({
              name: t('title'),
              columns: [
                { header: t('col.shift'), width: 14 },
                { header: t('col.businessDate'), kind: 'date' },
                { header: t('col.till') },
                { header: t('col.area'), width: 14 },
                { header: t('col.opened'), kind: 'datetime' },
                { header: t('col.closed'), kind: 'datetime' },
                { header: t('col.sales'), kind: 'money' },
                { header: t('col.cash'), kind: 'money' },
                { header: t('col.expected'), kind: 'money' },
                { header: t('col.counted'), kind: 'money' },
                { header: t('col.overShort'), kind: 'money' },
              ],
              rows: data.items.map((s) => [
                shiftLabel(s), s.businessDate,
                s.machineName ?? findBySameId(scope.machines, s.machineId)?.name ?? null,
                s.areaName ?? null, s.openedAt, s.status === 'open' ? null : (s.closedAt ?? null),
                s.serverTotals?.totalSales ?? null, s.serverTotals?.totalCash ?? null, s.expectedCash ?? null,
                s.status === 'open' ? null : (s.countedCash ?? null), s.status === 'open' ? null : (s.discrepancy ?? null),
              ]),
            })}
          />
        ) : null}
        {rangeInvalid ? null : isError ? (
          <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('col.shift')}</TableHead>
                  <TableHead>{t('col.businessDate')}</TableHead>
                  <TableHead>{t('col.till')}</TableHead>
                  <TableHead>{t('col.area')}</TableHead>
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
                        onClick={() => router.push(detailHref(s.id))}
                      >
                        <TableCell className="font-medium whitespace-nowrap">
                          <Link
                            href={detailHref(s.id)}
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
                        <TableCell className="text-sm">
                          <AreaName name={s.areaName} />
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          <div>{formatDateTimeInZone(s.openedAt, tz)}</div>
                          {s.openedByName ? (
                            <div className="text-muted-foreground">{s.openedByName}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {s.status === 'open' ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              <div>{formatDateTimeInZone(s.closedAt, tz)}</div>
                              <div className="text-muted-foreground">
                                {s.unattended ? t('closedRemotely') : (s.closedByName ?? '')}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-end font-medium">
                          {formatCurrency(s.serverTotals?.totalSales)}
                          {(s.offlineDeclinedCount ?? 0) > 0 ? (
                            <div className="text-destructive text-xs font-normal whitespace-nowrap">
                              {t('offlineDeclined', {
                                count: s.offlineDeclinedCount ?? 0,
                                amount: formatCurrency(s.offlineDeclinedAmount),
                              })}
                            </div>
                          ) : null}
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

        {!rangeInvalid && data && data.total > 0 ? (
          <div className="flex items-center justify-end gap-2 text-sm print:hidden">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || isFetching}
              onClick={() => setFilters({ page: Math.max(1, page - 1) })}
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
              onClick={() => setFilters({ page: Math.min(totalPages, page + 1) })}
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
