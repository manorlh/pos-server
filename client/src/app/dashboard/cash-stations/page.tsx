'use client';

/**
 * "עמדות מזומן" (P:/specs/cash-paylink.md §12): the kiosks' cash stations — one PayLink unit each, run by a
 * "שרת מזומן" (device role `cash_host`). Per station: its name and place, serial, host (online), the kiosks it
 * serves, its state, the change in it, open alerts and what it owes customers. Filtered by the scope bar
 * (company / shop), like the other device pages; "הוספת עמדה" for a shop's managers.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Coins, Plus, RefreshCw, Server } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { agorotText, type CashStation } from '@/lib/cashStations';
import { cashStationsKey, fetchCashStations } from '@/lib/cashStationsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { AddStationDialog } from '@/components/dashboard/cash-stations/add-station-dialog';
import { StationPill, ToneBadge, useCashAccess } from '@/components/dashboard/cash-stations/parts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

function StationCard({ s, showShop }: { s: CashStation; showShop: boolean }) {
  const t = useTranslations('cashStations.list');
  const kiosks = s.clients.map((c) => c.name ?? '—');
  return (
    <Card className={cn('transition-colors hover:border-primary/50', !s.isActive && 'opacity-70')}>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/dashboard/cash-stations/${s.stationId}`} className="text-base font-semibold hover:underline">
              {s.name}
            </Link>
            {s.location ? <p className="text-xs text-muted-foreground">{s.location}</p> : null}
            {showShop && s.shopName ? <p className="text-xs text-muted-foreground">{s.shopName}</p> : null}
          </div>
          <StationPill station={s} withReason={false} />
        </div>
        {s.status?.reason && s.status.state !== 'ready' ? <p className="text-xs text-muted-foreground">{s.status.reason}</p> : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">{t('serial')}</dt>
            <dd dir="ltr" className="text-start font-mono text-xs">{s.serial || t('serialDefault')}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('host')}</dt>
            <dd className="flex items-center gap-1">
              {s.host ? (
                <>
                  <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', s.host.online ? 'bg-emerald-500' : 'bg-red-500')}
                    aria-label={s.host.online ? t('hostOnline') : t('hostOffline')}
                  />
                  <Link href={`/dashboard/machines/${s.host.machineId}`} className="truncate hover:underline">
                    {s.host.name ?? '—'}
                  </Link>
                </>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">{t('noHost')}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('change')}</dt>
            <dd className="tabular-nums">
              {agorotText(s.status?.changeAvailableAgorot)}
              {s.status?.exactOnly ? <span className="ms-1 text-xs text-amber-700 dark:text-amber-400">{t('exactOnly')}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('kiosks')}</dt>
            <dd className="truncate" title={kiosks.join(', ')}>
              {kiosks.length ? kiosks.join(', ') : <span className="text-muted-foreground">{t('noKiosks')}</span>}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          {s.alerts.length > 0 ? (
            <ToneBadge tone="bad" title={s.alerts.map((a) => a.text).join('\n')}>
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {t('alerts', { count: s.alerts.length })}
            </ToneBadge>
          ) : (
            <ToneBadge tone="muted">{t('noAlerts')}</ToneBadge>
          )}
          {s.owed.count > 0 ? (
            <ToneBadge tone="warn">{t('owed', { count: s.owed.count, amount: agorotText(s.owed.amountAgorot) })}</ToneBadge>
          ) : null}
          {s.status?.queue ? <ToneBadge tone="info">{t('queue', { count: s.status.queue })}</ToneBadge> : null}
          {!s.isActive ? <ToneBadge tone="muted">{t('inactive')}</ToneBadge> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function CashStationsPage() {
  const t = useTranslations('cashStations.list');
  const { resolution, effective, scope } = usePageScope({ maxLevel: 'shop' });
  const { canEdit, hydrated } = useCashAccess();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const shopId = effective.shopId ?? null;
  const companyId = effective.companyId ?? null;
  const params = { companyId: shopId ? null : companyId, shopId, includeInactive };
  const query = useQuery({
    queryKey: cashStationsKey(params),
    queryFn: () => fetchCashStations(params),
    enabled: hydrated && resolution.status === 'ok',
    refetchInterval: 20_000,
  });
  const stations = query.data ?? [];
  const shopsInView = new Set(stations.map((s) => s.shopId));
  const addShops = shopId ? scope.shops.filter((s) => s.id === shopId) : companyId ? scope.shops.filter((s) => s.companyId === companyId) : scope.shops;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Coins className="h-6 w-6 text-primary" aria-hidden /> {t('title')}
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canEdit ? (
          <Button onClick={() => setAddOpen(true)}>
            <Plus aria-hidden /> {t('add')}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          <Switch checked={includeInactive} onCheckedChange={(v) => setIncludeInactive(!!v)} aria-label={t('includeInactive')} />
          {t('includeInactive')}
        </label>
        <span className="flex items-center gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')} aria-hidden />
          {stations.length > 0 ? t('count', { count: stations.length }) : t('refreshing')}
        </span>
      </div>

      <ScopeGate resolution={resolution}>
        {query.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : query.isError ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{t('loadError')}</p>
        ) : stations.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed bg-gradient-to-b from-muted/50 to-background p-10 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
              <Coins className="h-8 w-8" aria-hidden />
            </span>
            <div className="space-y-1">
              <p className="font-semibold">{t('empty')}</p>
              <p className="max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {canEdit ? (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus aria-hidden /> {t('add')}
                </Button>
              ) : null}
              <Link href="/dashboard/machines" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <Server className="h-4 w-4" aria-hidden /> {t('pairHost')}
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {stations.map((s) => (
              <StationCard key={s.stationId} s={s} showShop={!shopId && shopsInView.size > 1} />
            ))}
          </div>
        )}
      </ScopeGate>

      {addOpen ? (
        <AddStationDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          shops={addShops}
          machines={scope.machines}
          defaultShopId={shopId ?? (addShops.length === 1 ? addShops[0].id : null)}
        />
      ) : null}
    </div>
  );
}
