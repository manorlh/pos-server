'use client';

/**
 * One cash station (P:/specs/cash-paylink.md §12): a PayLink unit by its serial, the "שרת מזומן" that runs it,
 * its state, and its tabs — מצב (denominations, cashbox, queue, alerts), יומן (the transactions), תנועות (float,
 * refills, collections, counts), חובות (change owed and credits held, closed by hand), מגירה ו-Z (the drawer
 * and the kiosks' cash against it), תחזוקה (commands to the host, confirmed), הגדרות (the station's overrides)
 * and קיוסקים (which kiosks it serves). `?tab=` opens a tab (the alerts link to `?tab=owed`).
 */

import { use, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Coins, Server, Store } from 'lucide-react';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { formatDateTime } from '@/lib/format';
import { agorotText } from '@/lib/cashStations';
import { cashStationKey, fetchCashStation } from '@/lib/cashStationsApi';
import { StationPill, ToneBadge, useCashAccess } from '@/components/dashboard/cash-stations/parts';
import { StatusTab } from '@/components/dashboard/cash-stations/status-tab';
import { JournalTab } from '@/components/dashboard/cash-stations/journal-tab';
import { MovementsTab } from '@/components/dashboard/cash-stations/movements-tab';
import { OwedTab } from '@/components/dashboard/cash-stations/owed-tab';
import { DrawerTab } from '@/components/dashboard/cash-stations/drawer-tab';
import { MaintenanceTab } from '@/components/dashboard/cash-stations/maintenance-tab';
import { SettingsTab } from '@/components/dashboard/cash-stations/settings-tab';
import { KiosksTab } from '@/components/dashboard/cash-stations/kiosks-tab';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const TABS = ['status', 'journal', 'movements', 'owed', 'drawer', 'maintenance', 'settings', 'kiosks'] as const;
type Tab = (typeof TABS)[number];

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

export default function CashStationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('cashStations');
  const search = useSearchParams();
  const asked = search.get('tab');
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(asked ?? '') ? (asked as Tab) : 'status');
  const { canEdit, canCommand } = useCashAccess();
  const { scope } = usePageScope({ maxLevel: 'shop', silent: true });

  const query = useQuery({
    queryKey: cashStationKey(id),
    queryFn: () => fetchCashStation(id),
    refetchInterval: 15_000,
    retry: (count, err) => {
      const code = httpStatus(err);
      return code !== 403 && code !== 404 && count < 2;
    },
  });
  const station = query.data;
  useSyncScopeFromRoute({ companyId: station?.companyId ?? null, shopId: station?.shopId ?? null });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError || !station) {
    const code = httpStatus(query.error);
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{code === 404 ? t('page.notFound') : code === 403 ? t('page.forbidden') : t('page.loadError')}</p>
        <Link href="/dashboard/cash-stations" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowRight aria-hidden /> {t('page.back')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Coins className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h1 className="text-2xl font-bold">{station.name}</h1>
            {station.location ? <span className="text-base text-muted-foreground">{station.location}</span> : null}
            <StationPill station={station} />
            {!station.isActive ? <ToneBadge tone="muted">{t('page.inactive')}</ToneBadge> : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Store className="h-3.5 w-3.5" aria-hidden />
              <Link href={`/dashboard/shops/${station.shopId}`} className="hover:underline">
                {station.shopName ?? '—'}
              </Link>
            </span>
            <span>
              {t('page.serial')}: <span dir="ltr" className="font-mono">{station.serial || t('page.serialDefault')}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Server className="h-3.5 w-3.5" aria-hidden />
              {station.host ? (
                <>
                  <Link href={`/dashboard/machines/${station.host.machineId}`} className="hover:underline">
                    {station.host.name ?? '—'}
                  </Link>
                  <span className={station.host.online ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
                    ({station.host.online ? t('page.hostOnline') : t('page.hostOffline')})
                  </span>
                  {station.host.lanAddress ? (
                    <span dir="ltr" className="font-mono text-xs">
                      {station.host.lanAddress}:{station.host.port ?? 47630}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">{t('page.noHost')}</span>
              )}
            </span>
            {station.status?.reportedAt ? <span className="text-xs">{t('page.reportedAt', { at: formatDateTime(station.status.reportedAt) })}</span> : null}
          </p>
        </div>
        <Link href="/dashboard/cash-stations" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('page.all')}
        </Link>
      </div>

      <div className="flex flex-wrap gap-1 rounded-2xl bg-muted p-1" role="tablist" aria-label={t('page.tabsLabel')}>
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm transition-all duration-200',
              tab === key ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${key}`)}
            {key === 'owed' && station.owed.count > 0 ? (
              <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white" title={agorotText(station.owed.amountAgorot)}>
                {station.owed.count}
              </span>
            ) : null}
            {key === 'status' && station.alerts.length > 0 ? (
              <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-white">{station.alerts.length}</span>
            ) : null}
            {key === 'kiosks' ? <span className="text-[10px] text-muted-foreground">{station.clients.length}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="animate-in fade-in duration-200">
        {tab === 'status' ? <StatusTab station={station} /> : null}
        {tab === 'journal' ? <JournalTab stationId={station.stationId} /> : null}
        {tab === 'movements' ? <MovementsTab stationId={station.stationId} /> : null}
        {tab === 'owed' ? <OwedTab stationId={station.stationId} canEdit={canEdit} /> : null}
        {tab === 'drawer' ? <DrawerTab stationId={station.stationId} /> : null}
        {tab === 'maintenance' ? <MaintenanceTab station={station} canCommand={canCommand} /> : null}
        {tab === 'settings' ? <SettingsTab key={station.stationId} station={station} canEdit={canEdit} machines={scope.machines} /> : null}
        {tab === 'kiosks' ? <KiosksTab station={station} machines={scope.machines} canEdit={canEdit} /> : null}
      </div>
    </div>
  );
}
