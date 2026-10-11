'use client';

/**
 * "שינוי הגדרות לסדרות שנבחרו" — the same change for many batches (lib/prepaidBatchBulkEdit.ts; the
 * cloud's app/services/prepaid_voucher_bulk_edit.py runs each batch through "ערוך סדרה").
 *
 * Three steps: tick "שנה" by each setting to change and set its value (an unticked setting stays as it
 * is on every batch) → "תצוגה מקדימה": per batch what changes and what it touches, or why it is refused
 * → "החל על N סדרות" (one request id: a retry after a lost answer never applies twice) → the summary.
 */
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, CircleSlash, Eye, Loader2, MinusCircle } from 'lucide-react';
import { fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { retryableSendError, newKey } from '@/lib/deviceCommands';
import { changesByCategory, editValueText, type PrepaidBatchEditPlan } from '@/lib/prepaidBatchEdit';
import { formatDate } from '@/lib/format';
import { MAX_VOUCHERS_PER_SALE, PREPAID_PROMOTION_POLICIES, type PrepaidPromotionPolicy } from '@/lib/prepaidVoucherBenefit';
import { maxVouchersProblem } from '@/lib/voucherFields';
import {
  BULK_FAILED,
  BULK_FIELDS,
  BULK_SECTIONS,
  MAX_BULK_BATCHES,
  NOT_APPLICABLE,
  bulkChanges,
  knownRefusal,
  notApplicableCount,
  offeredFields,
  outcomeOrder,
  willChange,
  type BulkApplyResult,
  type BulkBatchOutcome,
  type BulkField,
  type BulkPreviewResult,
} from '@/lib/prepaidBatchBulkEdit';
import {
  PREPAID_REDEMPTION_ACCOUNTING,
  applyPrepaidBatchesBulkEdit,
  fetchPrepaidTypes,
  previewPrepaidBatchesBulkEdit,
  type PrepaidBarcodeType,
  type PrepaidBatchEditBody,
  type PrepaidPricing,
  type PrepaidRedemptionAccounting,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { useEditFieldLabel, useEditValueFormat, useEffectLines } from '@/components/dashboard/prepaid-vouchers/batch-edit';
import { RulesFields, stackingBody, stackingValid, type RulesState } from '@/components/dashboard/prepaid-vouchers/voucher-terms';
import { policyBody, policyState, type PolicyState } from '@/components/dashboard/prepaid-vouchers/voucher-types';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** `yyyy-mm-dd` → the start / end of that day, local time, as ISO (as the batch form sends it). */
function dayBoundIso(value: string, end: boolean): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const at = end ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
  return at.toISOString();
}

interface Draft {
  validFrom: string;
  validUntil: string;
  shopIds: string[];
  offlineAllowed: boolean;
  rules: RulesState;
  promotionPolicy: PrepaidPromotionPolicy;
  maxUsesPerSale: string;
  maxUsesPerDay: string;
  splitAllowed: boolean;
  includeExtras: boolean;
  totalQty: string;
  applyToPartial: boolean;
  pricing: PrepaidPricing;
  tillValue: string;
  allowTopUp: boolean;
  accounting: PrepaidRedemptionAccounting;
  policy: PolicyState;
  showCode: boolean;
  showItems: boolean;
  showValidity: boolean;
  showCredit: boolean;
  printTillValue: boolean;
  barcodeType: PrepaidBarcodeType;
}

const EMPTY_DRAFT: Draft = {
  validFrom: '', validUntil: '', shopIds: [], offlineAllowed: false,
  rules: { stacking: 'single', maxVouchersPerSale: '', promotionPolicy: 'exclude', usesPerVoucher: '1', maxUsesPerSale: '1', maxUsesPerDay: '' },
  promotionPolicy: 'exclude', maxUsesPerSale: '1', maxUsesPerDay: '',
  splitAllowed: false, includeExtras: false, totalQty: '', applyToPartial: false,
  pricing: 'cover', tillValue: '', allowTopUp: true, accounting: 'discount', policy: policyState(),
  showCode: false, showItems: true, showValidity: true, showCredit: true, printTillValue: false, barcodeType: 'qr',
};

const decimal = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);

/** Every setting's wire values as the form has them (lib/prepaidBatchBulkEdit.ts picks the ticked ones). */
function partsOf(d: Draft): Partial<Record<BulkField, Record<string, unknown>>> {
  return {
    validFrom: { validFrom: dayBoundIso(d.validFrom, false) },
    validUntil: { validUntil: dayBoundIso(d.validUntil, true) },
    shopIds: { shopIds: d.shopIds.length ? [...d.shopIds].sort() : null },
    offlineAllowed: { offlineAllowed: d.offlineAllowed },
    stacking: stackingBody(d.rules),
    promotionPolicy: { promotionPolicy: d.promotionPolicy },
    maxUsesPerSale: { maxUsesPerSale: parseInt(d.maxUsesPerSale, 10) || 1 },
    maxUsesPerDay: { maxUsesPerDay: d.maxUsesPerDay.trim() ? parseInt(d.maxUsesPerDay, 10) : null },
    splitAllowed: { splitAllowed: d.splitAllowed },
    includeExtras: { includeExtras: d.includeExtras },
    totalQty: { totalQty: parseInt(d.totalQty, 10) || null },
    pricing: { pricing: d.pricing },
    tillValue: { tillValue: decimal(d.tillValue) },
    allowTopUp: { allowTopUp: d.allowTopUp },
    redemptionAccounting: { redemptionAccounting: d.accounting },
    discountBlockPolicy: { discountBlockPolicy: policyBody(d.policy) },
    showCode: { showCode: d.showCode },
    showItems: { showItems: d.showItems },
    showValidity: { showValidity: d.showValidity },
    showCredit: { showCredit: d.showCredit },
    printTillValue: { printTillValue: d.printTillValue },
    barcodeType: { barcodeType: d.barcodeType },
  };
}

const wholeIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

/** What is still wrong with the ticked settings — each with the value, why and the limit (the button stays disabled). */
function problemsOf(d: Draft, ticked: ReadonlySet<BulkField>, t: (k: string, v?: Record<string, string | number>) => string): string[] {
  const out: string[] = [];
  if (ticked.size === 0) out.push(t('nothingChosen'));
  const maxBad = ticked.has('stacking') && !stackingValid(d.rules) ? maxVouchersProblem(d.rules.maxVouchersPerSale, MAX_VOUCHERS_PER_SALE) : null;
  if (maxBad) out.push(t('problem.stacking', { value: maxBad.value, max: maxBad.max }));
  if (ticked.has('totalQty') && !wholeIn(d.totalQty, 1, 2000)) out.push(t('problem.totalQty', { value: d.totalQty }));
  if (ticked.has('tillValue') && d.tillValue.trim() && !(Number(d.tillValue.replace(',', '.')) > 0)) {
    out.push(t('problem.tillValue', { value: d.tillValue }));
  }
  if (ticked.has('maxUsesPerSale') && !wholeIn(d.maxUsesPerSale, 1, 1000)) out.push(t('problem.uses', { value: d.maxUsesPerSale }));
  if (ticked.has('maxUsesPerDay') && d.maxUsesPerDay.trim() && !wholeIn(d.maxUsesPerDay, 1, 1000)) {
    out.push(t('problem.uses', { value: d.maxUsesPerDay }));
  }
  if (ticked.has('validFrom') && ticked.has('validUntil') && d.validFrom && d.validUntil && d.validUntil < d.validFrom) {
    out.push(t('problem.dates', {
      from: formatDate(dayBoundIso(d.validFrom, false) ?? d.validFrom), until: formatDate(dayBoundIso(d.validUntil, true) ?? d.validUntil),
    }));
  }
  return out;
}

type Step = 'form' | 'preview' | 'result';

export function BulkEditDialog({ open, batches, onOpenChange, onDone }: {
  open: boolean;
  /** The batches picked on the list (as shown, under the filters). */
  batches: PrepaidVoucherBatch[];
  onOpenChange: (v: boolean) => void;
  /** After an apply, when the dialog closes: the selection is cleared. */
  onDone: () => void;
}) {
  const t = useTranslations('prepaidVouchers.bulk');
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const label = useEditFieldLabel();
  const [step, setStep] = useState<Step>('form');
  const [ticked, setTicked] = useState<Set<BulkField>>(() => new Set());
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // What the preview was asked with: the apply sends exactly that, under one request id.
  const [sent, setSent] = useState<{ ids: string[]; changes: PrepaidBatchEditBody; requestId: string } | null>(null);
  const [preview, setPreview] = useState<BulkPreviewResult | null>(null);
  const [result, setResult] = useState<BulkApplyResult | null>(null);
  const [lost, setLost] = useState(false);

  const set = (patch: Partial<Draft>) => setDraft((cur) => ({ ...cur, ...patch }));
  const tick = (field: BulkField, on: boolean) => setTicked((cur) => {
    const next = new Set(cur);
    if (on) next.add(field);
    else next.delete(field);
    return next;
  });

  const ids = batches.map((b) => b.id);
  const byId = new Map(batches.map((b) => [b.id, b]));
  const companyIds = [...new Set(batches.map((b) => b.companyId))];
  const companyName = new Map(batches.map((b) => [b.companyId, b.companyName ?? '']));
  const shops = useQuery({
    queryKey: ['shops', 'bulk', ...companyIds],
    queryFn: async () => (await Promise.all(companyIds.map(async (c) => (await fetchShops(c)).map((s) => ({
      id: s.id, label: companyIds.length > 1 ? `${s.name} · ${companyName.get(c) ?? ''}` : s.name,
    }))))).flat(),
    enabled: open && companyIds.length > 0,
  });
  const types = useQuery({ queryKey: ['prepaid-voucher-types', 'flags'], queryFn: () => fetchPrepaidTypes({ includeInactive: false }), enabled: open });
  const overrideEditable = !!types.data?.overrideEditable;

  // Only the settings every picked batch has (lib/voucherFields.ts); a fixed value has no top-up.
  const offered = offeredFields(batches);
  const shownFields = new Set<BulkField>(offered.fields.filter((f) =>
    !(f === 'allowTopUp' && ticked.has('pricing') && draft.pricing === 'fixed')));
  const sending = new Set([...ticked].filter((f) => shownFields.has(f)));
  const changes = bulkChanges(partsOf(draft), sending,
    sending.has('totalQty') && draft.applyToPartial ? { applyToPartial: true } : {}) as PrepaidBatchEditBody;
  const problems = problemsOf(draft, sending, t);
  const tooMany = ids.length > MAX_BULK_BATCHES;

  const errorText = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && /^[a-z_]+$/.test(detail) && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };

  const plan = useMutation({
    mutationFn: (v: { ids: string[]; changes: PrepaidBatchEditBody }) => previewPrepaidBatchesBulkEdit(v.ids, v.changes),
    onSuccess: (out, v) => {
      setPreview(out);
      // Exactly what was previewed (not the form as it may be now), under a new request id.
      setSent({ ids: v.ids, changes: v.changes, requestId: newKey() });
      setLost(false);
      setStep('preview');
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const write = useMutation({
    mutationFn: () => {
      const s = sent as NonNullable<typeof sent>;
      return applyPrepaidBatchesBulkEdit(s.ids, s.changes, s.requestId);
    },
    onSuccess: (out) => {
      setResult(out);
      setLost(false);
      setStep('result');
      toast.success(t('done', { n: out.summary.applied }));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      for (const it of out.items) {
        if (it.status !== 'applied') continue;
        void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', it.batchId] });
        void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', it.batchId] });
      }
    },
    onError: (err) => {
      // No answer (or a server hiccup): the same request id again applies nothing twice.
      setLost(retryableSendError((err as { response?: { status?: number } })?.response?.status ?? null));
      toast.error(errorText(err));
    },
  });

  const close = (v: boolean) => {
    if (v || write.isPending) return;
    const applied = step === 'result';
    onOpenChange(false);
    setStep('form');
    setPreview(null);
    setResult(null);
    setSent(null);
    setLost(false);
    if (applied) {
      setTicked(new Set());
      setDraft(EMPTY_DRAFT);
      onDone();
    }
  };

  const row = (field: BulkField, control: ReactNode, hint?: string) => (
    <FieldRow key={field} field={field} label={label(field)} ticked={ticked.has(field)} onTick={(on) => tick(field, on)}
      notFor={notApplicableCount(field, batches)} hint={hint}>
      {control}
    </FieldRow>
  );
  const on = (field: BulkField) => ticked.has(field);
  const switchRow = (field: BulkField, value: boolean, onChange: (v: boolean) => void) => row(field, (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{value ? t('value.on') : t('value.off')}</span>
      <Switch checked={value} disabled={!on(field)} onCheckedChange={(v) => onChange(!!v)} aria-label={label(field)} />
    </div>
  ));

  const controls: Record<BulkField, ReactNode> = {
    validFrom: row('validFrom', (
      <DatePicker id="pv-bulk-from" value={draft.validFrom} disabled={!on('validFrom')} onChange={(e) => set({ validFrom: e.target.value })} />
    ), t('emptyClears')),
    validUntil: row('validUntil', (
      <DatePicker id="pv-bulk-until" value={draft.validUntil} disabled={!on('validUntil')} onChange={(e) => set({ validUntil: e.target.value })} />
    ), t('emptyClears')),
    shopIds: row('shopIds', (
      <EntityMultiSelect label={label('shopIds')} options={shops.data ?? []} selected={draft.shopIds}
        onChange={(v) => set({ shopIds: v })} allLabel={t('allShops')} clearLabel={t('allShops')}
        emptyLabel={tp('create.noShops')} disabled={!on('shopIds')} />
    ), companyIds.length > 1 ? t('shopsManyCompanies') : undefined),
    offlineAllowed: switchRow('offlineAllowed', draft.offlineAllowed, (v) => set({ offlineAllowed: v })),
    stacking: row('stacking', <RulesFields kind="items" stackingOnly value={draft.rules} onChange={(rules) => set({ rules })} />),
    promotionPolicy: row('promotionPolicy', (
      <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={draft.promotionPolicy}
        disabled={!on('promotionPolicy')} onChange={(e) => set({ promotionPolicy: e.target.value as PrepaidPromotionPolicy })}
        aria-label={label('promotionPolicy')}>
        {PREPAID_PROMOTION_POLICIES.map((p) => <option key={p} value={p}>{tp(`kinds.promotionPolicy.${p}`)}</option>)}
      </select>
    ), tp(`kinds.promotionHint.${draft.promotionPolicy}`)),
    maxUsesPerSale: row('maxUsesPerSale', (
      <Input type="number" min={1} max={1000} className="h-9 max-w-40" value={draft.maxUsesPerSale} disabled={!on('maxUsesPerSale')}
        onChange={(e) => set({ maxUsesPerSale: e.target.value })} aria-label={label('maxUsesPerSale')} />
    ), `${tp('kinds.maxUsesPerSaleHint')} ${t('usesPerBatchHint')}`),
    maxUsesPerDay: row('maxUsesPerDay', (
      <Input type="number" min={1} max={1000} className="h-9 max-w-40" value={draft.maxUsesPerDay} disabled={!on('maxUsesPerDay')}
        onChange={(e) => set({ maxUsesPerDay: e.target.value })} placeholder={tp('kinds.noMaximum')} aria-label={label('maxUsesPerDay')} />
    ), tp('kinds.maxUsesPerDayHint')),
    splitAllowed: switchRow('splitAllowed', draft.splitAllowed, (v) => set({ splitAllowed: v })),
    includeExtras: switchRow('includeExtras', draft.includeExtras, (v) => set({ includeExtras: v })),
    totalQty: row('totalQty', (
      <div className="space-y-2">
        <Input type="number" min={1} className="h-9 max-w-40" value={draft.totalQty} disabled={!on('totalQty')}
          onChange={(e) => set({ totalQty: e.target.value })} aria-label={label('totalQty')} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={draft.applyToPartial} disabled={!on('totalQty')}
            onChange={(e) => set({ applyToPartial: e.target.checked })} />
          <span className="min-w-0">
            <span className="block">{tp('edit.applyToPartial')}</span>
            <span className="block text-xs text-muted-foreground">{t('applyToPartialHint')}</span>
          </span>
        </label>
      </div>
    ), t('totalQtyHint')),
    pricing: row('pricing', (
      <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={draft.pricing}
        disabled={!on('pricing')} onChange={(e) => set({ pricing: e.target.value as PrepaidPricing })} aria-label={label('pricing')}>
        <option value="fixed">{tp('edit.choice.pricing.fixed')}</option>
        <option value="cover">{tp('edit.choice.pricing.cover')}</option>
      </select>
    ), tp(`edit.pricingHint.${draft.pricing}`)),
    tillValue: row('tillValue', (
      <Input inputMode="decimal" className="h-9 max-w-40" value={draft.tillValue} disabled={!on('tillValue')}
        onChange={(e) => set({ tillValue: e.target.value })} placeholder={tp('create.tillValuePlaceholder')} aria-label={label('tillValue')} />
    ), t('tillValueHint')),
    allowTopUp: switchRow('allowTopUp', draft.allowTopUp, (v) => set({ allowTopUp: v })),
    redemptionAccounting: row('redemptionAccounting', (
      <div className="space-y-1">
        <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={draft.accounting}
          disabled={!on('redemptionAccounting')} onChange={(e) => set({ accounting: e.target.value as PrepaidRedemptionAccounting })}
          aria-label={label('redemptionAccounting')}>
          {PREPAID_REDEMPTION_ACCOUNTING.map((m) => <option key={m} value={m}>{tp(`types.accounting.${m}`)}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">{tp(`types.accountingHint.${draft.accounting}`)}</p>
      </div>
    )),
    discountBlockPolicy: row('discountBlockPolicy', (
      <fieldset className="space-y-1" disabled={!on('discountBlockPolicy')}>
        {(['honour', 'auto', 'manager'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm">
            <input type="radio" name="pv-bulk-override" className="mt-1 accent-primary" checked={draft.policy.mode === m}
              disabled={m !== 'honour' && !overrideEditable} onChange={() => set({ policy: { ...draft.policy, mode: m } })} />
            <span><span className="font-medium">{tp(`types.override.${m}`)}</span> — <span className="text-muted-foreground">{tp(`types.overrideHint.${m}`)}</span></span>
          </label>
        ))}
        {!overrideEditable ? <p className="text-xs text-muted-foreground">{tp('types.overrideNoPermission')}</p> : null}
        {draft.policy.mode !== 'honour' ? (
          <div className="grid gap-2 pt-1 sm:grid-cols-3">
            {(['maxAmount', 'maxPercent', 'maxTotal'] as const).map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`pv-bulk-${k}`} className="text-xs">{tp(`types.cap.${k}`)}</Label>
                <Input id={`pv-bulk-${k}`} inputMode="decimal" value={draft.policy[k]} disabled={!overrideEditable}
                  onChange={(e) => set({ policy: { ...draft.policy, [k]: e.target.value } })} />
              </div>
            ))}
          </div>
        ) : null}
      </fieldset>
    )),
    showCode: switchRow('showCode', draft.showCode, (v) => set({ showCode: v })),
    showItems: switchRow('showItems', draft.showItems, (v) => set({ showItems: v })),
    showValidity: switchRow('showValidity', draft.showValidity, (v) => set({ showValidity: v })),
    showCredit: switchRow('showCredit', draft.showCredit, (v) => set({ showCredit: v })),
    printTillValue: switchRow('printTillValue', draft.printTillValue, (v) => set({ printTillValue: v })),
    barcodeType: row('barcodeType', (
      <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={draft.barcodeType}
        disabled={!on('barcodeType')} onChange={(e) => set({ barcodeType: e.target.value as PrepaidBarcodeType })} aria-label={label('barcodeType')}>
        <option value="qr">{tp('create.barcodeQr')}</option>
        <option value="code128">{tp('create.barcodeCode128')}</option>
      </select>
    )),
  };

  const okCount = willChange(preview);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'result' ? t('resultTitle') : step === 'preview' ? t('previewTitle') : t('title', { n: ids.length })}
          </DialogTitle>
        </DialogHeader>

        {step === 'form' ? (
          <div className="space-y-4">
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('intro')}</p>
            {offered.mixed ? (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
                {t('mixedKinds')}
              </p>
            ) : null}
            {BULK_SECTIONS.map((section) => {
              const here = BULK_FIELDS.filter((f) => f.section === section && shownFields.has(f.field));
              return here.length ? (
                <section key={section} className="space-y-2">
                  <h3 className="text-sm font-semibold">{t(`section.${section}`)}</h3>
                  {here.map((f) => controls[f.field])}
                </section>
              ) : null;
            })}
          </div>
        ) : null}

        {step === 'preview' && preview ? (
          <div className="space-y-3">
            <p className="text-sm font-medium" aria-live="polite">
              {t('summaryPreview', { ok: preview.summary.ok, unchanged: preview.summary.unchanged, refused: preview.summary.refused })}
            </p>
            <ul className="space-y-2">
              {outcomeOrder(preview.items).map((it) => (
                <OutcomeRow key={it.batchId} item={it} batch={byId.get(it.batchId) ?? null} sent={sent?.changes ?? null} />
              ))}
            </ul>
            {lost ? (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
                {t('lostAnswer')}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 'result' && result ? (
          <div className="space-y-3">
            <p className="text-sm font-medium" aria-live="polite">
              {t('summaryResult', { applied: result.summary.applied, unchanged: result.summary.unchanged, refused: result.summary.refused })}
            </p>
            <ul className="space-y-2">
              {outcomeOrder(result.items).map((it) => (
                <OutcomeRow key={it.batchId} item={it} batch={byId.get(it.batchId) ?? null} sent={sent?.changes ?? null} compact />
              ))}
            </ul>
          </div>
        ) : null}

        <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
          {step === 'form' && problems.length ? <p>{t('missing', { list: problems.join(', ') })}</p> : null}
          {tooMany ? <p className="text-destructive">{t('tooMany', { max: MAX_BULK_BATCHES })}</p> : null}
        </div>

        <DialogFooter>
          {step === 'form' ? (
            <>
              <Button variant="outline" onClick={() => close(false)}>{tc('cancel')}</Button>
              <Button onClick={() => plan.mutate({ ids, changes })} disabled={problems.length > 0 || tooMany || plan.isPending || ids.length === 0}>
                {plan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                {plan.isPending ? t('previewing') : t('preview')}
              </Button>
            </>
          ) : step === 'preview' ? (
            <>
              <Button variant="outline" onClick={() => { setStep('form'); setPreview(null); setSent(null); setLost(false); }} disabled={write.isPending}>
                {t('back')}
              </Button>
              <Button onClick={() => write.mutate()} disabled={write.isPending || okCount === 0}>
                {write.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {write.isPending ? t('applying') : lost ? t('retry') : t('apply', { n: okCount })}
              </Button>
            </>
          ) : (
            <Button onClick={() => close(false)}>{t('close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One setting: its "שנה" box, its control (live only when ticked), and the batches it is not for. */
function FieldRow({ field, label, ticked, onTick, notFor, hint, children }: {
  field: BulkField;
  label: string;
  ticked: boolean;
  onTick: (on: boolean) => void;
  notFor: number;
  hint?: string;
  children: ReactNode;
}) {
  const t = useTranslations('prepaidVouchers.bulk');
  return (
    <div className={cn('space-y-2 rounded-lg border p-3', ticked ? 'border-primary/50 bg-primary/5' : '')} data-field={field}>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={ticked} onChange={(e) => onTick(e.target.checked)}
          aria-label={t('changeField', { field: label })} />
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t('change')}</span>
        <span className="font-medium">{label}</span>
      </label>
      <fieldset disabled={!ticked} aria-disabled={!ticked} className={cn('min-w-0 space-y-1', !ticked && 'pointer-events-none opacity-50')}>
        {children}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </fieldset>
      {notFor > 0 ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('notFor', { n: notFor })}</p> : null}
    </div>
  );
}

const STATUS_ICON = {
  ok: CheckCircle2, applied: CheckCircle2, unchanged: MinusCircle, refused: CircleSlash,
} as const;
const STATUS_STYLE = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  applied: 'text-emerald-700 dark:text-emerald-400',
  unchanged: 'text-muted-foreground',
  refused: 'text-destructive',
} as const;

/** One batch of the preview / the result: what changes and what it touches, or why it is refused. */
function OutcomeRow({ item, batch, sent, compact = false }: {
  item: BulkBatchOutcome;
  batch: PrepaidVoucherBatch | null;
  /** What was asked (the value a refusal names). */
  sent: PrepaidBatchEditBody | null;
  compact?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.bulk');
  const te = useTranslations('prepaidVouchers.edit');
  const tp = useTranslations('prepaidVouchers');
  const label = useEditFieldLabel();
  const fmt = useEditValueFormat(batch);
  const effects = useEffectLines();
  const Icon = STATUS_ICON[item.status as keyof typeof STATUS_ICON] ?? MinusCircle;
  const name = item.name ?? batch?.name ?? null;
  const title = name ? (item.customerName ? `${item.customerName} · ${name}` : name) : t('unknownBatch');
  const plan: PrepaidBatchEditPlan = { changes: item.changes ?? [], effects: item.effects ?? {}, confirm: !!item.confirm };
  const reason = (): string => {
    if (item.reason === NOT_APPLICABLE) return t('notApplicable', { fields: (item.fields ?? []).map(label).join(', ') });
    if (item.reason === BULK_FAILED) return t('failed');
    const known = knownRefusal(item.reason);
    if (known?.key === 'reasonTotalQty') return t('reasonTotalQty', { value: String(sent?.totalQty ?? ''), min: known.min, max: known.max });
    if (known?.key === 'reasonFixedValue') return t('reasonFixedValue');
    if (item.reason && /^[a-z_]+$/.test(item.reason) && tp.has(`errors.${item.reason}`)) return tp(`errors.${item.reason}`);
    return item.message ?? item.reason ?? '';
  };
  return (
    <li className="space-y-1.5 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', STATUS_STYLE[item.status as keyof typeof STATUS_STYLE])} aria-hidden />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
        <span className={cn('shrink-0 text-xs', STATUS_STYLE[item.status as keyof typeof STATUS_STYLE])}>{t(`status.${item.status}`)}</span>
      </div>
      {item.status === 'refused' ? <p className="text-xs text-destructive">{reason()}</p> : null}
      {item.status !== 'refused' && !compact ? changesByCategory(plan).map((g) => (
        <div key={g.category} className="space-y-0.5 ps-6">
          <ul className="space-y-0.5 text-xs">
            {g.changes.map((c) => (
              <li key={c.field} className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-muted-foreground">{label(c.field)}:</span>
                <span className="break-words line-through decoration-muted-foreground/60">{editValueText(c.field, c.before, fmt)}</span>
                <ArrowLeft className="h-3 w-3 shrink-0 self-center text-muted-foreground ltr:rotate-180" aria-label={te('to')} />
                <span className="break-words font-medium">{editValueText(c.field, c.after, fmt)}</span>
              </li>
            ))}
          </ul>
          {effects(g.category, plan).map((line) => (
            <p key={line} className="text-[11px] text-amber-700 dark:text-amber-400">{line}</p>
          ))}
        </div>
      )) : null}
      {item.status !== 'refused' && (item.unchangedFields ?? []).length ? (
        <p className="ps-6 text-[11px] text-muted-foreground">{t('unchangedFields', { fields: (item.unchangedFields ?? []).map(label).join(', ') })}</p>
      ) : null}
    </li>
  );
}
