'use client';

/**
 * An upsell rule ("הגדלת מכירה"): when the till adds one of the trigger products (or a
 * product of the trigger categories), it shows a small card that does not stop the
 * cashier — "add fries?" (`add`) or "make it a meal?" (`upgrade`, the line becomes the
 * suggested product). Server: `/menu/upsells`, docs/SPEC_MENU_MODIFIERS.md §6.
 *
 * "חלון בחירה": a rule may offer several products and/or categories (a category: its
 * products), ask its own question ("האם הצעת שתייה ללקוח?") in a centred window with the
 * options as tiles, only in quick orders or only at tables, and be asked of every order
 * ("בכל הזמנה" — when a table is sent to the kitchen or its bill asked for, and when a
 * quick order goes to payment). A rule with one product, the card and both places is
 * exactly the rule as it was.
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
  type UpsellDisplay,
  type UpsellInput,
  type UpsellRule,
  type UpsellTrigger,
  type UpsellWhere,
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
  triggerType: UpsellTrigger;
  triggerIds: string[];
  action: UpsellAction;
  /** What is offered: products first, then categories (a category: its products on the till). */
  optionProducts: string[];
  optionCategories: string[];
  prompt: string;
  display: UpsellDisplay;
  where: UpsellWhere;
  skipIfPresent: boolean;
  oncePerOrder: boolean;
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
  // A rule from an older server (or before options): its one product.
  const options = r?.options ?? (r?.productId ? [{ type: 'product' as const, id: r.productId }] : []);
  return {
    name: r?.name ?? '',
    companyId: r ? (r.companyId ?? '') : company,
    triggerType: r?.triggerType ?? 'product',
    triggerIds: r?.triggerIds ?? [],
    action: r?.action ?? 'add',
    optionProducts: options.filter((o) => o.type === 'product').map((o) => o.id),
    optionCategories: options.filter((o) => o.type === 'category').map((o) => o.id),
    prompt: r?.prompt ?? '',
    display: r?.display ?? 'card',
    where: r?.where ?? 'both',
    skipIfPresent: r?.skipIfPresent ?? true,
    // A new rule never asks an order twice; a rule from before keeps once per line.
    oncePerOrder: r ? (r.oncePerOrder ?? false) : true,
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
  const ts = useTranslations('specials.upsell');
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

  const everyOrder = d.triggerType === 'order';
  // "בכל הזמנה" is always asked in the window, and only adds.
  const action: UpsellAction = everyOrder ? 'add' : d.action;
  const display: UpsellDisplay = everyOrder ? 'popup' : d.display;
  const optionCount = d.optionProducts.length + d.optionCategories.length;

  const problem = !d.name.trim()
    ? t('problemName')
    : !everyOrder && d.triggerIds.length === 0
      ? t('problemTrigger')
      : optionCount === 0
        ? ts('problemOptions')
        : action === 'upgrade' && (d.optionProducts.length !== 1 || d.optionCategories.length > 0)
          ? ts('problemUpgrade')
          : d.timed && (!HHMM.test(d.startTime) || !HHMM.test(d.endTime))
            ? t('problemHours')
            : d.triggerType === 'product' && action === 'add' && d.optionProducts.some((p) => d.triggerIds.includes(p))
              ? t('problemSelf')
              : null;

  const body = (): UpsellInput => ({
    name: d.name.trim(),
    companyId: d.companyId || null,
    triggerType: d.triggerType,
    triggerIds: everyOrder ? [] : d.triggerIds,
    action,
    options: [
      ...d.optionProducts.map((id) => ({ type: 'product' as const, id })),
      ...(action === 'upgrade' ? [] : d.optionCategories.map((id) => ({ type: 'category' as const, id }))),
    ],
    prompt: d.prompt.trim() || null,
    display,
    where: d.where,
    skipIfPresent: d.skipIfPresent,
    oncePerOrder: d.oncePerOrder,
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
      {/* The owner's example: נקניקיה → "האם הצעת שתייה ללקוח?" → קולה / ספרייט / מים. */}
      {!rule ? (
        <IosCard className="flex items-center gap-3 p-3">
          <p className="min-w-0 flex-1 text-[13px] text-[#3C3C43] dark:text-white/70">{ts('example')}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setD((x) => ({
                ...x,
                name: x.name || ts('exampleName'),
                prompt: ts('examplePrompt'),
                display: 'popup',
                action: 'add',
                oncePerOrder: true,
                skipIfPresent: true,
              }))
            }
          >
            {ts('exampleUse')}
          </Button>
        </IosCard>
      ) : null}

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
            { id: 'order', label: ts('triggerOrder') },
          ]}
        />
        {d.triggerType === 'product' ? (
          <ProductListPicker label={t('triggerProductsLabel')} value={d.triggerIds} onChange={(v) => set('triggerIds', v)} />
        ) : d.triggerType === 'category' ? (
          <EntityMultiSelect
            label={t('triggerCategoriesLabel')}
            options={categoryOptions}
            selected={d.triggerIds}
            onChange={(v) => set('triggerIds', v)}
            allLabel={t('noCategories')}
            clearLabel={t('clear')}
            emptyLabel={t('noCategoriesFound')}
          />
        ) : (
          <p className="text-[13px] text-[#6D6D72]">{ts('triggerOrderHint')}</p>
        )}
        <div className="space-y-1.5">
          <span className="text-[13px] text-[#6D6D72]">{ts('where')}</span>
          <IosSegmented
            value={d.where}
            onChange={(v) => set('where', v)}
            options={[
              { id: 'quick', label: ts('whereQuick') },
              { id: 'tables', label: ts('whereTables') },
              { id: 'both', label: ts('whereBoth') },
            ]}
          />
        </div>
      </IosCard>

      <IosSectionHeader>{t('suggest')}</IosSectionHeader>
      <IosCard className="space-y-3 p-4">
        {everyOrder ? null : (
          <>
            <IosSegmented
              value={d.action}
              onChange={(v) => set('action', v)}
              options={[
                { id: 'add', label: t('actionAdd') },
                { id: 'upgrade', label: t('actionUpgrade') },
              ]}
            />
            <p className="text-[12px] text-[#6D6D72]">{d.action === 'add' ? t('actionAddHint') : t('actionUpgradeHint')}</p>
          </>
        )}
        <ProductListPicker
          label={action === 'upgrade' ? t('product') : `${ts('options')} · ${ts('optionProducts')}`}
          value={d.optionProducts}
          // An upgrade becomes one product: the last one picked.
          onChange={(ids) => set('optionProducts', action === 'upgrade' ? ids.slice(-1) : ids)}
        />
        {action === 'add' ? (
          <>
            <EntityMultiSelect
              label={ts('optionCategoriesLabel')}
              options={categoryOptions}
              selected={d.optionCategories}
              onChange={(v) => set('optionCategories', v)}
              allLabel={t('noCategories')}
              clearLabel={t('clear')}
              emptyLabel={t('noCategoriesFound')}
            />
            <p className="text-[12px] text-[#6D6D72]">{ts('optionsHint')}</p>
          </>
        ) : null}

        <div className="space-y-1.5">
          <span className="text-[13px] text-[#6D6D72]">{ts('display')}</span>
          {everyOrder ? (
            <p className="text-[13px] font-medium">{ts('displayPopup')}</p>
          ) : (
            <IosSegmented
              value={d.display}
              onChange={(v) => set('display', v)}
              options={[
                { id: 'card', label: ts('displayCard') },
                { id: 'popup', label: ts('displayPopup') },
              ]}
            />
          )}
          <p className="text-[12px] text-[#6D6D72]">{display === 'popup' ? ts('displayPopupHint') : ts('displayCardHint')}</p>
        </div>
        {display === 'popup' ? (
          <label className="block space-y-1 text-[13px]">
            <span className="text-[#6D6D72]">{ts('prompt')}</span>
            <Input value={d.prompt} onChange={(e) => set('prompt', e.target.value.slice(0, 200))} placeholder={ts('promptPlaceholder')} />
          </label>
        ) : (
          <label className="block space-y-1 text-[13px]">
            <span className="text-[#6D6D72]">{t('message')}</span>
            <Input value={d.message} onChange={(e) => set('message', e.target.value.slice(0, 200))} placeholder={t('messagePlaceholder')} />
          </label>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[15px]">{t('showPrice')}</span>
          <IosSwitch checked={d.showPrice} onChange={(v) => set('showPrice', v)} label={t('showPrice')} />
        </div>
        {action === 'add' ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px]">{ts('skipIfPresent')}</span>
            <IosSwitch checked={d.skipIfPresent} onChange={(v) => set('skipIfPresent', v)} label={ts('skipIfPresent')} />
          </div>
        ) : null}
        {everyOrder ? null : (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px]">{ts('oncePerOrder')}</span>
              <IosSwitch checked={d.oncePerOrder} onChange={(v) => set('oncePerOrder', v)} label={ts('oncePerOrder')} />
            </div>
            {!d.oncePerOrder ? <p className="text-[12px] text-[#6D6D72]">{ts('oncePerOrderHint')}</p> : null}
          </div>
        )}
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
      {display === 'popup' || everyOrder || d.where !== 'both' || optionCount > 1 ? (
        <IosFootnote>{ts('footnote')}</IosFootnote>
      ) : null}

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
