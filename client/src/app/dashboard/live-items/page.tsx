'use client';

/**
 * Live sales by item (מכירות לפי פריט — חי): per product, what the chosen scope has sold
 * so far — today by default, the shifts open now, or a custom range — refreshed every
 * 30 seconds. Built for a manager's phone: one line of scope, period chips, a sticky
 * search and sort, then a column of cards (a table from `md` up).
 *
 * The figures are `GET /reports/live-items`, the product sales report's own over the
 * same documents, scoped by role on the server; the scope here can only narrow it.
 *
 * On the report framework (P:\specs\reports-upgrade.md §2, §5): the board's state — its own
 * scope (with the area), the period, the range, the search, the sort and "show all" — is in the
 * URL (lib/liveItemsView.ts), so a link is the board. From `md` up the table is a ReportTable
 * (sort by a header, column chooser, its totals); the phone keeps its ranked cards. Excel / PDF
 * with export columns take every product of the scope and period (not only the top 20), with
 * the scope's totals (a search sums its rows). No tips: an item has none. The designed PDF adds
 * the three cards against the period before (not for the open shifts) and the products by net.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, LayoutDashboard, RefreshCw, Search, X } from 'lucide-react';
import { fetchLiveItems } from '@/lib/api';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { todayIso } from '@/lib/reportWindow';
import { normalizeNavText } from '@/lib/navigation';
import type { ReportFilterLine } from '@/lib/reportExport';
import {
  LIVE_PERIODS,
  LIVE_SORTS,
  liveItemsApiParams,
  liveItemsTotals,
  parseLiveItemsState,
  searchLiveRows,
  sortLiveRows,
  writeLiveItemsState,
  type LiveItemsState,
} from '@/lib/liveItemsView';
import type { LiveItemRow } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ALL_COMPANIES, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import { ScopePicker, useOrgScopeLabel } from '@/components/dashboard/live/scope-picker';
import { previousWindow } from '@/lib/designedReport';
import {
  ReportTable,
  StandaloneExportBar,
  type PreviousPeriod,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const REFRESH_MS = 30_000;
const TOP_N = 20;
const ROW_LIMIT = 1000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The share as a thin bar under the card: how much of the scope's takings it is. */
function ShareBar({ share }: { share: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
    </div>
  );
}

const rowKeyOf = (r: LiveItemRow) => `${r.productId ?? ''}|${r.sku ?? ''}|${r.name ?? ''}`;

export default function LiveItemsPage() {
  const t = useTranslations('liveBoard.items');
  const tc = useTranslations('common');
  const now = useNow(15_000);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const today = todayIso();

  // ── The board's state: the URL ──
  const state = useMemo(() => parseLiveItemsState(new URLSearchParams(urlKey), today), [today, urlKey]);
  const write = (patch: Partial<LiveItemsState>) => {
    // The live query, not this render's: a pending search write may have landed since.
    const live = new URLSearchParams(window.location.search);
    const next = writeLiveItemsState(live, { ...parseLiveItemsState(live, today), ...patch }, today).toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  };
  const scope: OrgScope = {
    companyId: state.companyId ?? ALL_COMPANIES,
    shopId: state.shopId,
    areaId: state.areaId,
    machineId: state.machineId,
  };
  const scopeName = useOrgScopeLabel(scope);

  // The search box answers every key; the URL follows a moment later (a link keeps it).
  const [query, setQuery] = useState(state.q);
  const [urlQ, setUrlQ] = useState(state.q);
  if (urlQ !== state.q) {
    setUrlQ(state.q);
    setQuery(state.q);
  }
  const qTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (qTimer.current !== null) window.clearTimeout(qTimer.current);
    },
    [],
  );
  const onSearch = (value: string) => {
    setQuery(value);
    if (qTimer.current !== null) window.clearTimeout(qTimer.current);
    qTimer.current = window.setTimeout(() => {
      qTimer.current = null;
      setUrlQ(value);
      write({ q: value });
    }, 300);
  };

  const params = useMemo(() => liveItemsApiParams(state, ROW_LIMIT), [state]);
  const { period, from, to } = state;

  // A custom range that ends before today will not change; no point polling it.
  const live = period !== 'custom' || !to || to >= today;
  const report = useQuery({
    queryKey: ['live-items', params],
    queryFn: () => fetchLiveItems(params),
    placeholderData: keepPreviousData,
    refetchInterval: live ? REFRESH_MS : false,
    refetchOnWindowFocus: true,
    enabled: period !== 'custom' || (!!from && !!to && from <= to),
  });

  const rows = useMemo(
    () => sortLiveRows(searchLiveRows(report.data?.rows ?? [], query, normalizeNavText), state.sort, state.desc),
    [query, report.data?.rows, state.desc, state.sort],
  );

  const searching = query.trim().length > 0;
  const shown = state.all || searching ? rows : rows.slice(0, TOP_N);
  const totals = report.data?.totals;
  const updatedAt = report.dataUpdatedAt;

  // ── The table (md and up) and the export: every row found, the board's own order ──
  const rank = useMemo(() => new Map(rows.map((r, i) => [rowKeyOf(r), i + 1])), [rows]);
  const table = useMemo<ReportTableSpec<LiveItemRow>>(() => {
    const tot = totals ? liveItemsTotals(rows, totals, searching) : null;
    return {
      id: 'main',
      title: t('kpi.products'),
      rows: shown,
      rowKey: rowKeyOf,
      totalsLabel: tc('total'),
      emptyText: searching ? t('noMatch') : t('empty'),
      // Every product of the scope and period (and the search), not just the top 20 shown.
      exportRows: async () => rows,
      columns: [
        {
          key: 'rank',
          header: '#',
          screenOnly: true,
          sortable: false,
          value: (r) => rank.get(rowKeyOf(r)) ?? null,
          className: 'w-10 text-muted-foreground tabular-nums',
        },
        {
          key: 'name',
          header: t('col.name'),
          required: true,
          width: 26,
          value: (r) => r.name || t('unnamed'),
          cell: (r) => (
            <>
              <span className="font-medium">{r.name || t('unnamed')}</span>
              {r.sku ? <span className="ms-2 text-xs text-muted-foreground">{r.sku}</span> : null}
            </>
          ),
        },
        { key: 'sku', header: t('export.sku'), width: 12, exportOnly: true, value: (r) => r.sku ?? null },
        { key: 'qty', header: t('col.qty'), kind: 'number', value: (r) => r.qty, total: tot?.qty },
        { key: 'unitsSold', header: t('export.unitsSold'), kind: 'number', exportOnly: true, value: (r) => r.unitsSold, total: tot?.unitsSold },
        {
          key: 'unitsRefunded',
          header: t('export.unitsRefunded'),
          kind: 'number',
          exportOnly: true,
          value: (r) => r.unitsRefunded,
          total: tot?.unitsRefunded,
        },
        { key: 'gross', header: t('col.gross'), kind: 'money', value: (r) => r.gross, total: tot?.gross },
        { key: 'discounts', header: t('export.discounts'), kind: 'money', exportOnly: true, value: (r) => r.discounts, total: tot?.discounts },
        { key: 'refunds', header: t('export.refunds'), kind: 'money', exportOnly: true, value: (r) => r.refunds, total: tot?.refunds },
        { key: 'net', header: t('col.net'), kind: 'money', value: (r) => r.net, total: tot?.net, className: 'font-semibold' },
        {
          key: 'share',
          header: t('col.share'),
          kind: 'percent',
          value: (r) => r.share,
          totalCell: '',
          headClassName: 'w-48',
          cell: (r) => (
            <div className="flex min-w-32 items-center gap-2">
              <ShareBar share={r.share} />
              <span className="w-12 shrink-0 text-end text-xs tabular-nums">{r.share.toFixed(1)}%</span>
            </div>
          ),
        },
      ],
    };
  }, [rank, rows, searching, shown, t, tc, totals]);

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the three cards, the products by net,
  // and — for a day or a range, not the open shifts — the same board for the period before it
  // (`previousWindow`: a day against the same weekday last week), fetched on the click.
  const exportKpis: ReportKpi[] = totals
    ? [
        { key: 'net', label: t('kpi.net'), value: totals.net, kind: 'money', icon: 'sales' },
        { key: 'qty', label: t('kpi.qty'), value: totals.qty, kind: 'number', icon: 'items' },
        { key: 'products', label: t('kpi.products'), value: totals.productCount, kind: 'count', icon: 'box' },
      ]
    : [];
  const shownWindow = report.data?.window;
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = period === 'shift' ? null : previousWindow(shownWindow?.from, shownWindow?.to);
    if (!before) return null;
    const prev = await fetchLiveItems({ ...params, shift: undefined, from: before.from, to: before.to });
    return {
      rows: sortLiveRows(searchLiveRows(prev.rows, query, normalizeNavText), state.sort, state.desc),
      kpis: { net: prev.totals.net, qty: prev.totals.qty, products: prev.totals.productCount },
      from: before.from,
      to: before.to,
    };
  };

  // The page's own scope (not the dashboard's), the period, the search and the row limit.
  const filterLines: ReportFilterLine[] = [
    { label: t('period.label'), value: t(`period.${period}`) },
    ...(searching ? [{ label: t('searchPlaceholder'), value: query.trim() }] : []),
    ...(report.data?.truncated ? [{ label: t('kpi.products'), value: t('truncated', { n: report.data.rowLimit }) }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span aria-live="polite" className="hidden sm:inline">
            {updatedAt
              ? t('updatedAgo', {
                  ago: formatDistanceToNow(new Date(Math.min(updatedAt, now)), { addSuffix: true, locale: he }),
                })
              : null}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={() => void report.refetch()}
            aria-label={t('refresh')}
            title={t('refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', report.isFetching && 'animate-spin')} aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-muted"
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden />
          {t('toBoard')}
        </Link>
        <StandaloneExportBar
          reportKey="live-items"
          title={t('title')}
          tables={[table as ReportTableSpec<unknown>]}
          from={report.data?.window.from}
          to={report.data?.window.to}
          place={scopeName}
          filterLines={filterLines}
          disabled={!report.data || rows.length === 0}
          reportType="live-items"
          kpis={exportKpis}
          chartFrom={{ label: 'name', value: 'net', type: 'hbar' }}
          insightKeys={{ label: 'name', value: 'net', count: 'qty' }}
          previous={previous}
        />
      </div>

      <ScopePicker
        value={scope}
        onChange={(s) =>
          write({
            companyId: s.companyId && s.companyId !== ALL_COMPANIES ? s.companyId : null,
            shopId: s.shopId,
            areaId: s.areaId,
            machineId: s.machineId,
            all: false,
          })
        }
        allowAll
      />

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('period.label')}>
          {LIVE_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => write({ period: p })}
              aria-pressed={period === p}
              className={cn(
                'inline-flex min-h-11 items-center rounded-full border px-4 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                period === p ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
              )}
            >
              {t(`period.${p}`)}
            </button>
          ))}
        </div>
        {period === 'custom' ? (
          <div className="grid grid-cols-2 gap-2 sm:max-w-md">
            <div className="space-y-1">
              <Label htmlFor="live-from">{t('period.from')}</Label>
              <DatePicker
                id="live-from"
                value={from}
                max={to || undefined}
                onChange={(e) => write({ from: e.target.value })}
                range={{ from, to, onSelect: (r) => write({ from: r.from, to: r.to }) }}
                className="h-11"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="live-to">{t('period.to')}</Label>
              <DatePicker
                id="live-to"
                value={to}
                min={from || undefined}
                onChange={(e) => write({ to: e.target.value })}
                range={{ from, to, onSelect: (r) => write({ from: r.from, to: r.to }) }}
                className="h-11"
              />
            </div>
          </div>
        ) : null}
        {period === 'shift' && report.data ? (
          <p className="text-xs text-muted-foreground">
            {t('period.openShifts', { count: report.data.openShiftCount ?? 0 })}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { key: 'net', value: totals ? formatCurrency(totals.net) : null },
          { key: 'qty', value: totals ? formatQuantity(totals.qty) : null },
          { key: 'products', value: totals ? String(totals.productCount) : null },
        ].map((k) => (
          <div key={k.key} className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <p className="truncate text-xs text-muted-foreground">{t(`kpi.${k.key}`)}</p>
            {k.value === null ? (
              <Skeleton className="mt-1 h-6 w-16" />
            ) : (
              <p className="truncate text-lg font-bold tabular-nums">{k.value}</p>
            )}
          </div>
        ))}
      </div>

      <div className="sticky top-0 z-20 -mx-3 space-y-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/80 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            value={query}
            onChange={(e) => onSearch(e.target.value.slice(0, 120))}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="h-11 rounded-xl bg-card ps-9 pe-11 text-base [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <Button variant="ghost" size="icon" className="absolute end-0 top-0 size-11" onClick={() => onSearch('')} aria-label={t('clearSearch')}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm text-muted-foreground">{t('sort.label')}</span>
          <Select
            value={state.sort}
            onValueChange={(v) => v && write({ sort: v as LiveItemsState['sort'] })}
            items={LIVE_SORTS.map((s) => ({ value: s, label: t(`sort.${s}`) }))}
          >
            <SelectTrigger className="h-11 min-w-0 flex-1 sm:max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIVE_SORTS.map((s) => (
                <SelectItem key={s} value={s} label={t(`sort.${s}`)}>
                  {t(`sort.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="size-11 shrink-0"
            onClick={() => write({ desc: !state.desc })}
            aria-label={state.desc ? t('sort.desc') : t('sort.asc')}
            title={state.desc ? t('sort.desc') : t('sort.asc')}
          >
            {state.desc ? <ArrowDownWideNarrow className="h-4 w-4" aria-hidden /> : <ArrowUpNarrowWide className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </div>

      {report.isError && !report.data ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <span>{t('loadError')}</span>
          <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : report.isPending && report.fetchStatus !== 'idle' ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {searching ? t('noMatch') : t('empty')}
        </p>
      ) : (
        <>
          {/* Phone: a column of cards. */}
          <ol className="space-y-2 md:hidden">
            {shown.map((r, i) => (
              <li key={rowKeyOf(r)} className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.name || t('unnamed')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('qtyLine', { qty: formatQuantity(r.qty) })}
                      {r.sku ? ` · ${r.sku}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-end">
                    <p className="font-semibold tabular-nums">{formatCurrency(r.net)}</p>
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {t('grossShort', { gross: formatCurrency(r.gross) })} · {r.share.toFixed(1)}%
                    </p>
                  </div>
                </div>
                <ShareBar share={r.share} />
              </li>
            ))}
          </ol>

          {/* Wider: the report table (sort by a header, column chooser, the totals). */}
          <div className="hidden md:block">
            <ReportTable reportKey="live-items" table={table} />
          </div>

          {!searching && rows.length > TOP_N ? (
            <Button variant="outline" className="min-h-11 w-full" onClick={() => write({ all: !state.all })}>
              {state.all ? t('showTop', { n: TOP_N }) : t('showAll', { count: rows.length })}
            </Button>
          ) : null}
          {report.data?.truncated ? (
            <p className="text-xs text-muted-foreground">{t('truncated', { n: report.data.rowLimit })}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
