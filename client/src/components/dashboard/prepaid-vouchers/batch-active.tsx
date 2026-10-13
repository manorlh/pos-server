'use client';

/**
 * "סדרה פעילה" — a batch turned off / on from the cloud (the cloud's app/services/prepaid_voucher_controls.py
 * `set_active`; `PUT /prepaid-vouchers/batches/{id}/active`, "ערוך סדרה"'s permission). Off: every till
 * refuses its vouchers ("הסדרה כבויה — לא ניתן לממש שוברים ממנה") until it is turned on again.
 *
 * Made of "השהיית מימושים" (no setting of its own): off is a pause of the batch's own, on resumes every
 * open one of its own. A pause of its event / production / type stops it too: shown here read only
 * ("מושהית דרך אירוע: …"), lifted in "בקרה ובדיקות" → "השהיית מימושים".
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Loader2, PauseCircle } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { formatDateTime } from '@/lib/format';
import { setPrepaidBatchActive, type PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const RED = 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100';
const AMBER = 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100';
/** The cloud's limit (app/schemas/prepaid_voucher.py ACTIVE_REASON_MAX). */
const REASON_MAX = 500;

/** Whether the batch is on; an older cloud says nothing — on. */
export function batchIsActive(b: Pick<PrepaidVoucherBatch, 'active'>): boolean {
  return b.active !== false;
}

/** "כבויה" — on a batch's card in the list. */
export function InactiveTag({ className }: { className?: string }) {
  const t = useTranslations('prepaidVoucherActive');
  return (
    <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', RED, className)}>
      {t('tag')}
    </span>
  );
}

function useErrorText() {
  const t = useTranslations('prepaidVoucherActive');
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && t.has(`errors.${detail}`)) return t(`errors.${detail}`);
    if (typeof detail === 'string' && /^[a-z_]+$/.test(detail) && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

/**
 * The batch header's "סדרה פעילה" switch (on = green). Off is confirmed first ("שוברי הסדרה לא ימומשו
 * עד שתופעל מחדש") with an optional reason; on is at once. Only with edit on the vouchers.
 */
export function BatchActiveSwitch({ batch, onChanged, className }: {
  batch: PrepaidVoucherBatch;
  onChanged: () => void;
  className?: string;
}) {
  const t = useTranslations('prepaidVoucherActive');
  const tc = useTranslations('common');
  const access = useDashboardAccess();
  const editable = canAccess(access, 'prepaid_vouchers', 'edit');
  const errorText = useErrorText();
  const on = batchIsActive(batch);
  const [confirmOff, setConfirmOff] = useState(false);
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: (v: { active: boolean; reason?: string }) => setPrepaidBatchActive(batch.id, v.active, v.reason),
    onSuccess: (out, v) => {
      toast.success(!out.changed ? t('alreadySo') : v.active ? t('turnedOn') : t('turnedOff'));
      setConfirmOff(false);
      setReason('');
      onChanged();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const toggle = (v: boolean) => (v ? save.mutate({ active: true }) : setConfirmOff(true));

  return (
    <>
      <label className={cn('flex items-center gap-2 rounded-full border px-3 py-1 text-sm print:hidden',
        on ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100' : RED,
        className)}>
        <span className="font-medium">{t('switch')}</span>
        <Switch checked={on} disabled={!editable || save.isPending} onCheckedChange={(v) => toggle(!!v)} aria-label={t('switch')}
          className="data-checked:bg-emerald-600 dark:data-checked:bg-emerald-500" />
        {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      </label>

      <Dialog open={confirmOff} onOpenChange={(v) => { if (!v && !save.isPending) { setConfirmOff(false); setReason(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('confirmText')}</p>
          <div className="space-y-1">
            <Label htmlFor="pv-active-reason">{t('reason')}</Label>
            <textarea id="pv-active-reason" rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmOff(false); setReason(''); }} disabled={save.isPending}>{tc('cancel')}</Button>
            <Button variant="destructive" onClick={() => save.mutate({ active: false, reason })} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Under the batch's header: the red "הסדרה כבויה" banner while it is off (why, since when, by whom), and a
 * pause of its event / production / type — read only, with a link to "השהיית מימושים" ([onOpenPauses],
 * only for whoever sees the controls).
 */
export function BatchActiveNotices({ batch, onOpenPauses }: { batch: PrepaidVoucherBatch; onOpenPauses?: () => void }) {
  const t = useTranslations('prepaidVoucherActive');
  const access = useDashboardAccess();
  const controls = canAccess(access, 'prepaid_voucher_controls', 'view');
  const off = !batchIsActive(batch);
  const above = batch.pausedBy ?? null;
  if (!off && !above) return null;
  const inactive = batch.inactive ?? null;
  return (
    <div className="space-y-2">
      {off ? (
        <div role="status" className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', RED)}>
          <Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t('banner')}</p>
            <p className="text-xs">{t('bannerHint')}</p>
            {inactive?.reason ? <p className="text-xs">{t('reasonLine', { reason: inactive.reason })}</p> : null}
            {inactive?.since ? (
              <p className="text-xs opacity-80">{t('since', { when: formatDateTime(inactive.since), who: inactive.by ?? '—' })}</p>
            ) : null}
            {inactive?.until ? <p className="text-xs opacity-80">{t('until', { when: formatDateTime(inactive.until) })}</p> : null}
          </div>
        </div>
      ) : null}
      {above ? (
        <div role="status" className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', AMBER)}>
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {t('pausedBy', { kind: t.has(`kind.${above.kind}`) ? t(`kind.${above.kind}`) : above.kindText ?? above.kind, reason: above.reason })}
            </p>
            <p className="text-xs">
              {t('pausedByName', { kind: t.has(`kind.${above.kind}`) ? t(`kind.${above.kind}`) : above.kind, name: above.name })}
              {above.until ? ` · ${t('until', { when: formatDateTime(above.until) })}` : ''}
            </p>
            <p className="text-xs opacity-80">{t('pausedByHint')}</p>
          </div>
          {controls && onOpenPauses ? (
            <Button size="sm" variant="outline" className="shrink-0 print:hidden" onClick={onOpenPauses}>{t('openPauses')}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
