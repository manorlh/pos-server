'use client';

/**
 * An upsell rule ("הגדלת מכירה"): when the till adds one of the trigger products (or a
 * product of the trigger categories), it shows a small card that does not stop the
 * cashier — "add fries?" (`add`) or "make it a meal?" (`upgrade`, the line becomes the
 * suggested product). Server: `/menu/upsells`, docs/SPEC_MENU_MODIFIERS.md §6.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import {
  createUpsell,
  updateUpsell,
  type UpsellAction,
  type UpsellInput,
  type UpsellRule,
} from '@/lib/menuApi';
import { ProductListPicker, useCategoryOptions } from '@/components/dashboard/promotions/group-picker';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { IosCard, IosChip, IosFootnote, IosRow, IosSectionHeader, IosSegmented, IosSwitch } from './ios';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

interface Draft {
  name: string;
  companyId: string;
  triggerType: 'product' | 'category';
  triggerIds: string[];
  action: UpsellAction;
  productId: string | null;
  message: string;
  showPrice: boolean;
  timed: boolean;
  startTime: string;
  endTime: string;
  weekdays: number[];
  priority: string;
  isActive: boolean;
}

function draftOf(r: UpsellRule | null, company: string): Draft {
  return {
    name: r?.name ?? '',
    companyId: r ? (r.companyId ?? '') : company,
    triggerType: r?.triggerType ?? 'product',
    triggerIds: r?.triggerIds ?? [],
    action: r?.action ?? 'add',
    productId: r?.productId ?? null,
    message: r?.message ?? '',
    showPrice: r?.showPrice ?? true,
    timed: !!(r?.startTime && r?.endTime),
    startTime: r?.startTime ?? '11:00',
    endTime: r?.endTime ?? '17:00',
    weekdays: r?.weekdays ?? [],
    priority: String(r?.priority ?? 0),
    isActive: r?.isActive ?? true,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function UpsellEditorDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule: UpsellRule | null;
}) {
  const t = useTranslations('upsells.editor');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto bg-[#F2F2F7] dark:bg-black">
        <DialogHeader>
          <DialogTitle>{rule ? t('titleEdit') : t('titleNew')}</DialogTitle>
        </DialogHeader>
        {open ? <UpsellEditor key={rule?.id ?? 'new'} rule={rule} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function UpsellEditor({ rule, onDone }: { rule: UpsellRule | null; onDone: () => void }) {
  const t = useTranslations('upsells.editor');
  const tw = useTranslations('promotions.weekdays');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { user } = useAuth();
  const scope = useScope();
  const admin = user?.role === 'super_admin' || user?.role === 'distributor';
  const [d, setD] = useState<Draft>(() =>
    draftOf(rule, admin ? '' : (scope.companyId ?? user?.companyId ?? scope.companies[0]?.id ?? '')),
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const categoryOptions = useCategoryOptions();

  const problem = !d.name.trim()
    ? t('problemName')
    : d.triggerIds.length === 0
      ? t('problemTrigger')
      : !d.productId
        ? t('problemProduct')
        : d.timed && (!HHMM.test(d.startTime) || !HHMM.test(d.endTime))
          ? t('problemHours')
          : d.triggerType === 'product' && d.action === 'add' && d.triggerIds.includes(d.productId)
            ? t('problemSelf')
            : null;

  const body = (): UpsellInput => ({
    name: d.name.trim(),
    companyId: d.companyId || null,
    triggerType: d.triggerType,
    triggerIds: d.triggerIds,
    action: d.action,
    productId: d.productId!,
    message: d.message.trim() || null,
    showPrice: d.showPrice,
    startTime: d.timed ? d.startTime : null,
    endTime: d.timed ? d.endTime : null,
    weekdays: d.weekdays.length ? d.weekdays : null,
    priority: Math.min(100, Math.max(0, Number.parseInt(d.priority || '0', 10) || 0)),
    isActive: d.isActive,
  });

  const save = useMutation({
    mutationFn: () => (rule ? updateUpsell(rule.id, body()) : createUpsell(body())),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['menu-upsells'] });
      onDone();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const companyOptions = [
    ...(admin ? [{ value: '', label: t('wholeOrg') }] : []),
    ...scope.companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div className="space-y-1">
      <IosCard>
        <IosRow>
          <span className="w-24 shrink-0 text-[15px]">{t('name')}</span>
          <Input
            value={d.name}
            onChange={(e) => set('name', e.target.value.slice(0, 120))}
            placeholder={t('namePlaceholder')}
            className="border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
          />
        </IosRow>
        {companyOptions.length > 1 ? (
          <IosRow>
            <span className="w-24 shrink-0 text-[15px]">{t('company')}</span>
            <select
              value={d.companyId}
              onChange={(e) => set('companyId', e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[#007AFF] outline-none"
            >
              {companyOptions.map((o) => (
                <option key={o.value || 'org'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </IosRow>
        ) : null}
      </IosCard>

      <IosSectionHeader>{t('when')}</IosSectionHeader>
      <IosCard className="space-y-3 p-4">
        <IosSegmented
          value={d.triggerType}
          onChange={(v) => setD((x) => ({ ...x, triggerType: v, triggerIds: [] }))}
          options={[
            { id: 'product', label: t('triggerProducts') },
            { id: 'category', label: t('triggerCategories') },
          ]}
        />
        {d.triggerType === 'product' ? (
          <ProductListPicker label={t('triggerProductsLabel')} value={d.triggerIds} onChange={(v) => set('triggerIds', v)} />
        ) : (
          <EntityMultiSelect
            label={t('triggerCategoriesLabel')}
            options={categoryOptions}
            selected={d.triggerIds}
            onChange={(v) => set('triggerIds', v)}
            allLabel={t('noCategories')}
            clearLabel={t('clear')}
            emptyLabel={t('noCategoriesFound')}
          />
        )}
      </IosCard>

      <IosSectionHeader>{t('suggest')}</IosSectionHeader>
      <IosCard className="space-y-3 p-4">
        <IosSegmented
          value={d.action}
          onChange={(v) => set('action', v)}
          options={[
            { id: 'add', label: t('actionAdd') },
            { id: 'upgrade', label: t('actionUpgrade') },
          ]}
        />
        <p className="text-[12px] text-[#6D6D72]">{d.action === 'add' ? t('actionAddHint') : t('actionUpgradeHint')}</p>
        <ProductListPicker
          label={t('product')}
          value={d.productId ? [d.productId] : []}
          onChange={(ids) => set('productId', ids.length ? ids[ids.length - 1] : null)}
        />
        <label className="block space-y-1 text-[13px]">
          <span className="text-[#6D6D72]">{t('message')}</span>
          <Input value={d.message} onChange={(e) => set('message', e.target.value.slice(0, 200))} placeholder={t('messagePlaceholder')} />
        </label>
        <div className="flex items-center justify-between">
          <span className="text-[15px]">{t('showPrice')}</span>
          <IosSwitch checked={d.showPrice} onChange={(v) => set('showPrice', v)} label={t('showPrice')} />
        </div>
      </IosCard>

      <IosSectionHeader>{t('schedule')}</IosSectionHeader>
      <IosCard>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('timed')}</span>
          <IosSwitch checked={d.timed} onChange={(v) => set('timed', v)} label={t('timed')} />
        </IosRow>
        {d.timed ? (
          <IosRow>
            <span className="flex-1 text-[15px]">{t('hours')}</span>
            <Input type="time" value={d.startTime} onChange={(e) => set('startTime', e.target.value)} className="h-8 w-28" aria-label={t('from')} />
            <span className="text-[#8E8E93]">–</span>
            <Input type="time" value={d.endTime} onChange={(e) => set('endTime', e.target.value)} className="h-8 w-28" aria-label={t('to')} />
          </IosRow>
        ) : null}
        <IosRow>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((day) => (
              <IosChip
                key={day}
                on={d.weekdays.includes(day)}
                onClick={() =>
                  set('weekdays', d.weekdays.includes(day) ? d.weekdays.filter((x) => x !== day) : [...d.weekdays, day].sort())
                }
              >
                {tw(String(day))}
              </IosChip>
            ))}
          </div>
        </IosRow>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('priority')}</span>
          <Input
            value={d.priority}
            inputMode="numeric"
            onChange={(e) => set('priority', e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            className="h-8 w-16 text-center"
          />
        </IosRow>
        <IosRow>
          <span className="flex-1 text-[15px]">{t('active')}</span>
          <IosSwitch checked={d.isActive} onChange={(v) => set('isActive', v)} label={t('active')} />
        </IosRow>
      </IosCard>
      <IosFootnote>{t('scheduleHint')}</IosFootnote>

      {problem ? <p className="px-4 pt-3 text-[13px] text-[#FF3B30]">{problem}</p> : null}
      <DialogFooter className="pt-4">
        <Button variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
        <Button disabled={!!problem || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </div>
  );
}
