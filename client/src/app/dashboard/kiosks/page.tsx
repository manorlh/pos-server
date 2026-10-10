'use client';

/**
 * "קיוסקים" — customer self-order kiosks. A kiosk is an ordinary paired till the dashboard
 * turned into a self-order station (pos-server app/routers/kiosks.py): its live status and
 * remote control here, and its look and behaviour per company → shop → kiosk with a live
 * preview. The kiosk itself keeps everything a till has (shifts, Z, documents, printing).
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Gamepad2, LayoutList, MonitorSmartphone, Palette, Plus, RefreshCw } from 'lucide-react';
// "שליטה מרחוק" (components/dashboard/live-control): pause, banner, quick hides — live.
import { KioskControlPanel } from '@/components/dashboard/live-control';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { fetchKiosks, type KioskLevel, type KioskSummary } from '@/lib/kioskApi';
import { KioskList } from '@/components/dashboard/kiosks/kiosk-list';
import { KioskDetailDialog } from '@/components/dashboard/kiosks/kiosk-detail-dialog';
import { ConvertDialog } from '@/components/dashboard/kiosks/convert-dialog';
import { KioskSettingsEditor, useNowMs } from '@/components/dashboard/kiosks/kiosk-settings-editor';

type View = 'list' | 'settings' | 'remote';

/** The machine-admin roles: they act on kiosks (the server checks each one's scope). */
const WRITE_ROLES = ['super_admin', 'distributor', 'company_manager', 'shop_manager'];
/** Read: any dashboard role but the till-side ones. */
const READ_DENIED = ['cashier', 'shift_supervisor'];

export default function KiosksPage() {
  const t = useTranslations('kiosks');
  const { resolution, effective, scope } = usePageScope({ maxLevel: 'shop' });
  const role = useAuth((s) => s.user?.role ?? null);
  const authHydrated = useAuth((s) => s.authHydrated);
  const tenantName = useAuth((s) => s.tenants.find((x) => x.id === s.activeTenantId)?.name ?? '');
  const nowMs = useNowMs(15_000);

  const [view, setView] = useState<View>('list');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [chosenLevel, setChosenLevel] = useState<KioskLevel | null>(null);
  const [settingsKioskId, setSettingsKioskId] = useState<string | null>(null);

  const shopId = effective.shopId ?? null;
  const shop = scope.shops.find((s) => s.id === shopId) ?? null;
  // A shop inherits from its own company's layer (not a parent company's in the tree), so
  // with a shop in scope the company level is that shop's company.
  const companyId = shop?.companyId ?? effective.companyId ?? null;
  const company = scope.companies.find((c) => c.id === companyId) ?? null;

  const canRead = authHydrated && !!role && !READ_DENIED.includes(role);
  const canWrite = !!role && WRITE_ROLES.includes(role);

  const kiosksQuery = useQuery({
    queryKey: ['kiosks', companyId, shopId],
    queryFn: () => fetchKiosks({ companyId: shopId ? null : companyId, shopId }),
    enabled: canRead && resolution.status === 'ok',
    refetchInterval: 15_000,
  });
  const kiosks = useMemo(() => kiosksQuery.data ?? [], [kiosksQuery.data]);
  const detail = kiosks.find((k) => k.machineId === detailId) ?? null;

  const level: KioskLevel = chosenLevel ?? (shopId || role === 'shop_manager' ? 'shop' : 'company');
  const fallbackMachineIds = useMemo(
    () => scope.machineOptions.map((m) => ({ id: m.id, shopId: m.shopId ?? null })),
    [scope.machineOptions],
  );

  const openSettings = (k: KioskSummary) => {
    setDetailId(null);
    setSettingsKioskId(k.machineId);
    setChosenLevel('machine');
    setView('settings');
  };

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
            <MonitorSmartphone className="h-6 w-6 text-primary" /> {t('title')}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canWrite ? (
          <Button onClick={() => setConvertOpen(true)}>
            <Plus /> {t('convert.button')}
          </Button>
        ) : null}
      </div>

      <div className="inline-flex rounded-2xl bg-muted p-1">
        {(
          [
            { key: 'list', icon: <LayoutList className="h-4 w-4" /> },
            { key: 'settings', icon: <Palette className="h-4 w-4" /> },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setView(tab.key)}
            className={cn(
              'flex items-center gap-2 rounded-xl px-4 py-2 text-sm transition-all duration-200',
              view === tab.key ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon} {t(`tabs.${tab.key}`)}
          </button>
        ))}
        {canWrite ? (
          <button
            type="button"
            onClick={() => setView('remote')}
            className={cn(
              'flex items-center gap-2 rounded-xl px-4 py-2 text-sm transition-all duration-200',
              view === 'remote' ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Gamepad2 className="h-4 w-4" /> שליטה מרחוק
          </button>
        ) : null}
      </div>

      <ScopeGate resolution={resolution}>
        {view === 'remote' ? (
          <div className="max-w-2xl animate-in fade-in duration-300">
            <KioskControlPanel scope={{ companyId: shopId ? null : companyId, shopId }} />
          </div>
        ) : view === 'list' ? (
          <div className="space-y-3 animate-in fade-in duration-300">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <RefreshCw className={cn('h-3.5 w-3.5', kiosksQuery.isFetching && 'animate-spin')} /> {t('list.refreshing')}
              </span>
              {kiosks.length > 0 ? <span>{t('list.count', { n: kiosks.length })}</span> : null}
            </div>
            {kiosksQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-24 w-full rounded-2xl" />
                <Skeleton className="h-24 w-full rounded-2xl" />
              </div>
            ) : kiosksQuery.isError ? (
              <p className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{t('list.loadFailed')}</p>
            ) : kiosks.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed bg-gradient-to-b from-muted/50 to-background p-10 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
                  <MonitorSmartphone className="h-8 w-8" />
                </span>
                <div className="space-y-1">
                  <p className="font-semibold">{t('list.empty')}</p>
                  <p className="max-w-md text-sm text-muted-foreground">{t('list.emptyHint')}</p>
                </div>
                {canWrite ? (
                  <Button onClick={() => setConvertOpen(true)}>
                    <Plus /> {t('convert.button')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <KioskList kiosks={kiosks} nowMs={nowMs} onManage={(k) => setDetailId(k.machineId)} onSettings={openSettings} />
            )}
          </div>
        ) : (
          <div className="animate-in fade-in duration-300">
            <KioskSettingsEditor
              companyId={companyId}
              companyName={company?.name ?? null}
              shopId={shopId}
              shopName={shop?.name ?? null}
              kiosks={kiosks}
              kioskId={settingsKioskId ?? kiosks[0]?.machineId ?? null}
              onKioskChange={setSettingsKioskId}
              level={level}
              onLevelChange={setChosenLevel}
              role={role}
              fallbackMachineIds={fallbackMachineIds}
              brandName={tenantName}
            />
          </div>
        )}
      </ScopeGate>

      <KioskDetailDialog
        kiosk={detail}
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
        canWrite={canWrite}
        shops={scope.shops}
        machines={scope.machines}
        kiosks={kiosks}
        nowMs={nowMs}
        onOpenSettings={openSettings}
      />
      {convertOpen ? (
        <ConvertDialog
          open={convertOpen}
          onOpenChange={setConvertOpen}
          shopId={shopId}
          shops={scope.shops}
          machines={scope.machines}
          kiosks={kiosks}
          onCreated={(k) => setDetailId(k.machineId)}
        />
      ) : null}
    </div>
  );
}
