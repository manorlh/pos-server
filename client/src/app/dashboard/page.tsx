'use client';

/**
 * The overview — the manager's landing page (לוח מנהל): today's figures for the scope,
 * then company › shop › till, searchable, built for a phone first.
 *
 * Two sources, joined on the till's id, each owning what it is the authority on:
 *
 * * `GET /reports/overview` — the structure the caller may see and **the money**, the
 *   per-cashier report's figures for today in the tenant's timezone, scoped by role on
 *   the server exactly like every other report;
 * * `GET /machines` — **the live state**: the server-resolved status light, the open
 *   shift, the alerts. Not restated by the overview, so the page can never say a till
 *   is online in one place and offline in another.
 *
 * The app-update rollout is a third, optional read: a role that may not see it just
 * gets no update chips.
 *
 * It replaced the old overview's tenant-wide product/category counts and its one-level
 * drill list: the tree is the drill-down now (company and shop rows link to their
 * pages), and the day's sales KPIs live in the header.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import Link from 'next/link';
import { Activity, Megaphone, RefreshCw, Search, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { fetchAppReleaseRollout, fetchMachines, fetchOverview } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import {
  buildOverviewTree,
  filterOverviewTree,
  findTill,
  type OverviewFilter,
  type TillNode,
} from '@/lib/overview';
import type { AppReleaseRolloutRow, PosMachine } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ExceptionsTodayChip } from '@/components/dashboard/exceptions-today-chip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OverviewKpis } from '@/components/dashboard/overview/overview-kpis';
import { OverviewTree } from '@/components/dashboard/overview/overview-tree';
import { TillDetails, TillDetailsTitle } from '@/components/dashboard/overview/till-details';

const REFRESH_MS = 30_000;
/** Above this many shops they start collapsed; a small business sees its tills at once. */
const EXPAND_ALL_UP_TO = 3;
const FILTERS: OverviewFilter[] = ['all', 'offline', 'openShift', 'alerts'];

/** `lg` and up: the details sit beside the tree instead of in a bottom sheet. */
function useIsDesktop(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia('(min-width: 1024px)');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(min-width: 1024px)').matches,
    () => false,
  );
}

/** A clock for "updated 2 minutes ago", ticking often enough to stay honest. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tO = useTranslations('dashboard.overview');
  const tMachines = useTranslations('machines');
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const isDesktop = useIsDesktop();
  const now = useNow(15_000);
  // The machine-admin roles: the ones the till-messages endpoints admit.
  const role = useAuth((s) => s.user?.role);
  const canMessageTills =
    role === 'super_admin' || role === 'distributor' || role === 'company_manager' || role === 'shop_manager';

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

  const params = useMemo(
    () => ({
      companyId: effective.companyId ?? undefined,
      shopId: effective.shopId ?? undefined,
      machineId: effective.machineId ?? undefined,
    }),
    [effective.companyId, effective.machineId, effective.shopId],
  );

  const overview = useQuery({
    queryKey: ['overview', params],
    queryFn: () => fetchOverview(params),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
  // Same cache entry as the scope provider's list: refreshing it here refreshes the bar too.
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

  const tree = useMemo(() => {
    const byId = new Map((machines.data ?? []).map((m) => [m.id, m]));
    const rolloutById = new Map((rollout.data ?? []).map((r) => [r.machineId, r]));
    return buildOverviewTree(overview.data?.companies ?? [], byId, rolloutById, now);
  }, [machines.data, now, overview.data?.companies, rollout.data]);

  const registerLabel = useCallback(
    (n: number) => tMachines('registerLabel', { number: n }),
    [tMachines],
  );
  const visible = useMemo(
    () => filterOverviewTree(tree, query, filter, registerLabel),
    [filter, query, registerLabel, tree],
  );

  const allShops = useMemo(() => tree.flatMap((c) => c.shops), [tree]);
  const allTills = useMemo(() => allShops.flatMap((s) => s.tills), [allShops]);
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

  // Looked up in the whole tree, so a till stays open while the search narrows past it.
  const selected = useMemo(() => findTill(tree, selectedId), [selectedId, tree]);

  const updatedAt = Math.max(overview.dataUpdatedAt || 0, machines.dataUpdatedAt || 0);
  const refreshing = overview.isFetching || machines.isFetching;
  const refreshAll = () => {
    void overview.refetch();
    void machines.refetch();
    void rollout.refetch();
  };

  const subtitle = (() => {
    if (scope.machine) return t('subtitleMachine', { name: scope.machine.name });
    if (scope.shop) return t('subtitleShop', { name: scope.shop.name });
    if (scope.company) return t('subtitleCompany', { name: scope.company.name });
    return tO('subtitle');
  })();

  const details = (till: TillNode, shopId: string, companyId: string) => (
    <TillDetails till={till} shopId={shopId} companyId={companyId} />
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span aria-live="polite">
            {refreshing && !updatedAt
              ? tO('updating')
              : updatedAt
                ? tO('updatedAgo', {
                    ago: formatDistanceToNow(new Date(Math.min(updatedAt, now)), {
                      addSuffix: true,
                      locale: he,
                    }),
                  })
                : null}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={refreshAll}
            aria-label={tO('refresh')}
            title={tO('refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/dashboard/live-items"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-muted"
        >
          <Activity className="h-4 w-4" aria-hidden />
          {tO('liveItems')}
        </Link>
        {canMessageTills ? (
          <Link
            href="/dashboard/till-messages"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-muted"
          >
            <Megaphone className="h-4 w-4" aria-hidden />
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
        {overview.isError && !overview.data ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <span>{tO('loadError')}</span>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              {tO('retry')}
            </Button>
          </div>
        ) : null}

        <OverviewKpis
          kpis={overview.data?.kpis}
          salesLoading={overview.isPending}
          tills={tillStats}
          liveLoading={overview.isPending || machines.isPending}
        />

        {/* Sticky under the scroll container's top edge: the search stays in reach while
            the tree scrolls. The negative margins let its background run edge to edge. */}
        <div className="sticky top-0 z-20 -mx-3 space-y-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/80 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6">
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
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
              className="h-11 pointer-coarse:h-11 rounded-xl bg-card ps-9 pe-11 text-base [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon"
                className="absolute end-0 top-0 size-11"
                onClick={() => setQuery('')}
                aria-label={tO('clearSearch')}
              >
                <X className="h-4 w-4" aria-hidden />
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
                  'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  filter === f
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-card hover:bg-muted',
                )}
              >
                {tO(`filter.${f}`)}
                {f !== 'all' && filterCounts[f] > 0 ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[11px] tabular-nums',
                      filter === f ? 'bg-primary-foreground/20' : 'bg-muted',
                    )}
                  >
                    {filterCounts[f]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            {overview.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-14 w-full rounded-xl" />
              </div>
            ) : allShops.length === 0 ? (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                {tO('noShops')}
              </p>
            ) : visible.length === 0 ? (
              <div className="rounded-xl border border-dashed p-6 text-center">
                <p className="font-medium">{tO('empty')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{tO('emptyHint')}</p>
              </div>
            ) : (
              <OverviewTree
                companies={visible}
                isExpanded={isExpanded}
                onToggleShop={toggleShop}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )}
          </div>

          <aside className="hidden lg:block">
            <div className="sticky top-36 max-h-[calc(100dvh-11rem)] overflow-y-auto rounded-xl bg-card p-4 ring-1 ring-foreground/10">
              {selected && isDesktop ? (
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="min-w-0 font-semibold">
                      <TillDetailsTitle till={selected.till} />
                    </h2>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setSelectedId(null)}
                      aria-label={tO('details.close')}
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                  {details(selected.till, selected.shopId, selected.companyId)}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{tO('details.pick')}</p>
              )}
            </div>
          </aside>
        </div>

        {/* Below `lg`: a bottom sheet over the tree, thumb-reachable, at most 85% tall. */}
        <Dialog
          open={!!selected && !isDesktop}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
        >
          <DialogContent className="top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 rounded-b-none pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] data-open:zoom-in-100 data-open:slide-in-from-bottom-10 data-closed:zoom-out-100 data-closed:slide-out-to-bottom-10 sm:max-w-none">
            {selected ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    <TillDetailsTitle till={selected.till} />
                  </DialogTitle>
                </DialogHeader>
                {details(selected.till, selected.shopId, selected.companyId)}
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </ScopeGate>
    </div>
  );
}
