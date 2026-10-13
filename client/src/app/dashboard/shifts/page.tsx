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
 * On the report framework (P:\specs\reports-upgrade.md §5): the days and the area in the
 * report bar, the status, "awaiting Z", the shop and the till beside them — all in the URL
 * under the keys they always had (`status`, `awaitingZ`, `branch`, `till`, `area`, `from`,
 * `to`, `page`), so the machines page's `?awaitingZ=1` and a shift's "back to the list" land
 * as before. A first visit lists every shift, newest first; a range narrows once run. The
 * table has the tips (§2ה, cash and card apart in the export) and a totals row (this page's
 * shifts on screen; every shift in the export, which takes every page).
 *
 * An open shift is closed from here as the devices page closes it ("סגור משמרת": the remote
 * close, or a dead till's administrative close), one at a time or all of the place's at once
 * (components/dashboard/shifts/shift-close.tsx).
 */

import { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilePlus2, ListFilter } from 'lucide-react';
import { AREA_NONE, fetchShifts, type ShiftListParams } from '@/lib/api';
import { usePageScope, useScopeQuery } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatCurrency, formatDateTimeInZone, moneyValue } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { sumMoney } from '@/lib/listExportColumns';
import { parseReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import { shiftPlace, shiftRegisterNumber, tillOptions, toggleOpenOnly, type ShiftStatusFilter } from '@/lib/shiftsPage';
import type { Money, Shift, ShiftListResponse } from '@/lib/types';
import { AreaName } from '@/components/dashboard/areas/area-filter';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
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
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const PAGE_SIZE = 50;

/** A select's "all" (a Base UI select item needs a value). */
const ALL = '__all__';

/**
 * The days and the area in the bar; the status, "awaiting Z" and the page's own shop / till as
 * the report's extras — under the URL keys the list always used.
 */
const SPEC: ReportFilterSpec = {
  filters: ['area'],
  extras: { status: '', awaitingZ: '', branch: '', till: '' },
};

function statusOf(extras: Record<string, string>): { status: ShiftStatusFilter; awaitingZ: boolean } {
  const awaitingZ = extras.awaitingZ === '1';
  // Awaiting a Z means closed: an open shift is never waiting for one.
  const status: ShiftStatusFilter = awaitingZ
    ? 'closed'
    : extras.status === 'open' || extras.status === 'closed'
      ? extras.status
      : 'all';
  return { status, awaitingZ };
}

/** Money summed, or null when no row has it (a page of open shifts has no count). */
function sumOrNull<R>(rows: R[], pick: (row: R) => Money | null | undefined): number | null {
  const values = rows.map(pick).filter((v) => v !== null && v !== undefined && v !== '');
  return values.length ? sumMoney(values) : null;
}

export default function ShiftsPage() {
  const t = useTranslations('shifts');
  const tr = useTranslations('shifts.report');
  const router = useRouter();
  const pathname = usePathname();
  const shiftLabel = useShiftLabel();
  const canProduceZ = useCanProduceZ();
  const { scope, resolution, effective, ready } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const tz = useTenantTimeZone();
  const tillLabel = useTillLabel();
  const closer = useShiftCloseDialogs(scope.machines);
  const filters = useReportFilters(SPEC);

  // What the list runs on: the URL (`?awaitingZ=1` from the machines page needs no run).
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const parsed = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, todayIso()), [urlKey]);
  const { status, awaitingZ } = statusOf(parsed.extras);
  const area = parsed.values.areaId;
  const from = parsed.applied ? parsed.values.from : '';
  const to = parsed.applied ? parsed.values.to : '';
  const page = Math.max(1, Math.floor(Number(searchParams.get('page') ?? '1')) || 1);
  // The shop and till the list is filtered on: the scope bar's, else the page's own.
  const place = shiftPlace(
    { shopId: effective.shopId, machineId: effective.machineId },
    { branch: parsed.extras.branch ?? '', till: parsed.extras.till ?? '' },
    scope.machines,
  );
  const shopId = place.shopId;
  const machineId = place.machineId;

  // A shift's page links back to exactly this list — scope and filters — and carries the
  // scope itself so the bar above it keeps naming the same shop and till.
  const scopeQuery = useScopeQuery((st) => st.query);
  const detailHref = (id: string) => {
    const q = new URLSearchParams(scopeQuery.replace(/^\?/, ''));
    q.set('list', urlKey);
    return `/dashboard/shifts/${id}?${q.toString()}`;
  };

  /** Another page of the same list (the filters stay as they are in the URL). */
  const setPage = (next: number) => {
    const q = new URLSearchParams(urlKey);
    if (next > 1) q.set('page', String(next));
    else q.delete('page');
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

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

  // Any other filter or scope is a new result set: back to its first page. An area belongs
  // to one shop, so another shop drops it (keeping "no area", which means the same anywhere).
  const filterKey = JSON.stringify({ ...params, page: undefined });
  const lastFilterKey = useRef(filterKey);
  const lastShop = useRef(shopId ?? '');
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    const shopChanged = lastShop.current !== (shopId ?? '');
    lastShop.current = shopId ?? '';
    if (!(page > 1) && !(shopChanged && area && area !== AREA_NONE)) return;
    const q = new URLSearchParams(urlKey);
    q.delete('page');
    if (shopChanged && area && area !== AREA_NONE) q.delete('area');
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the filters change
  }, [filterKey]);

  const rangeInvalid = !!from && !!to && from > to;
  const list = useQuery<ShiftListResponse>({
    queryKey: ['shifts', params],
    queryFn: () => fetchShifts(params),
    placeholderData: (prev) => prev,
    enabled: ready && !rangeInvalid,
  });
  const data = list.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  // A page past the end (a bookmarked ?page=9, or rows taken into a Z meanwhile) is
  // moved to the last page that has rows.
  useEffect(() => {
    if (data && !list.isFetching && page > totalPages) setPage(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setPage reads the live URL
  }, [data, list.isFetching, page, totalPages]);

  // ── The page's own filters in the bar (the draft; "הפק דוח" runs them) ──
  const draft = statusOf(filters.draftExtras);
  const draftPlace = shiftPlace(
    { shopId: effective.shopId, machineId: effective.machineId },
    { branch: filters.draftExtras.branch ?? '', till: filters.draftExtras.till ?? '' },
    scope.machines,
  );
  const setDraftStatus = (next: { status: ShiftStatusFilter; awaitingZ: boolean }) => {
    filters.setExtra('status', next.status === 'all' ? '' : next.status);
    filters.setExtra('awaitingZ', next.awaitingZ ? '1' : '');
  };
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
    ...tillOptions(scope.machines, draftPlace.shopId, shopNameOf).map((o) => ({
      value: o.id,
      label: draftPlace.shopId
        ? tillLabel(o.name, o.number)
        : t('filter.tillWithShop', { till: tillLabel(o.name, o.number), shop: shopNameOf(o.shopId) }),
    })),
  ];
  // A shop or till from a link whose list has not loaded (or is out of reach) still shows as chosen.
  if (draftPlace.shopId && !shopItems.some((i) => i.value === draftPlace.shopId)) {
    shopItems.push({ value: draftPlace.shopId, label: t('filter.unknown') });
  }
  if (draftPlace.machineId && !tillItems.some((i) => i.value === draftPlace.machineId)) {
    tillItems.push({ value: draftPlace.machineId, label: findBySameId(scope.machines, draftPlace.machineId)?.name ?? t('filter.unknown') });
  }
  const openOnly = draft.status === 'open' && !draft.awaitingZ;

  const barFields = (
    <>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('filter.status')}</Label>
        <Select
          value={draft.status}
          onValueChange={(v) => setDraftStatus({ status: (v ?? 'all') as ShiftStatusFilter, awaitingZ: false })}
          items={statusItems}
          // "Awaiting a Z" already means closed.
          disabled={draft.awaitingZ}
        >
          <SelectTrigger className="w-full min-w-0">
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
      <div className="min-w-0 space-y-1" title={draftPlace.shopLocked ? t('filter.lockedByScope') : undefined}>
        <Label className="text-xs">{t('filter.shop')}</Label>
        <Select
          value={draftPlace.shopId ?? ALL}
          // Another shop: its tills and areas are others — both start over.
          onValueChange={(v) => {
            filters.setExtra('branch', !v || v === ALL ? '' : String(v));
            filters.setExtra('till', '');
          }}
          items={shopItems}
          disabled={draftPlace.shopLocked}
        >
          <SelectTrigger className="w-full min-w-0">
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
      <div className="min-w-0 space-y-1" title={draftPlace.tillLocked ? t('filter.lockedByScope') : undefined}>
        <Label className="text-xs">{t('filter.till')}</Label>
        <Select
          value={draftPlace.machineId ?? ALL}
          onValueChange={(v) => filters.setExtra('till', !v || v === ALL ? '' : String(v))}
          items={tillItems}
          disabled={draftPlace.tillLocked}
        >
          <SelectTrigger className="w-full min-w-0">
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
      <div className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* "רק פתוחות": the status select's "open" in one tap, in step with it. */}
        <Button
          size="sm"
          variant={openOnly ? 'default' : 'outline'}
          aria-pressed={openOnly}
          className="rounded-full"
          onClick={() => setDraftStatus(toggleOpenOnly(draft))}
        >
          <ListFilter className="h-4 w-4 me-1" aria-hidden />
          {t('filter.openOnly')}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={draft.awaitingZ}
            onChange={(e) => setDraftStatus({ status: e.target.checked ? 'closed' : draft.status, awaitingZ: e.target.checked })}
          />
          {t('filter.awaitingZ')}
        </label>
      </div>
    </>
  );

  // What "סגור את כל המשמרות הפתוחות" takes: the list's place — never its dates or status.
  const { data: areas = [] } = useShopAreas(shopId, true);
  const placeParams = useMemo<Pick<ShiftListParams, 'shopId' | 'machineId' | 'areaId'>>(() => {
    const p: Pick<ShiftListParams, 'shopId' | 'machineId' | 'areaId'> = {};
    if (machineId) p.machineId = machineId;
    else if (shopId) p.shopId = shopId;
    if (area) p.areaId = area;
    return p;
  }, [area, machineId, shopId]);
  const areaName = area ? (area === AREA_NONE ? t('close.bulkNoArea') : (areas.find((a) => a.id === area)?.name ?? t('filter.unknown'))) : null;
  const placeLabel = [
    shopId ? shopNameOf(shopId) || t('filter.unknown') : t('close.bulkAllShops'),
    machineId ? (findBySameId(scope.machines, machineId)?.name ?? t('filter.unknown')) : null,
    areaName,
  ]
    .filter(Boolean)
    .join(' · ');

  // ── The table: this page on screen, every page in the export ──
  const pageOnly = Boolean(data && data.total > data.items.length);
  const table = useMemo<ReportTableSpec<Shift>>(() => {
    const machineOf = (s: Shift) => findBySameId(scope.machines, s.machineId);
    const open = (s: Shift) => s.status === 'open';
    const columns: ReportColumn<Shift>[] = [
      {
        key: 'shift',
        header: t('col.shift'),
        required: true,
        width: 14,
        value: (s) => shiftLabel(s),
        className: 'font-medium',
        cell: (s) => (
          <Link href={detailHref(s.id)} className="hover:underline" onClick={(e) => e.stopPropagation()}>
            {shiftLabel(s)}
          </Link>
        ),
      },
      { key: 'businessDate', header: t('col.businessDate'), kind: 'date', value: (s) => s.businessDate },
      {
        key: 'posNumber',
        header: t('col.posNumber'),
        width: 10,
        value: (s) => shiftRegisterNumber(s, machineOf(s)),
        className: 'tabular-nums',
      },
      {
        key: 'till',
        header: t('col.till'),
        value: (s) => s.machineName ?? machineOf(s)?.name ?? null,
        cell: (s) => (
          <>
            {s.machineName ?? machineOf(s)?.name ?? '—'}
            {/* An independent till shows its cashier no shifts: the shift is an internal record. */}
            {machineOf(s)?.independentTill ? <div className="text-xs text-muted-foreground">{t('internalShift')}</div> : null}
          </>
        ),
      },
      { key: 'shop', header: t('col.shop'), value: (s) => s.shopName ?? findBySameId(scope.shops, s.shopId)?.name ?? null },
      { key: 'area', header: t('col.area'), width: 14, value: (s) => s.areaName ?? null, cell: (s) => <AreaName name={s.areaName} /> },
      {
        key: 'opened',
        header: t('col.opened'),
        kind: 'datetime',
        value: (s) => s.openedAt,
        className: 'text-xs',
        cell: (s) => (
          <>
            <div>{formatDateTimeInZone(s.openedAt, tz)}</div>
            {s.openedByName ? <div className="text-muted-foreground">{s.openedByName}</div> : null}
          </>
        ),
      },
      { key: 'openedBy', header: t('detail.openedBy'), exportOnly: true, value: (s) => s.openedByName ?? null },
      {
        key: 'closed',
        header: t('col.closed'),
        kind: 'datetime',
        value: (s) => (open(s) ? null : (s.closedAt ?? null)),
        className: 'text-xs',
        cell: (s) =>
          open(s) ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <>
              <div>{formatDateTimeInZone(s.closedAt, tz)}</div>
              <div className="text-muted-foreground">{s.unattended ? t('closedRemotely') : (s.closedByName ?? '')}</div>
            </>
          ),
      },
      {
        key: 'closedBy',
        header: t('detail.closedBy'),
        exportOnly: true,
        value: (s) => (open(s) ? null : s.unattended ? t('closedRemotely') : (s.closedByName ?? null)),
      },
      {
        key: 'sales',
        header: t('col.sales'),
        kind: 'money',
        value: (s) => s.serverTotals?.totalSales ?? null,
        totalOf: (rows) => sumOrNull(rows, (s) => s.serverTotals?.totalSales),
        className: 'font-medium',
        cell: (s) => (
          <>
            {formatCurrency(s.serverTotals?.totalSales)}
            {(s.offlineDeclinedCount ?? 0) > 0 ? (
              <div className="text-destructive text-xs font-normal whitespace-nowrap">
                {t('offlineDeclined', { count: s.offlineDeclinedCount ?? 0, amount: formatCurrency(s.offlineDeclinedAmount) })}
              </div>
            ) : null}
          </>
        ),
      },
      {
        key: 'cash',
        header: t('col.cash'),
        kind: 'money',
        value: (s) => s.serverTotals?.totalCash ?? null,
        totalOf: (rows) => sumOrNull(rows, (s) => s.serverTotals?.totalCash),
      },
      {
        // The tips, apart from the takings (§2ה); cash and card under them, and apart in the export.
        key: 'tips',
        header: tr('tips'),
        kind: 'money',
        value: (s) => s.serverTotals?.totalTips ?? null,
        totalOf: (rows) => sumOrNull(rows, (s) => s.serverTotals?.totalTips),
        cell: (s) =>
          moneyValue(s.serverTotals?.totalTips) ? (
            <>
              {formatCurrency(s.serverTotals?.totalTips)}
              <div className="text-muted-foreground text-xs font-normal whitespace-nowrap">
                {tr('tipsSplit', {
                  cash: formatCurrency(s.serverTotals?.totalCashTips),
                  card: formatCurrency(s.serverTotals?.totalCardTips),
                })}
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: 'cashTips',
        header: tr('cashTips'),
        kind: 'money',
        exportOnly: true,
        value: (s) => s.serverTotals?.totalCashTips ?? null,
        totalOf: (rows) => sumOrNull(rows, (s) => s.serverTotals?.totalCashTips),
      },
      {
        key: 'cardTips',
        header: tr('cardTips'),
        kind: 'money',
        exportOnly: true,
        value: (s) => s.serverTotals?.totalCardTips ?? null,
        totalOf: (rows) => sumOrNull(rows, (s) => s.serverTotals?.totalCardTips),
      },
      {
        key: 'expected',
        header: t('col.expected'),
        kind: 'money',
        value: (s) => s.expectedCash ?? null,
        totalOf: (rows) => sumOrNull(rows, (s) => s.expectedCash),
      },
      {
        key: 'counted',
        header: t('col.counted'),
        kind: 'money',
        value: (s) => (open(s) ? null : (s.countedCash ?? null)),
        totalOf: (rows) => sumOrNull(rows.filter((s) => !open(s)), (s) => s.countedCash),
        cell: (s) => (open(s) ? '—' : <CountedCash value={s.countedCash} />),
      },
      {
        key: 'overShort',
        header: t('col.overShort'),
        kind: 'money',
        value: (s) => (open(s) ? null : (s.discrepancy ?? null)),
        totalOf: (rows) => sumOrNull(rows.filter((s) => !open(s)), (s) => s.discrepancy),
        cell: (s) => (open(s) ? '—' : <OverShort value={s.discrepancy} />),
      },
      {
        key: 'state',
        header: t('col.state'),
        screenOnly: true,
        sortable: false,
        value: (s) => s.status,
        cell: (s) => <ShiftBadges shift={s} />,
      },
      {
        key: 'actions',
        header: t('col.actions'),
        screenOnly: true,
        sortable: false,
        value: () => null,
        cell: (s) => (
          <span onClick={(e) => e.stopPropagation()}>
            <ShiftCloseAction shift={s} canClose={canProduceZ} closer={closer} />
          </span>
        ),
      },
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: data?.items ?? [],
      rowKey: (s) => s.id,
      // This page's shifts on screen (said so when there are more); every shift in the export.
      totalsLabel: pageOnly ? tr('totalPage') : tr('total'),
      emptyText: t('empty'),
      onRowClick: (s) => router.push(detailHref(s.id)),
      exportRows: () =>
        fetchAllPages((p, pageSize) => fetchShifts({ ...params, page: p, pageSize }), { pageSize: 200 }),
    };
    // detailHref reads the URL and the scope: both are in the deps through urlKey / scopeQuery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canProduceZ, closer, data, pageOnly, params, router, scope.machines, scope.shops, scopeQuery, shiftLabel, t, tr, tz, urlKey]);

  // ── What the export header says the page's own filters are ──
  const extraLines: ReportFilterLine[] = [];
  if (awaitingZ) extraLines.push({ label: t('filter.status'), value: t('filter.awaitingZ') });
  else if (status !== 'all') extraLines.push({ label: t('filter.status'), value: t(`status.${status}`) });
  const exportPlace =
    [shopId ? shopNameOf(shopId) : null, machineId ? (findBySameId(scope.machines, machineId)?.name ?? null) : null]
      .filter(Boolean)
      .join(' · ') || null;

  return (
    <>
      <ReportPage
        reportKey="shifts"
        title={t('title')}
        subtitle={t('subtitle')}
        headerExtra={
          <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
            <BulkCloseOpenShifts place={placeParams} placeLabel={placeLabel} machines={scope.machines} canClose={canProduceZ} />
            {canProduceZ ? (
              <Link href={zWizardHref(shopId, machineId)} className={buttonVariants({ size: 'sm' })}>
                <FilePlus2 className="h-4 w-4 me-1" aria-hidden />
                {t('produceZ')}
              </Link>
            ) : null}
          </div>
        }
        resolution={resolution}
        filters={filters}
        bar={{
          shopId: draftPlace.shopId,
          children: barFields,
          hint: [t('filter.dateHint'), parsed.applied ? '' : tr('allDays')].filter(Boolean).join(' '),
        }}
        query={reportQueryState(list)}
        prompt={t('empty')}
        ready
        loading="table"
        export={{
          tables: [table as ReportTableSpec<unknown>],
          from: from || null,
          to: to || null,
          place: exportPlace,
          filterLines: extraLines,
          disabled: !data || data.total === 0,
        }}
      >
        <ReportTable table={table} />
        {data && data.total > 0 ? (
          <div className="flex items-center justify-end gap-2 text-sm print:hidden">
            <span className="text-muted-foreground me-auto text-xs">{tr('shifts', { count: data.total })}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || list.isFetching}
              onClick={() => setPage(Math.max(1, page - 1))}
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
              disabled={page >= totalPages || list.isFetching}
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              aria-label={t('nextPage')}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </ReportPage>
      {closer.dialogs}
    </>
  );
}
