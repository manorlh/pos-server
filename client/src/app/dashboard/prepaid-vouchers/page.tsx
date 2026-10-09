'use client';

/**
 * Prepaid vouchers (שוברי הפקה): batches of vouchers worth goods ("1 נקניקייה + 1 שתייה")
 * handed to an event's production team and redeemed at the tills by QR.
 *
 * Make a batch (goods, count, event name, logo, free text, validity, shops, one-time or
 * in parts), follow it (issued / partly used / used), look at a voucher's redemptions,
 * cancel a voucher or the whole batch, and print: a PDF of the batch or of one voucher,
 * or straight to a ticket / card printer at the page size picked. The cloud is the only
 * ledger; the server decides who may see which batch (app/services/prepaid_vouchers.py).
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  Ban,
  FileDown,
  History,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  FileSpreadsheet,
  Printer,
  TicketCheck,
  X,
} from 'lucide-react';
import { fetchCompanies, fetchShops, uploadBrandingImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  addPrepaidVouchers,
  assignPrepaidGroups,
  cancelPrepaidBatch,
  cancelPrepaidVoucher,
  createPrepaidBatch,
  downloadPrepaidVouchersFile,
  fetchAllPrepaidVouchers,
  fetchFilteredPrepaidBatches,
  fetchPrepaidBatches,
  fetchPrepaidVoucherRows,
  fetchPrepaidTypes,
  updatePrepaidBatch,
  type PrepaidBarcodeType,
  type PrepaidBatchEditBody,
  type PrepaidPricing,
  type PrepaidRedemptionAccounting,
  type PrepaidVoucher,
  type PrepaidVoucherBatch,
  type PrepaidVoucherStatus,
} from '@/lib/prepaidVouchersApi';
import { groupPlan, groupSizeOf, serialRange, type GroupMode } from '@/lib/prepaidVoucherGroups';
import { batchFormProblems, issueTotals } from '@/lib/prepaidBatchForm';
import {
  addRequest,
  ATTEMPT_TIMEOUT_MS,
  batchKeys,
  duplicateOf,
  sessionStore,
  submitWithKey,
  type PrepaidDuplicateRef,
  type SubmitPhase,
} from '@/lib/prepaidBatchSubmit';
import { changedFields, touchesContents } from '@/lib/prepaidBatchEdit';
import { useBatchEditSave } from '@/components/dashboard/prepaid-vouchers/batch-edit';
import { EventPicker, PrepaidProductionsView, ProductionPicker } from '@/components/dashboard/prepaid-vouchers/productions';
import { OfflineAssignmentPanel } from '@/components/dashboard/prepaid-vouchers/offline-assignment';
import {
  BATCH_SORTS,
  EMPTY_FILTERS,
  VOUCHER_STATES,
  VOUCHER_VIEWS,
  activeFilterCount,
  filtersToQuery,
  rateText,
  type VoucherFilters,
  type VoucherView,
} from '@/lib/prepaidVoucherFilters';
import { downloadExcel } from '@/lib/excelExport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { STATE_STYLE, VoucherRowsTable, voucherSheet } from '@/components/dashboard/prepaid-vouchers/all-vouchers';
import { MultiPicker, VoucherFilterBar, useVoucherFacets, useVoucherPageState } from '@/components/dashboard/prepaid-vouchers/voucher-filters';
import { TillsReport } from '@/components/dashboard/prepaid-vouchers/tills-report';
import { SettlementView } from '@/components/dashboard/prepaid-vouchers/settlement/settlement-view';
import { ExtraReports } from '@/components/dashboard/prepaid-vouchers/extras/extra-reports';
import { ExtrasView } from '@/components/dashboard/prepaid-vouchers/extras/extras-view';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { VoucherSearch, type SearchPick } from '@/components/dashboard/prepaid-vouchers/voucher-search';
import { DEFAULT_WEIGHT_UNIT, itemText, quantityNumberText } from '@/lib/prepaidVoucherProducts';
import { GoodsEditor, type DraftItem } from '@/components/dashboard/prepaid-vouchers/goods-editor';
import {
  PrepaidTypesView,
  ToggleFields,
  TypeSummary,
  policyBody,
  policyState,
  type PolicyState,
} from '@/components/dashboard/prepaid-vouchers/voucher-types';
import { discountDraftErrors, isDiscountKind, moneyText, type PrepaidVoucherKind } from '@/lib/prepaidVoucherBenefit';
import {
  BatchRulesCard,
  DEFAULT_RULES,
  DiscountTermsFields,
  EMPTY_DISCOUNT_TERMS,
  KindPicker,
  RulesFields,
  stackingBody,
  stackingValid,
  useBatchTermsText,
  type DiscountTermsState,
  type RulesState,
} from '@/components/dashboard/prepaid-vouchers/voucher-terms';
import { PrepaidBatchGroupsView } from '@/components/dashboard/prepaid-vouchers/batch-groups';
import { cn } from '@/lib/utils';
import { formatDate, isoDate } from '@/lib/format';
import {
  PAGE_PRESETS,
  VoucherPreview,
  geometryOf,
  printVouchers,
  type PagePresetId,
  type PrintLayout,
} from '@/components/dashboard/prepaid-vouchers/voucher-print';
import { PrepaidBatchReportView } from '@/components/dashboard/prepaid-vouchers/batch-report';
import { VoucherDistributionView } from '@/components/dashboard/prepaid-vouchers/distribution/distribution-view';
import { VoucherNote, VoucherNoteButton } from '@/components/dashboard/prepaid-vouchers/voucher-note';
import { RedemptionHistory } from '@/components/dashboard/prepaid-vouchers/redemption-history';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const PAGE_SIZE = 100;
const LAYOUT_KEY = 'prepaidVouchers.layout';

function day(iso: string | null | undefined): string {
  return isoDate(iso) ? formatDate(iso) : '';
}

/** `yyyy-mm-dd` from a date input → the start / end of that day, local time, as ISO. */
function dayBoundIso(value: string, end: boolean): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const at = end ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
  return at.toISOString();
}

const STATUS_STYLE: Record<PrepaidVoucherStatus, string> = {
  active: 'bg-primary/10 text-primary',
  partially_used: 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  used: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  cancelled: 'bg-destructive/10 text-destructive',
};

function useErrorText() {
  const t = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && detail.startsWith('prepaid_voucher_') && t.has(`errors.${detail}`)) {
      return t(`errors.${detail}`);
    }
    return axiosErrorToToastMessage(err, tc('error'));
  };
}

/** "100 קבוצות של 10 …" — what a run of [count] in groups of [size] comes out as; null when not grouped. */
function useGroupPlanText() {
  const t = useTranslations('prepaidVouchers.create');
  return (count: number, size: number | null): string | null => {
    const plan = groupPlan(count, size);
    if (!plan) return null;
    if (plan.full === 0) return t('groupPlanSingle', { last: plan.last ?? 0 });
    if (plan.last) return t('groupPlanUneven', { full: plan.full, size: plan.size, last: plan.last, groups: plan.groups });
    return t('groupPlanEven', { groups: plan.groups, size: plan.size });
  };
}

/** None / 10 / 20 / a custom size — the same control on the new-batch form and on "split into groups". */
function GroupSizePicker({ mode, custom, onMode, onCustom, idPrefix }: {
  mode: GroupMode;
  custom: string;
  onMode: (m: GroupMode) => void;
  onCustom: (v: string) => void;
  idPrefix: string;
}) {
  const t = useTranslations('prepaidVouchers.create');
  const modes: GroupMode[] = ['none', '10', '20', 'custom'];
  const label = (m: GroupMode) =>
    m === 'none' ? t('groupingNone') : m === 'custom' ? t('groupingCustom') : t(m === '10' ? 'grouping10' : 'grouping20');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label>{t('groupingLabel')}</Label>
        <Select value={mode} onValueChange={(v) => v && onMode(v as GroupMode)} items={modes.map((m) => ({ value: m, label: label(m) }))}>
          <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {modes.map((m) => (
              <SelectItem key={m} value={m} label={label(m)}>{label(m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {mode === 'custom' ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-group-size`}>{t('groupSizeCustom')}</Label>
          <Input id={`${idPrefix}-group-size`} type="number" min={1} max={5000} className="h-9 w-28" value={custom}
            onChange={(e) => onCustom(e.target.value)} />
        </div>
      ) : null}
    </div>
  );
}

function BarcodeTypePicker({ value, onChange, disabled }: {
  value: PrepaidBarcodeType;
  onChange: (v: PrepaidBarcodeType) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.create');
  const types: PrepaidBarcodeType[] = ['qr', 'code128'];
  const label = (v: PrepaidBarcodeType) => (v === 'qr' ? t('barcodeQr') : t('barcodeCode128'));
  return (
    <div className="space-y-1">
      <Label>{t('barcodeType')}</Label>
      <Select value={value} disabled={disabled} onValueChange={(v) => v && onChange(v as PrepaidBarcodeType)}
        items={types.map((v) => ({ value: v, label: label(v) }))}>
        <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {types.map((v) => (
            <SelectItem key={v} value={v} label={label(v)}>{label(v)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * A weight typed as text ("0.5"), taken when the field is left or Enter is pressed — so "0." can be
 * typed. Keyed by its value where it is used: a +/- or a commit starts it afresh.
 */
/** A number field's text ('' for none). */
const numText = (v: number | null | undefined) => (v == null ? '' : String(v));

/**
 * The new-batch form — and, with [editing], "ערוך סדרה": the same form opened with the batch's own
 * settings (a snapshot: its type is not read again). Mounted afresh each time it opens to edit.
 */
function CreateBatchDialog({ open, onOpenChange, onCreated, editing = null }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (b: PrepaidVoucherBatch) => void;
  editing?: PrepaidVoucherBatch | null;
}) {
  const t = useTranslations('prepaidVouchers.create');
  const te = useTranslations('prepaidVouchers.edit');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const ed = editing;

  const [name, setName] = useState(ed?.name ?? '');
  const [eventName, setEventName] = useState(ed?.eventName ?? '');
  const [freeText, setFreeText] = useState(ed?.freeText ?? '');
  const [logoUrl, setLogoUrl] = useState<string | null>(ed?.logoUrl ?? null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [companyId, setCompanyId] = useState(ed?.companyId ?? '');
  const [shopIds, setShopIds] = useState<string[]>(ed?.shopIds ?? []);
  const [validFrom, setValidFrom] = useState(ed ? day(ed.validFrom) : '');
  const [validUntil, setValidUntil] = useState(ed ? day(ed.validUntil) : '');
  const [splitAllowed, setSplitAllowed] = useState(ed?.splitAllowed ?? false);
  const issued = ed ? (ed.issuedCount ?? ed.stats.total) : 0;
  const [count, setCount] = useState(ed ? String(issued) : '50');
  const [items, setItems] = useState<DraftItem[]>(() => (ed?.items ?? []).map((i) => ({
    product: { id: i.productId, name: i.name, price: 0, isWeighed: !!i.weighed, unitLabel: i.unitLabel ?? null },
    quantity: i.quantity,
  })));
  // The type it is issued from (the spec's §2); '' — the form says it all (a type of its own).
  const [typeId, setTypeId] = useState('');
  // Without a type: its value at the till and price to the production (₪, optional).
  const [tillValue, setTillValue] = useState(numText(ed?.tillValue));
  const [productionPrice, setProductionPrice] = useState(numText(ed?.productionPrice));
  // Editing: how a redemption is priced, as the batch says (a new batch: fixed with a value).
  const [pricing, setPricing] = useState<PrepaidPricing>(ed?.pricing ?? 'cover');
  const [allowTopUp, setAllowTopUp] = useState(ed?.allowTopUp ?? true);
  // The three toggles, set at setup (a type brings its own).
  // How the till books a redemption: a document deduction by default.
  const [accounting, setAccounting] = useState<PrepaidRedemptionAccounting>(ed?.redemptionAccounting ?? 'discount');
  // "הצג תוקף על השובר": on by default.
  const [showValidity, setShowValidity] = useState(ed ? ed.showValidity !== false : true);
  const [offlineAllowed, setOfflineAllowed] = useState(ed?.offlineAllowed ?? false);
  const [policy, setPolicy] = useState<PolicyState>(policyState(ed?.discountBlockPolicy));
  // Production (docs/SPEC_VOUCHER_PRODUCTION.md): groups, the code under the barcode, the barcode, who ordered.
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [groupCustom, setGroupCustom] = useState('');
  const [showCode, setShowCode] = useState(ed?.showCode ?? false);
  // "הצגת הפריטים על השובר": on by default; off prints the voucher without its goods / benefit.
  const [showItems, setShowItems] = useState(ed ? ed.showItems !== false : true);
  // "נוצר על ידי Runner Systems" at the bottom of the voucher: on by default.
  const [showCredit, setShowCredit] = useState(ed ? ed.showCredit !== false : true);
  const [barcodeType, setBarcodeType] = useState<PrepaidBarcodeType>(ed?.barcodeType ?? 'qr');
  const [customerName, setCustomerName] = useState(ed?.customerName ?? '');
  const [orderRef, setOrderRef] = useState(ed?.orderRef ?? '');
  // The production it is made for and its event (§13): picked from lists; their names are printed.
  const [productionId, setProductionId] = useState(ed?.production?.id ?? '');
  const [reportEventId, setReportEventId] = useState(ed?.reportEvent?.id ?? '');
  // Kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7).
  const [kind, setKind] = useState<PrepaidVoucherKind>(ed?.kind ?? 'items');
  const [terms, setTerms] = useState<DiscountTermsState>(() => (ed
    ? {
        discountType: ed.discountType ?? 'fixed',
        value: numText(ed.discountValue),
        minPurchase: numText(ed.minPurchase),
        maxDiscount: numText(ed.maxDiscount),
        // The chips: the products by the names they were printed with (products first, then categories).
        products: (ed.targets?.productIds ?? []).map((id, n) => ({ id, name: ed.targets?.names?.[n] ?? id, price: 0 })),
        categoryIds: ed.targets?.categoryIds ?? [],
        maxUnits: ed.maxUnits ? String(ed.maxUnits) : '1',
      }
    : EMPTY_DISCOUNT_TERMS));
  const [rules, setRules] = useState<RulesState>(() => (ed
    ? {
        stacking: ed.stacking ?? 'single',
        maxVouchersPerSale: ed.maxVouchersPerSale ? String(ed.maxVouchersPerSale) : '',
        promotionPolicy: ed.promotionPolicy ?? 'exclude',
        usesPerVoucher: String(ed.usesPerVoucher ?? 1),
        maxUsesPerSale: String(ed.maxUsesPerSale ?? 1),
        maxUsesPerDay: ed.maxUsesPerDay ? String(ed.maxUsesPerDay) : '',
      }
    : DEFAULT_RULES));
  // Goods: "כולל תוספות" — paid options and a meal's upcharges covered too (§7.14). Off by default.
  const [includeExtras, setIncludeExtras] = useState(ed?.includeExtras ?? false);
  // "החל גם על שוברים במימוש חלקי": new contents reach the partly redeemed vouchers too.
  const [applyToPartial, setApplyToPartial] = useState(false);
  const groupsBatch = ed?.selection === 'groups';
  // The company's active types (its own and its parents').
  const types = useQuery({
    queryKey: ['prepaid-voucher-types', companyId, 'active'],
    queryFn: () => fetchPrepaidTypes({ companyId, includeInactive: false }),
    enabled: open && !!companyId,
  });
  const chosen = typeId ? (types.data?.items ?? []).find((x) => x.id === typeId) ?? null : null;
  const pricesVisible = ed ? !!ed.pricesVisible : !!types.data?.pricesVisible;
  const discount = isDiscountKind(chosen ? chosen.kind : kind);
  const termErrors = chosen ? [] : discountDraftErrors({
    kind,
    discountType: terms.discountType,
    value: terms.value,
    minPurchase: terms.minPurchase,
    maxDiscount: terms.maxDiscount,
    targetCount: terms.products.length + terms.categoryIds.length,
    maxUnits: terms.maxUnits,
    usesPerVoucher: rules.usesPerVoucher,
    maxUsesPerSale: rules.maxUsesPerSale,
    maxUsesPerDay: rules.maxUsesPerDay,
  });
  const planText = useGroupPlanText();

  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: open });
  useEffect(() => {
    if (!companyId && companies.data?.length === 1) setCompanyId(companies.data[0].id);
  }, [companies.data, companyId]);
  const shops = useQuery({ queryKey: ['shops', companyId], queryFn: () => fetchShops(companyId), enabled: open && !!companyId });

  const reset = () => {
    setName('');
    setEventName('');
    setFreeText('');
    setLogoUrl(null);
    setShopIds([]);
    setValidFrom('');
    setValidUntil('');
    setSplitAllowed(false);
    setCount('50');
    setItems([]);
    setTypeId('');
    setTillValue('');
    setProductionPrice('');
    setAccounting('discount');
    setShowValidity(true);
    setOfflineAllowed(false);
    setPolicy(policyState());
    setGroupMode('none');
    setGroupCustom('');
    setShowCode(false);
    setShowItems(true);
    setShowCredit(true);
    setBarcodeType('qr');
    setCustomerName('');
    setOrderRef('');
    setProductionId('');
    setReportEventId('');
    setKind('items');
    setTerms(EMPTY_DISCOUNT_TERMS);
    setRules(DEFAULT_RULES);
    setIncludeExtras(false);
  };

  const n = parseInt(count, 10);
  const groupSize = groupSizeOf(groupMode, groupCustom);
  const groupOk = groupMode === 'none' || groupSize !== null;
  const plan = groupOk ? planText(n, groupSize) : null;
  // What is still missing, said in words under the button (not just a disabled button).
  const problems = batchFormProblems({
    name, companyId, discount, itemCount: chosen ? Math.max(1, chosen.items.length) : groupsBatch ? 1 : items.length,
    termErrors: termErrors.length, count: n, groupOk, validFrom, validUntil,
    stackingOk: chosen ? true : stackingValid(rules),
  });
  // Editing: never fewer vouchers than were issued, and a fixed value has its value.
  const editProblems = ed
    ? [
        Number.isFinite(n) && n < issued ? te('problem.countBelowIssued', { n: issued }) : null,
        !discount && pricing === 'fixed' && !tillValue.trim() ? te('problem.value') : null,
      ].filter((x): x is string => !!x)
    : [];
  const canCreate = problems.length === 0 && editProblems.length === 0;
  // "100 שוברים … זכאות ל-300 יחידות" — what the run entitles to in all, before it is issued.
  const totals = discount ? null : issueTotals(n, chosen
    ? chosen.items.map((i) => ({ quantity: i.quantity, weighed: i.weighed, unitLabel: i.unitLabel }))
    : items.map((i) => ({ quantity: i.quantity, weighed: i.product.isWeighed, unitLabel: i.product.unitLabel })),
  DEFAULT_WEIGHT_UNIT);
  const decimal = (v: string) => (v.trim() ? Number(v) : null);

  const common = {
    name: name.trim(),
    companyId,
    shopIds: shopIds.length ? shopIds : null,
    eventName: eventName.trim() || null,
    logoUrl,
    freeText: freeText.trim() || null,
    validFrom: dayBoundIso(validFrom, false),
    validUntil: dayBoundIso(validUntil, true),
    count: n,
    groupSize,
    showCode,
    showItems,
    showCredit,
    showValidity,
    barcodeType,
    customerName: customerName.trim() || null,
    orderRef: orderRef.trim() || null,
    productionId: productionId || null,
    reportEventId: reportEventId || null,
  };
  // "ערוך סדרה": the settings as the PATCH reads them — sent only where they differ from how the
  // form opened (lib/prepaidBatchEdit.ts changedFields), the cloud plans and confirms the rest.
  const editSnapshot = (): PrepaidBatchEditBody => {
    const out: PrepaidBatchEditBody = {
      name: name.trim(),
      customerName: customerName.trim() || null,
      eventName: eventName.trim() || null,
      orderRef: orderRef.trim() || null,
      freeText: freeText.trim() || null,
      logoUrl,
      showItems, showValidity, showCredit, showCode, barcodeType,
      validFrom: dayBoundIso(validFrom, false),
      validUntil: dayBoundIso(validUntil, true),
      shopIds: shopIds.length ? [...shopIds].sort() : null,
      count: n,
      productionId: productionId || null,
      reportEventId: reportEventId || null,
      ...stackingBody(rules),
    };
    if (pricesVisible) out.productionPrice = decimal(productionPrice);
    if (!discount) {
      Object.assign(out, {
        offlineAllowed, redemptionAccounting: accounting, discountBlockPolicy: policyBody(policy),
        pricing, tillValue: decimal(tillValue), allowTopUp: pricing === 'cover' && allowTopUp,
        includeExtras, splitAllowed,
      });
      if (!groupsBatch) out.items = items.map((i) => ({ productId: i.product.id, quantity: i.quantity }));
    } else {
      Object.assign(out, {
        discountType: terms.discountType, discountValue: decimal(terms.value),
        minPurchase: kind === 'order_discount' ? decimal(terms.minPurchase) : null,
        maxDiscount: kind === 'order_discount' && terms.discountType === 'percent' ? decimal(terms.maxDiscount) : null,
        maxUnits: kind === 'item_discount' ? parseInt(terms.maxUnits, 10) || 1 : null,
        targets: kind === 'item_discount' ? { productIds: terms.products.map((p) => p.id), categoryIds: terms.categoryIds } : null,
        promotionPolicy: rules.promotionPolicy,
        usesPerVoucher: parseInt(rules.usesPerVoucher, 10) || 1,
        maxUsesPerSale: parseInt(rules.maxUsesPerSale, 10) || 1,
        maxUsesPerDay: rules.maxUsesPerDay.trim() ? parseInt(rules.maxUsesPerDay, 10) : null,
      });
    }
    return out;
  };
  // How the form opened: taken once, from the very same function (no change: nothing sent).
  const [opened] = useState<PrepaidBatchEditBody | null>(() => (ed ? editSnapshot() : null));
  const editBody = opened ? (changedFields(opened as Record<string, unknown>, editSnapshot() as Record<string, unknown>) as PrepaidBatchEditBody) : {};
  const contentsChanged = touchesContents(editBody as Record<string, unknown>);
  const partial = ed?.stats.partiallyUsed ?? 0;
  const editSave = useBatchEditSave(ed, (b) => onCreated?.(b));
  const saveEdit = async () => {
    const body: PrepaidBatchEditBody = contentsChanged && applyToPartial ? { ...editBody, applyToPartial: true } : editBody;
    if (await editSave.save(body)) onOpenChange(false);
  };

  // One Idempotency-Key per submission (lib/prepaidBatchSubmit.ts): a retry of the same form —
  // automatic after a lost answer, "נסה שוב", the dialog reopened, the page reloaded — gets the same
  // batch back from the server, never a second one.
  const [keys] = useState(() => batchKeys(sessionStore()));
  const [phase, setPhase] = useState<SubmitPhase>('idle');
  const [lostAnswer, setLostAnswer] = useState(false);
  const createBody = (): Parameters<typeof createPrepaidBatch>[0] => chosen
      ? { ...common, typeId: chosen.id, splitAllowed: false, items: [] }
      : {
        ...common,
        tillValue: decimal(tillValue),
        productionPrice: pricesVisible ? decimal(productionPrice) : null,
        redemptionAccounting: discount ? 'discount' : accounting,
        offlineAllowed,
        discountBlockPolicy: discount ? { mode: 'honour' } : policyBody(policy),
        splitAllowed: discount ? false : splitAllowed,
        items: discount ? [] : items.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
        includeExtras: discount ? false : includeExtras,
        count: n,
        groupSize,
        showCode,
        showItems,
        showCredit,
        barcodeType,
        customerName: customerName.trim() || null,
        orderRef: orderRef.trim() || null,
        kind,
        ...stackingBody(rules),
        ...(discount
          ? {
              discountType: terms.discountType,
              discountValue: decimal(terms.value),
              minPurchase: kind === 'order_discount' ? decimal(terms.minPurchase) : null,
              maxDiscount: kind === 'order_discount' && terms.discountType === 'percent' ? decimal(terms.maxDiscount) : null,
              maxUnits: kind === 'item_discount' ? parseInt(terms.maxUnits, 10) || 1 : null,
              targets: kind === 'item_discount' ? { productIds: terms.products.map((p) => p.id), categoryIds: terms.categoryIds } : null,
              promotionPolicy: rules.promotionPolicy,
              usesPerVoucher: parseInt(rules.usesPerVoucher, 10) || 1,
              maxUsesPerSale: parseInt(rules.maxUsesPerSale, 10) || 1,
              maxUsesPerDay: rules.maxUsesPerDay.trim() ? parseInt(rules.maxUsesPerDay, 10) : null,
            }
          : {}),
      };
  const create = useMutation({
    mutationFn: async () => {
      const body = createBody();
      setLostAnswer(false);
      const res = await submitWithKey(
        keys, body,
        (key) => createPrepaidBatch(body, { idempotencyKey: key, timeoutMs: ATTEMPT_TIMEOUT_MS }),
        { onPhase: setPhase },
      );
      if (!res.ok) {
        // No answer even after the re-checks: the batch may exist — "נסה שוב" asks with the same key.
        setLostAnswer(res.retryable);
        throw res.error;
      }
      return res.value;
    },
    onSuccess: (b) => {
      setLostAnswer(false);
      toast.success(t('created', { count: b.stats.total }));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      reset();
      onOpenChange(false);
      onCreated?.(b);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  // The voucher as it will print, while the form is being filled (the same SVG as the batch screen's).
  const manualDraft: PrepaidVoucherBatch = {
    id: 'draft', name: name.trim() || t('title'), eventName: eventName.trim() || null, logoUrl,
    freeText: freeText.trim() || null, validFrom: dayBoundIso(validFrom, false), validUntil: dayBoundIso(validUntil, true),
    splitAllowed: discount ? false : splitAllowed, status: 'active', companyId, companyName: null, shopIds: null, shops: [],
    items: discount ? [] : items.map((i) => ({
      productId: i.product.id, name: i.product.name, quantity: i.quantity, weighed: i.product.isWeighed, unitLabel: i.product.unitLabel,
    })),
    stats: { total: 0, active: 0, partiallyUsed: 0, used: 0, cancelled: 0 }, createdAt: null, cancelledAt: null,
    showCode, showItems, showCredit, barcodeType, includeExtras: !discount && includeExtras, kind,
    discountType: discount ? terms.discountType : null, discountValue: discount ? decimal(terms.value) : null,
    minPurchase: kind === 'order_discount' ? decimal(terms.minPurchase) : null,
    maxDiscount: kind === 'order_discount' && terms.discountType === 'percent' ? decimal(terms.maxDiscount) : null,
    maxUnits: kind === 'item_discount' ? parseInt(terms.maxUnits, 10) || 1 : null,
    targets: kind === 'item_discount'
      ? { productIds: terms.products.map((x) => x.id), categoryIds: terms.categoryIds, names: terms.products.map((x) => x.name) }
      : null,
    usesPerVoucher: parseInt(rules.usesPerVoucher, 10) || 1,
    tillValue: decimal(tillValue), pricing: tillValue.trim() ? 'fixed' : 'cover',
  };
  const draft: PrepaidVoucherBatch = chosen
    ? {
        ...manualDraft, kind: chosen.kind, items: chosen.items, includeExtras: chosen.includeExtras,
        splitAllowed: chosen.splitAllowed, discountType: chosen.discountType, discountValue: chosen.discountValue,
        minPurchase: chosen.minPurchase, maxDiscount: chosen.maxDiscount, maxUnits: chosen.maxUnits, targets: chosen.targets,
        usesPerVoucher: chosen.usesPerVoucher, benefitText: chosen.benefitText,
        typeName: chosen.origin === 'manual' ? chosen.name : null, tillValue: chosen.tillValue, pricing: chosen.pricing,
        printTillValue: chosen.printTillValue,
      }
    : manualDraft;
  const draftVoucher = {
    id: 'draft', serial: 1, displayCode: 'XXXX-XXXX-XXXX-XXXX', qrPayload: 'PV:SAMPLE', groupNo: groupSize ? 1 : null,
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadBrandingImage(file, 'logo');
      setLogoUrl(url);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ed ? te('title') : t('title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {ed ? (
            <div className="space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <p>{te('intro')}</p>
              {ed.type?.origin === 'manual' && ed.type.name ? <p>{te('typeLine', { name: ed.type.name, version: ed.type.version })}</p> : null}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-name">{t('name')}</Label>
              <Input id="pv-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-event">{t('eventName')}</Label>
              <Input id="pv-event" value={eventName} maxLength={200} onChange={(e) => setEventName(e.target.value)} placeholder={t('eventNamePlaceholder')} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ProductionPicker companyId={companyId} value={productionId} current={ed?.production ?? null}
              onChange={(id, pname) => {
                setProductionId(id);
                // "עבור מי" is the production's name (the cloud keeps them in step).
                if (id && pname) setCustomerName(pname);
              }} />
            <EventPicker companyId={companyId} value={reportEventId} current={ed?.reportEvent ?? null}
              onChange={(id, ename) => {
                setReportEventId(id);
                // The printed event name: the event's, unless one was typed.
                if (id && ename && !eventName.trim()) setEventName(ename);
              }} />
          </div>

          {ed ? null : (
          <div className="space-y-1">
            <Label>{t('type')}</Label>
            <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
              value={typeId} onChange={(ev) => setTypeId(ev.target.value)} disabled={!companyId} aria-label={t('type')}>
              <option value="">{t('typeNone')}</option>
              {(types.data?.items ?? []).map((x) => (
                <option key={x.id} value={x.id}>{x.code ? `${x.name} (${x.code})` : x.name}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{companyId ? t('typeHint') : t('pickCompany')}</p>
          </div>
          )}
          {chosen ? <TypeSummary type={chosen} /> : (<>
          {ed ? (
            <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">{te('kindFixed')}</p>
          ) : <KindPicker value={kind} onChange={setKind} />}
          {discount ? <DiscountTermsFields kind={kind} companyId={companyId} shopIds={shopIds} value={terms} onChange={setTerms} errors={termErrors} /> : null}

          {!discount && groupsBatch ? (
            <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
              {te('groupsReadOnly', { groups: (ed?.groups ?? []).map((g) => `${g.name} (${g.minQty}–${g.maxQty})`).join(' · ') })}
            </p>
          ) : null}
          {!discount && !groupsBatch ? <GoodsEditor companyId={companyId} shopIds={shopIds} items={items} onChange={setItems} enabled={open} /> : null}

          {!discount ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('includeExtras')}</p>
                <p className="text-xs text-muted-foreground">{includeExtras ? t('includeExtrasOn') : t('includeExtrasOff')}</p>
              </div>
              <Switch checked={includeExtras} onCheckedChange={(v) => setIncludeExtras(!!v)} aria-label={t('includeExtras')} />
            </div>
          ) : null}

          {!discount ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pv-till-value">{t('tillValue')}</Label>
                <Input id="pv-till-value" inputMode="decimal" value={tillValue} onChange={(ev) => setTillValue(ev.target.value)}
                  placeholder={t('tillValuePlaceholder')} />
                <p className="text-xs text-muted-foreground">{ed ? te(`pricingHint.${pricing}`) : tillValue.trim() ? t('tillValueFixed') : t('tillValueNone')}</p>
              </div>
              {pricesVisible ? (
                <div className="space-y-1">
                  <Label htmlFor="pv-production-price">{t('productionPrice')}</Label>
                  <Input id="pv-production-price" inputMode="decimal" value={productionPrice} onChange={(ev) => setProductionPrice(ev.target.value)} />
                  <p className="text-xs text-muted-foreground">{ed ? te('priceHint') : t('productionPriceHint')}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          {!discount && ed ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pv-pricing">{te('field.pricing')}</Label>
                <select id="pv-pricing" className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
                  value={pricing} onChange={(ev) => setPricing(ev.target.value as PrepaidPricing)}>
                  <option value="fixed">{te('choice.pricing.fixed')}</option>
                  <option value="cover">{te('choice.pricing.cover')}</option>
                </select>
              </div>
              {pricing === 'cover' ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <p className="min-w-0 text-sm font-medium">{te('field.allowTopUp')}</p>
                  <Switch checked={allowTopUp} onCheckedChange={(v) => setAllowTopUp(!!v)} aria-label={te('field.allowTopUp')} />
                </div>
              ) : null}
            </div>
          ) : null}
          {!discount ? (
            <div className="rounded-lg border p-3">
              <ToggleFields
                accounting={accounting} onAccounting={setAccounting}
                offlineAllowed={offlineAllowed} onOfflineAllowed={setOfflineAllowed}
                policy={policy} onPolicy={setPolicy} overrideEditable={!!types.data?.overrideEditable}
              />
            </div>
          ) : null}
          </>)}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-count">{ed ? te('field.count') : t('count')}</Label>
              <Input id="pv-count" type="number" min={ed ? Math.max(1, issued) : 1} max={ed ? issued + 5000 : 5000} value={count}
                onChange={(ev) => setCount(ev.target.value)} />
              {ed ? <p className="text-xs text-muted-foreground">{te('countHint', { n: issued })}</p> : null}
            </div>
            {!discount && !chosen ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{splitAllowed ? t('splitOn') : t('splitOff')}</p>
                  <p className="text-xs text-muted-foreground">{splitAllowed ? t('splitOnHint') : t('splitOffHint')}</p>
                </div>
                <Switch checked={splitAllowed} onCheckedChange={(v) => setSplitAllowed(!!v)} aria-label={t('splitLabel')} />
              </div>
            ) : null}
          </div>

          {!chosen ? (
            <div className="rounded-lg border p-3">
              <RulesFields kind={kind} value={rules} onChange={setRules} />
            </div>
          ) : null}

          {ed && contentsChanged ? (
            <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/30">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={applyToPartial}
                onChange={(ev) => setApplyToPartial(ev.target.checked)} disabled={partial === 0} />
              <span className="min-w-0">
                <span className="block font-medium">{te('applyToPartial')}</span>
                <span className="block text-xs text-muted-foreground">
                  {partial > 0 ? te('applyToPartialHint', { n: partial }) : te('applyToPartialNone')}
                </span>
              </span>
            </label>
          ) : null}

          {ed ? null : (
          <div className="space-y-2 rounded-lg border p-3">
            <GroupSizePicker mode={groupMode} custom={groupCustom} onMode={setGroupMode} onCustom={setGroupCustom} idPrefix="pv-create" />
            {!groupOk ? (
              <p className="text-xs text-destructive">{t('groupSizeInvalid')}</p>
            ) : plan ? (
              <p className="text-sm font-medium" aria-live="polite">{plan}</p>
            ) : null}
          </div>
          )}

          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('showItems')}</p>
              <p className="text-xs text-muted-foreground">{showItems ? t('showItemsOn') : t('showItemsOff')}</p>
            </div>
            <Switch checked={showItems} onCheckedChange={(v) => setShowItems(!!v)} aria-label={t('showItems')} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('showCode')}</p>
                <p className="text-xs text-muted-foreground">{t('showCodeHint')}</p>
              </div>
              <Switch checked={showCode} onCheckedChange={(v) => setShowCode(!!v)} aria-label={t('showCode')} />
            </div>
            <BarcodeTypePicker value={barcodeType} onChange={setBarcodeType} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={showCredit}
              onChange={(e) => setShowCredit(e.target.checked)} />
            {t('showCredit')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={showValidity}
              onChange={(e) => setShowValidity(e.target.checked)} />
            {t('showValidity')}
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-customer">{t('customerName')}</Label>
              <Input id="pv-customer" value={customerName} maxLength={200} onChange={(e) => setCustomerName(e.target.value)}
                placeholder={t('customerPlaceholder')} disabled={!!productionId} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-order">{t('orderRef')}</Label>
              <Input id="pv-order" value={orderRef} maxLength={100} onChange={(e) => setOrderRef(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-from">{t('validFrom')}</Label>
              <DatePicker id="pv-from" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-until">{t('validUntil')}</Label>
              <DatePicker id="pv-until" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pv-text">{t('freeText')}</Label>
            <textarea
              id="pv-text"
              rows={3}
              value={freeText}
              maxLength={1000}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder={t('freeTextPlaceholder')}
              className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </div>

          <div className="space-y-1">
            <Label>{t('logo')}</Label>
            <div className="flex items-center gap-3">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="" className="h-12 w-auto max-w-32 rounded border object-contain" />
              ) : null}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { void uploadLogo(e.target.files?.[0]); e.target.value = ''; }} />
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                {logoUrl ? t('logoReplace') : t('logoUpload')}
              </Button>
              {logoUrl ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setLogoUrl(null)}>{t('logoRemove')}</Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t('company')}</Label>
              <Select
                value={companyId}
                disabled={!!ed}
                onValueChange={(v) => {
                  setCompanyId(String(v ?? ''));
                  setShopIds([]);
                  // A production and an event are a company's: they go with it.
                  setProductionId('');
                  setReportEventId('');
                  // What another company may carry is another list: the picks go with the company.
                  setItems([]);
                  setTerms((cur) => ({ ...cur, products: [], categoryIds: [] }));
                }}
                items={(companies.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder={t('pickCompany')} /></SelectTrigger>
                <SelectContent>
                  {(companies.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('shops')}</Label>
              <EntityMultiSelect
                label={t('shops')}
                options={(shops.data ?? []).map((s) => ({ id: s.id, label: s.name }))}
                selected={shopIds}
                onChange={setShopIds}
                allLabel={t('allShops')}
                clearLabel={t('allShops')}
                emptyLabel={t('noShops')}
                disabled={!companyId}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t('preview')}</Label>
            <div className="overflow-x-auto rounded-lg border bg-muted/30 p-2">
              <VoucherPreview batch={draft} voucher={draftVoucher} layout={{ preset: 'ticket80x50' }} />
            </div>
          </div>
        </div>
        <div className="space-y-1 text-sm" aria-live="polite">
          {totals && totals.units + totals.weights.length > 0 && Number.isFinite(n) && n > 0 ? (
            <p className="font-medium">
              {t('totals', { count: n, units: totals.units })}
              {totals.weights.map((x) => ` ${t('totalsWeight', { quantity: quantityNumberText(x.quantity), unit: x.unit })}`).join('')}
            </p>
          ) : null}
          {problems.length || editProblems.length ? (
            <p className="text-xs text-muted-foreground">
              {t('missing', { list: [...problems.map((p) => t(`problem.${p}`)), ...editProblems].join(', ') })}
            </p>
          ) : null}
          {!ed && create.isPending && phase === 'checking' ? (
            <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('checking')}
            </p>
          ) : !ed && lostAnswer && !create.isPending ? (
            <p role="status" aria-live="polite" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
              {t('lostAnswer')}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tc('cancel')}</Button>
          {ed ? (
            <Button onClick={() => void saveEdit()} disabled={!canCreate || editSave.busy || Object.keys(editBody).length === 0}>
              {editSave.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
              {te('submit')}
            </Button>
          ) : (
            <Button onClick={() => create.mutate()} disabled={!canCreate || create.isPending}>
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TicketCheck className="h-4 w-4" />}
              {create.isPending && phase === 'checking'
                ? t('checking')
                : lostAnswer && !create.isPending
                  ? t('retrySame')
                  : t('submit', { count: Number.isFinite(n) ? n : 0 })}
            </Button>
          )}
        </DialogFooter>
        {editSave.dialog}
      </DialogContent>
    </Dialog>
  );
}

// ── Batch list ────────────────────────────────────────────────────────────────

function StatsBar({ b }: { b: PrepaidVoucherBatch }) {
  const t = useTranslations('prepaidVouchers.stats');
  const s = b.stats;
  const pct = (x: number) => (s.total ? `${(x / s.total) * 100}%` : '0%');
  return (
    <div className="space-y-1">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="bg-emerald-500" style={{ width: pct(s.used) }} />
        <div className="bg-amber-400" style={{ width: pct(s.partiallyUsed) }} />
        <div className="bg-destructive/60" style={{ width: pct(s.cancelled) }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{t('total', { n: s.total })}</span>
        <span>{t('active', { n: s.active })}</span>
        <span>{t('partiallyUsed', { n: s.partiallyUsed })}</span>
        <span>{t('used', { n: s.used })}</span>
        {s.cancelled ? <span>{t('cancelled', { n: s.cancelled })}</span> : null}
      </p>
    </div>
  );
}

/** What a batch is worth, in a line: its goods, or what its discount gives. */
function contentsText(b: PrepaidVoucherBatch, benefit: string | null): string {
  // "2× נקניקייה + 0.5 ק״ג זיתים" — a weight by its unit (§7.14).
  return benefit ?? b.items.map((i) => itemText(i)).join(' + ');
}

function validityText(b: PrepaidVoucherBatch, t: (k: string, v?: Record<string, string>) => string): string {
  if (b.validFrom && b.validUntil) return t('row.validity', { from: day(b.validFrom), to: day(b.validUntil) });
  if (b.validUntil) return t('row.validUntil', { date: day(b.validUntil) });
  if (b.validFrom) return t('row.validFrom', { date: day(b.validFrom) });
  return t('row.noValidity');
}

function BatchCard({ b, onOpen }: { b: PrepaidVoucherBatch; onOpen: () => void }) {
  const t = useTranslations('prepaidVouchers');
  const ts = useTranslations('prepaidVouchers.scope');
  const termsText = useBatchTermsText()(b);
  const discount = isDiscountKind(b.kind);
  const f = b.figures;
  const statusKey = b.state
    ? (['cancelled', 'not_started', 'expired', 'fully_redeemed'] as const).find((k) => b.state![k]) ?? 'active'
    : null;
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full space-y-2 rounded-xl bg-card p-3 text-start ring-1 ring-foreground/10 hover:ring-foreground/25">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">
              {b.customerName ? t('row.forWhom', { name: b.customerName }) : <span className="text-muted-foreground">{t('row.noCustomer')}</span>}
            </p>
            <p className="truncate text-sm">{b.eventName ? `${b.eventName} · ${b.name}` : b.name}</p>
            <p className="truncate text-xs text-muted-foreground">{contentsText(b, termsText.benefit)}</p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]',
            discount ? 'bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-300' : 'bg-muted')}>
            {termsText.kind}
          </span>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', b.status === 'cancelled' ? STATUS_STYLE.cancelled : STATUS_STYLE.active)}>
            {statusKey ? ts(`batchStatuses.${statusKey}`) : t(`batchStatus.${b.status}`)}
          </span>
        </div>
        {f ? (
          <p className="flex flex-wrap gap-x-3 text-xs">
            <span>{t('row.issued', { n: f.issued })}</span>
            <span className="font-medium">{t('row.redeemed', { n: f.redeemed })} {t('row.rate', { rate: rateText(f.rate) })}</span>
            <span>{t('row.open', { n: f.open })}</span>
            <span className="text-muted-foreground">{validityText(b, t)}</span>
          </p>
        ) : null}
        <StatsBar b={b} />
        <p className="text-xs text-muted-foreground">
          {termsText.uses ?? (b.splitAllowed ? t('card.splitAllowed') : t('card.oneTime'))}
          {!discount && b.includeExtras ? ` · ${t('create.includeExtras')}` : ''}
          {' · '}
          {b.shops.length ? b.shops.map((s) => s.name).join(', ') : t('allShopsOf', { company: b.companyName ?? '' })}
        </p>
      </button>
    </li>
  );
}

// ── Batch detail ──────────────────────────────────────────────────────────────

function readLayout(): PrintLayout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (raw) return JSON.parse(raw) as PrintLayout;
  } catch {
    /* private window */
  }
  return { preset: 'ticket80x50' };
}

function LayoutPicker({ layout, onChange }: { layout: PrintLayout; onChange: (l: PrintLayout) => void }) {
  const t = useTranslations('prepaidVouchers.layout');
  const ids: PagePresetId[] = [...PAGE_PRESETS.map((p) => p.id), 'custom'];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label>{t('label')}</Label>
        <Select
          value={layout.preset}
          onValueChange={(v) => v && onChange({ ...layout, preset: v as PagePresetId })}
          items={ids.map((id) => ({ value: id, label: t(id) }))}
        >
          <SelectTrigger className="h-9 w-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ids.map((id) => (
              <SelectItem key={id} value={id} label={t(id)}>{t(id)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {layout.preset === 'custom' ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="pv-w">{t('width')}</Label>
            <Input id="pv-w" type="number" min={30} max={300} className="h-9 w-24" value={layout.width ?? 80}
              onChange={(e) => onChange({ ...layout, width: Number(e.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pv-h">{t('height')}</Label>
            <Input id="pv-h" type="number" min={30} max={300} className="h-9 w-24" value={layout.height ?? 50}
              onChange={(e) => onChange({ ...layout, height: Number(e.target.value) })} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function BatchDetail({ batch, onBack }: { batch: PrepaidVoucherBatch; onBack: () => void }) {
  const t = useTranslations('prepaidVouchers');
  const tk = useTranslations('prepaidVouchers.kinds');
  const ta = useTranslations('prepaidVouchers.allVouchers');
  const ts = useTranslations('prepaidVouchers.scope');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const termsText = useBatchTermsText()(batch);
  const discount = isDiscountKind(batch.kind);

  const [layout, setLayoutState] = useState<PrintLayout>({ preset: 'ticket80x50' });
  useEffect(() => setLayoutState(readLayout()), []);
  const setLayout = (l: PrintLayout) => {
    setLayoutState(l);
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    } catch {
      /* private window */
    }
  };

  // The vouchers' filters (the shared model, lib/prepaidVoucherFilters.ts): state, group, words,
  // redeemed between, at which till, by whom — filtered and paged on the server.
  const [vf, setVf] = useState<VoucherFilters>(EMPTY_FILTERS);
  const setFilter = (next: VoucherFilters) => { setVf(next); setOffset(0); };
  const [exporting, setExporting] = useState(false);
  const facets = useVoucherFacets();
  const [offset, setOffset] = useState(0);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [view, setView] = useState<'vouchers' | 'groups' | 'report' | 'distribution'>('vouchers');
  const td = useTranslations('voucherDistribution');
  // "ערוך סדרה": the batch's form, opened with its own settings.
  const [editOpen, setEditOpen] = useState(false);
  const [addCount, setAddCount] = useState('10');
  const [busy, setBusy] = useState<string | null>(null);
  const [assignMode, setAssignMode] = useState<GroupMode>('10');
  const [assignCustom, setAssignCustom] = useState('');
  const planText = useGroupPlanText();
  const voucherQuery = filtersToQuery({ ...vf, batchId: [batch.id] });
  const list = useQuery({
    queryKey: ['prepaid-vouchers', batch.id, voucherQuery.toString(), offset],
    queryFn: () => fetchPrepaidVoucherRows(voucherQuery, PAGE_SIZE, offset),
  });
  const exportVouchers = async () => {
    setExporting(true);
    try {
      const rows = await fetchAllPages((page, size) => fetchPrepaidVoucherRows(voucherQuery, size, (page - 1) * size), { pageSize: 1000 });
      await downloadExcel([voucherSheet(rows, ta, ts)], `${fileBase} — ${ta('sheet')}`);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', batch.id] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-groups', batch.id] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', batch.id] });
  };

  // Print settings: only what the next print looks like changes (the code under the barcode,
  // the goods on the voucher, the barcode).
  const saveSettings = useMutation({
    mutationFn: (body: { showCode?: boolean; showItems?: boolean; showCredit?: boolean; showValidity?: boolean; printTillValue?: boolean; barcodeType?: PrepaidBarcodeType }) =>
      updatePrepaidBatch(batch.id, body),
    onSuccess: () => { toast.success(t('production.settingsSaved')); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });
  // The free text ("טקסט חופשי (מודפס)") after creation: what the next print says.
  const [freeText, setFreeText] = useState(batch.freeText ?? '');
  useEffect(() => setFreeText(batch.freeText ?? ''), [batch.freeText]);
  const freeTextChanged = freeText.trim() !== (batch.freeText ?? '').trim();
  const saveFreeText = useMutation({
    mutationFn: () => updatePrepaidBatch(batch.id, { freeText: freeText.trim() || null }),
    onSuccess: () => { toast.success(t('production.freeTextSaved')); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });
  const assignSize = groupSizeOf(assignMode, assignCustom);
  const assignGroups = useMutation({
    mutationFn: () => assignPrepaidGroups(batch.id, assignSize ?? 0),
    onSuccess: (b) => { toast.success(t('production.assigned', { n: b.groupCount ?? 0 })); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });

  const cancelBatch = useMutation({
    mutationFn: () => cancelPrepaidBatch(batch.id),
    onSuccess: () => { toast.success(t('batchCancelled')); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });
  const cancelOne = useMutation({
    mutationFn: (id: string) => cancelPrepaidVoucher(id),
    onSuccess: (v) => { toast.success(t('voucherCancelled', { serial: v.serial })); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });
  // "הוסף שוברים" exactly once (lib/prepaidBatchSubmit.ts): one Idempotency-Key per submission, a
  // lost answer re-checked ("בודק אם השוברים נוספו…") and "נסה שוב" with the same key.
  const [addKeys] = useState(() => batchKeys(sessionStore()));
  const [addPhase, setAddPhase] = useState<SubmitPhase>('idle');
  const [addLost, setAddLost] = useState(false);
  const addMore = useMutation({
    mutationFn: async () => {
      const count = parseInt(addCount, 10);
      setAddLost(false);
      const res = await submitWithKey(
        addKeys, addRequest(batch.id, count),
        (key) => addPrepaidVouchers(batch.id, count, null, { idempotencyKey: key, timeoutMs: ATTEMPT_TIMEOUT_MS }),
        { onPhase: setAddPhase },
      );
      if (!res.ok) {
        setAddLost(res.retryable);
        throw res.error;
      }
      return res.value;
    },
    onSuccess: (b) => { setAddLost(false); toast.success(t('added', { total: b.stats.total })); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });

  const fileBase = (batch.eventName || batch.name).trim();

  // PDF and ZIP are drawn on the server — the same file in every browser (the browser-side
  // rasterising came out blank on some, e.g. Safari / iPhone).
  const serverFile = (
    format: 'pdf' | 'zip' | 'groups' | 'csv',
    l: PrintLayout,
    fileName: string,
    voucherId?: string,
    group?: number,
  ) =>
    downloadPrepaidVouchersFile(batch.id, {
      format,
      layout: l.preset,
      width: l.preset === 'custom' ? l.width : undefined,
      height: l.preset === 'custom' ? l.height : undefined,
      voucherId,
      group,
      fileName,
    });

  const runAll = async (kind: 'print' | 'pdf' | 'zip' | 'groups' | 'csv') => {
    setBusy(kind === 'print' ? t('printPreparing') : t('fileServerPreparing'));
    try {
      if (kind === 'groups' || kind === 'csv') {
        // A file per group (each opened by its cover sheet) and the codes' manifest, in one ZIP.
        await serverFile(kind, layout, kind === 'csv' ? `${fileBase}.csv` : `${fileBase}.zip`);
        return;
      }
      if (kind !== 'print') {
        // A ZIP holds a file per voucher: one voucher per page, even for an A4 sheet.
        const l: PrintLayout = kind === 'zip' && layout.preset === 'a4grid' ? { preset: 'a6' } : layout;
        await serverFile(kind, l, `${fileBase}.${kind}`);
        return;
      }
      const all = (await fetchAllPrepaidVouchers(batch.id)).filter((v) => v.status !== 'cancelled' && v.status !== 'used');
      if (!all.length) {
        toast.error(t('nothingToPrint'));
        return;
      }
      await printVouchers(batch, all, layout, fileBase);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const runOne = async (v: PrepaidVoucher, kind: 'print' | 'pdf') => {
    const name = `${fileBase}-${String(v.serial).padStart(4, '0')}`;
    setBusy(kind === 'pdf' ? t('fileServerPreparing') : t('printPreparing'));
    try {
      // A single voucher on a sheet layout still gets a page of its own.
      const one: PrintLayout = layout.preset === 'a4grid' ? { preset: 'a6' } : layout;
      if (kind === 'print') await printVouchers(batch, [v], one, name);
      else await serverFile('pdf', one, `${name}.pdf`, v.id);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const groupPdf = async (group: number, range: [number, number]) => {
    setBusy(t('fileServerPreparing'));
    try {
      await serverFile('pdf', layout, `${fileBase}-${group}-${serialRange(range[0], range[1])}.pdf`, undefined, group);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const sample = list.data?.items[0] ?? {
    id: 'sample', serial: 1, displayCode: 'XXXX-XXXX-XXXX-XXXX', qrPayload: 'PV:SAMPLE', groupNo: batch.groupCount ? 1 : null,
  };
  const cancelled = batch.status === 'cancelled';
  const grouped = (batch.groupCount ?? 0) > 0;
  const narrowLine = batch.barcodeType === 'code128' && geometryOf(layout).cardW < 70;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowRight className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" aria-hidden />
          {t('back')}
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold">{batch.eventName || batch.name}</h2>
          <p className="text-sm text-muted-foreground">
            {batch.eventName ? `${batch.name} · ` : ''}
            {contentsText(batch, termsText.benefit)}
          </p>
          <p className="text-xs text-muted-foreground">
            {termsText.kind}
            {discount ? ` · ${tk('notTender')}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            {termsText.uses ?? (batch.splitAllowed ? t('card.splitAllowed') : t('card.oneTime'))}
            {` · ${tk(`stacking.${batch.stacking ?? 'single'}`)}`}
            {batch.maxVouchersPerSale ? ` · ${tk('maxVouchersShort', { n: batch.maxVouchersPerSale })}` : null}
            {discount ? ` · ${tk(`promotionPolicy.${batch.promotionPolicy ?? 'exclude'}`)}` : ''}
            {batch.validFrom ? ` · ${t('validFrom', { date: day(batch.validFrom) })}` : ''}
            {batch.validUntil ? ` · ${t('validUntil', { date: day(batch.validUntil) })}` : ''}
            {' · '}
            {batch.shops.length ? batch.shops.map((s) => s.name).join(', ') : t('allShopsOf', { company: batch.companyName ?? '' })}
          </p>
          {batch.type ? (
            <p className="text-xs text-muted-foreground">
              {[
                batch.type.origin === 'manual' && batch.type.name
                  ? t('typeLine', { name: batch.type.name, code: batch.type.code ?? '', version: batch.type.version })
                  : t('typeOwn'),
                batch.type.currentVersion && batch.type.currentVersion > batch.type.version
                  ? t('typeNewer', { n: batch.type.currentVersion }) : null,
                !discount && batch.tillValue != null ? t('tillValueIs', { v: moneyText(Math.round(batch.tillValue * 100)) }) : null,
                !discount && batch.pricesVisible && batch.productionPrice != null
                  ? t('productionPriceIs', { v: moneyText(Math.round(batch.productionPrice * 100)) }) : null,
                !discount ? t(`pricingShort.${batch.pricing ?? 'cover'}`) : null,
                !discount ? t(`accountingShort.${batch.redemptionAccounting ?? 'zero'}`) : null,
                batch.offlineAllowed ? t('offlineShort') : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {batch.customerName || batch.orderRef || batch.reportEvent ? (
            <p className="text-xs text-muted-foreground">
              {[
                batch.customerName ? t('production.customer', { name: batch.customerName }) : null,
                batch.orderRef ? t('production.order', { ref: batch.orderRef }) : null,
                batch.reportEvent ? t('productions.eventLine', { name: batch.reportEvent.name }) : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-[11px]', cancelled ? STATUS_STYLE.cancelled : STATUS_STYLE.active)}>
            {t(`batchStatus.${batch.status}`)}
          </span>
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} className="print:hidden">
            <Pencil className="h-4 w-4" />
            {t('edit.button')}
          </Button>
        </div>
      </div>
      {editOpen ? <CreateBatchDialog open editing={batch} onOpenChange={setEditOpen} onCreated={refresh} /> : null}

      <StatsBar b={batch} />
      {!discount && !cancelled ? <BatchToggles batch={batch} onSaved={refresh} /> : null}

      <div className="flex gap-1 print:hidden" role="tablist" aria-label={t('viewLabel')}>
        {(['vouchers', 'groups', 'report', 'distribution'] as const).map((v) => (
          <Button key={v} role="tab" aria-selected={view === v} size="sm"
            variant={view === v ? 'default' : 'outline'} onClick={() => setView(v)}>
            {v === 'distribution' ? td('tab') : t(`view.${v}`)}
          </Button>
        ))}
      </div>

      {view === 'distribution' ? <VoucherDistributionView batch={batch} /> : view === 'report' ? <PrepaidBatchReportView batch={batch} /> : view === 'groups' ? (
        <PrepaidBatchGroupsView batch={batch} busy={!!busy} onGroupPdf={(g, r) => void groupPdf(g, r)} />
      ) : (<>
      <Card>
        <CardHeader>
          <CardTitle>{t('printTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <LayoutPicker layout={layout} onChange={setLayout} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('create.showCode')}</p>
                <p className="text-xs text-muted-foreground">{t('create.showCodeHint')}</p>
              </div>
              <Switch checked={!!batch.showCode} disabled={saveSettings.isPending || cancelled}
                onCheckedChange={(v) => saveSettings.mutate({ showCode: !!v })} aria-label={t('create.showCode')} />
            </div>
            <BarcodeTypePicker value={batch.barcodeType ?? 'qr'} disabled={saveSettings.isPending || cancelled}
              onChange={(v) => saveSettings.mutate({ barcodeType: v })} />
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('create.showItems')}</p>
                <p className="text-xs text-muted-foreground">
                  {batch.showItems === false ? t('create.showItemsOff') : t('create.showItemsOn')}
                </p>
              </div>
              <Switch checked={batch.showItems !== false} disabled={saveSettings.isPending || cancelled}
                onCheckedChange={(v) => saveSettings.mutate({ showItems: !!v })} aria-label={t('create.showItems')} />
            </div>
            <label className="flex items-center gap-2 self-center text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={batch.showCredit !== false}
                disabled={saveSettings.isPending || cancelled}
                onChange={(e) => saveSettings.mutate({ showCredit: e.target.checked })} />
              {t('create.showCredit')}
            </label>
            <label className="flex items-center gap-2 self-center text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={batch.showValidity !== false}
                disabled={saveSettings.isPending || cancelled}
                onChange={(e) => saveSettings.mutate({ showValidity: e.target.checked })} />
              {t('create.showValidity')}
            </label>
            {!discount && batch.tillValue != null ? (
              <label className="flex items-center gap-2 self-center text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={!!batch.printTillValue}
                  disabled={saveSettings.isPending || cancelled}
                  onChange={(e) => saveSettings.mutate({ printTillValue: e.target.checked })} />
                {t('printTillValue')}
              </label>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pv-free-text-edit">{t('create.freeText')}</Label>
            <textarea
              id="pv-free-text-edit"
              rows={3}
              value={freeText}
              maxLength={1000}
              disabled={cancelled}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder={t('create.freeTextPlaceholder')}
              className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('production.freeTextHint')}</p>
              <Button size="sm" variant="outline" disabled={!freeTextChanged || saveFreeText.isPending || cancelled}
                onClick={() => saveFreeText.mutate()}>
                {saveFreeText.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('production.freeTextSave')}
              </Button>
            </div>
          </div>
          {narrowLine ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('production.code128Narrow')}</p> : null}
          <div className="overflow-x-auto py-1">
            {/* The free text as being typed: the preview shows what saving it will print. */}
            <VoucherPreview batch={{ ...batch, freeText: freeText.trim() || null }} voucher={sample} layout={layout} />
          </div>
          <p className="text-xs text-muted-foreground">{t('printHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void runAll('pdf')} disabled={!!busy || cancelled}>
              <FileDown className="h-4 w-4" />
              {t('pdfAll')}
            </Button>
            <Button variant="outline" onClick={() => void runAll('zip')} disabled={!!busy || cancelled}>
              <FileDown className="h-4 w-4" />
              {t('zipAll')}
            </Button>
            <Button variant="outline" onClick={() => void runAll('print')} disabled={!!busy || cancelled}>
              <Printer className="h-4 w-4" />
              {t('printAll')}
            </Button>
            <Button variant="outline" onClick={() => void runAll('csv')} disabled={!!busy} title={t('production.csvHint')}>
              <FileDown className="h-4 w-4" />
              {t('production.csv')}
            </Button>
            {busy ? (
              <span className="flex items-center gap-1 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy}
              </span>
            ) : null}
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">{t('production.title')}</p>
            {grouped ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  {t('production.groupsInfo', { groups: batch.groupCount ?? 0, size: batch.groupSize ?? 0 })}
                </p>
                <Button onClick={() => void runAll('groups')} disabled={!!busy || cancelled}>
                  <FileDown className="h-4 w-4" />
                  {t('production.zipGroups')}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{t('production.notGrouped')}</p>
                <div className="flex flex-wrap items-end gap-2">
                  <GroupSizePicker mode={assignMode} custom={assignCustom} onMode={setAssignMode} onCustom={setAssignCustom} idPrefix="pv-assign" />
                  <Button variant="outline" size="sm" disabled={!assignSize || assignGroups.isPending || cancelled}
                    onClick={() => assignGroups.mutate()}>
                    {t('production.assign')}
                  </Button>
                </div>
                {assignSize ? (
                  <p className="text-xs text-muted-foreground">{planText(batch.stats.total, assignSize)}</p>
                ) : null}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <BatchRulesCard key={`${batch.stacking}:${batch.maxVouchersPerSale}:${batch.promotionPolicy}:${batch.maxUsesPerSale}:${batch.maxUsesPerDay}`}
        batch={batch} onSaved={refresh} />

      {!cancelled ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="pv-add">{t('addLabel')}</Label>
            <Input id="pv-add" type="number" min={1} max={5000} className="h-9 w-28" value={addCount} onChange={(e) => setAddCount(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" disabled={addMore.isPending || !(parseInt(addCount, 10) >= 1)} onClick={() => addMore.mutate()}>
            {addMore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{' '}
            {addMore.isPending && addPhase === 'checking' ? t('addChecking') : addLost && !addMore.isPending ? t('addRetry') : t('add')}
          </Button>
          {addLost && !addMore.isPending ? (
            <span role="status" aria-live="polite" className="basis-full text-xs text-amber-800 dark:text-amber-200">{t('addLostAnswer')}</span>
          ) : null}
          {batch.groupSize ? (
            <span className="text-xs text-muted-foreground">{t('production.addHint', { size: batch.groupSize })}</span>
          ) : null}
          <div className="flex-1" />
          <Button
            variant="destructive"
            size="sm"
            disabled={cancelBatch.isPending}
            onClick={() => { if (window.confirm(t('confirmCancelBatch'))) cancelBatch.mutate(); }}
          >
            <Ban className="h-4 w-4" /> {t('cancelBatch')}
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <label className="block space-y-1 lg:col-span-2">
            <span className="block text-xs font-medium text-muted-foreground">{ts('qVouchers')}</span>
            <Input dir="auto" className="h-9" value={vf.q} placeholder="#12 · ABCD-EFGH-…"
              onChange={(e) => setFilter({ ...vf, q: e.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">{ts('state')}</span>
            <select className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" value={vf.state}
              onChange={(e) => setFilter({ ...vf, state: e.target.value as VoucherFilters['state'] })}>
              <option value="">{ts('stateAll')}</option>
              {VOUCHER_STATES.map((s) => <option key={s} value={s}>{ts(`states.${s}`)}</option>)}
            </select>
          </label>
          {grouped ? (
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('groupFilter')}</span>
              <Input inputMode="numeric" className="h-9" value={vf.group} placeholder={t('groupAll')}
                onChange={(e) => setFilter({ ...vf, group: e.target.value.replace(/\D/g, '') })} />
            </label>
          ) : null}
          <MultiPicker label={ts('till')} allLabel={ts('tillAll')} value={vf.machineId} onChange={(v) => setFilter({ ...vf, machineId: v })}
            options={(facets.data?.tills ?? []).map((x) => ({ id: x.id, label: x.name ?? x.id, hint: x.shopName }))} />
          <MultiPicker label={ts('employee')} allLabel={ts('employeeAll')} value={vf.employee} onChange={(v) => setFilter({ ...vf, employee: v })}
            options={(facets.data?.employees ?? []).map((x) => ({ id: x.id, label: x.name }))} />
          <label className="block space-y-1 lg:col-span-2">
            <span className="block text-xs font-medium text-muted-foreground">{ts('redeemed')}</span>
            <span className="flex items-center gap-1">
              <Input type="date" aria-label={`${ts('redeemed')} — ${ts('fromLabel')}`} className="h-9 min-w-0" value={vf.from}
                onChange={(e) => setFilter({ ...vf, from: e.target.value })} />
              <span className="text-xs text-muted-foreground">–</span>
              <Input type="date" aria-label={`${ts('redeemed')} — ${ts('toLabel')}`} className="h-9 min-w-0" value={vf.to}
                onChange={(e) => setFilter({ ...vf, to: e.target.value })} />
            </span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeFilterCount(vf) ? (
            <Button size="sm" variant="ghost" onClick={() => setFilter(EMPTY_FILTERS)}>
              <X className="h-4 w-4" /> {ts('clearAll')}
            </Button>
          ) : null}
          <span className="ms-auto text-xs text-muted-foreground">{list.data ? t('count', { n: list.data.total }) : null}</span>
          <Button size="sm" variant="outline" onClick={() => void exportVouchers()} disabled={exporting || !list.data?.total}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} {ta('export')}
          </Button>
        </div>

        {list.isPending ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : list.isError ? (
          <p className="text-sm text-destructive">{errorText(list.error)}</p>
        ) : (
          <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
            {list.data!.items.map((v) => (
              <li key={v.id} className="space-y-2 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-14 font-semibold tabular-nums">#{v.serial}</span>
                  {v.groupNo ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">{t('groupBadge', { g: v.groupNo })}</span>
                  ) : null}
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px]', STATE_STYLE[v.state])}>{ts(`states.${v.state}`)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {v.usesLeft != null
                      ? tk('usesLeft', { left: v.usesLeft, total: v.usesPerVoucher ?? batch.usesPerVoucher ?? 1 })
                      : v.items.map((i) => t('remainingOf', {
                        name: i.name,
                        left: quantityNumberText(i.remaining),
                        // By weight: "0.2/0.5 ק״ג".
                        total: i.weighed ? `${quantityNumberText(i.quantity)} ${i.unitLabel || DEFAULT_WEIGHT_UNIT}` : quantityNumberText(i.quantity),
                      })).join(' · ')}
                  </span>
                  <div className="flex gap-1">
                    <VoucherNoteButton voucher={v} onEdit={() => setEditingNote(editingNote === v.id ? null : v.id)} />
                    <Button size="icon-sm" variant="ghost" aria-label={t('history.title')} title={t('history.title')}
                      onClick={() => setOpenHistory(openHistory === v.id ? null : v.id)}>
                      <History className="h-4 w-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t('pdfOne')} title={t('pdfOne')} disabled={!!busy}
                      onClick={() => void runOne(v, 'pdf')}>
                      <FileDown className="h-4 w-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t('printOne')} title={t('printOne')} disabled={!!busy}
                      onClick={() => void runOne(v, 'print')}>
                      <Printer className="h-4 w-4" />
                    </Button>
                    {v.status === 'active' || v.status === 'partially_used' ? (
                      <Button size="icon-sm" variant="ghost" aria-label={t('cancelVoucher')} title={t('cancelVoucher')}
                        disabled={cancelOne.isPending}
                        onClick={() => { if (window.confirm(t('confirmCancelVoucher', { serial: v.serial }))) cancelOne.mutate(v.id); }}>
                        <Ban className="h-4 w-4 text-destructive" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <VoucherNote
                  key={`${v.id}:${v.note ?? ''}:${editingNote === v.id}`}
                  voucher={v}
                  editing={editingNote === v.id}
                  onDone={() => setEditingNote(null)}
                />
                {openHistory === v.id ? <RedemptionHistory voucherId={v.id} /> : null}
              </li>
            ))}
            {list.data!.items.length === 0 ? (
              <li className="p-4 text-center text-sm text-muted-foreground">{t('noVouchers')}</li>
            ) : null}
          </ul>
        )}
        {list.data && list.data.total > PAGE_SIZE ? (
          <div className="flex items-center justify-center gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              {t('previous')}
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, list.data.total)} / {list.data.total}
            </span>
            <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= list.data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              {t('next')}
            </Button>
          </div>
        ) : null}
      </div>
      </>)}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * The three toggles on an issued batch — editable after issue (each redemption records the mode it
 * used): "נכנס כאמצעי תשלום ולסה״כ הכללי", "מימוש ללא אינטרנט" and the discount-block policy.
 */
function BatchToggles({ batch, onSaved }: { batch: PrepaidVoucherBatch; onSaved: () => void }) {
  const t = useTranslations('prepaidVouchers');
  const types = useQuery({
    queryKey: ['prepaid-voucher-types', 'flags'],
    queryFn: () => fetchPrepaidTypes({ includeInactive: false }),
  });
  const [policy, setPolicy] = useState<PolicyState>(policyState(batch.discountBlockPolicy));
  // Accounting, offline and the policy apply to redemptions from now on: planned and confirmed first ("ערוך סדרה").
  const edit = useBatchEditSave(batch, () => onSaved());
  const policyChanged = JSON.stringify(policyBody(policy)) !== JSON.stringify(policyBody(policyState(batch.discountBlockPolicy)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('togglesTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('togglesHint')}</p>
        <ToggleFields
          accounting={batch.redemptionAccounting ?? 'zero'} onAccounting={(v) => void edit.save({ redemptionAccounting: v })}
          offlineAllowed={!!batch.offlineAllowed} onOfflineAllowed={(v) => void edit.save({ offlineAllowed: v })}
          policy={policy} onPolicy={setPolicy} overrideEditable={!!types.data?.overrideEditable} disabled={edit.busy}
        />
        {policyChanged ? (
          <Button size="sm" onClick={() => void edit.save({ discountBlockPolicy: policyBody(policy) })} disabled={edit.busy}>
            {t('togglesSavePolicy')}
          </Button>
        ) : null}
        {/* "מימוש ללא אינטרנט": the assignment to a till or the shop's LAN host (§7). */}
        {batch.offlineAllowed ? <OfflineAssignmentPanel batch={batch} /> : null}
        {edit.dialog}
      </CardContent>
    </Card>
  );
}

export default function PrepaidVouchersPage() {
  const t = useTranslations('prepaidVouchers');
  const ts = useTranslations('prepaidVouchers.scope');
  const errorText = useErrorText();
  const [creating, setCreating] = useState(false);
  // `?batch=<id>`: the control board's "שוברים" card opens a voucher's batch directly.
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('batch'));
  // The answer of a new batch named an identical one made a moment ago (a lost answer retried
  // without its key — an old tab, a reload): offered for cancelling, never blocked.
  const [duplicate, setDuplicate] = useState<PrepaidDuplicateRef | null>(null);
  // The view, the sort and every filter live in the URL (lib/prepaidVoucherFilters.ts): a filtered
  // view is a link, and the views share one set of filters.
  const [page, setPage] = useVoucherPageState();
  // "התחשבנות" only with its section; "בקרה ובדיקות" always (its simulator is for everyone, its controls ask their own).
  const access = useDashboardAccess();
  const views = VOUCHER_VIEWS.filter((v) => v !== 'settlement' || canAccess(access, 'prepaid_voucher_settlement', 'view'));
  const { view: urlView, sort, filters } = page;
  const view: VoucherView = views.includes(urlView) ? urlView : 'batches';
  const setView = (v: VoucherView) => setPage({ ...page, view: v });
  const setFilters = (f: VoucherFilters) => setPage({ ...page, filters: f });
  const facets = useVoucherFacets();

  const batches = useQuery({ queryKey: ['prepaid-voucher-batches'], queryFn: fetchPrepaidBatches });
  const selected = batches.data?.find((b) => b.id === selectedId) ?? null;
  const listQuery = filtersToQuery(filters, ['state', 'group']);
  const shown = useQuery({
    queryKey: ['prepaid-voucher-batches', 'filtered', listQuery.toString(), sort],
    queryFn: () => fetchFilteredPrepaidBatches(listQuery, sort),
    enabled: view === 'batches' && !selectedId,
  });

  const onPick = (p: SearchPick) => {
    if (p.kind === 'batch') {
      setSelectedId(p.batch.id);
      return;
    }
    setSelectedId(null);
    if (p.kind === 'voucher') setPage({ ...page, view: 'vouchers', filters: { ...EMPTY_FILTERS, q: p.code } });
    else if (p.kind === 'till') setPage({ ...page, view: 'tills', filters: { ...filters, machineId: [p.id] } });
    else setPage({ ...page, view: 'tills', filters: { ...filters, employee: [p.id] } });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {!selected && view === 'batches' ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t('new')}
          </Button>
        ) : null}
      </div>

      {duplicate ? (
        <DuplicateBatchNotice dup={duplicate} onOpen={() => setSelectedId(duplicate.id)} onDone={() => setDuplicate(null)} />
      ) : null}

      {!selected ? <VoucherSearch onPick={onPick} /> : null}

      {!selected ? (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('tabs.label')}>
          {views.map((v) => (
            <Button key={v} role="tab" aria-selected={view === v} size="sm" variant={view === v ? 'default' : 'outline'} onClick={() => setView(v)}>
              {t(`tabs.${v}`)}
            </Button>
          ))}
        </div>
      ) : null}

      {!selected && view !== 'types' && view !== 'productions' && view !== 'settlement' && view !== 'extras' ? (
        <VoucherFilterBar view={view} value={filters} onChange={setFilters} facets={facets.data} />
      ) : null}

      {selected ? (
        <BatchDetail key={selected.id} batch={selected} onBack={() => setSelectedId(null)} />
      ) : view === 'types' ? (
        <PrepaidTypesView />
      ) : view === 'productions' ? (
        <PrepaidProductionsView />
      ) : view === 'vouchers' ? (
        <VoucherRowsTable filters={filters} onQuery={(q) => setFilters({ ...filters, q })} />
      ) : view === 'tills' ? (
        <TillsReport filters={filters} />
      ) : view === 'settlement' ? (
        <SettlementView />
      ) : view === 'reports' ? (
        <ExtraReports filters={filters} />
      ) : view === 'extras' ? (
        <ExtrasView />
      ) : batches.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : batches.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <span>{errorText(batches.error)}</span>
          <Button variant="outline" size="sm" onClick={() => void batches.refetch()}>{t('retry')}</Button>
        </div>
      ) : (batches.data ?? []).length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative min-w-48 flex-1">
              <Input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                placeholder={ts('qBatches')} aria-label={ts('qBatches')} dir="auto" />
            </div>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              {ts('sort')}
              <select className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground dark:bg-input/30"
                value={sort} onChange={(e) => setPage({ ...page, sort: e.target.value as typeof sort })}>
                {BATCH_SORTS.map((s) => <option key={s} value={s}>{ts(`sorts.${s}`)}</option>)}
              </select>
            </label>
            <span className="text-xs text-muted-foreground">
              {shown.data ? ts('count', { shown: shown.data.total, total: batches.data!.length }) : null}
            </span>
          </div>
          {shown.isPending ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : shown.isError ? (
            <p className="text-sm text-destructive">{errorText(shown.error)}</p>
          ) : shown.data!.items.length ? (
            <ul className="space-y-2">
              {shown.data!.items.map((b) => (
                <BatchCard key={b.id} b={b} onOpen={() => setSelectedId(b.id)} />
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('filters.none')}</p>
          )}
        </>
      )}

      <CreateBatchDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(b) => { setSelectedId(b.id); setDuplicate(duplicateOf(b)); }}
      />
    </div>
  );
}

/**
 * "נראה שאצווה זהה נוצרה לפני רגע — לבטל את הכפולה?" — the earlier identical batch the server named
 * (`possibleDuplicate`): cancelled through the existing batch cancel, with its reason in the audit.
 */
function DuplicateBatchNotice({ dup, onOpen, onDone }: { dup: PrepaidDuplicateRef; onOpen: () => void; onDone: () => void }) {
  const t = useTranslations('prepaidVouchers.create.duplicate');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelPrepaidBatch(dup.id, dup.cancelReason),
    onSuccess: () => {
      toast.success(t('cancelled'));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      onDone();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const at = dup.createdAt ? new Date(dup.createdAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{t('title')}</p>
        <p className="text-xs">{t('details', { name: dup.name, count: dup.count, time: at })}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={cancel.isPending}
          onClick={() => { if (window.confirm(t('confirm', { reason: dup.cancelReason }))) cancel.mutate(); }}
        >
          {cancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} {t('cancel')}
        </Button>
        <Button size="sm" variant="outline" onClick={onOpen}>{t('open')}</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>{t('keep')}</Button>
      </div>
    </div>
  );
}
