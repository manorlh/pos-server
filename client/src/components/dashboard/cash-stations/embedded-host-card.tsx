'use client';

/**
 * The device page's "מארח עמדת מזומן" card (P:/specs/cash-paylink.md §14.1): a Windows kiosk whose PC has the
 * PayLink on USB runs its cash station(s) itself — the switch (off by default; `PUT /cash-stations/embedded-hosts/
 * {machineId}`), why it is not offered when it is not, and the stations it runs, each linked to its page. Turning it
 * off while a station still names it is refused by the server (`host_has_stations`) — the stations move first.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Coins, Loader2, Plus } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { embeddedHostKey, fetchEmbeddedHost, setEmbeddedHost } from '@/lib/cashStationsApi';
import type { PosMachine } from '@/lib/types';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToneBadge, useCashAccess } from './parts';

export function EmbeddedHostCard({ machine }: { machine: PosMachine }) {
  const t = useTranslations('cashStations.embeddedHost');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { canEdit } = useCashAccess();
  const query = useQuery({ queryKey: embeddedHostKey(machine.id), queryFn: () => fetchEmbeddedHost(machine.id) });
  const toggle = useMutation({
    mutationFn: (on: boolean) => setEmbeddedHost(machine.id, on),
    onSuccess: (next) => {
      qc.setQueryData(embeddedHostKey(machine.id), next);
      // The station pages' host lists and the machine itself (its `cashHostEmbedded`).
      void qc.invalidateQueries({ queryKey: ['cash-stations'] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(next.embedded ? t('on') : t('off'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const host = query.data;
  const activeStations = host?.stations.filter((s) => s.isActive) ?? [];
  // Off is refused by the server while an active station names it: said here before anyone tries.
  const offBlocked = !!host?.embedded && activeStations.length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Coins className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="max-w-3xl text-xs text-muted-foreground">{t('intro')}</p>
        {query.isLoading || !host ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <Switch
                  checked={host.embedded}
                  disabled={!canEdit || toggle.isPending || (!host.embedded && !host.allowed) || offBlocked}
                  onCheckedChange={(v) => toggle.mutate(!!v)}
                  aria-label={t('switch')}
                />
                <span>{t('switch')}</span>
              </label>
              {toggle.isPending ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
              {host.active ? <ToneBadge tone="ok">{t('on')}</ToneBadge> : null}
            </div>
            {!host.allowed && host.reason ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('notAllowed', { reason: host.reason })}</p> : null}
            {offBlocked ? <p className="text-xs text-muted-foreground">{t('offBlocked')}</p> : null}
            {!canEdit ? <p className="text-xs text-muted-foreground">{t('readOnly')}</p> : null}
            {host.embedded ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{t('stations')}</p>
                {host.stations.length === 0 ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
                    <span className="text-xs text-muted-foreground">{t('noStations')}</span>
                    <Link href="/dashboard/cash-stations" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                      <Plus aria-hidden /> {t('addStation')}
                    </Link>
                  </div>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {host.stations.map((s) => (
                      <li key={s.stationId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <Link href={`/dashboard/cash-stations/${s.stationId}`} className="font-medium hover:underline">
                          {s.label}
                        </Link>
                        {!s.isActive ? <ToneBadge tone="muted">{t('inactive')}</ToneBadge> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">{t('firewall')}</p>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
