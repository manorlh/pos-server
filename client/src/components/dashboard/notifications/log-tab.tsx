'use client';

/**
 * "יומן" — every message the service handled: a table on a wide screen, cards on a
 * phone. Recipients are shown masked exactly as the server returns them; the full
 * number is behind "חשיפת מספר" in the drawer (company managers and up, a reason,
 * audited, shown briefly). "התקבל אצל הספק" means the provider took the message — it
 * is not "נמסר", which only a delivery report says.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info, RefreshCw, Search } from 'lucide-react';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_STATES,
  fetchNotificationLog,
  fetchNotificationOverview,
} from '@/lib/notificationsApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NotificationDrawer } from './notification-drawer';
import { NC, SimpleSelect, formatWhen, useNcErrorText } from './shared';
import { StateBadge, stateTone } from './state-badge';

const PAGE = 50;
const REFRESH_MS = 15_000;

function Overview({ companyId }: { companyId: string | null }) {
  const t = useTranslations(`${NC}.notifications`);
  const { data, isLoading } = useQuery({
    queryKey: ['notifications-overview', companyId],
    queryFn: () => fetchNotificationOverview(companyId),
    refetchInterval: REFRESH_MS,
  });
  if (isLoading || !data) return <Skeleton className="h-20 w-full" />;
  const c = data.counts;
  const tiles: Array<{ key: string; label: string; value: number; tone: string }> = [
    { key: 'queued', label: t('overview.waiting'), value: (c.queued ?? 0) + (c.processing ?? 0), tone: stateTone('queued') },
    { key: 'accepted', label: t('states.provider_accepted'), value: c.provider_accepted ?? 0, tone: stateTone('provider_accepted') },
    { key: 'delivered', label: t('states.delivered'), value: c.delivered ?? 0, tone: stateTone('delivered') },
    {
      key: 'failed',
      label: t('overview.failed'),
      value: (c.failed_permanent ?? 0) + (c.failed_retryable ?? 0),
      tone: stateTone('failed_permanent'),
    },
    { key: 'unknown', label: t('states.unknown_outcome'), value: c.unknown_outcome ?? 0, tone: stateTone('unknown_outcome') },
    {
      key: 'stopped',
      label: t('overview.stopped'),
      value: (c.suppressed ?? 0) + (c.expired ?? 0) + (c.cancelled ?? 0),
      tone: stateTone('cancelled'),
    },
  ];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t('overview.last24h')}</span>
        {data.oldestQueuedAt ? <span>· {t('overview.oldestQueued', { at: formatWhen(data.oldestQueuedAt) })}</span> : null}
        <Badge variant="outline" className={data.liveSendingEnabled ? 'border-emerald-500/60' : 'border-amber-500/60'}>
          {data.liveSendingEnabled ? t('liveSwitchOn') : t('liveSwitchOff')}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.key} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            <p className={cn('mt-1 inline-block rounded px-1.5 text-xl font-semibold tabular-nums', tile.tone)}>
              {tile.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LogTab({
  companyId,
  shopId,
  canReveal,
}: {
  companyId: string | null;
  shopId: string | null;
  canReveal: boolean;
}) {
  const t = useTranslations(`${NC}.notifications`);
  const errorText = useNcErrorText();
  const [state, setState] = useState('');
  const [category, setCategory] = useState('');
  const [eventType, setEventType] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['notifications-log', companyId, shopId, state, category, eventType, q, offset],
    queryFn: () => fetchNotificationLog({ companyId, shopId, state, category, eventType, q, limit: PAGE, offset }),
    refetchInterval: REFRESH_MS,
  });
  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };

  return (
    <div className="space-y-4">
      <Overview companyId={companyId} />

      <p className="flex gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('acceptedIsNotDelivered')}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <SimpleSelect
          id="nl-state"
          label={t('filters.state')}
          value={state}
          onChange={resetPage(setState)}
          anyLabel={t('filters.all')}
          options={NOTIFICATION_STATES.map((s) => ({ value: s, label: t(`states.${s}`) }))}
        />
        <SimpleSelect
          id="nl-category"
          label={t('filters.category')}
          value={category}
          onChange={resetPage(setCategory)}
          anyLabel={t('filters.all')}
          options={NOTIFICATION_CATEGORIES.map((c) => ({ value: c, label: t(`categories.${c}`) }))}
        />
        <SimpleSelect
          id="nl-event"
          label={t('filters.event')}
          value={eventType}
          onChange={resetPage(setEventType)}
          anyLabel={t('filters.all')}
          options={NOTIFICATION_EVENTS.map((e) => ({ value: e, label: t(`events.${e}`) }))}
        />
        <form
          className="space-y-1 lg:col-span-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
            setOffset(0);
          }}
        >
          <Label htmlFor="nl-search" className="text-xs">
            {t('filters.search')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="nl-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('filters.searchHint')}
              maxLength={100}
            />
            <Button type="submit" variant="outline" aria-label={t('filters.searchButton')}>
              <Search aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label={t('refresh')}
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={cn(query.isFetching && 'animate-spin')} aria-hidden />
            </Button>
          </div>
        </form>
      </div>

      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(query.error)}
        </p>
      ) : query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          {/* Wide screen: the table. */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('cols.when')}</TableHead>
                  <TableHead>{t('cols.shop')}</TableHead>
                  <TableHead>{t('cols.event')}</TableHead>
                  <TableHead>{t('cols.recipient')}</TableHead>
                  <TableHead>{t('cols.category')}</TableHead>
                  <TableHead>{t('cols.state')}</TableHead>
                  <TableHead>{t('cols.providerRef')}</TableHead>
                  <TableHead className="text-center">{t('cols.attempts')}</TableHead>
                  <TableHead>{t('cols.reason')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setOpenId(row.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setOpenId(row.id);
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap tabular-nums">{formatWhen(row.createdAt)}</TableCell>
                    <TableCell>{row.shopName ?? '—'}</TableCell>
                    <TableCell>
                      <div>{t.has(`events.${row.eventType}`) ? t(`events.${row.eventType}`) : row.eventType}</div>
                      {row.contextLabel || row.aggregateRef ? (
                        <div className="text-xs text-muted-foreground">{row.contextLabel ?? row.aggregateRef}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span dir="ltr" className="font-mono text-xs">
                        {row.recipient}
                      </span>
                      <div className="text-xs text-muted-foreground">{row.channel?.toUpperCase()}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {t.has(`categories.${row.category}`) ? t(`categories.${row.category}`) : row.category}
                    </TableCell>
                    <TableCell>
                      <StateBadge row={row} />
                    </TableCell>
                    <TableCell dir="ltr" className="max-w-[10rem] truncate font-mono text-xs">
                      {row.providerRef ?? '—'}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{row.attempts}</TableCell>
                    <TableCell className="max-w-[12rem] truncate text-xs text-muted-foreground">
                      {row.stateReason ?? ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Phone: cards. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(row.id)}
                  className="w-full rounded-xl border p-3 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {t.has(`events.${row.eventType}`) ? t(`events.${row.eventType}`) : row.eventType}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatWhen(row.createdAt)}
                        {row.shopName ? ` · ${row.shopName}` : ''}
                      </p>
                    </div>
                    <StateBadge row={row} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span dir="ltr" className="font-mono">
                      {row.recipient}
                    </span>
                    {row.contextLabel || row.aggregateRef ? <span>{row.contextLabel ?? row.aggregateRef}</span> : null}
                    <span>{t('attemptsCount', { count: row.attempts })}</span>
                  </div>
                  {row.stateReason ? <p className="mt-1 text-xs text-muted-foreground">{row.stateReason}</p> : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {t('pageOf', { from: offset + 1, to: Math.min(offset + PAGE, total), total })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                <ChevronRight aria-hidden />
                {t('prev')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
              >
                {t('next')}
                <ChevronLeft aria-hidden />
              </Button>
            </div>
          </div>
        </>
      )}

      <NotificationDrawer id={openId} onClose={() => setOpenId(null)} canReveal={canReveal} />
    </div>
  );
}
