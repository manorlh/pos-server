'use client';

/**
 * "תצוגה חיה": the shop's open kitchen orders as the Expo sees them — read only,
 * polled every 5 seconds (`GET /kds/shops/{shop}/board`, pos-server SPEC_KDS.md §8).
 * Each card: the order's reference, source, mode and group state, its tasks per
 * station with state and quantity, unrouted items, and how long it has been waiting
 * (orange / red by the stations' thresholds).
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Timer } from 'lucide-react';
import { formatQuantity, formatTime, toDate } from '@/lib/format';
import { getKdsBoard, type KdsOrder, type KdsStation, type KdsTask } from '@/lib/kdsApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const POLL_MS = 5_000;
const DEFAULT_WARN = 10;
const DEFAULT_LATE = 20;

function minutesBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((b - a) / 60_000));
}

function timeOf(iso: string): string {
  return toDate(iso) ? formatTime(iso, { seconds: true }) : '';
}

function unrouted(task: KdsTask): boolean {
  return !task.stationId && task.activeQty > 0 && task.state !== 'ready';
}

export function LiveBoard({ shopId, stations }: { shopId: string; stations: KdsStation[] }) {
  const t = useTranslations('kds.page.live');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['kds-board', shopId],
    queryFn: () => getKdsBoard(shopId),
    refetchInterval: POLL_MS,
    staleTime: 0,
  });

  const thresholds = new Map(stations.map((s) => [s.id, s]));
  const orders = data?.orders ?? [];
  const unroutedCount = orders.reduce((n, o) => n + o.tasks.filter(unrouted).length, 0);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('hint')}</p>
        </div>
        {data ? (
          <span className="text-xs text-muted-foreground">{t('updated', { time: timeOf(data.serverTime) })}</span>
        ) : null}
      </div>

      {isError ? <p className="text-sm text-destructive">{t('loadError')}</p> : null}

      {isLoading && !data ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : data ? (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">{t('openOrders', { count: orders.length })}</Badge>
            {unroutedCount > 0 ? (
              <Badge variant="destructive">
                <CircleAlert aria-hidden /> {t('unrouted', { count: unroutedCount })}
              </Badge>
            ) : null}
          </div>

          {data.pickup.preparing.length + data.pickup.ready.length > 0 ? (
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
              <PickupNumbers title={t('pickupPreparing')} numbers={data.pickup.preparing.map((p) => p.number)} tone="prep" />
              <PickupNumbers title={t('pickupReady')} numbers={data.pickup.ready.map((p) => p.number)} tone="ready" />
            </div>
          ) : null}

          {orders.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{t('empty')}</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {orders.map((o) => (
                <OrderCard key={o.id} order={o} serverTime={data.serverTime} thresholds={thresholds} />
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function PickupNumbers({ title, numbers, tone }: { title: string; numbers: string[]; tone: 'prep' | 'ready' }) {
  return (
    <div className="space-y-1.5">
      <div className={cn('text-sm font-semibold', tone === 'ready' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300')}>
        {title}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {numbers.length === 0 ? <span className="text-sm text-muted-foreground">—</span> : null}
        {numbers.map((n) => (
          <span key={n} className="rounded-md bg-muted px-2.5 py-1 text-base font-bold tabular-nums">
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function OrderCard({
  order,
  serverTime,
  thresholds,
}: {
  order: KdsOrder;
  serverTime: string;
  thresholds: Map<string, KdsStation>;
}) {
  const t = useTranslations('kds.page.live');
  const tw = useTranslations('kds.workflow');
  const label = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);

  const minutes = minutesBetween(order.firstReleasedAt ?? order.createdAt, serverTime);
  const own = order.tasks
    .map((task) => (task.stationId ? thresholds.get(task.stationId) : undefined))
    .filter((s): s is KdsStation => !!s);
  const warn = own.length ? Math.min(...own.map((s) => s.warnMinutes)) : DEFAULT_WARN;
  const late = own.length ? Math.min(...own.map((s) => s.lateMinutes)) : DEFAULT_LATE;
  const ready = order.groupState === 'ready_for_pickup';
  const tone = ready ? 'ready' : minutes !== null && minutes >= late ? 'late' : minutes !== null && minutes >= warn ? 'warn' : 'ok';

  const title =
    order.pickupNumber !== null && order.pickupNumber !== undefined
      ? t('pickupNo', { n: order.pickupNumber })
      : order.displayRef || (order.tableRef ? t('table', { ref: order.tableRef }) : order.sourceRef);

  // Tasks per station, in the order they come (the server sorts by round, station, line).
  const groups = new Map<string, { name: string; tasks: KdsTask[] }>();
  for (const task of order.tasks) {
    const key = task.stationId ?? '__none__';
    const group = groups.get(key) ?? { name: task.stationId ? task.stationName || '—' : t('noStation'), tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const missing = order.tasks.filter(unrouted);

  return (
    <article
      className={cn(
        'space-y-3 rounded-xl border-2 bg-card p-4',
        tone === 'ready' && 'border-emerald-500/70',
        tone === 'late' && 'border-red-500/70',
        tone === 'warn' && 'border-amber-500/70',
        tone === 'ok' && 'border-border',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="truncate text-xl font-bold tabular-nums">{title}</div>
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline">{label(`sources.${order.source}`, order.source)}</Badge>
            <Badge variant="outline">{tw.has(`modes.${order.workflowMode}.name`) ? tw(`modes.${order.workflowMode}.name`) : order.workflowMode}</Badge>
            {order.groupState ? (
              <Badge
                className={cn(
                  ready && 'bg-emerald-600 text-white dark:bg-emerald-500',
                  !ready && 'bg-secondary text-secondary-foreground',
                )}
              >
                {label(`groupStates.${order.groupState}`, order.groupState)}
              </Badge>
            ) : null}
            {order.viewOnly ? <Badge variant="outline">{t('viewOnly')}</Badge> : null}
            <Badge variant={order.paid ? 'secondary' : 'outline'}>{order.paid ? t('paid') : t('unpaid')}</Badge>
          </div>
        </div>
        {minutes !== null ? (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold tabular-nums',
              tone === 'late' && 'bg-red-500/15 text-red-700 dark:text-red-300',
              tone === 'warn' && 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
              (tone === 'ok' || tone === 'ready') && 'bg-muted text-muted-foreground',
            )}
          >
            <Timer className="h-4 w-4" aria-hidden />
            {t('minutes', { n: minutes })}
          </span>
        ) : null}
      </header>

      {order.waiterName || order.pickupName ? (
        <p className="text-sm text-muted-foreground">{[order.waiterName, order.pickupName].filter(Boolean).join(' · ')}</p>
      ) : null}
      {order.orderNote ? <p className="rounded-md bg-amber-500/10 px-2 py-1 text-sm">{order.orderNote}</p> : null}

      {missing.length > 0 ? (
        <p role="alert" className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
          <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
          {t('unroutedCard', { count: missing.length })}
        </p>
      ) : null}

      <div className="space-y-2">
        {[...groups.entries()].map(([key, group]) => (
          <div key={key} className="space-y-1">
            <div className={cn('text-xs font-semibold', key === '__none__' ? 'text-destructive' : 'text-muted-foreground')}>
              {group.name}
            </div>
            <ul className="space-y-1">
              {group.tasks.map((task) => (
                <li key={task.id} className="flex items-start justify-between gap-2 text-sm">
                  <span className={cn('min-w-0', task.activeQty <= 0 && 'text-muted-foreground line-through')}>
                    <span className="font-semibold tabular-nums">{formatQuantity(task.activeQty > 0 ? task.activeQty : task.orderedQty)}×</span>{' '}
                    {task.name}
                    {task.roundNo > 1 ? <span className="text-xs text-muted-foreground"> · {t('round', { n: task.roundNo })}</span> : null}
                    {[...task.mods, ...task.removals.map((r) => t('without', { name: r }))].length > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        {[...task.mods, ...task.removals.map((r) => t('without', { name: r }))].join(', ')}
                      </span>
                    ) : null}
                    {task.notes ? <span className="block text-xs font-medium">{task.notes}</span> : null}
                    {task.allergies.length > 0 ? (
                      <span className="block text-xs font-semibold text-destructive">{task.allergies.join(', ')}</span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {task.release === 'hold' ? <Badge variant="outline">{t('hold')}</Badge> : null}
                    {task.fallbackPrinted && !task.fallbackResolved ? <Badge variant="outline">{t('fallback')}</Badge> : null}
                    <Badge
                      className={cn(
                        task.state === 'ready' && 'bg-emerald-600 text-white dark:bg-emerald-500',
                        task.state === 'preparing' && 'bg-amber-500 text-white dark:bg-amber-600',
                        task.state === 'queued' && 'bg-secondary text-secondary-foreground',
                      )}
                    >
                      {label(`taskStates.${task.state}`, task.state)}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </article>
  );
}
