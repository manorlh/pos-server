'use client';

/**
 * Shifts (משמרות) — every till's shifts and their X figures, newest first.
 *
 * A shift is what a Z is made of: a till opens one, sells into it, and closes it with
 * a cash count and an X report. The cloud accepts the close only when it holds every
 * document of the shift, and a closed shift then waits here until a Z takes it — the
 * "awaiting Z" filter is the to-do list for whoever produces the shop's Z.
 *
 * Shop and till come from the shared scope bar, as on the transactions and Z pages, and
 * from the page's own "סניף" / "קופה" filters, which never fight the bar: what the bar
 * fixes they show, locked (lib/shiftsPage.ts shiftPlace). `GET /shifts` has no company
 * filter, so a company in scope is called out rather than silently widened to the whole
 * organization.
 *
 * An open shift is closed from here as the devices page closes it ("סגור משמרת": the remote
 * close, or a dead till's administrative close), one at a time or all of the place's at once
 * (components/dashboard/shifts/shift-close.tsx).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilePlus2, ListFilter } from 'lucide-react';
import { AREA_NONE, fetchShifts, type ShiftListParams } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope, useScopeQuery } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatCurrency, formatDate, formatDateTimeInZone } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { shiftPlace, shiftRegisterNumber, tillOptions, toggleOpenOnly } from '@/lib/shiftsPage';
import type { ShiftListResponse, ShiftStatus } from '@/lib/types';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { AreaFilterSelect, AreaName } from '@/components/dashboard/areas/area-filter';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  CountedCash,
  OverShort,
  ShiftBadges,
  useShiftLabel,
} from '@/components/dashboard/shifts/shift-parts';
import {
  BulkCloseOpenShifts,
  ShiftCloseAction,
  useShiftCloseDialogs,
  useTillLabel,
} from '@/components/dashboard/shifts/shift-close';
import { Button, buttonVariants } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';

const PAGE_SIZE = 50;
const COLS = 15;

/** A select's "all" (a Base UI select item needs a value). */
const ALL = '__all__';

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
  // The page's own "סניף" and "קופה" (beside the scope bar's shop and till).
  const branch = sp.get('branch') ?? '';
  const till = sp.get('till') ?? '';
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
    branch,
    till,
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
  const tz = useTenantTimeZone();
  const tillLabel = useTillLabel();
  const closer = useShiftCloseDialogs(scope.machines);

  // `?awaitingZ=1` is how the machines page's "closed shifts awaiting a Z" flag lands here.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { status, awaitingZ, from, to, area, branch, till, page } = filtersFrom(searchParams);
  // The shop and till the list is filtered on: the scope bar's, else the page's own.
  const place = shiftPlace({ shopId: effective.shopId, machineId: effective.machineId }, { branch, till }, scope.machines);
  const shopId = place.shopId;
  const machineId = place.machineId;
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
        branch: string;
        till: string;
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
      if ('branch' in patch) put('branch', patch.branch ?? null);
      if ('till' in patch) put('till', patch.till ?? null);
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

  // "סניף" and "קופה": the shops in reach, and the chosen shop's tills ("קופה 2 · בר").
  const shopNameOf = (id: string | null | undefined) => (id ? (findBySameId(scope.shops, id)?.name ?? '') : '');
  const shopItems = [
    { value: ALL, label: t('filter.shopAll') },
    ...[...scope.shops]
      .sort((a, b) => a.name.localeCompare(b.name, 'he-IL'))
      .map((sh) => ({ value: sh.id, label: sh.name })),
  ];
  const tillItems = [
    { value: ALL, label: t('filter.tillAll') },
    ...tillOptions(scope.machines, shopId, shopNameOf).map((o) => ({
      value: o.id,
      label: shopId
        ? tillLabel(o.name, o.number)
        : t('filter.tillWithShop', { till: tillLabel(o.name, o.number), shop: shopNameOf(o.shopId) }),
    })),
  ];
  // A shop or till from a link whose list has not loaded (or is out of reach) still shows as chosen.
  if (shopId && !shopItems.some((i) => i.value === shopId)) shopItems.push({ value: shopId, label: t('filter.unknown') });
  if (machineId && !tillItems.some((i) => i.value === machineId)) {
    tillItems.push({ value: machineId, label: findBySameId(scope.machines, machineId)?.name ?? t('filter.unknown') });
  }
  const openOnly = status === 'open' && !awaitingZ;

  // What "סגור את כל המשמרות הפתוחות" takes: the list's place — never its dates or status.
  const { data: areas = [] } = useShopAreas(shopId, true);
  const placeParams = useMemo<Pick<ShiftListParams, 'shopId' | 'machineId' | 'areaId'>>(() => {
    const p: Pick<ShiftListParams, 'shopId' | 'machineId' | 'areaId'> = {};
    if (machineId) p.machineId = machineId;
    else if (shopId) p.shopId = shopId;
    if (area) p.areaId = area;
    return p;
  }, [area, machineId, shopId]);
  const placeLabel = [
    shopId ? shopNameOf(shopId) || t('filter.unknown') : t('close.bulkAllShops'),
    machineId ? (findBySameId(scope.machines, machineId)?.name ?? t('filter.unknown')) : null,
    area
      ? area === AREA_NONE
        ? t('close.bulkNoArea')
        : (areas.find((a) => a.id === area)?.name ?? t('filter.unknown'))
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
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
              <DatePicker
                value={from}
                max={to || undefined}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => setFilters({ from: e.target.value })}
                range={{ from, to, onSelect: (r) => setFilters({ from: r.from, to: r.to }) }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('filter.to')}</Label>
              <DatePicker
                value={to}
                min={from || undefined}
                aria-invalid={rangeInvalid || undefined}
                onChange={(e) => setFilters({ to: e.target.value })}
                range={{ from, to, onSelect: (r) => setFilters({ from: r.from, to: r.to }) }}
              />
            </div>
            <div className="space-y-1" title={place.shopLocked ? t('filter.lockedByScope') : undefined}>
              <Label className="text-xs">{t('filter.shop')}</Label>
              <Select
                value={shopId ?? ALL}
                // Another shop: its tills and areas are others — both start over.
                onValueChange={(v) =>
                  setFilters({ branch: !v || v === ALL ? '' : String(v), till: '', area: area === AREA_NONE ? area : '' })
                }
                items={shopItems}
                disabled={place.shopLocked}
              >
                <SelectTrigger className="min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {shopItems.map((item) => (
                    <SelectItem key={item.value} value={item.value} label={item.label}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1" title={place.tillLocked ? t('filter.lockedByScope') : undefined}>
              <Label className="text-xs">{t('filter.till')}</Label>
              <Select
                value={machineId ?? ALL}
                onValueChange={(v) => setFilters({ till: !v || v === ALL ? '' : String(v) })}
                items={tillItems}
                disabled={place.tillLocked}
              >
                <SelectTrigger className="min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tillItems.map((item) => (
                    <SelectItem key={item.value} value={item.value} label={item.label}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <AreaFilterSelect
              shopId={shopId}
              value={area}
              onChange={(next) => setFilters({ area: next })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* "רק פתוחות": the status select's "open" in one tap, in step with it. */}
            <Button
              size="sm"
              variant={openOnly ? 'default' : 'outline'}
              aria-pressed={openOnly}
              className="rounded-full"
              onClick={() => setFilters(toggleOpenOnly({ status, awaitingZ }))}
            >
              <ListFilter className="h-4 w-4 me-1" aria-hidden />
              {t('filter.openOnly')}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={awaitingZ}
                onChange={(e) => setFilters({ awaitingZ: e.target.checked })}
              />
              {t('filter.awaitingZ')}
            </label>
            <div className="ms-auto">
              <BulkCloseOpenShifts
                place={placeParams}
                placeLabel={placeLabel}
                machines={scope.machines}
                canClose={canProduceZ}
              />
            </div>
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
            // Every shift of these filters, not just this page (the list's largest page is 200).
            getSheets={async () => ({
              name: t('title'),
              columns: [
                { header: t('col.shift'), width: 14 },
                { header: t('col.businessDate'), kind: 'date' },
                { header: t('col.posNumber'), width: 10 },
                { header: t('col.till') },
                { header: t('col.shop') },
                { header: t('col.area'), width: 14 },
                { header: t('col.opened'), kind: 'datetime' },
                { header: t('col.closed'), kind: 'datetime' },
                { header: t('col.sales'), kind: 'money' },
                { header: t('col.cash'), kind: 'money' },
                { header: t('col.expected'), kind: 'money' },
                { header: t('col.counted'), kind: 'money' },
                { header: t('col.overShort'), kind: 'money' },
              ],
              rows: (
                await fetchAllPages((p, pageSize) => fetchShifts({ ...params, page: p, pageSize }), { pageSize: 200 })
              ).map((s) => [
                shiftLabel(s), s.businessDate,
                shiftRegisterNumber(s, findBySameId(scope.machines, s.machineId)),
                s.machineName ?? findBySameId(scope.machines, s.machineId)?.name ?? null,
                s.shopName ?? findBySameId(scope.shops, s.shopId)?.name ?? null,
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
                  <TableHead className="whitespace-nowrap">{t('col.posNumber')}</TableHead>
                  <TableHead>{t('col.till')}</TableHead>
                  <TableHead>{t('col.shop')}</TableHead>
                  <TableHead>{t('col.area')}</TableHead>
                  <TableHead>{t('col.opened')}</TableHead>
                  <TableHead>{t('col.closed')}</TableHead>
                  <TableHead className="text-end">{t('col.sales')}</TableHead>
                  <TableHead className="text-end">{t('col.cash')}</TableHead>
                  <TableHead className="text-end">{t('col.expected')}</TableHead>
                  <TableHead className="text-end">{t('col.counted')}</TableHead>
                  <TableHead className="text-end">{t('col.overShort')}</TableHead>
                  <TableHead>{t('col.state')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('col.actions')}</span>
                  </TableHead>
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
                    const machine = findBySameId(scope.machines, s.machineId);
                    const machineName = s.machineName ?? machine?.name ?? '—';
                    const shopName = s.shopName ?? findBySameId(scope.shops, s.shopId)?.name;
                    const number = shiftRegisterNumber(s, machine);
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
                        <TableCell className="tabular-nums">
                          {number !== null ? number : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>{machineName}</TableCell>
                        <TableCell className="text-sm">
                          {shopName ?? <span className="text-muted-foreground">—</span>}
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
                        <TableCell>
                          <ShiftCloseAction shift={s} canClose={canProduceZ} closer={closer} />
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
      {closer.dialogs}
    </div>
  );
}
