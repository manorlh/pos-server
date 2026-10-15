'use client';

/**
 * The device page's "שרת מזומן" card (P:/specs/cash-paylink.md §2, §12): whether the box is online and when it
 * last beat, its LAN address and port, its version, and the cash stations (PayLink units) it runs — each one's
 * state, linked to its page. The stations come from `GET /cash-stations?shopId=` (this host's).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Coins, FileText, Plus, RotateCw } from 'lucide-react';
import { sendDeviceCommand, sendDeviceLogsRequest } from '@/lib/deviceCommandsStore';
import { formatDateTime } from '@/lib/format';
import { agorotText, type CashStation } from '@/lib/cashStations';
import { cashStationsKey, fetchCashStations } from '@/lib/cashStationsApi';
import type { PosMachine } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog, Field, NativeSelect, StationPill } from './parts';

/** "בקש לוגים": how far back (device-logs-api.md §2: 15–1440 minutes, 120 by default). */
const LOG_MINUTES = [15, 60, 120, 240, 720, 1440] as const;

export function CashHostDeviceCard({ machine }: { machine: PosMachine }) {
  const t = useTranslations('cashStations.hostCard');
  const shopId = machine.shopId ?? null;
  const query = useQuery({
    queryKey: cashStationsKey({ shopId, includeInactive: false }),
    queryFn: () => fetchCashStations({ shopId }),
    enabled: !!shopId,
    refetchInterval: 30_000,
  });
  const mine: CashStation[] = (query.data ?? []).filter(
    (s) => s.host?.machineId?.toLowerCase() === machine.id.toLowerCase(),
  );
  // The host's own report rides on each of its stations; the machine row says the rest.
  const host = mine.find((s) => s.host)?.host ?? null;
  const online = host?.online ?? machine.online ?? false;
  const lastBeat = host?.lastHeartbeatAt ?? machine.lastHeartbeatAt ?? null;
  const address = host?.lanAddress ? `${host.lanAddress}:${host.port ?? 47630}` : null;
  // "שליטה מרחוק" (P:/specs/cash-paylink.md §11.15ד): a restart and a logs request — fire-and-forget, followed in the
  // commands' popup and tray (lib/deviceCommandsStore.ts); the server checks who may.
  const [restartAsk, setRestartAsk] = useState(false);
  const [minutes, setMinutes] = useState<number>(120);
  const restart = () => {
    sendDeviceCommand({ action: 'restart_app', machineIds: [machine.id], names: { [machine.id]: machine.name } });
    setRestartAsk(false);
  };
  const requestLogs = () => sendDeviceLogsRequest({ machineId: machine.id, machineName: machine.name, minutes });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Coins className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={online ? 'secondary' : 'destructive'}>{online ? t('online') : t('offline')}</Badge>
          <span className="text-xs text-muted-foreground">{t('notTill')}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Field label={t('lastHeartbeat')}>{lastBeat ? formatDateTime(lastBeat) : '—'}</Field>
          <Field label={t('lanAddress')}>
            <span dir="ltr" className="font-mono text-xs">{address ?? t('noAddress')}</span>
          </Field>
          <Field label={t('version')}>
            <span dir="ltr">{host?.version ?? machine.appVersion ?? '—'}</span>
          </Field>
          <Field label={t('reportedAt')}>{host?.reportedAt ? formatDateTime(host.reportedAt) : '—'}</Field>
        </dl>
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs font-medium text-muted-foreground">{t('remoteTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('remoteHint')}</p>
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setRestartAsk(true)}>
              <RotateCw aria-hidden /> {t('restart')}
            </Button>
            <div className="w-32 space-y-1">
              <label htmlFor={`cash-host-logs-${machine.id}`} className="text-xs text-muted-foreground">
                {t('logsMinutes')}
              </label>
              <NativeSelect
                id={`cash-host-logs-${machine.id}`}
                value={String(minutes)}
                onChange={(v) => setMinutes(Number(v))}
                options={LOG_MINUTES.map((m) => ({ value: String(m), label: String(m) }))}
              />
            </div>
            <Button size="sm" variant="outline" onClick={requestLogs}>
              <FileText aria-hidden /> {t('requestLogs')}
            </Button>
          </div>
        </div>
        <ConfirmDialog
          open={restartAsk}
          onOpenChange={setRestartAsk}
          title={t('restartConfirm', { name: machine.name })}
          description={t('restartBody')}
          confirmLabel={t('restart')}
          onConfirm={restart}
        />
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('stations')}</p>
          {!shopId ? (
            <p className="text-xs text-muted-foreground">{t('noShop')}</p>
          ) : query.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : mine.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
              <span className="text-xs text-muted-foreground">{t('noStations')}</span>
              <Link href="/dashboard/cash-stations" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                <Plus aria-hidden /> {t('addStation')}
              </Link>
            </div>
          ) : (
            <ul className="divide-y rounded-md border">
              {mine.map((s) => (
                <li key={s.stationId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <Link href={`/dashboard/cash-stations/${s.stationId}`} className="font-medium hover:underline">
                      {s.label}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {t('serial')}: <span dir="ltr" className="font-mono">{s.serial || t('serialDefault')}</span>
                      {' · '}
                      {t('kiosks', { count: s.clients.length })}
                      {s.status?.changeAvailableAgorot != null ? ` · ${t('change')}: ${agorotText(s.status.changeAvailableAgorot)}` : ''}
                    </span>
                  </span>
                  <StationPill station={s} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
