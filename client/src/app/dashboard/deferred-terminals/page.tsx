'use client';

/**
 * "מסופונים — מצב לא מקוון" (P:/specs/nayax-deferred-all.md §9): every card terminal of one shop to the
 * deferred (offline) mode and back, from the cloud — "העבר הכל ללא מקוון", "החזר הכל למקוון" and a switch
 * per till. Each switch is a device command the till takes the first moment it is connected, acknowledges
 * at once and carries out once its terminal is free; the page follows it (ממתין → התקבל → בוצע / נכשל) and,
 * on the way back online, says how many deferred sales were approved and how many declined.
 *
 * A till left out (§8.2: Z-Credit, SynqPay, no card, an unsupported model, a build too old…) is greyed with
 * its reason and has no switch; a kiosk is listed only while kiosks are included. The section
 * `terminals_offline` gates the page (the server checks it on every route); switching needs it at edit.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CloudOff, Crown, Plug, RefreshCw, WifiOff } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatTimeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  MODE_LABELS,
  STATE_LABELS,
  declinedCount,
  isOpenCommand,
  lastAppliedText,
  nearLimit,
  outcomeText,
  pendingText,
  pollMs,
  reasonText,
  switchSummary,
  switchable,
  terminalText,
  visibleTills,
  type DeferredShopView,
  type DeferredTill,
} from '@/lib/deferredTerminals';
import { deferredTerminalsKeys, fetchDeferredTerminals, switchDeferred } from '@/lib/deferredTerminalsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

export default function DeferredTerminalsPage() {
  const t = useTranslations('deferredTerminals');
  // One shop's terminals: the page asks for a shop.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <ScopeGate resolution={resolution}>{shopId ? <ShopTerminals shopId={shopId} /> : null}</ScopeGate>
    </div>
  );
}

type Pending = { on: boolean; machineIds?: string[]; label: string } | null;

function ShopTerminals({ shopId }: { shopId: string }) {
  const t = useTranslations('deferredTerminals');
  const qc = useQueryClient();
  const { data: view, isLoading, isError, error, refetch, isFetching } = useQuery<DeferredShopView>({
    queryKey: deferredTerminalsKeys.shop(shopId),
    queryFn: () => fetchDeferredTerminals(shopId),
    // Quickly while a command is on its way (ממתין / התקבל), slowly otherwise.
    refetchInterval: (query) => pollMs(query.state.data),
  });
  const [confirm, setConfirm] = useState<Pending>(null);

  const send = useMutation({
    mutationFn: (p: { on: boolean; machineIds?: string[] }) => switchDeferred(shopId, p.on, p.machineIds),
    onSuccess: (result) => {
      const names = new Map((view?.tills ?? []).map((x) => [x.machineId, x.label]));
      const text = switchSummary(result, (id) => names.get(id) ?? id);
      if (result.created.length > 0) toast.success(text);
      else toast.warning(text);
      setConfirm(null);
      qc.invalidateQueries({ queryKey: deferredTerminalsKeys.shop(shopId) });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('switchError'))),
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !view) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {axiosErrorToToastMessage(error, t('loadError'))}
        </CardContent>
      </Card>
    );
  }

  const tills = visibleTills(view.tills);
  const reachable = tills.filter(switchable);
  const controllers = view.tills.filter((x) => view.controllers.includes(x.machineId)).map((x) => x.label);
  const kioskCount = view.tills.length - tills.length;
  const autoOff =
    view.settings.autoOff === 'auto'
      ? t('autoOffAuto', { minutes: view.settings.autoOffMinutes })
      : view.settings.autoOff === 'never'
        ? t('autoOffNever')
        : t('autoOffAsk');

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={!view.canSwitch || reachable.length === 0 || send.isPending}
              onClick={() => setConfirm({ on: true, label: t('allOffline') })}
            >
              <CloudOff className="size-4 ms-1" aria-hidden />
              {t('allOffline')}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!view.canSwitch || reachable.length === 0 || send.isPending}
              onClick={() => setConfirm({ on: false, label: t('allOnline') })}
            >
              <Plug className="size-4 ms-1" aria-hidden />
              {t('allOnline')}
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn('size-4 ms-1', isFetching && 'animate-spin')} aria-hidden />
              {t('refresh')}
            </Button>
          </div>
          {!view.canSwitch ? <p className="text-xs text-muted-foreground">{t('readOnly')}</p> : null}
          <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <span>{t('reachable', { n: reachable.length, total: tills.length })}</span>
            <span>{t('autoOffLine', { value: autoOff })}</span>
            <span>{t('ttlLine', { minutes: view.settings.ttlMinutes })}</span>
            <span>
              {view.settings.includeKiosks ? t('kiosksIncluded') : t('kiosksExcluded', { n: kioskCount })}
            </span>
            <span className="sm:col-span-2">
              {controllers.length > 0 ? t('controllers', { names: controllers.join(' · ') }) : t('noControllers')}
            </span>
          </div>
        </CardContent>
      </Card>

      {tills.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {tills.map((till) => (
            <TillRow
              key={till.machineId}
              till={till}
              canSwitch={view.canSwitch}
              busy={send.isPending}
              onSwitch={(on) =>
                on
                  ? setConfirm({ on, machineIds: [till.machineId], label: t('oneOffline', { name: till.label }) })
                  : send.mutate({ on, machineIds: [till.machineId] })
              }
            />
          ))}
        </div>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => (!open ? setConfirm(null) : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm?.label}</DialogTitle>
            <DialogDescription>
              {confirm?.on ? t('confirmOffline') : t('confirmOnline')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant={confirm?.on ? 'destructive' : 'default'}
              disabled={send.isPending}
              onClick={() => confirm && send.mutate({ on: confirm.on, machineIds: confirm.machineIds })}
            >
              {send.isPending ? t('sending') : t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const MODE_TONE: Record<string, string> = {
  offline: 'border-amber-500 text-amber-700 dark:text-amber-300',
  online: 'border-emerald-500 text-emerald-700 dark:text-emerald-300',
  unknown: 'text-muted-foreground',
};

const STATE_TONE: Record<string, string> = {
  pending: 'text-muted-foreground',
  received: 'border-sky-500 text-sky-700 dark:text-sky-300',
  done: 'border-emerald-500 text-emerald-700 dark:text-emerald-300',
  failed: 'border-destructive text-destructive',
  cancelled: 'text-muted-foreground',
};

function TillRow({
  till,
  canSwitch,
  busy,
  onSwitch,
}: {
  till: DeferredTill;
  canSwitch: boolean;
  busy: boolean;
  onSwitch: (on: boolean) => void;
}) {
  const t = useTranslations('deferredTerminals');
  const included = switchable(till);
  const cmd = till.lastCommand;
  const open = isOpenCommand(cmd);
  // What the till is (or is being told) to be: an order on its way, else what its terminal last said.
  const wanted = open && cmd?.on != null ? cmd.on : till.mode === 'offline';
  const outcome = outcomeText(cmd);
  const declined = declinedCount(cmd);
  const applied = lastAppliedText(till.lastApplied);
  const why = till.reasonText ?? reasonText(till.reason, till.model);
  const switchId = `deferred-${till.machineId}`;

  return (
    <Card className={cn(!included && 'opacity-60')}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {till.label}
              {till.isController ? (
                <Badge variant="outline" className="gap-1">
                  <Crown className="size-3" aria-hidden />
                  {t('controller')}
                </Badge>
              ) : null}
              {till.isKiosk ? <Badge variant="outline">{t('kiosk')}</Badge> : null}
              {!till.online ? (
                <Badge variant="outline" className="gap-1 text-muted-foreground">
                  <WifiOff className="size-3" aria-hidden />
                  {t('notConnected')}
                </Badge>
              ) : null}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{terminalText(till.kind, till.model)}</p>
          </div>
          {included ? (
            <div className="flex min-h-11 items-center gap-2">
              <label htmlFor={switchId} className="text-sm">
                {t('offlineSwitch')}
              </label>
              <Switch
                id={switchId}
                checked={wanted}
                disabled={!canSwitch || busy}
                onCheckedChange={(on) => onSwitch(!!on)}
              />
            </div>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">{why ?? t('notIncluded')}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1">
            {t('mode')}:
            <Badge variant="outline" className={MODE_TONE[till.mode]}>
              {MODE_LABELS[till.mode]}
            </Badge>
          </span>
          <span className={cn(nearLimit(till) && 'font-semibold text-amber-700 dark:text-amber-300')}>
            {nearLimit(till) ? <AlertTriangle className="inline size-3.5 me-1" aria-hidden /> : null}
            {t('deferred', { value: pendingText(till.pending, till.txLimit) })}
          </span>
          <span className="text-xs text-muted-foreground">
            {till.reportedAt ? t('updated', { ago: formatTimeAgo(till.reportedAt) }) : t('neverReported')}
          </span>
        </div>
        {applied ? <p className="text-xs text-muted-foreground">{t('lastApplied', { value: applied })}</p> : null}
        {cmd ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{cmd.on ? t('commandOffline') : t('commandOnline')}</span>
            <Badge variant="outline" className={STATE_TONE[cmd.state]}>
              {STATE_LABELS[cmd.state]}
            </Badge>
            <span className="text-muted-foreground">
              {formatTimeAgo(cmd.doneAt ?? cmd.receivedAt ?? cmd.createdAt ?? undefined)}
              {cmd.createdBy ? ` · ${cmd.createdBy}` : ''}
            </span>
            {outcome ? (
              <span className={cn(declined > 0 ? 'font-bold text-destructive' : cmd.state === 'failed' && 'text-destructive')}>
                {outcome}
              </span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
