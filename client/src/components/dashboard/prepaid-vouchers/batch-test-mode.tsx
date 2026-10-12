'use client';

/**
 * "מצב בדיקה" on the batch's page (P:/specs/voucher-test-mode.md; lib/prepaidVoucherTestMode.ts): the
 * switch, the orange banner while it is on, "סיום בדיקה והפעלה" (confirmed first) and "יומן בדיקות" —
 * the test scans: who, when, which till / shop, which voucher, what it would have covered and left.
 * Turning it on / off is "ערוך סדרה" (`testMode`), so its permission and its audit line are the edit's.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FlaskConical, Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { formatDateTime } from '@/lib/format';
import { updatePrepaidBatch, type PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { fetchPrepaidTestLog, wouldCoverText, wouldRemainText } from '@/lib/prepaidVoucherTestMode';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const ORANGE = 'border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-100';

/** "בבדיקה" — on a batch's card and header. */
export function TestModeTag({ className }: { className?: string }) {
  const t = useTranslations('prepaidVoucherTestMode');
  return (
    <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', ORANGE, className)}>
      {t('tag')}
    </span>
  );
}

function money(v: number | null | undefined): string {
  return v == null ? '' : `₪${v.toFixed(2)}`;
}

export function BatchTestModePanel({ batch, onChanged }: { batch: PrepaidVoucherBatch; onChanged: () => void }) {
  const t = useTranslations('prepaidVoucherTestMode');
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const access = useDashboardAccess();
  const editable = canAccess(access, 'prepaid_vouchers', 'edit');
  const [confirmOff, setConfirmOff] = useState(false);
  const on = !!batch.testMode;

  const log = useQuery({ queryKey: ['prepaid-voucher-test-log', batch.id], queryFn: () => fetchPrepaidTestLog(batch.id) });
  const rows = log.data?.items ?? [];

  const errorText = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && t.has(`errors.${detail}`)) return t(`errors.${detail}`);
    if (typeof detail === 'string' && detail.startsWith('prepaid_voucher_') && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
  const save = useMutation({
    mutationFn: (testMode: boolean) => updatePrepaidBatch(batch.id, { testMode }),
    onSuccess: (b) => {
      toast.success(b.testMode ? t('turnedOn') : t('turnedOff'));
      setConfirmOff(false);
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-test-log', batch.id] });
      onChanged();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  // Off makes the vouchers real: always through the confirmation.
  const toggle = (v: boolean) => (v ? save.mutate(true) : setConfirmOff(true));

  if (!on && !rows.length && !editable) return null;
  return (
    <div className="space-y-2 print:hidden">
      {on ? (
        <div role="status" className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm', ORANGE)}>
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t('banner')}</p>
            {batch.testModeSince ? (
              <p className="text-xs opacity-80">
                {t('since', { when: formatDateTime(batch.testModeSince), who: batch.testModeBy ?? '—' })}
              </p>
            ) : null}
          </div>
          {editable ? (
            <Button size="sm" onClick={() => setConfirmOff(true)} disabled={save.isPending}>
              {t('finish')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('switch')}</p>
          <p className="text-xs text-muted-foreground">{t('switchHint')}</p>
        </div>
        <Switch checked={on} disabled={!editable || save.isPending} onCheckedChange={(v) => toggle(!!v)} aria-label={t('switch')} />
      </div>

      {on || rows.length ? (
        <details className="rounded-lg border px-3 py-2" open={on}>
          <summary className="cursor-pointer text-sm font-medium">
            {t('logTitle')} {log.data ? <span className="text-muted-foreground">({log.data.total})</span> : null}
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('logHint')}</p>
          {log.isPending ? (
            <p className="py-2 text-xs text-muted-foreground"><Loader2 className="inline h-3 w-3 animate-spin" /></p>
          ) : !rows.length ? (
            <p className="py-2 text-xs text-muted-foreground">{t('logEmpty')}</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-start">
                    <th className="px-1 py-1 text-start font-medium">{t('col.when')}</th>
                    <th className="px-1 py-1 text-start font-medium">{t('col.who')}</th>
                    <th className="px-1 py-1 text-start font-medium">{t('col.where')}</th>
                    <th className="px-1 py-1 text-start font-medium">{t('col.voucher')}</th>
                    <th className="px-1 py-1 text-start font-medium">{t('col.covered')}</th>
                    <th className="px-1 py-1 text-start font-medium">{t('col.left')}</th>
                    <th className="px-1 py-1 text-start font-medium">{t('col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-1 py-1 whitespace-nowrap">{r.at ? formatDateTime(r.at) : ''}</td>
                      <td className="px-1 py-1">{r.posUserName ?? '—'}</td>
                      <td className="px-1 py-1">{[r.machineName, r.shopName].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-1 py-1 tabular-nums">{r.serial != null ? `#${r.serial}` : '—'}</td>
                      <td className="px-1 py-1">
                        {r.discount != null
                          ? money(r.discount)
                          : [wouldCoverText(r), r.covered != null ? money(r.covered) : null].filter(Boolean).join(' · ')}
                      </td>
                      <td className="px-1 py-1">
                        {[wouldRemainText(r, { uses: t('uses'), total: t('total') }), r.topUp ? t('toPay', { v: money(r.topUp) }) : null]
                          .filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-1 py-1">{t(`status.${r.status}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      ) : null}

      <Dialog open={confirmOff} onOpenChange={(v) => { if (!v && !save.isPending) setConfirmOff(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('finish')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('finishConfirm')}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOff(false)} disabled={save.isPending}>{tc('cancel')}</Button>
            <Button onClick={() => save.mutate(false)} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('finish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
