'use client';

/**
 * The control board (לוח בקרה) — the dashboard's home, where every sign-in lands.
 *
 * What the scope sold on a day, against another day, and the state of its tills, built
 * for a phone first:
 *
 * * filters — company › shop › point of sale › till, the day, and the comparison (none,
 *   the day before, the same weekday last week, any other day) — all in the URL, so a
 *   refresh or a shared link keeps them; on a phone one bar opens them as a bottom sheet;
 * * the headline figures with their change (▲/▼ %), the day by the hour with the compared
 *   day dashed over it, the tenders, the alerts, the best sellers;
 * * company › shop › point of sale › till — the old overview's tree, searchable, with its
 *   status lights, alerts and update chips; company and shop rows link to their pages, a
 *   till opens its details.
 *
 * Sources, joined on the till's id, each the authority on what it says:
 *
 * * `GET /reports/overview` — the structure the caller may see and **the money**, per
 *   day (the per-cashier report's figures, scoped by role on the server);
 * * `GET /reports/hourly` and `/reports/live-items` — the day by the hour and by item,
 *   narrowed the same way;
 * * `GET /machines` — **the live state**: the server-resolved status, the open shift,
 *   the alerts, the last sync. Never restated by the reports, so a till is never online
 *   in one place and offline in another;
 * * the app-update rollout, optional: a role that may not read it gets no update chips.
 *
 * The fuller day-against-day board (sellers, hour by hour, open tables, card brands)
 * stays at /dashboard/compare, linked from here.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Activity, BarChart3, Bell, LayoutDashboard, Megaphone, Monitor, RefreshCw, Search, UserRound, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { fetchAppReleaseRollout, fetchLiveItems, fetchMachines, fetchOverview } from '@/lib/api';
import { fetchHourlyReport } from '@/lib/salesReportsApi';
import { usePageScope, useScopeQuery } from '@/lib/scope';
import { formatTime } from '@/lib/format';
import {
  buildOverviewTree,
  filterOverviewTree,
  findTill,
  type CompanyNode,
  type OverviewFilter,
} from '@/lib/overview';
import {
  BOARD_PARAM,
  alertTills,
  boardDays,
  compareItems,
  isoDay,
  mergeHourly,
  parseBoardParams,
  scopeFigures,
} from '@/lib/controlBoard';
import type { AppReleaseRolloutRow, PosMachine } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ExceptionsTodayChip } from '@/components/dashboard/exceptions-today-chip';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OverviewTree } from '@/components/dashboard/overview/overview-tree';
import { TillDetails, TillDetailsTitle } from '@/components/dashboard/overview/till-details';
import { Wordmark, boardSurface, useSystemDark } from '@/components/dashboard/control-board/board-ui';
import { DayBoxes, PhoneFilterBar, ScopeBoxes, useDayNames } from '@/components/dashboard/control-board/board-filters';
import { BoardKpis } from '@/components/dashboard/control-board/board-kpis';
import { BoardHourly } from '@/components/dashboard/control-board/board-hourly';
import { BoardTenders } from '@/components/dashboard/control-board/board-tenders';
import { BoardAlerts, type BoardAlert } from '@/components/dashboard/control-board/board-alerts';
import { BoardItems } from '@/components/dashboard/control-board/board-items';
import { BoardInsightsBlock, BoardTabs } from '@/components/dashboard/insights-actions';

const REFRESH_MS = 30_000;
/** A past day does not change by the second; it is read again after this. */
const PAST_DAY_STALE_MS = 5 * 60_000;
/** Above this many shops they start collapsed; a small business sees its tills at once. */
const EXPAND_ALL_UP_TO = 3;
const FILTERS: OverviewFilter[] = ['all', 'offline', 'openShift', 'alerts'];
const BEST_SELLERS = 8;
const NO_AREAS: { id: string; name: string }[] = [];

/** A clock for "updated 2 minutes ago" and for today rolling over at midnight. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** `md` and up: the till's details open as a side drawer instead of a bottom sheet. */
function useIsWide(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia('(min-width: 768px)');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(min-width: 768px)').matches,
    () => false,
  );
}

/**
 * The tree inside one point of sale: its tills only (by where they stand now, as the
 * tree always groups them), and the shop's counts recomputed for them. With one till in
 * scope, the shop's other (now empty) points of sale are left out too.
 */
function narrowToArea(tree: CompanyNode[], areaId: string | null, oneTill: boolean): CompanyNode[] {
  if (oneTill) {
    return tree.map((company) => ({
      ...company,
      shops: company.shops.map((shop) => ({
        ...shop,
        sales: {
          ...shop.sales,
          areas: (shop.sales.areas ?? []).filter((a) => shop.tills.some((x) => x.sales.areaId === a.id)),
        },
      })),
    }));
  }
  if (!areaId) return tree;
  return tree
    .map((company) => ({
      ...company,
      shops: company.shops
        .filter((shop) => (shop.sales.areas ?? []).some((a) => a.id === areaId))
        .map((shop) => {
          const tills = shop.tills.filter((x) => x.sales.areaId === areaId);
          return {
            ...shop,
            sales: { ...shop.sales, areas: (shop.sales.areas ?? []).filter((a) => a.id === areaId) },
            tills,
            online: tills.filter((x) => x.online).length,
            openShifts: tills.filter((x) => x.openShift).length,
            alerts: tills.filter((x) => x.alerts > 0).length,
          };
        }),
    }))
    .filter((company) => company.shops.length > 0);
}

/** The phone's tab bar: jumps to the board's sections. */
function PhoneTabs({ alerts }: { alerts: number }) {
  const t = useTranslations('controlBoard.tabs');
  const [active, setActive] = useState<'overview' | 'tills' | 'alerts'>('overview');
  useEffect(() => {
    const ids = ['cb-overview', 'cb-alerts', 'cb-tills'] as const;
    const els = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!hit) return;
        setActive(hit.target.id === 'cb-tills' ? 'tills' : hit.target.id === 'cb-alerts' ? 'alerts' : 'overview');
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  const go = (tab: 'overview' | 'tills' | 'alerts') => {
    setActive(tab);
    document
      .getElementById(tab === 'tills' ? 'cb-tills' : tab === 'alerts' ? 'cb-alerts' : 'cb-overview')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const tabs = [
    { id: 'overview' as const, icon: LayoutDashboard, label: t('overview') },
    { id: 'tills' as const, icon: Monitor, label: t('tills') },
    { id: 'alerts' as const, icon: Bell, label: t('alerts'), badge: alerts },
  ];
  return (
    <nav
      aria-label={t('label')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-cb-line bg-cb-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden print:hidden"
    >
      <div className="mx-auto grid max-w-md grid-cols-3">
        {tabs.map(({ id, icon: Icon, label, badge }) => (
          <button
            key={id}
            type="button"
            onClick={() => go(id)}
            aria-current={active === id ? 'true' : undefined}
            className={cn(
              'relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none focus-visible:bg-cb-soft',
              active === id ? 'text-cb-blue-ink' : 'text-cb-muted',
            )}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden />
              {badge ? (
                <span className="absolute -top-1.5 -end-2.5 min-w-4 rounded-full bg-cb-amber px-1 text-center text-[10px] font-bold leading-4 text-black/85">
                  {badge}
                </span>
              ) : null}
            </span>
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

export default function DashboardPage() {
  const t = useTranslations('controlBoard');
  const tO = useTranslations('dashboard.overview');
  const tMachines = useTranslations('machines');
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const searchParams = useSearchParams();
  const board = useMemo(() => parseBoardParams((key) => searchParams.get(key)), [searchParams]);
  const now = useNow(15_000);
  const today = isoDay(new Date(now));
  const { dayA, dayB } = boardDays(board, today);
  const isToday = dayA === today;
  const names = useDayNames(today);
  const dark = useSystemDark();
  const isWide = useIsWide();
  const scopeQuery = useScopeQuery((s) => s.query);
  // The machine-admin roles: the ones the till-messages endpoints admit.
  const user = useAuth((s) => s.user);
  const role = user?.role;
  const canMessageTills =
    role === 'super_admin' || role === 'distributor' || role === 'company_manager' || role === 'shop_manager';

  // ── The point of sale: the URL's, once it is known to be the chosen shop's ──────
  const shopAreas = useShopAreas(effective.shopId);
  const areas = shopAreas.data ?? NO_AREAS;
  const urlArea = effective.shopId ? board.area : null;
  const areaId = urlArea && (!shopAreas.isSuccess || areas.some((a) => a.id === urlArea)) ? urlArea : null;
  const { selection, setScope } = scope;
  useEffect(() => {
    if (!board.area) return;
    const stale = !effective.shopId || (shopAreas.isSuccess && !areas.some((a) => a.id === board.area));
    // A correction, not a choice: `replace`, so Back does not return to it.
    if (stale) setScope(selection, 'replace', { [BOARD_PARAM.area]: null });
  }, [areas, board.area, effective.shopId, selection, setScope, shopAreas.isSuccess]);

  // ── Queries ──────────────────────────────────────────────────────────────────
  const base = useMemo(
    () => ({
      companyId: effective.companyId ?? undefined,
      shopId: effective.shopId ?? undefined,
      machineId: effective.machineId ?? undefined,
    }),
    [effective.companyId, effective.machineId, effective.shopId],
  );
  // A till is narrower than its point of sale; with one chosen the area is not sent.
  const narrow = useMemo(
    () => ({ ...base, areaId: base.machineId ? undefined : (areaId ?? undefined) }),
    [areaId, base],
  );
  const liveA = isToday ? REFRESH_MS : (false as const);

  const ovA = useQuery({
    queryKey: ['overview', { ...base, date: dayA }],
    queryFn: () => fetchOverview({ ...base, date: dayA }),
    placeholderData: keepPreviousData,
    refetchInterval: liveA,
    refetchOnWindowFocus: isToday,
    staleTime: isToday ? undefined : PAST_DAY_STALE_MS,
  });
  const ovB = useQuery({
    queryKey: ['overview', { ...base, date: dayB }],
    queryFn: () => fetchOverview({ ...base, date: dayB ?? undefined }),
    enabled: !!dayB,
    placeholderData: keepPreviousData,
    staleTime: PAST_DAY_STALE_MS,
  });
  const hourlyParams = (day: string) => ({ from: day, to: day, ...narrow });
  const hrA = useQuery({
    queryKey: ['cb-hourly', hourlyParams(dayA)],
    queryFn: () => fetchHourlyReport(hourlyParams(dayA)),
    placeholderData: keepPreviousData,
    refetchInterval: liveA,
    staleTime: isToday ? undefined : PAST_DAY_STALE_MS,
  });
  const hrB = useQuery({
    queryKey: ['cb-hourly', hourlyParams(dayB ?? '')],
    queryFn: () => fetchHourlyReport(hourlyParams(dayB ?? '')),
    enabled: !!dayB,
    placeholderData: keepPreviousData,
    staleTime: PAST_DAY_STALE_MS,
  });
  const itemParams = (day: string) => ({ date: day, ...narrow, limit: 200 });
  const itA = useQuery({
    queryKey: ['cb-items', itemParams(dayA)],
    queryFn: () => fetchLiveItems(itemParams(dayA)),
    placeholderData: keepPreviousData,
    refetchInterval: liveA,
    staleTime: isToday ? undefined : PAST_DAY_STALE_MS,
  });
  const itB = useQuery({
    queryKey: ['cb-items', itemParams(dayB ?? '')],
    queryFn: () => fetchLiveItems(itemParams(dayB ?? '')),
    enabled: !!dayB,
    placeholderData: keepPreviousData,
    staleTime: PAST_DAY_STALE_MS,
  });
  // Same cache entry as the scope provider's list: refreshing it here refreshes the filters too.
  const machines = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
  const rollout = useQuery<AppReleaseRolloutRow[]>({
    queryKey: ['app-release-rollout', 'overview'],
    queryFn: () => fetchAppReleaseRollout({}),
    refetchInterval: REFRESH_MS * 2,
    retry: false,
  });

  // ── The tree ─────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<OverviewFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Shops the user opened or closed by hand, for the current search + filter only: a
   * new search starts from "every matching shop open" rather than inheriting the folds
   * of the last one.
   */
  const narrowingKey = `${query.trim()}|${filter}`;
  const [folds, setFolds] = useState<{ key: string; open: Record<string, boolean> }>({
    key: narrowingKey,
    open: {},
  });

  const tree = useMemo(() => {
    const byId = new Map((machines.data ?? []).map((m) => [m.id, m]));
    const rolloutById = new Map((rollout.data ?? []).map((r) => [r.machineId, r]));
    const built = buildOverviewTree(ovA.data?.companies ?? [], byId, rolloutById, now);
    return narrowToArea(built, effective.machineId ? null : areaId, !!effective.machineId);
  }, [areaId, effective.machineId, machines.data, now, ovA.data?.companies, rollout.data]);

  const registerLabel = useCallback((n: number) => tMachines('registerLabel', { number: n }), [tMachines]);
  const visible = useMemo(
    () => filterOverviewTree(tree, query, filter, registerLabel),
    [filter, query, registerLabel, tree],
  );

  const allShops = useMemo(() => tree.flatMap((c) => c.shops), [tree]);
  const allTills = useMemo(() => allShops.flatMap((s) => s.tills), [allShops]);
  const totals = useMemo(() => new Map(allShops.map((s) => [s.sales.id, s.tills.length])), [allShops]);
  const tillStats = useMemo(
    () => ({
      total: allTills.length,
      online: allTills.filter((x) => x.online).length,
      openShifts: allTills.filter((x) => x.openShift).length,
      alerts: allTills.filter((x) => x.alerts > 0).length,
    }),
    [allTills],
  );
  const filterCounts: Record<OverviewFilter, number> = {
    all: tillStats.total,
    offline: tillStats.total - tillStats.online,
    openShift: tillStats.openShifts,
    alerts: tillStats.alerts,
  };

  const narrowing = query.trim().length > 0 || filter !== 'all';
  const defaultOpen = narrowing || allShops.length <= EXPAND_ALL_UP_TO;
  const openByHand = folds.key === narrowingKey ? folds.open : {};
  const isExpanded = (shopId: string) => openByHand[shopId] ?? defaultOpen;
  const toggleShop = (shopId: string) =>
    setFolds({ key: narrowingKey, open: { ...openByHand, [shopId]: !isExpanded(shopId) } });
  const singleShop = !!effective.shopId && allShops.length === 1;

  // Looked up in the whole tree, so a till stays open while the search narrows past it.
  const selected = useMemo(() => findTill(tree, selectedId), [selectedId, tree]);

  const alerts = useMemo<BoardAlert[]>(() => {
    const shopOf = new Map<string, string>();
    for (const shop of allShops) for (const till of shop.tills) shopOf.set(till.sales.id, shop.sales.name);
    const many = allShops.length > 1;
    return alertTills(
      allTills.map((till) => ({
        till,
        status: till.live?.status ?? null,
        alerts: till.alerts,
        registerNumber: till.registerNumber,
      })),
    ).map(({ till: row, kind }) => ({
      till: row.till,
      kind,
      shopName: many ? shopOf.get(row.till.sales.id) : undefined,
    }));
  }, [allShops, allTills]);

  // ── Figures ──────────────────────────────────────────────────────────────────
  const figureScope = {
    shopId: effective.shopId,
    areaId: effective.machineId ? null : areaId,
    machineId: effective.machineId,
  };
  const figA = scopeFigures(ovA.data, figureScope);
  const figB = dayB ? scopeFigures(ovB.data, figureScope) : null;
  const nowHour = isToday ? new Date(now).getHours() : null;
  // Cheap enough per render (a day has 24 hours and 200 items at most).
  const points = mergeHourly(hrA.data?.byHour ?? [], dayB ? (hrB.data?.byHour ?? []) : null, nowHour);
  const items = compareItems(itA.data?.rows ?? [], dayB ? (itB.data?.rows ?? []) : null, BEST_SELLERS);
  const labelA = names.relative(dayA);
  const labelB = dayB ? names.compared(dayA, dayB, board.cmp) : null;

  // ── Refresh ──────────────────────────────────────────────────────────────────
  const updatedAt = Math.max(ovA.dataUpdatedAt || 0, machines.dataUpdatedAt || 0);
  const refreshing = ovA.isFetching || machines.isFetching || hrA.isFetching;
  const refreshAll = () => {
    for (const q of [ovA, ovB, hrA, hrB, itA, itB, machines, rollout]) void q.refetch();
  };

  const updated = (
    <div className="flex shrink-0 items-center gap-0.5 text-xs text-cb-muted">
      <span
        aria-live="polite"
        title={
          updatedAt
            ? tO('updatedAgo', {
                ago: formatDistanceToNow(new Date(Math.min(updatedAt, now)), { addSuffix: true, locale: he }),
              })
            : undefined
        }
      >
        {refreshing && !updatedAt
          ? t('updating')
          : updatedAt
            ? t('updatedAt', {
                time: formatTime(updatedAt),
              })
            : null}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 text-cb-blue-ink hover:bg-cb-soft"
        onClick={refreshAll}
        aria-label={t('refresh')}
        title={t('refresh')}
      >
        <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} aria-hidden />
      </Button>
    </div>
  );

  const scopeName = scope.machine?.name ?? areas.find((a) => a.id === areaId)?.name ?? scope.shop?.name ?? scope.company?.name;
  const subtitle = [scopeName, labelA, labelB ? t('compare.versus', { day: labelB }) : null].filter(Boolean).join(' · ');
  const chip =
    'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-cb-line bg-cb-card px-3 text-sm text-cb-ink hover:bg-cb-soft';

  return (
    // The board's own surface, edge to edge over the shell's padding; `.dark` follows the system.
    <div
      className={cn(
        boardSurface(dark),
        '-m-3 min-h-[calc(100dvh-3rem)] bg-cb-page px-3 pt-3 pb-28 sm:-m-4 sm:px-4 sm:pt-4 md:-m-6 md:min-h-dvh md:p-6 lg:p-8',
      )}
    >
      <div className="mx-auto max-w-[1400px] space-y-4 md:space-y-5">
        {/* insights-actions: "לוח בקרה | השוואות | תובנות" */}
        <BoardTabs active="board" className="max-w-md" />

        {/* Header (wide screens; a phone has the wordmark in its top bar) */}
        <header className="hidden items-center justify-between gap-4 md:flex">
          <Wordmark className="text-xl" />
          <div className="flex min-w-0 items-center gap-2">
            {updated}
            <DayBoxes board={board} today={today} dayA={dayA} dayB={dayB} className="hidden w-[30rem] grid-cols-2 lg:grid" />
            <Link
              href="/dashboard/profile"
              aria-label={t('profile')}
              title={user?.username ?? t('profile')}
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-cb-line bg-cb-card text-sm font-semibold text-cb-ink shadow-[var(--cb-shadow)] hover:bg-cb-soft"
            >
              {user?.username ? user.username.slice(0, 2).toUpperCase() : <UserRound className="size-5" aria-hidden />}
            </Link>
          </div>
        </header>

        {/* Title */}
        <div id="cb-overview" className="flex scroll-mt-4 items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-cb-ink md:text-[32px]">{t('title')}</h1>
            <p className="truncate text-sm text-cb-muted">{subtitle}</p>
          </div>
          <div className="md:hidden">{updated}</div>
        </div>

        {/* Filters */}
        <PhoneFilterBar
          board={board}
          today={today}
          dayA={dayA}
          dayB={dayB}
          areas={areas}
          areaId={areaId}
          dark={dark}
        />
        <div className="hidden space-y-3 md:block">
          <ScopeBoxes board={board} areas={areas} areaId={areaId} className="grid-cols-2 xl:grid-cols-4" />
          <DayBoxes board={board} today={today} dayA={dayA} dayB={dayB} className="grid-cols-2 lg:hidden" />
        </div>

        {/* Shortcuts the old overview had */}
        <div className="flex flex-wrap gap-2">
          <Link href={`/dashboard/live-items${scopeQuery}`} className={chip}>
            <Activity className="size-4 text-cb-muted" aria-hidden />
            {tO('liveItems')}
          </Link>
          <Link href="/dashboard/compare" className={chip}>
            <BarChart3 className="size-4 text-cb-muted" aria-hidden />
            {t('compareBoard')}
          </Link>
          {canMessageTills ? (
            <Link href="/dashboard/till-messages" className={chip}>
              <Megaphone className="size-4 text-cb-muted" aria-hidden />
              {tO('tillMessages')}
            </Link>
          ) : null}
          <ExceptionsTodayChip
            companyId={effective.companyId ?? undefined}
            shopId={effective.shopId ?? undefined}
            machineId={effective.machineId ?? undefined}
          />
        </div>

        <ScopeGate resolution={resolution}>
          {ovA.isError && !ovA.data ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-cb-red/30 bg-cb-red/8 p-4 text-sm text-cb-red-ink">
              <span>{t('loadError')}</span>
              <Button variant="outline" size="sm" onClick={refreshAll}>
                {t('retry')}
              </Button>
            </div>
          ) : null}

          <div className="space-y-4 md:space-y-5">
            <BoardKpis
              a={figA}
              b={figB}
              isToday={isToday}
              salesLoading={ovA.isPending}
              compareLoading={!!dayB && (ovB.isPending || ovB.isPlaceholderData)}
              tills={tillStats}
              liveLoading={ovA.isPending || machines.isPending}
              versusTitle={labelB ? t('compare.versus', { day: labelB }) : ''}
            />

            {/* Phone: chart, tenders, alerts. Wide: alerts | chart | tenders, as the mockup. */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1fr)]">
              <BoardHourly
                className="order-1 md:col-span-2 lg:order-2 lg:col-span-1"
                points={points}
                labelA={labelA}
                labelB={labelB}
                loading={hrA.isPending}
              />
              <BoardTenders
                className="order-2 lg:order-3"
                a={figA}
                b={figB}
                labelA={labelA}
                labelB={labelB}
                loading={ovA.isPending}
              />
              <BoardAlerts
                id="cb-alerts"
                className="order-3 lg:order-1"
                alerts={alerts}
                loading={ovA.isPending || machines.isPending}
                onOpen={setSelectedId}
              />
            </div>

            {/* Company › shop › point of sale › till */}
            <section id="cb-tills" aria-label={t('tills.title')} className="scroll-mt-4 space-y-3">
              <div className="sticky top-0 z-20 -mx-3 space-y-2 bg-cb-page/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-cb-page/80 sm:-mx-4 sm:px-4 md:static md:mx-0 md:flex md:items-center md:gap-3 md:space-y-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
                <h2 className="hidden shrink-0 text-lg font-semibold text-cb-ink md:block">{t('tills.title')}</h2>
                <div className="relative md:ms-auto md:w-80">
                  <Search
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-cb-muted"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={tO('searchPlaceholder')}
                    aria-label={tO('searchLabel')}
                    className="h-11 rounded-xl border-cb-line bg-cb-card ps-9 pe-11 text-base md:text-sm pointer-coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
                  />
                  {query ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute end-0 top-0 size-11"
                      onClick={() => setQuery('')}
                      aria-label={tO('clearSearch')}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label={tO('filter.label')}>
                  {FILTERS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      aria-pressed={filter === f}
                      className={cn(
                        'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40',
                        filter === f
                          ? 'border-cb-blue bg-cb-blue text-white'
                          : 'border-cb-line bg-cb-card text-cb-ink hover:bg-cb-soft',
                      )}
                    >
                      {tO(`filter.${f}`)}
                      {f !== 'all' && filterCounts[f] > 0 ? (
                        <span
                          className={cn(
                            'rounded-full px-1.5 text-[11px] tabular-nums',
                            filter === f ? 'bg-white/20' : 'bg-cb-soft',
                          )}
                        >
                          {filterCounts[f]}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              {ovA.isPending ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full rounded-2xl bg-cb-card" />
                  <Skeleton className="h-14 w-full rounded-2xl bg-cb-card" />
                  <Skeleton className="h-14 w-full rounded-2xl bg-cb-card" />
                </div>
              ) : allShops.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-cb-line p-6 text-center text-sm text-cb-muted">
                  {tO('noShops')}
                </p>
              ) : visible.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-cb-line p-6 text-center">
                  <p className="font-medium text-cb-ink">{tO('empty')}</p>
                  <p className="mt-1 text-sm text-cb-muted">{tO('emptyHint')}</p>
                </div>
              ) : (
                <OverviewTree
                  companies={visible}
                  isExpanded={isExpanded}
                  onToggleShop={toggleShop}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  singleShop={singleShop}
                  totals={totals}
                />
              )}
            </section>

            <BoardItems
              items={items}
              comparing={!!dayB}
              loading={itA.isPending}
              href={`/dashboard/live-items${scopeQuery}`}
            />

            {/* insights-actions: today's till anomalies + slow items, with one-tap actions */}
            <BoardInsightsBlock
              scope={{
                companyId: effective.companyId ?? undefined,
                shopId: effective.shopId ?? undefined,
                areaId: effective.machineId ? undefined : (areaId ?? undefined),
                machineId: effective.machineId ?? undefined,
              }}
              onOpenTill={setSelectedId}
            />
          </div>

          {/* A till's details: a drawer at the end edge on a wide screen, a bottom sheet on a phone. */}
          <Dialog
            open={!!selected}
            onOpenChange={(open) => {
              if (!open) setSelectedId(null);
            }}
          >
            <DialogContent
              className={cn(
                boardSurface(dark),
                'bg-cb-card text-cb-ink',
                isWide &&
                  'top-0 left-0 h-dvh max-h-dvh w-[26rem] max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 content-start rounded-none rounded-s-2xl data-open:zoom-in-100 data-open:slide-in-from-left-10 data-closed:zoom-out-100 data-closed:slide-out-to-left-10 sm:max-w-[26rem]',
              )}
            >
              {selected ? (
                <>
                  <DialogHeader>
                    <DialogTitle>
                      <TillDetailsTitle till={selected.till} />
                    </DialogTitle>
                  </DialogHeader>
                  <TillDetails till={selected.till} shopId={selected.shopId} companyId={selected.companyId} />
                </>
              ) : null}
            </DialogContent>
          </Dialog>
        </ScopeGate>
      </div>

      <PhoneTabs alerts={alerts.length} />
    </div>
  );
}
