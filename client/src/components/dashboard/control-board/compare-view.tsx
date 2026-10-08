'use client';

/**
 * השוואות — the home page's second view (`/dashboard?view=compare`; the old
 * `/dashboard/compare` comes here).
 *
 * * **Period against period** — a day, a week, a month, any range or an event, against the
 *   period before, the same weekday last week, the same period last year, any range or
 *   another event: every headline figure with its change as a number and a percent, the
 *   two curves overlaid (by the hour for days, by the n-th day for longer periods, by the
 *   hours since it began for events), the tenders, the vouchers, the best sellers — one
 *   request (`GET /reports/compare`) — and, for days, the cashiers, the breakdown under the
 *   scope, the card brands and the open tables (the old compare board's).
 * * **Side by side** — two to four shops, points of sale, tills or cashiers (side-by-side.tsx).
 *
 * Every filter is in the URL (lib/periodCompare.ts) with the shared scope; Excel / PDF
 * through the reports' toolbar. Phone first, on the board's own tokens (light and dark).
 */

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Layers, Users } from 'lucide-react';
import { fetchCashierSalesReport, fetchOverview } from '@/lib/api';
import {
  fetchPeriodCompare,
  fetchVoucherBoard,
  type CompareScope,
  type EventBrief,
  type PeriodCompareReport,
} from '@/lib/compareApi';
import { fetchCardBrandsReport } from '@/lib/salesReportsApi';
import { formatCurrency, formatShortDate } from '@/lib/format';
import { useScope } from '@/lib/scope';
import { shiftIsoDay, type BoardParams } from '@/lib/controlBoard';
import {
  PERIOD_KINDS,
  comparedRange,
  compareQuery,
  comparisonSheets,
  curvePoints,
  defaultVs,
  monthEnd,
  monthStart,
  periodRange,
  rangeDays,
  sideBySideSheets,
  stepAnchor,
  toSalesFigures,
  weekStart,
  type CompareParams,
  type DayRange,
  type ExportWords,
  type FiguresLike,
  type PeriodKind,
  type VsKind,
} from '@/lib/periodCompare';
import type { ExcelSheet } from '@/lib/excelExport';
import type { CashierSalesReport, OverviewReport, OverviewSales } from '@/lib/types';
import { DatePicker } from '@/components/ui/date-picker';
import { Button } from '@/components/ui/button';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { OpenTablesWidget } from '@/components/dashboard/insights/open-tables-widget';
import { FilterBox, Segmented, type FilterOption } from './board-ui';
import { ScopeBoxes, useDayNames } from './board-filters';
import { BoardTenders } from './board-tenders';
import { BoardItems } from './board-items';
import { BoardVouchers } from './board-vouchers';
import { CardBrandsCard, CompareChart, CompareKpis, CompareRowsCard, type CompareRow } from './compare-parts';
import { EventPicker, useEventWhen } from './event-picker';
import { SideBySide, useSideBySide } from './side-by-side';

const LIVE_MS = 60_000;
const PAST_STALE_MS = 5 * 60_000;
const TOP_ITEMS = 10;

/** The scope's own rows one level under it, from a range's overview (the old compare board's). */
function breakdown(
  report: OverviewReport | undefined,
  scope: CompareScope,
): { level: 'companies' | 'shops' | 'areas' | 'tills'; rows: { id: string; name: string; sales: OverviewSales }[] } {
  if (!report) return { level: 'shops', rows: [] };
  const shops = report.companies.flatMap((c) => c.shops);
  const till = (m: { id: string; name: string; posNumber?: string | null }) =>
    m.posNumber ? `#${m.posNumber} · ${m.name}` : m.name;
  if (scope.machineId) {
    const m = shops.flatMap((s) => s.machines).find((x) => x.id === scope.machineId);
    return { level: 'tills', rows: m ? [{ id: m.id, name: till(m), sales: m }] : [] };
  }
  if (scope.areaId && scope.shopId) {
    const shop = shops.find((s) => s.id === scope.shopId);
    const area = shop?.areas?.find((a) => a.id === scope.areaId);
    const rows = (shop?.machines ?? [])
      .filter((m) => area?.machineIds.includes(m.id))
      .map((m) => ({ id: m.id, name: till(m), sales: m as OverviewSales }));
    return { level: 'tills', rows };
  }
  if (scope.shopId) {
    const shop = shops.find((s) => s.id === scope.shopId);
    if (!shop) return { level: 'tills', rows: [] };
    const areas = shop.areas ?? [];
    return areas.length
      ? { level: 'areas', rows: areas.map((a) => ({ id: a.id, name: a.name, sales: a as OverviewSales })) }
      : { level: 'tills', rows: shop.machines.map((m) => ({ id: m.id, name: till(m), sales: m as OverviewSales })) };
  }
  if (!scope.companyId && report.companies.length > 1) {
    return { level: 'companies', rows: report.companies.map((c) => ({ id: c.id, name: c.name, sales: c as OverviewSales })) };
  }
  return {
    level: 'shops',
    rows: shops.map((s) => ({ id: s.id, name: s.number ? `#${s.number} · ${s.name}` : s.name, sales: s as OverviewSales })),
  };
}

/** A against B by id, A's biggest first (rows only in B kept, with zero for A). */
function joinRows<T>(a: T[], b: T[] | null, id: (x: T) => string, name: (x: T) => string, value: (x: T) => number, sub?: (x: T) => string): CompareRow[] {
  const byId = new Map<string, CompareRow>();
  for (const x of a) byId.set(id(x), { id: id(x), name: name(x), sub: sub?.(x), a: value(x), b: 0 });
  for (const x of b ?? []) {
    const row = byId.get(id(x)) ?? { id: id(x), name: name(x), a: 0, b: 0 };
    row.b = value(x);
    byId.set(id(x), row);
  }
  return [...byId.values()].sort((x, y) => y.a - x.a || y.b - x.b);
}

export function CompareView({
  params,
  board,
  today,
  scopeParams,
  areas,
  areaId,
  dark,
  canSeeVouchers,
  now,
  events,
  eventsLoading,
}: {
  params: CompareParams;
  board: BoardParams;
  today: string;
  /** The board's scope, narrowed (company › shop › point of sale › till). */
  scopeParams: CompareScope;
  areas: { id: string; name: string }[];
  areaId: string | null;
  dark: boolean;
  canSeeVouchers: boolean;
  /** The page's clock (ms), for "is the event still running". */
  now: number;
  events: EventBrief[];
  eventsLoading: boolean;
}) {
  const t = useTranslations('controlBoard.compareView');
  const tEvent = useTranslations('controlBoard.event');
  const tBoard = useTranslations('controlBoard');
  const names = useDayNames(today);
  const when = useEventWhen();
  const scope = useScope();
  const months = t.raw('months') as string[];

  // ── Writing the URL ──────────────────────────────────────────────────────────
  const write = useCallback(
    (next: Partial<CompareParams>) =>
      scope.setScope(scope.selection, 'push', compareQuery({ view: 'compare', period: params.period, ...next })),
    [params.period, scope],
  );
  const pickEvent = (e: EventBrief | null) => {
    if (!e) {
      write({ event: null, vs: defaultVs(params.period), vsEvent: null });
      return;
    }
    // An event is one shop's: the scope moves to it, the point of sale and till go.
    scope.setScope(
      { companyId: e.companyId ?? scope.selection.companyId, shopId: e.shopId, machineId: null },
      'push',
      { ...compareQuery({ view: 'compare', period: params.period, event: e.id, vs: 'none', vsEvent: null }), area: null },
    );
  };

  // ── The two periods ──────────────────────────────────────────────────────────
  const isEvent = !!params.event;
  const event = isEvent ? (events.find((e) => e.id === params.event) ?? null) : null;
  const vsEventId = params.vs === 'event' ? params.vsEvent : null;
  const vsEvent = vsEventId ? (events.find((e) => e.id === vsEventId) ?? null) : null;
  const rangeA: DayRange | null = isEvent ? null : periodRange(params, today);
  const rangeB: DayRange | null =
    params.vs === 'custom'
      ? comparedRange(params, rangeA ?? { from: today, to: today }, today)
      : rangeA && !vsEventId
        ? comparedRange(params, rangeA, today)
        : null;

  const rangeLabel = (r: DayRange, hint: PeriodKind): string => {
    if (r.from === r.to) return names.relative(r.from);
    const sameMonth = r.from.slice(0, 7) === r.to.slice(0, 7);
    if (sameMonth && r.from === monthStart(r.from) && (r.to === monthEnd(r.from) || hint === 'month')) {
      const [y, m] = r.from.split('-').map(Number);
      return t('periodName.month', { month: months[m - 1] ?? '', year: y });
    }
    if (hint === 'week' && rangeDays(r) <= 7 && r.from === weekStart(r.from)) {
      return t('periodName.week', { from: formatShortDate(r.from), to: formatShortDate(r.to) });
    }
    return t('periodName.range', { from: formatShortDate(r.from), to: formatShortDate(r.to) });
  };
  const labelA = isEvent ? (event?.name ?? '…') : rangeLabel(rangeA as DayRange, params.period);
  const labelB = vsEventId
    ? (vsEvent?.name ?? '…')
    : rangeB
      ? params.vs === 'lastWeek' && params.period === 'day' && rangeA
        ? names.compared(rangeA.from, rangeB.from, 'lastWeek')
        : rangeLabel(rangeB, params.vs === 'custom' ? 'range' : params.period)
      : null;

  // ── Data ─────────────────────────────────────────────────────────────────────
  const periodParams = {
    ...scopeParams,
    ...(isEvent ? { eventId: params.event as string } : { from: rangeA?.from, to: rangeA?.to }),
    ...(vsEventId ? { cmpEventId: vsEventId } : rangeB ? { cmpFrom: rangeB.from, cmpTo: rangeB.to } : {}),
  };
  const live = isEvent
    ? !!event && new Date(event.endsAt).getTime() > now
    : rangeA?.to === today;
  const periods = params.mode === 'periods';
  const compare = useQuery<PeriodCompareReport>({
    queryKey: ['period-compare', periodParams, TOP_ITEMS],
    queryFn: () => fetchPeriodCompare({ ...periodParams, items: TOP_ITEMS }),
    enabled: periods,
    placeholderData: keepPreviousData,
    refetchInterval: live ? LIVE_MS : false,
    staleTime: live ? undefined : PAST_STALE_MS,
  });
  const vouchers = useQuery({
    queryKey: ['voucher-board', periodParams],
    queryFn: () => fetchVoucherBoard(periodParams),
    enabled: periods && canSeeVouchers,
    placeholderData: keepPreviousData,
    refetchInterval: live ? LIVE_MS : false,
  });
  // Days only (an event is its own tills over its own window — these reports know days).
  const days = periods && !isEvent && !!rangeA;
  const windowA = { from: rangeA?.from, to: rangeA?.to, shopId: scopeParams.shopId, machineId: scopeParams.machineId, areaId: scopeParams.areaId };
  const windowB = rangeB ? { ...windowA, from: rangeB.from, to: rangeB.to } : null;
  const sellersA = useQuery<CashierSalesReport>({
    queryKey: ['cmp-cashiers', windowA],
    queryFn: () => fetchCashierSalesReport(windowA),
    enabled: days,
    placeholderData: keepPreviousData,
  });
  const sellersB = useQuery<CashierSalesReport>({
    queryKey: ['cmp-cashiers', windowB],
    queryFn: () => fetchCashierSalesReport(windowB ?? windowA),
    enabled: days && !!windowB,
    placeholderData: keepPreviousData,
  });
  const overviewParams = (r: DayRange) => ({
    from: r.from,
    to: r.to,
    companyId: scopeParams.companyId,
    shopId: scopeParams.shopId,
    machineId: scopeParams.machineId,
  });
  const ovA = useQuery<OverviewReport>({
    queryKey: ['cmp-overview-range', rangeA ? overviewParams(rangeA) : null],
    queryFn: () => fetchOverview(overviewParams(rangeA as DayRange)),
    enabled: days,
    placeholderData: keepPreviousData,
  });
  const ovB = useQuery<OverviewReport>({
    queryKey: ['cmp-overview-range', rangeB ? overviewParams(rangeB) : null],
    queryFn: () => fetchOverview(overviewParams(rangeB as DayRange)),
    enabled: days && !!rangeB,
    placeholderData: keepPreviousData,
  });
  const brands = useQuery({
    queryKey: ['cmp-brands', windowA],
    queryFn: () => fetchCardBrandsReport({ from: windowA.from, to: windowA.to, shopId: windowA.shopId, machineId: windowA.machineId }),
    enabled: days,
    placeholderData: keepPreviousData,
  });
  const side = useSideBySide({ params, range: rangeA, eventId: params.event, companyId: scopeParams.companyId });

  const report = compare.data;
  const current: FiguresLike | null = report?.current ?? null;
  const previous: FiguresLike | null = report?.previous ?? null;
  const comparing = !!previous && !!labelB;
  const points = useMemo(
    () => curvePoints(report?.series ?? [], report?.granularity === 'hour' && report?.alignment === 'clock'),
    [report],
  );
  const items = (report?.topItems ?? []).map((i) => ({
    key: i.key,
    name: i.name ?? '—',
    qtyA: i.qty,
    netA: i.net,
    qtyB: i.previousQty ?? 0,
    netB: i.previousNet ?? 0,
  }));
  const sellers = joinRows(
    sellersA.data?.rows ?? [],
    windowB ? (sellersB.data?.rows ?? []) : null,
    (r) => r.cashierId ?? r.cashierName ?? '—',
    (r) => r.cashierName ?? '—',
    (r) => r.net,
    (r) => t('sellerLine', { docs: r.documentCount, avg: formatCurrency(r.averageBasket) }),
  );
  const partsA = breakdown(ovA.data, scopeParams);
  const partsB = rangeB ? breakdown(ovB.data, scopeParams) : null;
  const parts = joinRows(
    partsA.rows,
    partsB ? partsB.rows : null,
    (r) => r.id,
    (r) => r.name,
    (r) => r.sales.salesToday,
  );
  const hourRows: CompareRow[] = points
    .filter((p) => (p.a ?? 0) !== 0 || (p.b ?? 0) !== 0)
    .map((p) => ({
      id: String(p.index),
      name: report?.granularity === 'day' && p.dateA ? formatShortDate(p.dateA) : p.label,
      a: p.a ?? 0,
      b: p.b ?? 0,
    }));

  // ── Filters ──────────────────────────────────────────────────────────────────
  const vsOptions: FilterOption[] = isEvent
    ? [
        { value: 'event', label: t('vs.event') },
        { value: 'custom', label: t('vs.custom') },
        { value: 'none', label: t('vs.none') },
      ]
    : [
        {
          value: 'prev',
          label:
            params.period === 'day' ? t('vs.prevDay') : params.period === 'week' ? t('vs.prevWeek') : params.period === 'month' ? t('vs.prevMonth') : t('vs.prev'),
        },
        ...(params.period === 'day' ? [{ value: 'lastWeek', label: t('vs.lastWeek') }] : []),
        { value: 'lastYear', label: t('vs.lastYear') },
        { value: 'custom', label: t('vs.custom') },
        { value: 'event', label: t('vs.event') },
        { value: 'none', label: t('vs.none') },
      ];
  const setVs = (vs: VsKind) => {
    if (vs === 'custom') {
      const seed = rangeB ?? (rangeA ? comparedRange({ ...params, vs: 'prev' }, rangeA, today) : null) ?? { from: today, to: today };
      write({ vs, vsFrom: seed.from, vsTo: seed.to, vsEvent: null });
    } else if (vs === 'event') {
      // Chosen in the picker below; until then there is nothing to compare with.
      write({ vs: 'event', vsFrom: null, vsTo: null, vsEvent: params.vsEvent ?? events.find((e) => e.id !== params.event)?.id ?? null });
    } else {
      write({ vs, vsFrom: null, vsTo: null, vsEvent: null });
    }
  };
  const setPeriod = (period: PeriodKind) => {
    const keep = params.vs === 'lastYear' || params.vs === 'none' || params.vs === 'custom' || params.vs === 'event';
    const seed = rangeA ?? { from: today, to: today };
    scope.setScope(
      scope.selection,
      'push',
      compareQuery({
        view: 'compare',
        period,
        vs: keep ? params.vs : defaultVs(period),
        ...(period === 'range' ? { from: seed.from, to: seed.to } : { from: null, to: null }),
      }),
    );
  };
  const nextAnchor = rangeA ? stepAnchor(params, rangeA, 1) : today;
  const canNext = !!rangeA && rangeA.to < today && nextAnchor <= today;
  const step = (dir: -1 | 1) => {
    if (!rangeA) return;
    if (params.period === 'range') {
      const len = rangeDays(rangeA) * dir;
      const to = shiftIsoDay(rangeA.to, len);
      write({ from: shiftIsoDay(rangeA.from, len), to: to > today ? today : to });
      return;
    }
    const anchor = stepAnchor(params, rangeA, dir);
    write({ date: anchor >= today ? null : anchor });
  };

  // ── Export ───────────────────────────────────────────────────────────────────
  const words: ExportWords = {
    summary: t('export.summary'),
    curve: t('export.curve'),
    items: t('export.items'),
    vouchers: t('export.vouchers'),
    figure: t('export.figure'),
    change: t('export.change'),
    changePct: t('export.changePct'),
    bucket: t('export.bucket'),
    item: t('export.item'),
    sku: t('export.sku'),
    qty: t('export.qty'),
    net: t('export.net'),
    total: t('export.total'),
    voucher: t('export.voucher'),
    voucherCount: t('export.voucherCount'),
    units: t('export.units'),
    value: t('export.value'),
    figures: {
      sales: t('figures.sales'),
      gross: t('figures.gross'),
      discounts: t('figures.discounts'),
      refunds: t('figures.refunds'),
      documents: t('figures.documents'),
      salesCount: t('figures.salesCount'),
      refundsCount: t('figures.refundsCount'),
      averageTicket: t('figures.averageTicket'),
      items: t('figures.items'),
      cash: t('figures.cash'),
      card: t('figures.card'),
      other: t('figures.other'),
      tips: t('figures.tips'),
    },
  };
  const exportTitle = comparing ? t('export.titleVs', { a: labelA, b: labelB as string }) : t('export.title', { a: labelA });
  const getSheets = async (): Promise<ExcelSheet[]> => {
    if (!periods) {
      const r = side.data;
      if (!r) return [];
      return sideBySideSheets(
        {
          title: t('export.sideTitle', { kind: t(`side.${params.side}`) }),
          period: labelA,
          buckets: r.buckets,
          entities: r.entities.map((e) => ({ name: e.name ?? e.id, figures: e.figures, series: e.series })),
        },
        words,
      );
    }
    // Every item, not only the ten on screen.
    const full = await fetchPeriodCompare({ ...periodParams, items: 1000 });
    const sheets = comparisonSheets(
      {
        title: exportTitle,
        labelA,
        labelB: full.previous ? labelB : null,
        current: full.current,
        previous: full.previous ?? null,
        series: curvePoints(full.series, false),
        items: full.topItems,
        vouchers: vouchers.data?.rows.map((v) => ({ name: v.name, current: v.current, previous: v.previous ?? null })),
      },
      words,
    );
    if (days && sellers.length) {
      sheets.push({
        name: t('sellers'),
        heading: [exportTitle],
        columns: [
          { header: t('sellers'), width: 20 },
          { header: `${words.net} ${labelA}`, kind: 'money' },
          ...(comparing ? [{ header: `${words.net} ${labelB}`, kind: 'money' as const }] : []),
        ],
        rows: sellers.map((s) => (comparing ? [s.name, s.a, s.b] : [s.name, s.a])),
      });
    }
    if (days && parts.length) {
      sheets.push({
        name: t('breakdown', { level: t(`levels.${partsA.level}`) }).slice(0, 31),
        heading: [exportTitle],
        columns: [
          { header: t(`levels.${partsA.level}`), width: 22 },
          { header: `${words.net} ${labelA}`, kind: 'money' },
          ...(comparing ? [{ header: `${words.net} ${labelB}`, kind: 'money' as const }] : []),
        ],
        rows: parts.map((r) => (comparing ? [r.name, r.a, r.b] : [r.name, r.a])),
      });
    }
    return sheets;
  };

  const anchorValue = rangeA?.from ?? today;

  return (
    <div className="space-y-4 md:space-y-5">
      {/* ── Filters ── */}
      <section aria-label={t('title')} className="space-y-3 rounded-2xl border border-cb-line bg-cb-card p-3 shadow-[var(--cb-shadow)] md:p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <ScopeBoxes board={board} areas={areas} areaId={areaId} className="grid-cols-2 xl:grid-cols-4" />
          <EventPicker
            value={params.event}
            events={events}
            loading={eventsLoading}
            onChange={pickEvent}
            label={tEvent('label')}
            title={tEvent('pick')}
            dark={dark}
          />
        </div>

        {isEvent ? (
          <p className="text-xs text-cb-muted">
            {event ? `${when(event)} · ${tEvent('tills', { count: event.machineIds.length })}` : tEvent('notFound')}
          </p>
        ) : (
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <Segmented
              label={t('period.label')}
              value={params.period}
              onChange={setPeriod}
              options={PERIOD_KINDS.map((k) => ({ id: k, label: t(`period.${k}`) }))}
            />
            {params.period === 'range' ? (
              <div className="grid grid-cols-2 gap-2">
                <DatePicker
                  aria-label={t('from')}
                  value={rangeA?.from ?? today}
                  max={today}
                  dir="ltr"
                  onChange={(e) => e.target.value >= '2000-01-01' && write({ from: e.target.value, to: rangeA?.to ?? today })}
                  className="h-11 rounded-xl bg-cb-card text-sm text-cb-ink"
                />
                <DatePicker
                  aria-label={t('to')}
                  value={rangeA?.to ?? today}
                  max={today}
                  dir="ltr"
                  onChange={(e) => e.target.value >= '2000-01-01' && write({ from: rangeA?.from ?? today, to: e.target.value })}
                  className="h-11 rounded-xl bg-cb-card text-sm text-cb-ink"
                />
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="size-11 text-cb-blue-ink" onClick={() => step(-1)} aria-label={t('prevPeriod')} title={t('prevPeriod')}>
                  <ChevronRight className="size-5 ltr:rotate-180" aria-hidden />
                </Button>
                <div className="min-w-0 flex-1 text-center md:w-56 md:flex-none">
                  <p className="truncate text-sm font-semibold text-cb-ink">{labelA}</p>
                  <DatePicker
                    aria-label={t('anchor')}
                    value={anchorValue}
                    max={today}
                    dir="ltr"
                    onChange={(e) => e.target.value >= '2000-01-01' && e.target.value <= today && write({ date: e.target.value === today ? null : e.target.value })}
                    className="mx-auto mt-1 h-9 max-w-44 rounded-lg bg-cb-card text-xs text-cb-muted"
                  />
                </div>
                <Button variant="ghost" size="icon" className="size-11 text-cb-blue-ink" onClick={() => step(1)} disabled={!canNext} aria-label={t('nextPeriod')} title={t('nextPeriod')}>
                  <ChevronLeft className="size-5 ltr:rotate-180" aria-hidden />
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-2">
          <FilterBox
            label={t('vs.label')}
            value={params.vs}
            options={vsOptions}
            display={params.vs === 'none' ? t('vs.none') : labelB ?? vsOptions.find((o) => o.value === params.vs)?.label}
            onChange={(v) => setVs(v as VsKind)}
          />
          {params.vs === 'custom' ? (
            <div className="grid grid-cols-2 gap-2">
              <DatePicker
                aria-label={t('vsFrom')}
                value={rangeB?.from ?? today}
                max={today}
                dir="ltr"
                onChange={(e) => e.target.value >= '2000-01-01' && write({ vs: 'custom', vsFrom: e.target.value, vsTo: rangeB?.to ?? e.target.value })}
                className="h-11 rounded-xl bg-cb-card text-sm text-cb-ink"
              />
              <DatePicker
                aria-label={t('vsTo')}
                value={rangeB?.to ?? today}
                max={today}
                dir="ltr"
                onChange={(e) => e.target.value >= '2000-01-01' && write({ vs: 'custom', vsFrom: rangeB?.from ?? e.target.value, vsTo: e.target.value })}
                className="h-11 rounded-xl bg-cb-card text-sm text-cb-ink"
              />
            </div>
          ) : params.vs === 'event' ? (
            <EventPicker
              value={params.vsEvent}
              events={events}
              loading={eventsLoading}
              onChange={(e) => write({ vs: e ? 'event' : 'none', vsEvent: e?.id ?? null })}
              label={tEvent('label')}
              title={tEvent('pickCompare')}
              excludeId={params.event}
              dark={dark}
            />
          ) : (
            <Segmented
              label={t('mode.label')}
              value={params.mode}
              onChange={(mode) => write({ mode })}
              options={[
                { id: 'periods', label: t('mode.periods') },
                { id: 'side', label: t('mode.side') },
              ]}
            />
          )}
        </div>
        {params.vs === 'custom' || params.vs === 'event' ? (
          <Segmented
            label={t('mode.label')}
            value={params.mode}
            onChange={(mode) => write({ mode })}
            options={[
              { id: 'periods', label: t('mode.periods') },
              { id: 'side', label: t('mode.side') },
            ]}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm text-cb-muted">
            {labelA}
            {comparing && periods ? ` · ${tBoard('compare.versus', { day: labelB as string })}` : ''}
          </p>
          <div className="flex items-center gap-2">
            {isEvent && vsEventId ? (
              <Link
                href={`/dashboard/events/compare?ids=${encodeURIComponent(`${params.event},${vsEventId}`)}`}
                className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-cb-blue-ink hover:bg-cb-soft"
              >
                {tEvent('fullCompare')}
              </Link>
            ) : null}
            <ReportExportToolbar
              title={periods ? exportTitle : t('export.sideTitle', { kind: t(`side.${params.side}`) })}
              from={rangeA?.from ?? event?.startDate}
              to={rangeA?.to ?? event?.endDate}
              disabled={periods ? !report : !side.data}
              getSheets={getSheets}
            />
          </div>
        </div>
      </section>

      {compare.isError && periods && !report ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-cb-red/30 bg-cb-red/8 p-4 text-sm text-cb-red-ink">
          <span>{isEvent ? tEvent('notFound') : t('loadError')}</span>
          <Button variant="outline" size="sm" onClick={() => void compare.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : null}

      {/* ── Side by side ── */}
      {!periods ? (
        <SideBySide
          params={params}
          write={write}
          range={rangeA ?? (event ? { from: event.startDate, to: event.endDate } : null)}
          areas={areas}
          areaId={areaId}
          report={side.data}
          loading={side.isFetching}
        />
      ) : (
        /* ── Period against period ── */
        <div className="space-y-4 md:space-y-5">
          <CompareKpis
            current={current}
            previous={comparing ? previous : null}
            labelB={labelB}
            loading={compare.isPending}
            compareLoading={compare.isPlaceholderData}
          />

          <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <CompareChart
              points={points}
              labelA={labelA}
              labelB={comparing ? labelB : null}
              granularity={report?.granularity ?? 'hour'}
              alignment={report?.alignment ?? 'clock'}
              loading={compare.isPending}
            />
            <BoardTenders
              a={toSalesFigures(current ?? ZERO)}
              b={comparing && previous ? toSalesFigures(previous) : null}
              labelA={labelA}
              labelB={comparing ? labelB : null}
              loading={compare.isPending}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-2">
            <BoardItems
              items={items}
              comparing={comparing}
              loading={compare.isPending}
              href={`/dashboard/live-items`}
              emptyText={t('itemsEmpty')}
            />
            {canSeeVouchers ? (
              <BoardVouchers report={vouchers.data} loading={vouchers.isPending} labelB={comparing ? labelB : null} />
            ) : null}
          </div>

          {isEvent ? <p className="text-xs text-cb-muted">{t('eventOnly')}</p> : null}

          {days ? (
            <>
              <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-2">
                <CompareRowsCard
                  id="cb-compare-sellers"
                  title={t('sellers')}
                  icon={Users}
                  rows={sellers}
                  comparing={comparing}
                  loading={sellersA.isPending}
                  empty={t('sellersEmpty')}
                />
                <CompareRowsCard
                  id="cb-compare-parts"
                  title={t('breakdown', { level: t(`levels.${partsA.level}`) })}
                  icon={Layers}
                  rows={parts}
                  comparing={comparing}
                  loading={ovA.isPending}
                  empty={t('breakdownEmpty')}
                />
              </div>
              <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-2">
                <CompareRowsCard
                  id="cb-compare-hours"
                  title={report?.granularity === 'day' ? t('chart.byDay') : t('hours')}
                  icon={Clock}
                  rows={hourRows}
                  comparing={comparing}
                  loading={compare.isPending}
                  empty={t('chart.empty')}
                />
                <CardBrandsCard report={brands.data} loading={brands.isPending} />
              </div>
              {rangeA?.to === today ? (
                <OpenTablesWidget
                  scope={{
                    companyId: scopeParams.companyId ?? '',
                    shopId: scopeParams.shopId ?? '',
                    areaId: scopeParams.areaId ?? '',
                    machineId: scopeParams.machineId ?? '',
                  }}
                  auto
                />
              ) : null}
            </>
          ) : null}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {compare.isFetching ? tBoard('updating') : ''}
      </span>
    </div>
  );
}

const ZERO: FiguresLike = {
  sales: 0, gross: 0, discounts: 0, refunds: 0, documents: 0, salesCount: 0, refundsCount: 0,
  averageTicket: 0, items: 0, cash: 0, card: 0, other: 0, tips: 0,
};
