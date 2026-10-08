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
  PREPAID_REDEMPTION_ACCOUNTING,
  type PrepaidVoucherType,
} from '@/lib/prepaidVouchersApi';
import { benefitText, discountDraftErrors, isDiscountKind, moneyText, termsOfBatch, type PrepaidVoucherKind } from '@/lib/prepaidVoucherBenefit';
import { itemText } from '@/lib/prepaidVoucherProducts';
import { GoodsEditor, type DraftItem } from '@/components/dashboard/prepaid-vouchers/goods-editor';
import {
  DiscountTermsFields,
  EMPTY_DISCOUNT_TERMS,
  KindPicker,
  RulesFields,
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

/** "1× נקניקייה + 1× שתייה", or a discount's benefit. */
export function typeContents(t: Pick<PrepaidVoucherType, 'kind' | 'items' | 'benefitText' | 'discountType' | 'discountValue' | 'minPurchase' | 'maxDiscount' | 'maxUnits' | 'targets'>): string {
  if (isDiscountKind(t.kind)) return t.benefitText ?? benefitText(termsOfBatch(t)) ?? '';
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
      <p className="text-muted-foreground">{tk(`kind.${type.kind ?? 'items'}`)} · {typeContents(type)}</p>
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
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [pickedCompany, setCompanyId] = useState(initial?.companyId ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [kind, setKind] = useState<PrepaidVoucherKind>(initial?.kind ?? 'items');
  // Editing keeps the type's goods unless they are changed (the picker needs full product rows).
  const [items, setItems] = useState<DraftItem[]>([]);
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
    stacking: initial?.stacking ?? 'single',
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

  const discount = isDiscountKind(kind);
  const decimal = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);
  const termErrors = discountDraftErrors({
    kind, discountType: terms.discountType, value: terms.value, minPurchase: terms.minPurchase, maxDiscount: terms.maxDiscount,
    targetCount: terms.products.length + terms.categoryIds.length + (initial?.targets?.productIds.length ?? 0),
    maxUnits: terms.maxUnits, usesPerVoucher: rules.usesPerVoucher, maxUsesPerSale: rules.maxUsesPerSale, maxUsesPerDay: rules.maxUsesPerDay,
  });
  const goodsCount = goodsTouched || !initial ? items.length : initial.items.length;
  const problems = [
    !name.trim() ? t('problem.name') : null,
    !companyId ? t('problem.company') : null,
    !discount && goodsCount === 0 ? t('problem.items') : null,
    discount && termErrors.length ? t('problem.terms') : null,
    !discount && pricing === 'fixed' && decimal(tillValue) == null ? t('problem.value') : null,
  ].filter(Boolean) as string[];

  const body = (): PrepaidTypeBody => {
    const out: PrepaidTypeBody = {
      name: name.trim(), code: code.trim() || null, description: description.trim() || null,
      includeExtras: !discount && includeExtras, splitAllowed: !discount && splitAllowed,
      stacking: rules.stacking,
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
      if (goodsTouched || !initial) out.items = items.map((i) => ({ productId: i.product.id, quantity: i.quantity }));
    } else {
      Object.assign(out, {
        discountType: terms.discountType, discountValue: decimal(terms.value),
        minPurchase: kind === 'order_discount' ? decimal(terms.minPurchase) : null,
        maxDiscount: kind === 'order_discount' && terms.discountType === 'percent' ? decimal(terms.maxDiscount) : null,
        maxUnits: kind === 'item_discount' ? parseInt(terms.maxUnits, 10) || 1 : null,
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

  const save = useMutation({
    mutationFn: () => (initial ? updatePrepaidType(initial.id, body()) : createPrepaidType(body())),
    onSuccess: (x) => {
      toast.success(initial ? t('saved', { version: x.version }) : t('created'));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-types'] });
      onDone();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('saveFailed'))),
  });

  return (
    <>
        <div className="space-y-4">
          {initial && initial.batchCount > 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('versionNote', { n: initial.batchCount })}</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="pvt-name">{t('name')}</Label>
              <Input id="pvt-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pvt-code">{t('code')}</Label>
              <Input id="pvt-code" value={code} maxLength={32} dir="ltr" onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MEAL" />
            </div>
          </div>
          {!initial ? (
            <div className="space-y-1">
              <Label>{t('company')}</Label>
              <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
                value={companyId} onChange={(e) => { setCompanyId(e.target.value); setItems([]); }} aria-label={t('company')}>
                <option value="">{t('pickCompany')}</option>
                {(companies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="pvt-desc">{t('description')}</Label>
            <Input id="pvt-desc" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {!initial ? <KindPicker value={kind} onChange={setKind} /> : null}
          {discount ? (
            <DiscountTermsFields kind={kind} companyId={companyId} shopIds={[]} value={terms} onChange={setTerms} errors={termErrors} />
          ) : (
            <>
              {initial && !goodsTouched ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span>{typeContents(initial)}</span>
                  <Button size="sm" variant="outline" onClick={() => setGoodsTouched(true)}>{t('changeGoods')}</Button>
                </div>
              ) : (
                <GoodsEditor companyId={companyId} items={items} onChange={(v) => { setItems(v); setGoodsTouched(true); }} />
              )}

              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">{t('pricesTitle')}</p>
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
                </fieldset>
                {pricing === 'cover' ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t('allowTopUp')}</span>
                    <Switch checked={allowTopUp} onCheckedChange={(v) => setAllowTopUp(!!v)} aria-label={t('allowTopUp')} />
                  </div>
                ) : null}
                <ToggleFields
                  accounting={accounting} onAccounting={setAccounting}
                  offlineAllowed={offlineAllowed} onOfflineAllowed={setOfflineAllowed}
                  policy={policy} onPolicy={setPolicy} overrideEditable={overrideEditable}
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">{t('showValidity')}</span>
                  <Switch checked={showValidity} onCheckedChange={(v) => setShowValidity(!!v)} aria-label={t('showValidity')} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">{t('printTillValue')}</span>
                  <Switch checked={printTillValue} onCheckedChange={(v) => setPrintTillValue(!!v)} aria-label={t('printTillValue')} />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{splitAllowed ? t('splitOn') : t('splitOff')}</p>
                    <p className="text-xs text-muted-foreground">{splitAllowed ? t('splitOnHint') : t('splitOffHint')}</p>
                  </div>
                  <Switch checked={splitAllowed} onCheckedChange={(v) => setSplitAllowed(!!v)} aria-label={t('splitOn')} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <span className="text-sm font-medium">{t('includeExtras')}</span>
                  <Switch checked={includeExtras} onCheckedChange={(v) => setIncludeExtras(!!v)} aria-label={t('includeExtras')} />
                </div>
              </div>
            </>
          )}
          <div className="rounded-lg border p-3">
            <RulesFields kind={kind} value={rules} onChange={setRules} />
          </div>
          {problems.length ? <p className="text-xs text-muted-foreground">{t('missing', { list: problems.join(', ') })}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>{tc('cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={problems.length > 0 || save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {initial ? t('save') : t('create')}
          </Button>
        </DialogFooter>
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
  accounting, onAccounting, offlineAllowed, onOfflineAllowed, policy, onPolicy, overrideEditable, disabled = false,
}: {
  accounting: PrepaidRedemptionAccounting;
  onAccounting: (v: PrepaidRedemptionAccounting) => void;
  offlineAllowed: boolean;
  onOfflineAllowed: (v: boolean) => void;
  policy: PolicyState;
  onPolicy: (p: PolicyState) => void;
  overrideEditable: boolean;
  disabled?: boolean;
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
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('offlineAllowed')}</p>
          <p className="text-xs text-muted-foreground">{t('offlineHint')}</p>
        </div>
        <Switch checked={offlineAllowed} disabled={disabled} onCheckedChange={(v) => onOfflineAllowed(!!v)} aria-label={t('offlineAllowed')} />
      </div>
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
