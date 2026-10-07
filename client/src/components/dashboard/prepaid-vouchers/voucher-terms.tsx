'use client';

/**
 * A prepaid voucher batch's kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7): goods
 * (`items`, a tender), a discount on the whole sale or on chosen items (a discount on the
 * document, never a tender) — and the rules of use every kind has: other vouchers in the
 * same sale, promotions, uses per voucher / sale / day.
 *
 * What is printed (the benefit) and the uses per voucher are fixed when the batch is made;
 * the rules of use may change later ([BatchRulesCard]) and apply from the next sale.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  PREPAID_KINDS,
  PREPAID_PROMOTION_POLICIES,
  PREPAID_STACKING,
  benefitText,
  isDiscountKind,
  termsOfBatch,
  type DiscountDraftError,
  type PrepaidDiscountType,
  type PrepaidPromotionPolicy,
  type PrepaidStacking,
  type PrepaidVoucherKind,
} from '@/lib/prepaidVoucherBenefit';
import { updatePrepaidBatch, type PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { ProductListPicker, useCategoryOptions } from '@/components/dashboard/promotions/group-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** "פריטים" / "הנחה על כל העסקה" / "הנחה על פריט", with what it means under it. */
export function KindPicker({ value, onChange }: { value: PrepaidVoucherKind; onChange: (k: PrepaidVoucherKind) => void }) {
  const t = useTranslations('prepaidVouchers.kinds');
  return (
    <div className="space-y-1">
      <Label>{t('label')}</Label>
      <Select value={value} onValueChange={(v) => v && onChange(v as PrepaidVoucherKind)}
        items={PREPAID_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))}>
        <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {PREPAID_KINDS.map((k) => (
            <SelectItem key={k} value={k} label={t(`kind.${k}`)}>{t(`kind.${k}`)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t(`kindHint.${value}`)}</p>
    </div>
  );
}

export interface DiscountTermsState {
  discountType: PrepaidDiscountType;
  value: string;
  minPurchase: string;
  maxDiscount: string;
  productIds: string[];
  categoryIds: string[];
  maxUnits: string;
}

export const EMPTY_DISCOUNT_TERMS: DiscountTermsState = {
  discountType: 'fixed', value: '', minPurchase: '', maxDiscount: '', productIds: [], categoryIds: [], maxUnits: '1',
};

/** What a discount voucher gives: ₪ or %, how much, a minimum and cap (whole sale), or what it is on (items). */
export function DiscountTermsFields({
  kind,
  value,
  onChange,
  errors,
}: {
  kind: PrepaidVoucherKind;
  value: DiscountTermsState;
  onChange: (next: DiscountTermsState) => void;
  errors: DiscountDraftError[];
}) {
  const t = useTranslations('prepaidVouchers.kinds');
  const categoryOptions = useCategoryOptions();
  const set = (patch: Partial<DiscountTermsState>) => onChange({ ...value, ...patch });
  const types: PrepaidDiscountType[] = ['fixed', 'percent'];
  const names = [
    ...categoryOptions.filter((c) => value.categoryIds.includes(c.id)).map((c) => c.label),
  ];
  const preview = benefitText({
    kind,
    discountType: value.discountType,
    value: Number(value.value) > 0 ? Math.round(Number(value.value) * 100) : null,
    minPurchaseAgorot: Number(value.minPurchase) > 0 ? Math.round(Number(value.minPurchase) * 100) : null,
    maxDiscountAgorot: Number(value.maxDiscount) > 0 ? Math.round(Number(value.maxDiscount) * 100) : null,
    maxUnits: Number(value.maxUnits) || null,
    names: value.productIds.length ? [`${value.productIds.length} ${t('products')}`, ...names] : names,
  });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t('discountType')}</Label>
          <Select value={value.discountType} onValueChange={(v) => v && set({ discountType: v as PrepaidDiscountType })}
            items={types.map((d) => ({ value: d, label: t(d) }))}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {types.map((d) => <SelectItem key={d} value={d} label={t(d)}>{t(d)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pv-discount-value">{value.discountType === 'fixed' ? t('valueFixed') : t('valuePercent')}</Label>
          <Input id="pv-discount-value" inputMode="decimal" className="h-9" value={value.value}
            onChange={(e) => set({ value: e.target.value })} />
        </div>
      </div>
      {kind === 'order_discount' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pv-min">{t('minPurchase')}</Label>
            <Input id="pv-min" inputMode="decimal" className="h-9" value={value.minPurchase}
              onChange={(e) => set({ minPurchase: e.target.value })} />
            <p className="text-xs text-muted-foreground">{t('minPurchaseHint')}</p>
          </div>
          {value.discountType === 'percent' ? (
            <div className="space-y-1">
              <Label htmlFor="pv-cap">{t('maxDiscount')}</Label>
              <Input id="pv-cap" inputMode="decimal" className="h-9" value={value.maxDiscount}
                onChange={(e) => set({ maxDiscount: e.target.value })} />
            </div>
          ) : null}
        </div>
      ) : null}
      {kind === 'item_discount' ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('targets')}</p>
          <ProductListPicker label={t('products')} value={value.productIds} onChange={(productIds) => set({ productIds })} />
          <div className="space-y-1">
            <Label>{t('categories')}</Label>
            <EntityMultiSelect
              label={t('categories')}
              options={categoryOptions}
              selected={value.categoryIds}
              onChange={(categoryIds) => set({ categoryIds })}
              allLabel={t('categories')}
              clearLabel={t('categories')}
              emptyLabel={t('targetsEmpty')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pv-units">{t('maxUnits')}</Label>
            <Input id="pv-units" type="number" min={1} max={100} className="h-9 w-28" value={value.maxUnits}
              onChange={(e) => set({ maxUnits: e.target.value })} />
          </div>
        </div>
      ) : null}
      {preview ? <p className="text-sm font-semibold" aria-live="polite">{preview}</p> : null}
      {errors.length ? (
        <ul className="space-y-0.5 text-xs text-destructive">
          {errors.map((e) => <li key={e}>{t(`formError.${e}`)}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

export interface RulesState {
  stacking: PrepaidStacking;
  promotionPolicy: PrepaidPromotionPolicy;
  usesPerVoucher: string;
  maxUsesPerSale: string;
  maxUsesPerDay: string;
}

export const DEFAULT_RULES: RulesState = {
  stacking: 'single', promotionPolicy: 'exclude', usesPerVoucher: '1', maxUsesPerSale: '1', maxUsesPerDay: '',
};

/** Other vouchers in the sale, promotions, uses. [usesFixed]: after printing, uses per voucher do not change. */
export function RulesFields({
  kind,
  value,
  onChange,
  usesFixed = false,
}: {
  kind: PrepaidVoucherKind;
  value: RulesState;
  onChange: (next: RulesState) => void;
  usesFixed?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.kinds');
  const set = (patch: Partial<RulesState>) => onChange({ ...value, ...patch });
  const discount = isDiscountKind(kind);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t('stackingLabel')}</Label>
          <Select value={value.stacking} onValueChange={(v) => v && set({ stacking: v as PrepaidStacking })}
            items={PREPAID_STACKING.map((s) => ({ value: s, label: t(`stacking.${s}`) }))}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PREPAID_STACKING.map((s) => (
                <SelectItem key={s} value={s} label={t(`stacking.${s}`)}>{t(`stacking.${s}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {discount ? <p className="text-xs text-muted-foreground">{t('stackingHint')}</p> : null}
        </div>
        {discount ? (
          <div className="space-y-1">
            <Label>{t('promotionLabel')}</Label>
            <Select value={value.promotionPolicy} onValueChange={(v) => v && set({ promotionPolicy: v as PrepaidPromotionPolicy })}
              items={PREPAID_PROMOTION_POLICIES.map((p) => ({ value: p, label: t(`promotionPolicy.${p}`) }))}>
              <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PREPAID_PROMOTION_POLICIES.map((p) => (
                  <SelectItem key={p} value={p} label={t(`promotionPolicy.${p}`)}>{t(`promotionPolicy.${p}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`promotionHint.${value.promotionPolicy}`)}</p>
          </div>
        ) : null}
      </div>
      {discount ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pv-uses">{t('usesPerVoucher')}</Label>
            <Input id="pv-uses" type="number" min={1} max={1000} className="h-9" value={value.usesPerVoucher} disabled={usesFixed}
              onChange={(e) => set({ usesPerVoucher: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pv-per-sale">{t('maxUsesPerSale')}</Label>
            <Input id="pv-per-sale" type="number" min={1} max={1000} className="h-9" value={value.maxUsesPerSale}
              onChange={(e) => set({ maxUsesPerSale: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pv-per-day">{t('maxUsesPerDay')}</Label>
            <Input id="pv-per-day" type="number" min={1} max={1000} className="h-9" value={value.maxUsesPerDay}
              onChange={(e) => set({ maxUsesPerDay: e.target.value })} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The kind's badge and what the voucher gives — for the batch list and the batch's header. */
export function useBatchTermsText() {
  const t = useTranslations('prepaidVouchers.kinds');
  return (b: PrepaidVoucherBatch): { kind: string; benefit: string | null; uses: string | null } => {
    const kind = b.kind ?? 'items';
    const benefit = b.benefitText ?? benefitText(termsOfBatch(b));
    if (!isDiscountKind(kind)) return { kind: t(`kind.${kind}`), benefit: null, uses: null };
    const per = b.usesPerVoucher ?? 1;
    const parts = [per === 1 ? t('usesOne') : t('usesMany', { n: per })];
    if ((b.maxUsesPerSale ?? 1) > 1) parts.push(t('perSale', { n: b.maxUsesPerSale ?? 1 }));
    if (b.maxUsesPerDay) parts.push(t('perDay', { n: b.maxUsesPerDay }));
    return { kind: t(`kind.${kind}`), benefit, uses: parts.join(' · ') };
  };
}

/** The rules of use on the batch's page: they change from the next sale; the paper does not. */
export function BatchRulesCard({ batch, onSaved }: { batch: PrepaidVoucherBatch; onSaved: () => void }) {
  const t = useTranslations('prepaidVouchers.kinds');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const kind = batch.kind ?? 'items';
  const [rules, setRules] = useState<RulesState>({
    stacking: batch.stacking ?? 'single',
    promotionPolicy: batch.promotionPolicy ?? 'exclude',
    usesPerVoucher: String(batch.usesPerVoucher ?? 1),
    maxUsesPerSale: String(batch.maxUsesPerSale ?? 1),
    maxUsesPerDay: batch.maxUsesPerDay ? String(batch.maxUsesPerDay) : '',
  });
  const perSale = parseInt(rules.maxUsesPerSale, 10);
  const perDay = rules.maxUsesPerDay.trim() ? parseInt(rules.maxUsesPerDay, 10) : null;
  const valid = Number.isFinite(perSale) && perSale >= 1 && (perDay === null || (Number.isFinite(perDay) && perDay >= 1));
  const save = useMutation({
    mutationFn: () =>
      updatePrepaidBatch(batch.id, isDiscountKind(kind)
        ? { stacking: rules.stacking, promotionPolicy: rules.promotionPolicy, maxUsesPerSale: perSale, maxUsesPerDay: perDay }
        : { stacking: rules.stacking }),
    onSuccess: () => {
      toast.success(t('rulesSaved'));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      onSaved();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rulesTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('rulesHint')}</p>
        <RulesFields kind={kind} value={rules} onChange={setRules} usesFixed />
        <Button size="sm" onClick={() => save.mutate()} disabled={!valid || save.isPending || batch.status === 'cancelled'}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t('save')}
        </Button>
      </CardContent>
    </Card>
  );
}
