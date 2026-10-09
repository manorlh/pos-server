'use client';

/**
 * "תקינות מכשירים" — every kiosk in scope and what it needs to work (pos-server
 * `GET /kiosks/health`, app/services/kiosk_health.py): the app, the card terminal, the
 * printer, the link to the till, the KDS screens, the media and the uploads, each with its
 * state; open alerts; refreshed every 15 seconds. Summary chips by overall state (each a
 * filter), a shop filter and a search; a kiosk opens a drawer with its details, last events
 * and sessions, and from there the kiosks page's own actions dialog.
 *
 * Scoped like the kiosks page (company or shop); read by every dashboard role but the
 * till-side ones, acted on by the machine-admin roles.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { HeartPulse, MonitorSmartphone, RefreshCw, Search, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { cn } from '@/lib/utils';
import { useAuth, useTenantTimeZone } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { formatDateTimeInZone } from '@/lib/format';
import { fetchKiosks } from '@/lib/kioskApi';
import {
  batteryHistoryRows,
  combinedCounts,
  filterDevices,
  filterHealth,
  healthCounts,
  healthShops,
  sortDevices,
  sortHealth,
  type HealthOverall,
} from '@/lib/kioskInsights';
import { fetchKiosksHealth } from '@/lib/kioskInsightsApi';
import { KioskDetailDialog } from '@/components/dashboard/kiosks/kiosk-detail-dialog';
import { HealthSummaryChips, KioskHealthCard } from '@/components/dashboard/device-health/health-list';
import { KioskHealthDrawer } from '@/components/dashboard/device-health/health-drawer';
import { agoText, useHealthLabels, useNowMs } from '@/components/dashboard/device-health/health-ui';
import { BatteryHistoryTable, BatterySettingsNote, DeviceBatteryCard } from '@/components/dashboard/device-health/battery';

const REFRESH_MS = 15_000;
/** The machine-admin roles: they act on kiosks (the server checks each one's scope). */
const WRITE_ROLES = ['super_admin', 'distributor', 'company_manager', 'shop_manager'];
/** Read: any dashboard role but the till-side ones. */
const READ_DENIED = ['cashier', 'shift_supervisor'];
const ALL = '__all__';

export default function DeviceHealthPage() {
  const t = useTranslations('deviceHealth');
  const router = useRouter();
  const L = useHealthLabels();
  const { resolution, effective, scope } = usePageScope({ maxLevel: 'shop' });
  const role = useAuth((s) => s.user?.role ?? null);
  const authHydrated = useAuth((s) => s.authHydrated);
  const timeZone = useTenantTimeZone();
  const nowMs = useNowMs(REFRESH_MS);

  const [overall, setOverall] = useState<HealthOverall | ''>('');
  const [shopFilter, setShopFilter] = useState('');
  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);

  const shopId = effective.shopId ?? null;
  const shop = scope.shops.find((s) => s.id === shopId) ?? null;
  const companyId = shop?.companyId ?? effective.companyId ?? null;

  const canRead = authHydrated && !!role && !READ_DENIED.includes(role);
  const canWrite = !!role && WRITE_ROLES.includes(role);

  const health = useQuery({
    queryKey: ['kiosks-health', companyId, shopId],
    queryFn: () => fetchKiosksHealth({ companyId: shopId ? null : companyId, shopId }),
    enabled: canRead && resolution.status === 'ok',
    refetchInterval: REFRESH_MS,
  });
  // The kiosks page's own summaries, for its actions dialog — fetched only while a kiosk is open.
  const summaries = useQuery({
    queryKey: ['kiosks', companyId, shopId],
    queryFn: () => fetchKiosks({ companyId: shopId ? null : companyId, shopId }),
    enabled: canRead && resolution.status === 'ok' && (!!actionsId || !!drawerId),
    refetchInterval: actionsId || drawerId ? REFRESH_MS : false,
  });

  const rows = useMemo(() => health.data?.kiosks ?? [], [health.data]);
  // "סוללה חלשה": every other device of the scope (tills, handhelds, tablets) and the history.
  const devices = useMemo(() => health.data?.devices ?? [], [health.data]);
  const counts = useMemo(() => combinedCounts(healthCounts(health.data ?? { kiosks: [] }), devices), [health.data, devices]);
  const shops = useMemo(() => healthShops([...rows, ...devices]), [rows, devices]);
  const shown = useMemo(
    () => sortHealth(filterHealth(rows, { overall, shopId: shopFilter, search })),
    [rows, overall, shopFilter, search],
  );
  const shownDevices = useMemo(
    () => sortDevices(filterDevices(devices, { overall, shopId: shopFilter, search })),
    [devices, overall, shopFilter, search],
  );
  const history = useMemo(
    () => batteryHistoryRows(health.data?.batteryHistory, rows, devices, { shopId: shopFilter, search }),
    [health.data, rows, devices, shopFilter, search],
  );
  const total = rows.length + devices.length;
  const drawerRow = rows.find((r) => r.machineId === drawerId) ?? null;
  const actionsKiosk = (summaries.data ?? []).find((k) => k.machineId === actionsId) ?? null;
  const formatTime = (iso: string) => formatDateTimeInZone(iso, timeZone);
  const filtered = overall !== '' || shopFilter !== '' || search.trim() !== '';

  const shopItems = useMemo(
    () => [{ value: ALL, label: t('filters.allShops') }, ...shops.map((s) => ({ value: s.id, label: s.name }))],
    [shops, t],
  );

  if (authHydrated && !canRead) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <HeartPulse className="h-6 w-6 text-primary" /> {t('title')}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/kiosks" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <MonitorSmartphone /> {t('toKiosks')}
        </Link>
      </div>

      <ScopeGate resolution={resolution}>
        <div className="space-y-4 animate-in fade-in duration-300">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', health.isFetching && 'animate-spin')} aria-hidden /> {t('refreshing')}
            </span>
            {health.dataUpdatedAt > 0 ? (
              <span>{t('updated', { ago: agoText(new Date(health.dataUpdatedAt).toISOString(), nowMs) ?? '' })}</span>
            ) : null}
          </div>

          {health.isLoading ? (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-64 w-full rounded-2xl" />
              ))}
            </div>
          ) : health.isError && !health.data ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              <span>{t('loadFailed')}</span>
              <Button size="sm" variant="outline" onClick={() => void health.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed bg-gradient-to-b from-muted/50 to-background p-10 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
                <HeartPulse className="h-8 w-8" />
              </span>
              <div className="space-y-1">
                <p className="font-semibold">{t('empty')}</p>
                <p className="max-w-md text-sm text-muted-foreground">{t('emptyHint')}</p>
              </div>
              <Link href="/dashboard/kiosks" className={buttonVariants({ size: 'sm' })}>
                {t('toKiosks')}
              </Link>
            </div>
          ) : (
            <>
              <HealthSummaryChips counts={counts} total={total} value={overall} onChange={setOverall} L={L} />

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-56 flex-1 sm:max-w-sm">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('filters.search')}
                    aria-label={t('filters.search')}
                    className="ps-8"
                  />
                </div>
                {shops.length > 1 ? (
                  <Select value={shopFilter || ALL} onValueChange={(v) => setShopFilter(!v || v === ALL ? '' : String(v))} items={shopItems}>
                    <SelectTrigger className="min-w-44" aria-label={t('filters.shop')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {shopItems.map((i) => (
                        <SelectItem key={i.value} value={i.value} label={i.label}>
                          {i.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {filtered ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setOverall('');
                      setShopFilter('');
                      setSearch('');
                    }}
                  >
                    <X /> {t('clearFilters')}
                  </Button>
                ) : null}
                <span className="ms-auto text-xs text-muted-foreground">
                  {t('count', { shown: shown.length + shownDevices.length, total })}
                </span>
              </div>

              {/* The kiosks */}
              <h2 className="pt-1 text-base font-semibold">{t('sections.kiosks', { n: rows.length })}</h2>
              {rows.length === 0 ? (
                <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t('noKiosks')}{' '}
                  <Link href="/dashboard/kiosks" className="text-primary underline">
                    {t('toKiosks')}
                  </Link>
                </p>
              ) : shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {shown.map((row) => (
                    <KioskHealthCard
                      key={row.machineId}
                      row={row}
                      L={L}
                      nowMs={nowMs}
                      formatTime={formatTime}
                      onOpen={() => setDrawerId(row.machineId)}
                    />
                  ))}
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t('alertsNote')}{' '}
                <Link href="/dashboard/kiosks" className="text-primary underline">
                  {t('alertsNoteLink')}
                </Link>
              </p>

              {/* "סוללה חלשה": the scope's other devices */}
              {devices.length > 0 ? (
                <section className="space-y-3 pt-2">
                  <h2 className="text-base font-semibold">{t('sections.devices', { n: devices.length })}</h2>
                  {shownDevices.length === 0 ? (
                    <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {shownDevices.map((d) => (
                        <DeviceBatteryCard key={d.machineId} device={d} L={L} nowMs={nowMs} formatTime={formatTime} />
                      ))}
                    </div>
                  )}
                </section>
              ) : null}

              {/* "היסטוריית סוללה חלשה" */}
              {(health.data?.batteryHistory ?? []).length > 0 ? (
                <section className="space-y-3 pt-2">
                  <h2 className="text-base font-semibold">{t('sections.batteryHistory')}</h2>
                  <BatteryHistoryTable rows={history} formatTime={formatTime} />
                </section>
              ) : null}

              <BatterySettingsNote isSuperAdmin={role === 'super_admin'} />
            </>
          )}
        </div>
      </ScopeGate>

      <KioskHealthDrawer
        row={drawerRow}
        open={!!drawerRow}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
        L={L}
        nowMs={nowMs}
        formatTime={formatTime}
        actions={
          !summaries.data
            ? summaries.isError
              ? 'none'
              : 'loading'
            : summaries.data.some((k) => k.machineId === drawerId)
              ? 'ready'
              : 'none'
        }
        isSuperAdmin={role === 'super_admin'}
        onOpenActions={(machineId) => {
          // One dialog at a time: the drawer closes, and comes back when the actions close.
          setDrawerId(null);
          setActionsId(machineId);
        }}
      />

      <KioskDetailDialog
        kiosk={actionsKiosk}
        open={!!actionsKiosk}
        onOpenChange={(open) => {
          if (!open) {
            const back = actionsId;
            setActionsId(null);
            setDrawerId(back);
          }
        }}
        canWrite={canWrite}
        shops={scope.shops}
        machines={scope.machines}
        kiosks={summaries.data ?? []}
        nowMs={nowMs}
        onOpenSettings={() => router.push('/dashboard/kiosks')}
      />
    </div>
  );
}
