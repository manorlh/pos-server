'use client';

/**
 * "ערוך סדרה" — the confirmation and the save (lib/prepaidBatchEdit.ts; the cloud's
 * app/services/prepaid_voucher_edit.py). Every change goes through [useBatchEditSave]: the cloud
 * plans it first; free changes (texts, print settings) are saved at once, anything else is shown
 * as a list — each change before → after and what it touches — and saved only once confirmed.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDate } from '@/lib/format';
import { moneyText } from '@/lib/prepaidVoucherBenefit';
import {
  changesByCategory,
  editValueText,
  type EditValueFormat,
  type PrepaidBatchEditPlan,
  type PrepaidEditCategory,
} from '@/lib/prepaidBatchEdit';
import {
  previewPrepaidBatchEdit,
  updatePrepaidBatch,
  type PrepaidBatchEditBody,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** The labels of a choice's values, from the texts the forms already use. */
function useChoiceLabel() {
  const tt = useTranslations('prepaidVouchers.types');
  const tk = useTranslations('prepaidVouchers.kinds');
  const te = useTranslations('prepaidVouchers.edit');
  return (field: string, value: string): string | null => {
    const key = (
      {
        redemptionAccounting: `accounting.${value}`,
        pricing: `pricing.${value}`,
        discountBlockPolicy: `override.${value}`,
      } as Record<string, string>
    )[field];
    if (key && tt.has(key)) return tt(key);
    const kinds = ({ stacking: `stacking.${value}`, promotionPolicy: `promotionPolicy.${value}`, discountType: value } as Record<string, string>)[field];
    if (kinds && tk.has(kinds)) return tk(kinds);
    if (te.has(`choice.${field}.${value}`)) return te(`choice.${field}.${value}`);
    return null;
  };
}

/** How a change's two sides are worded, on the confirmation and in the batch's log. */
export function useEditValueFormat(batch: Pick<PrepaidVoucherBatch, 'shops'> | null): EditValueFormat {
  const t = useTranslations('prepaidVouchers.edit');
  const choice = useChoiceLabel();
  const shopNames = new Map((batch?.shops ?? []).map((s) => [s.id, s.name ?? s.id]));
  return {
    money: (v) => moneyText(Math.round(v * 100)),
    date: (iso) => formatDate(iso),
    yes: t('value.yes'),
    no: t('value.no'),
    none: (field) => (t.has(`value.none.${field}`) ? t(`value.none.${field}`) : t('value.empty')),
    choice,
    shopName: (id) => shopNames.get(id) ?? t('value.otherShop'),
  };
}

/** A field's name as the owner reads it ("בתוקף עד"). */
export function useEditFieldLabel() {
  const t = useTranslations('prepaidVouchers.edit');
  return (field: string) => (t.has(`field.${field}`) ? t(`field.${field}`) : field);
}

/** One category's effect, in words ("ישפיע על 340 שוברים שטרם מומשו"). */
function useEffectLines() {
  const t = useTranslations('prepaidVouchers.edit.effect');
  return (category: PrepaidEditCategory, plan: PrepaidBatchEditPlan): string[] => {
    const e = plan.effects;
    switch (category) {
      case 'free':
        return [t('free')];
      case 'validity':
        return [t('open', { n: e.validity?.vouchers ?? 0 })];
      case 'where':
        return [t('open', { n: e.where?.vouchers ?? 0 }), ...(e.where?.offlineAssigned ? [t('offlineAssigned')] : [])];
      case 'rules':
      case 'accounting':
        return [t('open', { n: e[category]?.vouchers ?? 0 }), t('fromNow')];
      case 'contents': {
        const c = e.contents;
        if (!c) return [];
        const lines = [t('contents', { n: c.unredeemed })];
        if (c.partial > 0) lines.push(c.applyToPartial ? t('contentsPartial', { n: c.partial }) : t('contentsPartialKept', { n: c.partial }));
        return lines;
      }
      case 'quantity':
        return e.quantity ? [t('issue', { n: e.quantity.issue, issued: e.quantity.issued })] : [];
      case 'price':
        return e.price ? [t('price', { from: e.price.fromSerial, issued: e.price.issued })] : [];
      default:
        return [];
    }
  };
}

export function BatchEditConfirm({
  batch, plan, open, busy, onConfirm, onCancel,
}: {
  batch: PrepaidVoucherBatch;
  plan: PrepaidBatchEditPlan | null;
  open: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('prepaidVouchers.edit');
  const effects = useEffectLines();
  const fmt = useEditValueFormat(batch);
  const label = useEditFieldLabel();
  const groups = plan ? changesByCategory(plan) : [];
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onCancel(); }}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('confirmTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('confirmIntro')}</p>
        <div className="space-y-3">
          {groups.map((g) => (
            <section key={g.category} className="space-y-1.5 rounded-lg border p-3">
              <h3 className="text-sm font-semibold">{t(`category.${g.category}`)}</h3>
              <ul className="space-y-1 text-sm">
                {g.changes.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-muted-foreground">{label(c.field)}:</span>
                    <span className="break-words line-through decoration-muted-foreground/60">{editValueText(c.field, c.before, fmt)}</span>
                    <ArrowLeft className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground ltr:rotate-180" aria-label={t('to')} />
                    <span className="break-words font-medium">{editValueText(c.field, c.after, fmt)}</span>
                  </li>
                ))}
              </ul>
              {effects(g.category, plan as PrepaidBatchEditPlan).map((line) => (
                <p key={line} className="text-xs text-amber-700 dark:text-amber-400">{line}</p>
              ))}
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>{t('back')}</Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Save an edit of [batch]: planned by the cloud first; saved at once when only free things change,
 * else after the owner confirms the list. `dialog` goes into the page; `save` resolves true once saved.
 */
export function useBatchEditSave(batch: PrepaidVoucherBatch | null, onSaved?: (b: PrepaidVoucherBatch) => void) {
  const t = useTranslations('prepaidVouchers.edit');
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [pending, setPending] = useState<{ body: PrepaidBatchEditBody; plan: PrepaidBatchEditPlan; resolve: (ok: boolean) => void } | null>(null);
  const errorText = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && detail.startsWith('prepaid_voucher_') && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
  const write = useMutation({
    mutationFn: (body: PrepaidBatchEditBody) => updatePrepaidBatch((batch as PrepaidVoucherBatch).id, body),
    onSuccess: (b) => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', b.id] });
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', b.id] });
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-groups', b.id] });
      onSaved?.(b);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const plan = useMutation({ mutationFn: (body: PrepaidBatchEditBody) => previewPrepaidBatchEdit((batch as PrepaidVoucherBatch).id, body) });

  const save = async (body: PrepaidBatchEditBody): Promise<boolean> => {
    if (!batch) return false;
    if (Object.keys(body).filter((k) => k !== 'applyToPartial').length === 0) {
      toast.info(t('noChanges'));
      return false;
    }
    let p: PrepaidBatchEditPlan;
    try {
      p = await plan.mutateAsync(body);
    } catch (err) {
      toast.error(errorText(err));
      return false;
    }
    if (p.changes.length === 0) {
      toast.info(t('noChanges'));
      return false;
    }
    if (!p.confirm) {
      try {
        await write.mutateAsync(body);
        return true;
      } catch {
        return false;
      }
    }
    return new Promise<boolean>((resolve) => setPending({ body, plan: p, resolve }));
  };

  const dialog = batch && (
    <BatchEditConfirm
      batch={batch}
      plan={pending?.plan ?? null}
      open={pending !== null}
      busy={write.isPending}
      onCancel={() => {
        pending?.resolve(false);
        setPending(null);
      }}
      onConfirm={() => {
        if (!pending) return;
        write.mutate(pending.body, {
          onSuccess: () => {
            pending.resolve(true);
            setPending(null);
          },
        });
      }}
    />
  );
  return { save, dialog, busy: plan.isPending || write.isPending };
}
