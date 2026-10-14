'use client';

/**
 * "קיוסקים" — which kiosks this cash station serves (P:/specs/cash-paylink.md §11.10, §12): a kiosk is assigned
 * by two till parameters on its own level — `cashEnabled` (cash on) and `cashStation` (this station). The list
 * shows what each kiosk resolves to now (the station's `clients`, worked out by the server through every
 * level); the switch writes the kiosk's own values. Several kiosks may share a station (they queue).
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, MonitorSmartphone } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { stationOfClient, type CashStation } from '@/lib/cashStations';
import { cashStationKey, cashStationsKey, fetchCashStations, setKioskStation } from '@/lib/cashStationsApi';
import type { PosMachine } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { ToneBadge } from './parts';

export function KiosksTab({ station, machines, canAssign }: { station: CashStation; machines: PosMachine[]; canAssign: boolean }) {
  const t = useTranslations('cashStations.kiosks');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  // The shop's other stations: a kiosk may resolve to one of them.
  const shopStations = useQuery({
    queryKey: cashStationsKey({ shopId: station.shopId }),
    queryFn: () => fetchCashStations({ shopId: station.shopId }),
  });
  const stations = shopStations.data ?? [station];

  const kiosks = machines
    .filter((m) => String(m.shopId ?? '').toLowerCase() === station.shopId.toLowerCase() && m.deviceRole === 'kiosk')
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const kioskIds = new Set(kiosks.map((k) => k.id.toLowerCase()));
  // A till (stage 3) or a kiosk the list does not hold, assigned all the same.
  const others = station.clients.filter((c) => !kioskIds.has(c.machineId.toLowerCase()));

  const assign = useMutation({
    mutationFn: (a: { machineId: string; on: boolean }) => setKioskStation(a.machineId, station.stationId, a.on),
    onSuccess: (_d, a) => {
      toast.success(a.on ? t('assigned') : t('unassigned'));
      void qc.invalidateQueries({ queryKey: cashStationKey(station.stationId) });
      void qc.invalidateQueries({ queryKey: ['cash-stations'] });
      void qc.invalidateQueries({ queryKey: ['till-parameters'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const nameOf = (id: string | null) => stations.find((s) => s.stationId === id)?.label ?? null;

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>
      {!canAssign ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {t('superAdminOnly')}
        </p>
      ) : null}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <MonitorSmartphone className="h-4 w-4" aria-hidden /> {t('title', { count: station.clients.length })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {kiosks.length === 0 && others.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noKiosks')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {kiosks.map((k) => {
                const resolved = stationOfClient(stations, k.id);
                const here = resolved === station.stationId;
                const elsewhere = resolved && !here ? nameOf(resolved) : null;
                const busy = assign.isPending && assign.variables?.machineId === k.id;
                return (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <Link href={`/dashboard/machines/${k.id}`} className="font-medium hover:underline">
                        {k.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {here ? t('servedHere') : elsewhere ? t('servedElsewhere', { station: elsewhere }) : t('noCash')}
                        {k.kioskEnabled === false ? ` · ${t('kioskOff')}` : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {here ? <ToneBadge tone="ok">{t('assignedBadge')}</ToneBadge> : null}
                      {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={here}
                          disabled={!canAssign || assign.isPending || !station.isActive}
                          onCheckedChange={(v) => assign.mutate({ machineId: k.id, on: !!v })}
                          aria-label={t('switch', { name: k.name })}
                        />
                        {t('switchLabel')}
                      </label>
                    </span>
                  </li>
                );
              })}
              {others.map((c) => (
                <li key={c.machineId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <Link href={`/dashboard/machines/${c.machineId}`} className="font-medium hover:underline">
                      {c.name ?? c.machineId.slice(0, 8)}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{c.kind === 'till' ? t('till') : t('servedHere')}</span>
                  </span>
                  <ToneBadge tone="ok">{t('assignedBadge')}</ToneBadge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t('howItResolves')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
