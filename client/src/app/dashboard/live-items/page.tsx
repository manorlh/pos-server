'use client';

/**
 * Live sales by item (מכירות לפי פריט — חי): per product, what the chosen scope has sold
 * so far — today by default, the shifts open now, or a custom range — refreshed every
 * 30 seconds. Built for a manager's phone: one line of scope, period chips, a sticky
 * search and sort, then a column of cards (a table from `md` up).
 *
 * The figures are `GET /reports/live-items`, the product sales report's own over the
 * same documents, scoped by role on the server; the scope here can only narrow it.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, LayoutDashboard, RefreshCw, Search, X } from 'lucide-react';
import { fetchLiveItems } from '@/lib/api';
import { formatCurrency, formatQuantity } from '@/lib/format';
import { todayIso } from '@/lib/reportWindow';
import { normalizeNavText } from '@/lib/navigation';
import type { LiveItemRow } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ALL_COMPANIES, EMPTY_ORG_SCOPE, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import { ScopePicker } from '@/components/dashboard/live/scope-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const REFRESH_MS = 30_000;
const TOP_N = 20;

type Period = 'today' | 'shift' | 'custom';
type SortKey = 'net' | 'qty' | 'gross' | 'name';
const PERIODS: Period[] = ['today', 'shift', 'custom'];
const SORTS: SortKey[] = ['net', 'qty', 'gross', 'name'];

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function sortRows(rows: LiveItemRow[], key: SortKey, desc: boolean): LiveItemRow[] {
  const sign = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (key === 'name') return sign * (a.name ?? '').localeCompare(b.name ?? '', 'he');
    return sign * (a[key] - b[key]);
  });
}

/** The share as a thin bar under the card: how much of the scope's takings it is. */
function ShareBar({ share }: { share: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
    </div>
  );
}

export default function LiveItemsPage() {
  const t = useTranslations('liveBoard.items');
  const now = useNow(15_000);

  const [scope, setScope] = useState<OrgScope>({ ...EMPTY_ORG_SCOPE, companyId: ALL_COMPANIES });
  const [period, setPeriod] = useState<Period>('today');
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('net');
  const [desc, setDesc] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const params = useMemo(() => {
    const company = scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined;
    const where = {
      companyId: company,
      shopId: scope.shopId || undefined,
      areaId: scope.areaId || undefined,
      machineId: scope.machineId || undefined,
      limit: 1000,
    };
    if (period === 'shift') return { ...where, shift: 'open' as const };
    if (period === 'custom') return { ...where, from: from || undefined, to: to || undefined };
    return where;
  }, [from, period, scope, to]);

  // A custom range that ends before today will not change; no point polling it.
  const live = period !== 'custom' || !to || to >= todayIso();
  const report = useQuery({
    queryKey: ['live-items', params],
    queryFn: () => fetchLiveItems(params),
    placeholderData: keepPreviousData,
    refetchInterval: live ? REFRESH_MS : false,
    refetchOnWindowFocus: true,
    enabled: period !== 'custom' || (!!from && !!to && from <= to),
  });

  const rows = useMemo(() => {
    const q = normalizeNavText(query);
    const all = report.data?.rows ?? [];
    const hit = q
      ? all.filter(
          (r) => normalizeNavText(r.name ?? '').includes(q) || normalizeNavText(r.sku ?? '').includes(q),
        )
      : all;
    return sortRows(hit, sortKey, desc);
  }, [desc, query, report.data?.rows, sortKey]);

  const searching = query.trim().length > 0;
  const shown = showAll || searching ? rows : rows.slice(0, TOP_N);
  const totals = report.data?.totals;
  const updatedAt = report.dataUpdatedAt;

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

      <div className="flex flex-wrap gap-2">
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-muted"
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden />
          {t('toBoard')}
        </Link>
      </div>

      <ScopePicker value={scope} onChange={(s) => { setScope(s); setShowAll(false); }} allowAll />

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('period.label')}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
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
              <Input id="live-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-11" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="live-to">{t('period.to')}</Label>
              <Input id="live-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-11" />
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="h-11 rounded-xl bg-card ps-9 pe-11 text-base [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <Button variant="ghost" size="icon" className="absolute end-0 top-0 size-11" onClick={() => setQuery('')} aria-label={t('clearSearch')}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm text-muted-foreground">{t('sort.label')}</span>
          <Select
            value={sortKey}
            onValueChange={(v) => v && setSortKey(v as SortKey)}
            items={SORTS.map((s) => ({ value: s, label: t(`sort.${s}`) }))}
          >
            <SelectTrigger className="h-11 min-w-0 flex-1 sm:max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
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
            onClick={() => setDesc((d) => !d)}
            aria-label={desc ? t('sort.desc') : t('sort.asc')}
            title={desc ? t('sort.desc') : t('sort.asc')}
          >
            {desc ? <ArrowDownWideNarrow className="h-4 w-4" aria-hidden /> : <ArrowUpNarrowWide className="h-4 w-4" aria-hidden />}
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
              <li key={`${r.productId ?? ''}|${r.sku ?? ''}|${r.name ?? ''}`} className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
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

          {/* Wider: a table. */}
          <div className="hidden overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>{t('col.name')}</TableHead>
                  <TableHead className="text-end">{t('col.qty')}</TableHead>
                  <TableHead className="text-end">{t('col.gross')}</TableHead>
                  <TableHead className="text-end">{t('col.net')}</TableHead>
                  <TableHead className="w-48">{t('col.share')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r, i) => (
                  <TableRow key={`${r.productId ?? ''}|${r.sku ?? ''}|${r.name ?? ''}`}>
                    <TableCell className="tabular-nums text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <span className="font-medium">{r.name || t('unnamed')}</span>
                      {r.sku ? <span className="ms-2 text-xs text-muted-foreground">{r.sku}</span> : null}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{formatQuantity(r.qty)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCurrency(r.gross)}</TableCell>
                    <TableCell className="text-end font-semibold tabular-nums">{formatCurrency(r.net)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ShareBar share={r.share} />
                        <span className="w-12 shrink-0 text-end text-xs tabular-nums">{r.share.toFixed(1)}%</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {!searching && rows.length > TOP_N ? (
            <Button variant="outline" className="min-h-11 w-full" onClick={() => setShowAll((s) => !s)}>
              {showAll ? t('showTop', { n: TOP_N }) : t('showAll', { count: rows.length })}
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
