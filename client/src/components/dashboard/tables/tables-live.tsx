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
 * Tables look as on the till: off-white objects, the state as a coloured ring (the till's
 * legend uses the same colours: free grey, occupied blue, kitchen orange, to pay green,
 * at another till red).
 */
export const STATE_CLASSES: Record<TableStateCode, string> = {
  free: 'bg-[#fffdf8] text-stone-600 border-stone-300 border-2',
  occupied: 'bg-[#fffdf8] text-stone-700 border-blue-500 border-4',
  sent: 'bg-[#fffdf8] text-stone-700 border-orange-500 border-4',
  awaiting_payment: 'bg-[#fffdf8] text-stone-700 border-green-600 border-4',
  locked: 'bg-[#fffdf8] text-stone-700 border-red-600 border-4',
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
            <span className={`inline-block h-3 w-3 rounded-full border ${STATE_CLASSES[s]}`} />
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
              className={`flex min-h-24 flex-col items-center justify-center rounded-2xl p-2 text-center shadow-md ${STATE_CLASSES[tb.state]}`}
            >
              <span className="text-xl font-bold">{tb.number}</span>
              {tb.name ? <span className="text-xs opacity-90">{tb.name}</span> : null}
              {tb.order ? (
                <>
                  <span className="text-sm font-medium">{formatCurrency(tb.order.total)}</span>
                  <span className="text-xs opacity-90">
                    {t('minutesOpen', { minutes: tb.minutesOpen ?? 0 })}
                    {tb.order.guests ? ` · ${t('guestsShort', { guests: tb.order.guests })}` : ''}
                  </span>
                </>
              ) : null}
              {tb.lock ? (
                <span className="text-xs">
                  {t('lockedBy', { till: tb.lock.posNumber ?? tb.lock.machineName ?? '?', user: tb.lock.posUserName ?? '' })}
                </span>
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
