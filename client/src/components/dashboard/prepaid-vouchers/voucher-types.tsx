'use client';

/**
 * Voucher types ("סוגי שוברים", the production vouchers spec §2–3): the templates batches are
 * issued from — what each voucher gives, its value at the till and its price to the production,
 * how a redemption is priced (fixed value / cover up to an amount) and recorded at the till
 * (a payment by the "שובר הפקה" tender / a ₪0 sale). A change of terms is a new version; batches
 * already issued keep theirs. The production price is shown and set only with the
 * `prepaid_voucher_prices` section.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { fetchCompanies } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  createPrepaidType,
  fetchPrepaidTypes,
  updatePrepaidType,
  type PrepaidOverrideMode,
  type PrepaidOverridePolicy,
  type PrepaidPricing,
  type PrepaidRedemptionAccounting,
  type PrepaidTypeBody,
  type PrepaidVoucherBatch,
  PREPAID_REDEMPTION_ACCOUNTING,
  type PrepaidVoucherType,
} from '@/lib/prepaidVouchersApi';
import { benefitText, discountDraftErrors, isDiscountKind, maxVouchersPerSale, moneyText, termsOfBatch, type PrepaidVoucherKind } from '@/lib/prepaidVoucherBenefit';
import { itemText } from '@/lib/prepaidVoucherProducts';
import { changedFields } from '@/lib/prepaidBatchEdit';
import { voucherFieldsFor } from '@/lib/voucherFields';
import {
  draftGroupsOf,
  emptyGroup,
  groupProblems,
  groupsBody,
  isPerGroup,
  isPunchCard,
  presetValues,
  totalQtyBody,
  type DraftGroup,
  type VoucherPreset,
  type VoucherSelection,
} from '@/lib/voucherPresets';
import { voucherSummary, type SummaryInput } from '@/lib/voucherSummary';
import { type DraftItem } from '@/components/dashboard/prepaid-vouchers/goods-editor';
import { FormSection, GoodsContents, PresetPicker, SummaryCard, summaryGroupsOf } from '@/components/dashboard/prepaid-vouchers/setup-parts';
import {
  DiscountTermsFields,
  EMPTY_DISCOUNT_TERMS,
  KindPicker,
  RulesFields,
  stackingBody,
  stackingValid,
  usePrepaidCategoryOptions,
  type DiscountTermsState,
  type RulesState,
} from '@/components/dashboard/prepaid-vouchers/voucher-terms';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

function money(v: number | null | undefined): string | null {
  return v == null ? null : moneyText(Math.round(v * 100));
}

/** What "סיכום השובר" reads of a type or a batch (a batch has most of these optional). */
export type SummarySource = Pick<PrepaidVoucherType, 'items'> & Partial<Pick<PrepaidVoucherType,
  'kind' | 'benefitText' | 'discountType' | 'discountValue' | 'minPurchase' | 'maxDiscount' | 'maxUnits' | 'targets'
  | 'selection' | 'groups' | 'totalQty' | 'groupNames' | 'splitAllowed' | 'includeExtras' | 'pricing' | 'tillValue' | 'allowTopUp'
  | 'redemptionAccounting' | 'usesPerVoucher' | 'maxUsesPerSale' | 'maxUsesPerDay' | 'stacking' | 'maxVouchersPerSale' | 'offlineAllowed'>>;

/**
 * A type (or a batch) as "סיכום השובר" reads it (lib/voucherSummary.ts): the groups by the names the
 * cloud sent (`groupNames`), money in ₪. A batch adds its count, validity and shops.
 */
export function summaryInputOf(t: SummarySource): SummaryInput {
  const discount = isDiscountKind(t.kind);
  const name = (map: Record<string, string> | undefined, id: string) => map?.[id.toLowerCase()] ?? map?.[id] ?? null;
  const groups = (t.groups ?? []).map((g) => ({
    name: g.name, minQty: g.minQty, maxQty: g.maxQty, allowRepeat: g.allowRepeat, allItems: g.allItems,
    names: [...(g.categoryIds ?? []).map((id) => name(t.groupNames?.categories, id)), ...(g.productIds ?? []).map((id) => name(t.groupNames?.products, id))]
      .filter((x): x is string => !!x),
    excluded: [...(g.excludeCategoryIds ?? []).map((id) => name(t.groupNames?.categories, id)), ...(g.excludeProductIds ?? []).map((id) => name(t.groupNames?.products, id))]
      .filter((x): x is string => !!x),
    categories: (g.categoryIds ?? []).map((id) => name(t.groupNames?.categories, id)).filter((x): x is string => !!x),
    products: (g.productIds ?? []).map((id) => name(t.groupNames?.products, id)).filter((x): x is string => !!x),
  }));
  return {
    kind: t.kind ?? 'items', selection: t.selection ?? 'items',
    items: t.items.map((i) => ({ name: i.name, quantity: i.quantity, weighed: i.weighed, unitLabel: i.unitLabel })),
    groups, totalQty: t.totalQty ?? null, splitAllowed: !discount && !!t.splitAllowed, includeExtras: !discount && !!t.includeExtras,
    pricing: t.pricing ?? null, tillValue: t.tillValue ?? null, allowTopUp: t.allowTopUp ?? null, accounting: discount ? null : t.redemptionAccounting ?? null,
    benefit: discount ? t.benefitText ?? benefitText(termsOfBatch(t)) : null,
    usesPerVoucher: t.usesPerVoucher ?? 1, maxUsesPerSale: t.maxUsesPerSale ?? 1, maxUsesPerDay: t.maxUsesPerDay ?? null,
    stacking: t.stacking ?? null, maxVouchersPerSale: t.maxVouchersPerSale ?? null, offlineAllowed: !!t.offlineAllowed,
  };
}

/** "סיכום השובר" of an issued batch: its terms, how many vouchers, the validity and the shops. */
export function batchSummaryLines(b: PrepaidVoucherBatch): string[] {
  return voucherSummary({
    ...summaryInputOf(b),
    count: b.issuedCount ?? b.stats.total,
    validFrom: b.validFrom, validUntil: b.validUntil,
    shopNames: (b.shops ?? []).map((x) => x.name ?? '').filter(Boolean),
  });
}

/** "1× נקניקייה + 1× שתייה", a discount's benefit, or what the item groups give ("כרטיסייה: עד 50 פריטים מתוך 'אוכל'…"). */
export function typeContents(t: SummarySource): string {
  if (isDiscountKind(t.kind)) return t.benefitText ?? benefitText(termsOfBatch(t)) ?? '';
  if (t.selection === 'groups' && t.groups?.length) return voucherSummary(summaryInputOf(t))[0] ?? '';
  return t.items.map((i) => i.text ?? itemText(i)).join(' + ');
}

/** The type in a few lines — the batch form shows it instead of the terms when one is chosen. */
export function TypeSummary({ type }: { type: PrepaidVoucherType }) {
  const t = useTranslations('prepaidVouchers.types');
  const tk = useTranslations('prepaidVouchers.kinds');
  return (
    <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <p className="font-medium">
        {type.name}
        {type.code ? <span className="ms-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal">{type.code}</span> : null}
        <span className="ms-2 text-xs font-normal text-muted-foreground">{t('version', { n: type.version })}</span>
      </p>
      <p className="text-muted-foreground">{tk(`kind.${type.kind ?? 'items'}`)}</p>
      <SummaryCard lines={voucherSummary(summaryInputOf(type))} />
      <TypePrices type={type} />
    </div>
  );
}

function TypePrices({ type }: { type: PrepaidVoucherType }) {
  const t = useTranslations('prepaidVouchers.types');
  if (isDiscountKind(type.kind)) return null;
  const parts = [
    type.tillValue != null ? t('tillValueIs', { v: money(type.tillValue)! }) : t('tillValueGoods'),
    type.pricesVisible && type.productionPrice != null ? t('productionPriceIs', { v: money(type.productionPrice)! }) : null,
    t(`pricing.${type.pricing}`),
    type.pricing === 'cover' && type.tillValue != null ? (type.allowTopUp ? t('topUpOn') : t('topUpOff')) : null,
    t(`accounting.${type.redemptionAccounting}`),
    type.discountBlockPolicy?.mode && type.discountBlockPolicy.mode !== 'honour' ? t(`override.${type.discountBlockPolicy.mode}`) : null,
    type.offlineAllowed ? t('offlineOn') : null,
    type.splitAllowed ? t('splitOn') : t('splitOff'),
  ].filter(Boolean);
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}

// ── The types screen ──────────────────────────────────────────────────────────

export function PrepaidTypesView() {
  const t = useTranslations('prepaidVouchers.types');
  const tk = useTranslations('prepaidVouchers.kinds');
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [showOneOff, setShowOneOff] = useState(false);
  const [editing, setEditing] = useState<PrepaidVoucherType | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['prepaid-voucher-types', 'all', showInactive, showOneOff],
    queryFn: () => fetchPrepaidTypes({ includeInactive: showInactive, includeOneOff: showOneOff }),
  });
  const toggle = useMutation({
    mutationFn: (x: PrepaidVoucherType) => updatePrepaidType(x.id, { active: !x.active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['prepaid-voucher-types'] }); },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });
  const rows = list.data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> {t('new')}</Button>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('showInactive')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={showOneOff} onChange={(e) => setShowOneOff(e.target.checked)} />
          {t('showOneOff')}
        </label>
      </div>
      {list.isPending ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((x) => (
            <li key={x.id} className="flex flex-wrap items-start gap-3 rounded-xl border p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">
                  {x.name}
                  {x.code ? <span className="ms-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal">{x.code}</span> : null}
                  {x.origin !== 'manual' ? <span className="ms-2 text-xs font-normal text-muted-foreground">{t(`origin.${x.origin}`)}</span> : null}
                  {!x.active ? <span className="ms-2 text-xs font-normal text-amber-700 dark:text-amber-400">{t('inactive')}</span> : null}
                </p>
                <p className="text-sm text-muted-foreground">{tk(`kind.${x.kind ?? 'items'}`)} · {typeContents(x)}</p>
                <TypePrices type={x} />
                <p className="text-xs text-muted-foreground">
                  {t('version', { n: x.version })} · {t('batches', { n: x.batchCount })}{x.companyName ? ` · ${x.companyName}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={x.active} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(x)} aria-label={t('active')} />
                <Button size="sm" variant="outline" onClick={() => setEditing(x)}><Pencil className="h-3.5 w-3.5" /> {t('edit')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <TypeDialog
        open={editing !== null}
        initial={editing === 'new' ? null : editing}
        pricesEditable={!!list.data?.pricesEditable}
        pricesVisible={!!list.data?.pricesVisible}
        overrideEditable={!!list.data?.overrideEditable}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
      />
    </div>
  );
}

// ── The type form ─────────────────────────────────────────────────────────────

function text(v: number | null | undefined): string {
  return v == null ? '' : String(v);
}

function TypeDialog({
  open, initial, onOpenChange, pricesEditable, pricesVisible, overrideEditable,
}: {
  open: boolean;
  initial: PrepaidVoucherType | null;
  onOpenChange: (v: boolean) => void;
  pricesEditable: boolean;
  pricesVisible: boolean;
  overrideEditable: boolean;
}) {
  const t = useTranslations('prepaidVouchers.types');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? t('editTitle', { name: initial.name }) : t('newTitle')}</DialogTitle>
        </DialogHeader>
        {/* A fresh form per type (and per opening): its state starts from the type. */}
        {open ? (
          <TypeForm key={initial?.id ?? 'new'} initial={initial} onDone={() => onOpenChange(false)}
            pricesEditable={pricesEditable} pricesVisible={pricesVisible} overrideEditable={overrideEditable} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TypeForm({
  initial, onDone, pricesEditable, pricesVisible, overrideEditable,
}: {
  initial: PrepaidVoucherType | null;
  onDone: () => void;
  pricesEditable: boolean;
  pricesVisible: boolean;
  overrideEditable: boolean;
}) {
  const t = useTranslations('prepaidVouchers.types');
  const ts = useTranslations('prepaidVouchers.setup');
  const tk = useTranslations('prepaidVouchers.kinds');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [pickedCompany, setCompanyId] = useState(initial?.companyId ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [kind, setKind] = useState<PrepaidVoucherKind>(initial?.kind ?? 'items');
  // Editing keeps the type's goods unless they are changed (the picker needs full product rows).
  const [items, setItems] = useState<DraftItem[]>([]);
  // A fixed list or item groups (lib/voucherPresets.ts): the groups by name, as the cloud sent them.
  const [selection, setSelection] = useState<VoucherSelection>(initial?.selection === 'groups' ? 'groups' : 'items');
  const [groups, setGroups] = useState<DraftGroup[]>(() => draftGroupsOf(initial?.groups, initial?.groupNames));
  const [totalQty, setTotalQty] = useState(initial?.totalQty ? String(initial.totalQty) : '');
  // The quick start picked (new types), and the punch card's simple view.
  const [preset, setPreset] = useState<VoucherPreset | null>(null);
  const [punchView, setPunchView] = useState(() => isPunchCard(initial?.selection, initial?.groups ?? [], initial?.totalQty));
  // "פריט אחד מכל קבוצה": on for that quick start; for a saved type, read from its groups and total.
  const [perGroup, setPerGroup] = useState(() => initial?.selection === 'groups' && isPerGroup(initial?.groups ?? [], initial?.totalQty));
  const [terms, setTerms] = useState<DiscountTermsState>({
    ...EMPTY_DISCOUNT_TERMS,
    discountType: initial?.discountType ?? 'fixed',
    value: text(initial?.discountValue),
    minPurchase: text(initial?.minPurchase),
    maxDiscount: text(initial?.maxDiscount),
    maxUnits: initial?.maxUnits ? String(initial.maxUnits) : '1',
    categoryIds: initial?.targets?.categoryIds ?? [],
  });
  const [rules, setRules] = useState<RulesState>({
    stacking: initial?.stacking ?? 'unlimited',
    maxVouchersPerSale: initial?.maxVouchersPerSale ? String(initial.maxVouchersPerSale) : '',
    promotionPolicy: initial?.promotionPolicy ?? 'exclude',
    usesPerVoucher: String(initial?.usesPerVoucher ?? 1),
    maxUsesPerSale: String(initial?.maxUsesPerSale ?? 1),
    maxUsesPerDay: initial?.maxUsesPerDay ? String(initial.maxUsesPerDay) : '',
  });
  const [tillValue, setTillValue] = useState(text(initial?.tillValue));
  const [productionPrice, setProductionPrice] = useState(text(initial?.productionPrice));
  const [pricing, setPricing] = useState<PrepaidPricing>(initial?.pricing ?? 'fixed');
  const [allowTopUp, setAllowTopUp] = useState(initial?.allowTopUp ?? true);
  const [accounting, setAccounting] = useState<PrepaidRedemptionAccounting>(initial?.redemptionAccounting ?? 'discount');
  const [showValidity, setShowValidity] = useState(initial?.showValidity ?? true);
  const [offlineAllowed, setOfflineAllowed] = useState(initial?.offlineAllowed ?? false);
  const [policy, setPolicy] = useState<PolicyState>(policyState(initial?.discountBlockPolicy));
  const [splitAllowed, setSplitAllowed] = useState(initial?.splitAllowed ?? false);
  const [includeExtras, setIncludeExtras] = useState(initial?.includeExtras ?? false);
  const [printTillValue, setPrintTillValue] = useState(initial?.printTillValue ?? false);
  const [goodsTouched, setGoodsTouched] = useState(false);

  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: !initial });
  // One company: it is the one (nothing to pick).
  const companyId = pickedCompany || (companies.data?.length === 1 ? companies.data[0].id : '');
  const categoryOptions = usePrepaidCategoryOptions(companyId);

  const discount = isDiscountKind(kind);
  const grouped = !discount && selection === 'groups';
  // Only what this kind of voucher has (lib/voucherFields.ts): goods — contents, pricing, split, extras;
  // a discount — its terms and the three uses; both — stacking, offline and the print flags.
  const fields = voucherFieldsFor({
    kind, selection, pricing, stacking: rules.stacking, discountType: terms.discountType, usesPerVoucher: rules.usesPerVoucher,
  });
  const decimal = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);
  const termErrors = discountDraftErrors({
    kind, discountType: terms.discountType, value: terms.value, minPurchase: terms.minPurchase, maxDiscount: terms.maxDiscount,
    targetCount: terms.products.length + terms.categoryIds.length + (initial?.targets?.productIds.length ?? 0),
    maxUnits: terms.maxUnits, usesPerVoucher: rules.usesPerVoucher, maxUsesPerSale: rules.maxUsesPerSale, maxUsesPerDay: rules.maxUsesPerDay,
  });
  // Groups of a type opened to edit stay as they are unless changed; a new one is checked.
  const groupsEditing = !initial || goodsTouched || initial.selection !== 'groups';
  const groupErrors = grouped && groupsEditing ? groupProblems(groups, totalQty) : [];
  const goodsCount = goodsTouched || !initial ? items.length : initial.items.length;
  const problems = [
    !name.trim() ? t('problem.name') : null,
    !companyId ? t('problem.company') : null,
    !discount && !grouped && goodsCount === 0 ? t('problem.items') : null,
    groupErrors.length ? t('problem.groups') : null,
    discount && termErrors.length ? t('problem.terms') : null,
    !stackingValid(rules) ? t('problem.maxVouchers') : null,
    !discount && pricing === 'fixed' && decimal(tillValue) == null ? t('problem.value') : null,
  ].filter(Boolean) as string[];

  const body = (): PrepaidTypeBody => {
    const out: PrepaidTypeBody = {
      name: name.trim(), code: code.trim() || null, description: description.trim() || null,
      includeExtras: !discount && includeExtras, splitAllowed: !discount && splitAllowed,
      ...stackingBody(rules),
    };
    if (!initial) Object.assign(out, { companyId, kind });
    if (!discount) {
      Object.assign(out, {
        tillValue: decimal(tillValue), pricing, allowTopUp: pricing === 'cover' && allowTopUp,
        redemptionAccounting: accounting,
        showValidity, offlineAllowed,
        printTillValue: printTillValue && decimal(tillValue) != null,
      });
      if (pricesEditable) out.productionPrice = decimal(productionPrice);
      if (overrideEditable || policy.mode === 'honour') out.discountBlockPolicy = policyBody(policy);
      if (grouped && groupsEditing) {
        // Item groups (the API's own fields), sent when set or changed; a fixed list's items go with the change.
        Object.assign(out, { selection: 'groups', groups: groupsBody(groups), totalQty: totalQtyBody(totalQty) });
        if (initial && initial.selection !== 'groups') out.items = [];
      } else if (!grouped) {
        if (initial?.selection === 'groups' || !initial) out.selection = 'items';
        if (goodsTouched || !initial) out.items = items.map((i) => ({ productId: i.product.id, quantity: i.quantity }));
      }
    } else {
      Object.assign(out, {
        discountType: terms.discountType, discountValue: decimal(terms.value),
        minPurchase: fields.visible.has('minPurchase') ? decimal(terms.minPurchase) : null,
        maxDiscount: fields.visible.has('maxDiscount') ? decimal(terms.maxDiscount) : null,
        maxUnits: fields.visible.has('maxUnits') ? parseInt(terms.maxUnits, 10) || 1 : null,
        // Every kind has them (a discount too): offline and "הצג תוקף על השובר".
        offlineAllowed, showValidity,
        promotionPolicy: rules.promotionPolicy,
        usesPerVoucher: parseInt(rules.usesPerVoucher, 10) || 1,
        maxUsesPerSale: parseInt(rules.maxUsesPerSale, 10) || 1,
        maxUsesPerDay: rules.maxUsesPerDay.trim() ? parseInt(rules.maxUsesPerDay, 10) : null,
      });
      if (kind === 'item_discount' && (terms.products.length || terms.categoryIds.length || !initial)) {
        out.targets = { productIds: terms.products.map((p) => p.id), categoryIds: terms.categoryIds };
      }
    }
    return out;
  };

  // A quick start: the form filled with values the owner could set by hand (lib/voucherPresets.ts).
  const applyPreset = (p: VoucherPreset) => {
    const v = presetValues(p, 50, grouped ? groups[0] : undefined);
    setPreset(p);
    setKind(v.kind);
    if (v.kind === 'items') {
      setSelection(v.selection);
      setGroups(v.groups);
      setTotalQty(v.totalQty);
      setSplitAllowed(v.splitAllowed);
      setPunchView(p === 'punch');
      setPerGroup(p === 'perGroup');
      // A punch card covers each item at its menu price unless a value is set (section 5).
      if (p === 'punch' && !tillValue.trim()) setPricing('cover');
    } else if (v.discountType) {
      setTerms((cur) => ({ ...cur, discountType: v.discountType! }));
    }
  };
  const pickSelection = (v: VoucherSelection) => {
    setSelection(v);
    setGoodsTouched(true);
    if (v === 'groups' && !groups.length) setGroups([emptyGroup('פריטים')]);
  };

  // "סיכום השובר" (lib/voucherSummary.ts), from what the form says now.
  const goodsNames = goodsTouched || !initial
    ? items.map((i) => ({ name: i.product.name, quantity: i.quantity, weighed: i.product.isWeighed, unitLabel: i.product.unitLabel }))
    : (initial?.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, weighed: i.weighed, unitLabel: i.unitLabel }));
  const targetNames = [
    ...terms.products.map((p) => p.name),
    ...categoryOptions.filter((c) => terms.categoryIds.includes(c.id)).map((c) => c.label.split(' › ').pop() ?? c.label),
  ];
  const benefit = discount
    ? (initial && !terms.products.length && terms.categoryIds === (initial.targets?.categoryIds ?? []) && terms.value === text(initial.discountValue)
      ? initial.benefitText ?? null
      : benefitText({
        kind, discountType: terms.discountType,
        value: Number(terms.value) > 0 ? Math.round(Number(terms.value) * 100) : null,
        minPurchaseAgorot: Number(terms.minPurchase) > 0 ? Math.round(Number(terms.minPurchase) * 100) : null,
        maxDiscountAgorot: Number(terms.maxDiscount) > 0 ? Math.round(Number(terms.maxDiscount) * 100) : null,
        maxUnits: Number(terms.maxUnits) || null, names: targetNames,
      }))
    : null;
  const summary = voucherSummary({
    kind, selection, items: goodsNames, groups: summaryGroupsOf(groups), totalQty: totalQtyBody(totalQty),
    splitAllowed: !discount && splitAllowed, includeExtras: !discount && includeExtras,
    pricing, tillValue: decimal(tillValue), allowTopUp: pricing === 'cover' && allowTopUp, accounting: discount ? null : accounting,
    benefit, usesPerVoucher: parseInt(rules.usesPerVoucher, 10) || 1, maxUsesPerSale: parseInt(rules.maxUsesPerSale, 10) || 1,
    maxUsesPerDay: rules.maxUsesPerDay.trim() ? parseInt(rules.maxUsesPerDay, 10) : null,
    stacking: rules.stacking, maxVouchersPerSale: maxVouchersPerSale(rules.stacking, rules.maxVouchersPerSale) ?? null,
    offlineAllowed,
  });

  // Editing a type that batches were issued from: a change of what it gives, its prices or its terms
  // makes a new version — confirmed first, with what changes; the batches issued keep theirs.
  const te = useTranslations('prepaidVouchers.edit');
  // How the form opened, from the very same function (taken once).
  const [opened] = useState<PrepaidTypeBody | null>(() => (initial ? body() : null));
  const [versionAsk, setVersionAsk] = useState<string[] | null>(null);
  const submit = () => {
    if (initial && initial.batchCount > 0 && opened) {
      const changed = Object.keys(changedFields(opened as Record<string, unknown>, body() as Record<string, unknown>))
        .filter((k) => !['name', 'code', 'description'].includes(k));
      if (changed.length) {
        setVersionAsk(changed);
        return;
      }
    }
    save.mutate();
  };

  const save = useMutation({
    mutationFn: () => (initial ? updatePrepaidType(initial.id, body()) : createPrepaidType(body())),
    onSuccess: (x) => {
      toast.success(initial ? t('saved', { version: x.version }) : t('created'));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-types'] });
      onDone();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });

  const goodsUntouched = !!initial && !goodsTouched;
  // "מכסה: עד 50 פריטים לכל שובר" in "כמה ומתי" (set with the items, in step 2).
  const quotaN = grouped ? (totalQtyBody(totalQty) ?? summaryGroupsOf(groups).reduce((a, g) => a + g.maxQty, 0)) : 0;
  return (
    <>
        <div className="space-y-4">
          {initial && initial.batchCount > 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('versionNote', { n: initial.batchCount })}</p>
          ) : null}
          <FormSection title={ts('typeDetailsTitle')} purpose={ts('typeDetailsPurpose')}>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="pvt-name">{t('name')}</Label>
                <Input id="pvt-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pvt-code">{t('code')}</Label>
                <Input id="pvt-code" value={code} maxLength={32} dir="ltr" onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MEAL" />
                <p className="text-xs text-muted-foreground">{t('codeHint')}</p>
              </div>
            </div>
            {!initial ? (
              <div className="space-y-1">
                <Label>{t('company')}</Label>
                <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
                  value={companyId} onChange={(e) => { setCompanyId(e.target.value); setItems([]); setGroups((gs) => gs.map((g) => ({ ...g, products: [], categories: [], excludeProducts: [], excludeCategories: [] }))); }} aria-label={t('company')}>
                  <option value="">{t('pickCompany')}</option>
                  {(companies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="pvt-desc">{t('description')}</Label>
              <Input id="pvt-desc" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </FormSection>

          <FormSection n={1} title={ts('s1Title')} purpose={ts('s1Purpose')}>
            {!initial ? (
              <>
                <PresetPicker value={preset} onPick={applyPreset} />
                <KindPicker value={kind} onChange={(k) => { setKind(k); setPreset(null); }} />
              </>
            ) : (
              <p className="text-sm">
                <span className="font-medium">{ts('kindIs')}</span> {tk(`kind.${kind}`)}
                <span className="block text-xs text-muted-foreground">{ts('kindFixedType')}</span>
              </p>
            )}
          </FormSection>

          <FormSection n={2} title={ts('s2Title')} purpose={discount ? ts('s2PurposeDiscount') : ts('s2Purpose')}>
            {fields.visible.has('discountType') ? (
              <DiscountTermsFields kind={kind} companyId={companyId} shopIds={[]} value={terms} onChange={setTerms} errors={termErrors} />
            ) : goodsUntouched ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span>{typeContents(initial!)}</span>
                <Button size="sm" variant="outline" onClick={() => setGoodsTouched(true)}>{t('changeGoods')}</Button>
              </div>
            ) : (
              <GoodsContents companyId={companyId} selection={selection} onSelection={pickSelection}
                items={items} onItems={(v) => { setItems(v); setGoodsTouched(true); }}
                groups={groups} onGroups={(v) => { setGroups(v); setGoodsTouched(true); }}
                totalQty={totalQty} onTotalQty={(v) => { setTotalQty(v); setGoodsTouched(true); }}
                punch={punchView} onPunch={setPunchView} perGroup={perGroup} onPerGroup={setPerGroup} />
            )}
            {fields.visible.has('includeExtras') ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('includeExtras')}</p>
                  <p className="text-xs text-muted-foreground">{includeExtras ? t('includeExtrasOn') : t('includeExtrasOff')}</p>
                </div>
                <Switch checked={includeExtras} onCheckedChange={(v) => setIncludeExtras(!!v)} aria-label={t('includeExtras')} />
              </div>
            ) : null}
          </FormSection>

          <FormSection n={3} title={ts('s3Title')} purpose={discount ? ts('s3PurposeDiscount') : ts('s3PurposeType')}>
            {discount ? (
              <RulesFields kind={kind} value={rules} onChange={setRules} part="uses" />
            ) : (
              <>
                {grouped && quotaN ? <p className="text-sm">{ts('quotaIs', { n: quotaN })}</p> : null}
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{splitAllowed ? t('splitOn') : t('splitOff')}</p>
                    <p className="text-xs text-muted-foreground">{splitAllowed ? t('splitOnHint') : grouped ? t('splitOffHintGroups') : t('splitOffHint')}</p>
                  </div>
                  <Switch checked={splitAllowed} onCheckedChange={(v) => setSplitAllowed(!!v)} aria-label={t('splitOn')} />
                </div>
              </>
            )}
            <p className="text-xs text-muted-foreground">{ts('validityInBatch')}</p>
          </FormSection>

          <FormSection n={4} title={ts('s4Title')} purpose={ts('s4Purpose')}>
            <RulesFields kind={kind} value={rules} onChange={setRules} part="sale" />
          </FormSection>

          <FormSection n={5} title={ts('s5Title')} purpose={discount ? ts('s5PurposeDiscount') : ts('s5Purpose')}>
            {discount ? null : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="pvt-value">{t('tillValue')}</Label>
                    <Input id="pvt-value" inputMode="decimal" value={tillValue} onChange={(e) => setTillValue(e.target.value)} />
                    <p className="text-xs text-muted-foreground">{t('tillValueHint')}</p>
                  </div>
                  {pricesVisible ? (
                    <div className="space-y-1">
                      <Label htmlFor="pvt-price">{t('productionPrice')}</Label>
                      <Input id="pvt-price" inputMode="decimal" value={productionPrice} disabled={!pricesEditable}
                        onChange={(e) => setProductionPrice(e.target.value)} />
                      <p className="text-xs text-muted-foreground">{t('productionPriceHint')}</p>
                    </div>
                  ) : null}
                </div>
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">{t('pricingLabel')}</legend>
                  {(['fixed', 'cover'] as const).map((p) => (
                    <label key={p} className="flex items-start gap-2 text-sm">
                      <input type="radio" name="pvt-pricing" className="mt-1 accent-primary" checked={pricing === p} onChange={() => setPricing(p)} />
                      <span><span className="font-medium">{t(`pricing.${p}`)}</span> — <span className="text-muted-foreground">{t(`pricingHint.${p}`)}</span></span>
                    </label>
                  ))}
                  {grouped && punchView ? <p className="text-xs text-muted-foreground">{ts('punchPricingHint')}</p> : null}
                </fieldset>
                {fields.visible.has('allowTopUp') ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t('allowTopUp')}</span>
                    <Switch checked={allowTopUp} onCheckedChange={(v) => setAllowTopUp(!!v)} aria-label={t('allowTopUp')} />
                  </div>
                ) : null}
                <ToggleFields
                  accounting={accounting} onAccounting={setAccounting}
                  offlineAllowed={offlineAllowed} onOfflineAllowed={setOfflineAllowed}
                  policy={policy} onPolicy={setPolicy} overrideEditable={overrideEditable} showOffline={false}
                />
              </>
            )}
          </FormSection>

          <FormSection n={6} title={ts('s6Title')} purpose={ts('s6PurposeType')}>
            <OfflineSwitch value={offlineAllowed} onChange={setOfflineAllowed} />
          </FormSection>

          <FormSection n={7} title={ts('s7Title')} purpose={ts('s7Purpose')}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t('showValidity')}</span>
              <Switch checked={showValidity} onCheckedChange={(v) => setShowValidity(!!v)} aria-label={t('showValidity')} />
            </div>
            {!discount ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{t('printTillValue')}</span>
                <Switch checked={printTillValue} onCheckedChange={(v) => setPrintTillValue(!!v)} aria-label={t('printTillValue')} />
              </div>
            ) : null}
          </FormSection>

          <SummaryCard lines={summary} sticky />
          {problems.length ? <p className="text-xs text-muted-foreground">{t('missing', { list: problems.join(', ') })}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>{tc('cancel')}</Button>
          <Button onClick={submit} disabled={problems.length > 0 || save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {initial ? t('save') : t('create')}
          </Button>
        </DialogFooter>
        <Dialog open={versionAsk !== null} onOpenChange={(v) => { if (!v && !save.isPending) setVersionAsk(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('versionAskTitle', { v: (initial?.version ?? 1) + 1 })}</DialogTitle>
            </DialogHeader>
            <p className="text-sm">{t('versionAskBody', { n: initial?.batchCount ?? 0, v: initial?.version ?? 1 })}</p>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {(versionAsk ?? []).map((k) => <li key={k}>{te.has(`field.${k}`) ? te(`field.${k}`) : k}</li>)}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setVersionAsk(null)} disabled={save.isPending}>{te('back')}</Button>
              <Button onClick={() => save.mutate(undefined, { onSettled: () => setVersionAsk(null) })} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {te('confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </>
  );
}

// ── The three toggles: on a type, and on a batch after issue ──────────────────

export interface PolicyState {
  mode: PrepaidOverrideMode;
  maxAmount: string;
  maxPercent: string;
  maxTotal: string;
}

export function policyState(p?: PrepaidOverridePolicy | null): PolicyState {
  return {
    mode: p?.mode ?? 'honour',
    maxAmount: p?.maxAmount == null ? '' : String(p.maxAmount),
    maxPercent: p?.maxPercent == null ? '' : String(p.maxPercent),
    maxTotal: p?.maxTotal == null ? '' : String(p.maxTotal),
  };
}

export function policyBody(p: PolicyState): PrepaidOverridePolicy {
  const n = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);
  return p.mode === 'honour' ? { mode: 'honour' } : { mode: p.mode, maxAmount: n(p.maxAmount), maxPercent: n(p.maxPercent), maxTotal: n(p.maxTotal) };
}

/**
 * "נכנס כאמצעי תשלום ולסה״כ הכללי", "מימוש ללא אינטרנט" and the discount-block policy. An override
 * (auto / manager) is set only with the `voucher_discount_override` section.
 */
export function ToggleFields({
  accounting, onAccounting, offlineAllowed, onOfflineAllowed, policy, onPolicy, overrideEditable, disabled = false, showOffline = true,
}: {
  accounting: PrepaidRedemptionAccounting;
  onAccounting: (v: PrepaidRedemptionAccounting) => void;
  offlineAllowed: boolean;
  onOfflineAllowed: (v: boolean) => void;
  policy: PolicyState;
  onPolicy: (p: PolicyState) => void;
  overrideEditable: boolean;
  disabled?: boolean;
  /** False: "מימוש ללא אינטרנט" is shown elsewhere (the guided form's "איפה תקף"). */
  showOffline?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.types');
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="pv-accounting">{t('accountingLabel')}</Label>
        <select id="pv-accounting" className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
          value={accounting} disabled={disabled} onChange={(e) => onAccounting(e.target.value as PrepaidRedemptionAccounting)}>
          {PREPAID_REDEMPTION_ACCOUNTING.map((m) => <option key={m} value={m}>{t(`accounting.${m}`)}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">{t(`accountingHint.${accounting}`)}</p>
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('accountantNote')}</p>
      </div>
      {showOffline ? <OfflineSwitch value={offlineAllowed} onChange={onOfflineAllowed} disabled={disabled} /> : null}
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('overrideLabel')}</legend>
        {(['honour', 'auto', 'manager'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm">
            <input type="radio" name="pv-override" className="mt-1 accent-primary" checked={policy.mode === m}
              disabled={disabled || (m !== 'honour' && !overrideEditable)} onChange={() => onPolicy({ ...policy, mode: m })} />
            <span><span className="font-medium">{t(`override.${m}`)}</span> — <span className="text-muted-foreground">{t(`overrideHint.${m}`)}</span></span>
          </label>
        ))}
        {!overrideEditable ? <p className="text-xs text-muted-foreground">{t('overrideNoPermission')}</p> : null}
        {policy.mode !== 'honour' ? (
          <div className="grid gap-2 pt-1 sm:grid-cols-3">
            {(['maxAmount', 'maxPercent', 'maxTotal'] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`pv-${k}`} className="text-xs">{t(`cap.${k}`)}</Label>
                <Input id={`pv-${k}`} inputMode="decimal" value={policy[k]} disabled={disabled || !overrideEditable}
                  onChange={(e) => onPolicy({ ...policy, [k]: e.target.value })} />
              </div>
            ))}
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

/** "מימוש ללא אינטרנט" with what it means. */
export function OfflineSwitch({ value, onChange, disabled = false }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const t = useTranslations('prepaidVouchers.types');
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t('offlineAllowed')}</p>
        <p className="text-xs text-muted-foreground">{t('offlineHint')}</p>
      </div>
      <Switch checked={value} disabled={disabled} onCheckedChange={(v) => onChange(!!v)} aria-label={t('offlineAllowed')} />
    </div>
  );
}
