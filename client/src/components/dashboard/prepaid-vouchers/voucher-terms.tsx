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

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Search, X } from 'lucide-react';
import { PrepaidProductPickList } from '@/components/dashboard/prepaid-vouchers/product-pick-list';
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
import {
  fetchPrepaidCategories,
  searchPrepaidProducts,
  updatePrepaidBatch,
  type PrepaidProductOption,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { EntityMultiSelect, type MultiSelectOption } from '@/components/dashboard/entity-multi-select';
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
  /** Chosen with their names (the chips), from the batch company's own list. */
  products: PrepaidProductOption[];
  categoryIds: string[];
  maxUnits: string;
}

export const EMPTY_DISCOUNT_TERMS: DiscountTermsState = {
  discountType: 'fixed', value: '', minPurchase: '', maxDiscount: '', products: [], categoryIds: [], maxUnits: '1',
};

/**
 * The categories an item discount of [companyId] may name (`GET /prepaid-vouchers/categories`,
 * the save's own rule), each named with its parent path ("שתייה › חמה").
 */
function usePrepaidCategoryOptions(companyId: string): MultiSelectOption[] {
  const { data = [] } = useQuery({
    queryKey: ['prepaid-voucher-categories', companyId],
    queryFn: () => fetchPrepaidCategories(companyId),
    enabled: !!companyId,
  });
  return useMemo(() => {
    const byId = new Map(data.map((c) => [c.id, c]));
    const path = (id: string): string => {
      const names: string[] = [];
      let c = byId.get(id);
      let guard = 0;
      while (c && guard++ < 10) {
        names.unshift(c.name);
        c = c.parentId ? byId.get(c.parentId) : undefined;
      }
      return names.join(' › ');
    };
    return data.map((c) => ({ id: c.id, label: path(c.id) })).sort((a, b) => a.label.localeCompare(b.label, 'he'));
  }, [data]);
}

/**
 * The products an item discount is on: chips of what is chosen, and a search over every product a
 * batch of [companyId] may be looking for (`GET /prepaid-vouchers/products?purpose=item_discount`,
 * the save's rule): one an item discount cannot take is shown greyed with why ("לא מקבל הנחות"),
 * so nothing offered is refused on save and nothing is silently missing (§7.14).
 */
function TargetProductsPicker({ companyId, shopIds, value, onChange }: {
  companyId: string;
  shopIds?: string[];
  value: PrepaidProductOption[];
  onChange: (next: PrepaidProductOption[]) => void;
}) {
  const t = useTranslations('prepaidVouchers.kinds');
  const tc = useTranslations('prepaidVouchers.create');
  const te = useTranslations('prepaidVouchers.eligibility');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', companyId, debounced, 'item_discount', shopIds ?? []],
    queryFn: () => searchPrepaidProducts(debounced, companyId, { purpose: 'item_discount', shopIds }),
    enabled: !!companyId,
  });
  const chosen = new Set(value.map((p) => p.id));
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{t('products')}</span>
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <span key={p.id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-2.5 pe-1 text-xs">
              <span className="truncate">{p.name}</span>
              <button type="button" onClick={() => onChange(value.filter((x) => x.id !== p.id))}
                aria-label={tc('remove')} className="rounded-full p-0.5 hover:bg-muted">
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tc('searchProducts')} className="ps-8"
          disabled={!companyId} />
      </div>
      <div className="max-h-44 overflow-y-auto rounded-lg border">
        <PrepaidProductPickList
          products={products.data}
          purpose="item_discount"
          chosen={chosen}
          onPick={(p) => onChange([...value, p])}
          pending={!!companyId && products.isPending}
          pendingText="…"
          emptyText={companyId ? tc('noProducts') : tc('pickCompany')}
        />
      </div>
      <p className="text-xs text-muted-foreground">{te('searchHint')}</p>
    </div>
  );
}

/** What a discount voucher gives: ₪ or %, how much, a minimum and cap (whole sale), or what it is on (items). */
export function DiscountTermsFields({
  kind,
  companyId,
  shopIds,
  value,
  onChange,
  errors,
}: {
  kind: PrepaidVoucherKind;
  /** The batch's company: what its products and categories may be (the save's rule). */
  companyId: string;
  /** The batch's shops so far: a till's own product goes on a voucher of its shop only. */
  shopIds?: string[];
  value: DiscountTermsState;
  onChange: (next: DiscountTermsState) => void;
  errors: DiscountDraftError[];
}) {
  const t = useTranslations('prepaidVouchers.kinds');
  const categoryOptions = usePrepaidCategoryOptions(companyId);
  const set = (patch: Partial<DiscountTermsState>) => onChange({ ...value, ...patch });
  const types: PrepaidDiscountType[] = ['fixed', 'percent'];
  // As the server prints them: the products' names, then the categories'.
  const names = [
    ...value.products.map((p) => p.name),
    ...categoryOptions.filter((c) => value.categoryIds.includes(c.id)).map((c) => c.label.split(' › ').pop() ?? c.label),
  ];
  const preview = benefitText({
    kind,
    discountType: value.discountType,
    value: Number(value.value) > 0 ? Math.round(Number(value.value) * 100) : null,
    minPurchaseAgorot: Number(value.minPurchase) > 0 ? Math.round(Number(value.minPurchase) * 100) : null,
    maxDiscountAgorot: Number(value.maxDiscount) > 0 ? Math.round(Number(value.maxDiscount) * 100) : null,
    maxUnits: Number(value.maxUnits) || null,
    names,
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
          <TargetProductsPicker companyId={companyId} shopIds={shopIds} value={value.products} onChange={(products) => set({ products })} />
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
              disabled={!companyId}
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
