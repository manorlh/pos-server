'use client';

/**
 * Open tables now ("שולחנות פתוחים — חי"): every table of the shop in its state's colour,
 * its order's total, guests and time open, and which till is inside it. Refreshed every
 * ten seconds. A manager can free a table a till left locked, or cancel a stuck order
 * (a till gone, the mode switched off) with a reason — recorded like a till's cancel.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  cancelOpenTable,
  fetchCancelReasons,
  fetchTablesLive,
  forceReleaseTable,
  tablesErrorCode,
  type LiveTable,
  type TableStateCode,
} from '@/lib/tablesApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Tables look as on the till: crisp shapes with a thin edge; a free table quiet, a taken one
 * in a light tint of its state's colour with that colour on its edge and a bar along the
 * start (occupied blue, kitchen orange, to pay amber, at another till violet).
 */
export const STATE_CLASSES: Record<TableStateCode, string> = {
  free: 'bg-card text-foreground border-border',
  occupied: 'bg-blue-50 text-foreground border-blue-500 dark:bg-blue-950/40',
  sent: 'bg-orange-50 text-foreground border-orange-500 dark:bg-orange-950/40',
  awaiting_payment: 'bg-amber-50 text-foreground border-amber-500 dark:bg-amber-950/40',
  locked: 'bg-violet-50 text-foreground border-violet-500 dark:bg-violet-950/40',
};

/** The state's accent: the bar along the card's start. */
const STATE_ACCENT: Record<TableStateCode, string> = {
  free: 'bg-transparent',
  occupied: 'bg-blue-500',
  sent: 'bg-orange-500',
  awaiting_payment: 'bg-amber-500',
  locked: 'bg-violet-500',
};

export function TablesLive({ shopId }: { shopId: string }) {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tables-live', shopId],
    queryFn: () => fetchTablesLive(shopId),
    refetchInterval: 10_000,
  });
  const { data: reasons = [] } = useQuery({ queryKey: ['table-cancel-reasons'], queryFn: () => fetchCancelReasons() });
  const [zoneId, setZoneId] = useState<string | 'all'>('all');
  const [picked, setPicked] = useState<LiveTable | null>(null);
  const [reasonId, setReasonId] = useState<string>('');
  const [reasonText, setReasonText] = useState('');

  const tables = useMemo(
    () => (data?.tables ?? []).filter((tb) => zoneId === 'all' || tb.zoneId === zoneId),
    [data, zoneId],
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['tables-live', shopId] });
  const fail = (err: unknown) => {
    const code = tablesErrorCode(err);
    toast.error(code && t.has(`errors.${code}`) ? t(`errors.${code}`) : axiosErrorToToastMessage(err, tc('error')));
  };

  const releaseMut = useMutation({
    mutationFn: (id: string) => forceReleaseTable(id),
    onSuccess: () => {
      toast.success(t('released'));
      setPicked(null);
      refresh();
    },
    onError: fail,
  });
  const cancelMut = useMutation({
    mutationFn: (id: string) => cancelOpenTable(id, { reasonId, reasonText: reasonText.trim() || null }),
    onSuccess: () => {
      toast.success(t('cancelledToast'));
      setPicked(null);
      refresh();
    },
    onError: fail,
  });
  const reason = reasons.find((r) => r.id === reasonId);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const summary = data?.summary;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('liveOpen')}</div>
          <div className="text-2xl font-bold">{summary?.openTables ?? 0}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('liveTotal')}</div>
          <div className="text-2xl font-bold">{formatCurrency(summary?.openTotal ?? 0)}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground">{t('liveGuests')}</div>
          <div className="text-2xl font-bold">{summary?.guests ?? 0}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={zoneId === 'all' ? 'default' : 'outline'} onClick={() => setZoneId('all')}>
          {t('allZones')}
        </Button>
        {(data?.zones ?? []).map((z) => (
          <Button key={z.id} size="sm" variant={zoneId === z.id ? 'default' : 'outline'} onClick={() => setZoneId(z.id)}>
            {z.name}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        {(Object.keys(STATE_CLASSES) as TableStateCode[]).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={`inline-block h-3 w-3 rounded-sm border ${STATE_CLASSES[s]}`} />
            {t(`state.${s}`)}
          </span>
        ))}
      </div>

      {tables.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">{t('noTables')}</div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
          {tables.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => (tb.order || tb.lock ? setPicked(tb) : undefined)}
              className={`relative flex min-h-24 flex-col items-center justify-center overflow-hidden rounded-lg border p-2 text-center ${STATE_CLASSES[tb.state]}`}
            >
              <span className={`absolute inset-y-0 start-0 w-1 ${STATE_ACCENT[tb.state]}`} />
              <span className="text-2xl font-semibold tabular-nums leading-tight">{tb.number}</span>
              {tb.name ? <span className="max-w-full truncate text-xs text-muted-foreground">{tb.name}</span> : null}
              {tb.order ? (
                <>
                  <span className="text-sm font-medium tabular-nums">{formatCurrency(tb.order.total)}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('minutesOpen', { minutes: tb.minutesOpen ?? 0 })}
                    {tb.order.guests ? ` · ${t('guestsShort', { guests: tb.order.guests })}` : ''}
                  </span>
                </>
              ) : null}
              {tb.order?.waiterName ? <span className="max-w-full truncate text-xs text-muted-foreground">{tb.order.waiterName}</span> : null}
              {tb.lock ? (
                <span className="text-xs">
                  {t('lockedBy', { till: tb.lock.posNumber ?? tb.lock.machineName ?? '?', user: tb.lock.posUserName ?? '' })}
                </span>
              ) : null}
              {!tb.order && tb.cleaningSince ? (
                // Paid, not cleared yet — as the till shows it.
                <span className="mt-1 text-xs font-medium text-muted-foreground">{t('cleaning')}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <Dialog open={picked !== null} onOpenChange={(o) => !o && setPicked(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{picked ? t('tableTitle', { number: picked.number }) : ''}</DialogTitle>
          </DialogHeader>
          {picked ? (
            <div className="space-y-3 text-sm">
              {picked.order ? (
                <div className="space-y-1">
                  <div>{t('openedBy', { name: picked.order.openedByName ?? '—', at: formatDateTime(picked.order.openedAt) })}</div>
                  <div>{t('orderTotal', { total: formatCurrency(picked.order.total) })}</div>
                  <div>{t(`state.${picked.state}`)}</div>
                  {picked.order.source === 'local' ? <div className="text-muted-foreground">{t('localOrderHint')}</div> : null}
                </div>
              ) : null}
              {picked.lock ? (
                <div className="rounded border p-2">
                  {t('lockedBy', {
                    till: picked.lock.posNumber ?? picked.lock.machineName ?? '?',
                    user: picked.lock.posUserName ?? '',
                  })}
                  <Button
                    size="sm"
                    variant="outline"
                    className="ms-2"
                    disabled={releaseMut.isPending}
                    onClick={() => releaseMut.mutate(picked.id)}
                  >
                    {t('forceRelease')}
                  </Button>
                </div>
              ) : null}
              {picked.order ? (
                <div className="space-y-2 rounded border p-2">
                  <div className="font-medium">{t('cancelStuck')}</div>
                  <p className="text-xs text-muted-foreground">{t('cancelStuckHint')}</p>
                  <div className="flex flex-wrap gap-1">
                    {reasons.map((r) => (
                      <Button
                        key={r.id}
                        size="sm"
                        variant={reasonId === r.id ? 'default' : 'outline'}
                        onClick={() => setReasonId(r.id)}
                      >
                        {r.name}
                      </Button>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <Label>{t('reasonText')}</Label>
                    <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPicked(null)}>
              {tc('cancel')}
            </Button>
            {picked?.order ? (
              <Button
                variant="destructive"
                disabled={
                  cancelMut.isPending || !reasonId || (reason?.requiresNote === true && !reasonText.trim())
                }
                onClick={() => picked && cancelMut.mutate(picked.id)}
              >
                {t('cancelTable')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
