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
  Minus,
  Plus,
  Printer,
  Search,
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
  fetchPrepaidBatches,
  fetchPrepaidVoucher,
  fetchPrepaidVouchers,
  searchPrepaidProducts,
  updatePrepaidBatch,
  type PrepaidBarcodeType,
  type PrepaidProductOption,
  type PrepaidVoucher,
  type PrepaidVoucherBatch,
  type PrepaidVoucherStatus,
} from '@/lib/prepaidVouchersApi';
import { groupPlan, groupSizeOf, serialRange, type GroupMode } from '@/lib/prepaidVoucherGroups';
import {
  NO_BATCH_FILTERS,
  batchFormProblems,
  filterBatches,
  issueTotals,
  type BatchFilters,
} from '@/lib/prepaidBatchForm';
import { clampQuantity, DEFAULT_WEIGHT_UNIT, itemText, quantityNumberText, quantityStep } from '@/lib/prepaidVoucherProducts';
import { PrepaidProductPickList } from '@/components/dashboard/prepaid-vouchers/product-pick-list';
import { discountDraftErrors, isDiscountKind, type PrepaidVoucherKind } from '@/lib/prepaidVoucherBenefit';
import {
  BatchRulesCard,
  DEFAULT_RULES,
  DiscountTermsFields,
  EMPTY_DISCOUNT_TERMS,
  KindPicker,
  RulesFields,
  useBatchTermsText,
  type DiscountTermsState,
  type RulesState,
} from '@/components/dashboard/prepaid-vouchers/voucher-terms';
import { PrepaidBatchGroupsView } from '@/components/dashboard/prepaid-vouchers/batch-groups';
import { cn } from '@/lib/utils';
import { formatDate, formatDateTime, isoDate } from '@/lib/format';
import {
  PAGE_PRESETS,
  VoucherPreview,
  geometryOf,
  printVouchers,
  type PagePresetId,
  type PrintLayout,
} from '@/components/dashboard/prepaid-vouchers/voucher-print';
import { PrepaidBatchReportView } from '@/components/dashboard/prepaid-vouchers/batch-report';
import { VoucherNote, VoucherNoteButton } from '@/components/dashboard/prepaid-vouchers/voucher-note';
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

function time(iso: string | null | undefined): string {
  return isoDate(iso) ? formatDateTime(iso) : '';
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
function WeightInput({ value, label, onCommit }: { value: number; label: string; onCommit: (q: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const q = Number(text.replace(',', '.'));
    if (Number.isFinite(q) && q > 0) onCommit(q);
    else setText(String(value));
  };
  return (
    <Input inputMode="decimal" aria-label={label} className="h-8 w-20 text-center tabular-nums" value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}

interface DraftItem {
  product: PrepaidProductOption;
  quantity: number;
}

function CreateBatchDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (b: PrepaidVoucherBatch) => void;
}) {
  const t = useTranslations('prepaidVouchers.create');
  const te = useTranslations('prepaidVouchers.eligibility');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [eventName, setEventName] = useState('');
  const [freeText, setFreeText] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [companyId, setCompanyId] = useState('');
  const [shopIds, setShopIds] = useState<string[]>([]);
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [splitAllowed, setSplitAllowed] = useState(false);
  const [count, setCount] = useState('50');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  // Production (docs/SPEC_VOUCHER_PRODUCTION.md): groups, the code under the barcode, the barcode, who ordered.
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [groupCustom, setGroupCustom] = useState('');
  const [showCode, setShowCode] = useState(false);
  // "הצגת הפריטים על השובר": on by default; off prints the voucher without its goods / benefit.
  const [showItems, setShowItems] = useState(true);
  // "נוצר על ידי Runner Systems" at the bottom of the voucher: on by default.
  const [showCredit, setShowCredit] = useState(true);
  const [barcodeType, setBarcodeType] = useState<PrepaidBarcodeType>('qr');
  const [customerName, setCustomerName] = useState('');
  const [orderRef, setOrderRef] = useState('');
  // Kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7).
  const [kind, setKind] = useState<PrepaidVoucherKind>('items');
  const [terms, setTerms] = useState<DiscountTermsState>(EMPTY_DISCOUNT_TERMS);
  const [rules, setRules] = useState<RulesState>(DEFAULT_RULES);
  // Goods: "כולל תוספות" — paid options and a meal's upcharges covered too (§7.14). Off by default.
  const [includeExtras, setIncludeExtras] = useState(false);
  const discount = isDiscountKind(kind);
  const termErrors = discountDraftErrors({
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

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: open });
  useEffect(() => {
    if (!companyId && companies.data?.length === 1) setCompanyId(companies.data[0].id);
  }, [companies.data, companyId]);
  const shops = useQuery({ queryKey: ['shops', companyId], queryFn: () => fetchShops(companyId), enabled: open && !!companyId });
  // Every product, each with whether it can go on and why not; a till's own product depends on the shops.
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', companyId, debounced, 'items', shopIds],
    queryFn: () => searchPrepaidProducts(debounced, companyId, { purpose: 'items', shopIds }),
    enabled: open && !!companyId,
  });

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
    setSearch('');
    setGroupMode('none');
    setGroupCustom('');
    setShowCode(false);
    setShowItems(true);
    setShowCredit(true);
    setBarcodeType('qr');
    setCustomerName('');
    setOrderRef('');
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
    name, companyId, discount, itemCount: items.length, termErrors: termErrors.length, count: n, groupOk, validFrom, validUntil,
  });
  const canCreate = problems.length === 0;
  // "100 שוברים … זכאות ל-300 יחידות" — what the run entitles to in all, before it is issued.
  const totals = discount ? null : issueTotals(n, items.map((i) => ({
    quantity: i.quantity, weighed: i.product.isWeighed, unitLabel: i.product.unitLabel,
  })), DEFAULT_WEIGHT_UNIT);
  const decimal = (v: string) => (v.trim() ? Number(v) : null);

  const create = useMutation({
    mutationFn: () =>
      createPrepaidBatch({
        name: name.trim(),
        companyId,
        shopIds: shopIds.length ? shopIds : null,
        eventName: eventName.trim() || null,
        logoUrl,
        freeText: freeText.trim() || null,
        validFrom: dayBoundIso(validFrom, false),
        validUntil: dayBoundIso(validUntil, true),
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
        stacking: rules.stacking,
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
      }),
    onSuccess: (b) => {
      toast.success(t('created', { count: b.stats.total }));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      reset();
      onOpenChange(false);
      onCreated(b);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  // The voucher as it will print, while the form is being filled (the same SVG as the batch screen's).
  const draft: PrepaidVoucherBatch = {
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
  };
  const draftVoucher = {
    id: 'draft', serial: 1, displayCode: 'XXXX-XXXX-XXXX-XXXX', qrPayload: 'PV:SAMPLE', groupNo: groupSize ? 1 : null,
  };

  const addItem = (p: PrepaidProductOption) =>
    setItems((cur) => (cur.some((i) => i.product.id === p.id) ? cur : [...cur, { product: p, quantity: 1 }]));
  // By weight to the gram ("0.5 ק״ג"), by the piece a whole unit (the cloud checks the same).
  const setQty = (id: string, q: number) =>
    setItems((cur) => cur.map((i) => (i.product.id === id ? { ...i, quantity: clampQuantity(q, i.product.isWeighed) } : i)));

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
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
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

          <KindPicker value={kind} onChange={setKind} />
          {discount ? <DiscountTermsFields kind={kind} companyId={companyId} shopIds={shopIds} value={terms} onChange={setTerms} errors={termErrors} /> : null}

          {!discount ? (
            <div className="space-y-2">
              <Label>{t('items')}</Label>
              {items.length ? (
                <ul className="divide-y rounded-lg border">
                  {items.map((i) => (
                    <li key={i.product.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{i.product.name}</span>
                      <Button type="button" size="icon-sm" variant="outline" aria-label={t('less')}
                        onClick={() => setQty(i.product.id, i.quantity - quantityStep(i.product.isWeighed))}>
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      {i.product.isWeighed ? (
                        // Sold by weight: a decimal of its unit ("0.5 ק״ג").
                        <span className="flex items-center gap-1" title={t('weightHint')}>
                          <WeightInput key={i.quantity} value={i.quantity} label={t('weightQty', { unit: i.product.unitLabel || DEFAULT_WEIGHT_UNIT })}
                            onCommit={(q) => setQty(i.product.id, q)} />
                          <span className="text-xs text-muted-foreground">{i.product.unitLabel || DEFAULT_WEIGHT_UNIT}</span>
                        </span>
                      ) : (
                        <span className="w-6 text-center tabular-nums">{i.quantity}</span>
                      )}
                      <Button type="button" size="icon-sm" variant="outline" aria-label={t('more')}
                        onClick={() => setQty(i.product.id, i.quantity + quantityStep(i.product.isWeighed))}>
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={t('remove')}
                        onClick={() => setItems((cur) => cur.filter((x) => x.product.id !== i.product.id))}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t('itemsEmpty')}</p>
              )}
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchProducts')} className="ps-8" />
              </div>
              <div className="max-h-48 overflow-y-auto rounded-lg border">
                <PrepaidProductPickList
                  products={products.data}
                  purpose="items"
                  chosen={new Set(items.map((i) => i.product.id))}
                  onPick={addItem}
                  pending={!!companyId && products.isPending}
                  pendingText={tc('loading')}
                  emptyText={companyId ? t('noProducts') : t('pickCompany')}
                />
              </div>
              <p className="text-xs text-muted-foreground">{te('searchHint')}</p>
            </div>
          ) : null}

          {!discount ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t('includeExtras')}</p>
                <p className="text-xs text-muted-foreground">{includeExtras ? t('includeExtrasOn') : t('includeExtrasOff')}</p>
              </div>
              <Switch checked={includeExtras} onCheckedChange={(v) => setIncludeExtras(!!v)} aria-label={t('includeExtras')} />
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-count">{t('count')}</Label>
              <Input id="pv-count" type="number" min={1} max={5000} value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
            {!discount ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{splitAllowed ? t('splitOn') : t('splitOff')}</p>
                  <p className="text-xs text-muted-foreground">{splitAllowed ? t('splitOnHint') : t('splitOffHint')}</p>
                </div>
                <Switch checked={splitAllowed} onCheckedChange={(v) => setSplitAllowed(!!v)} aria-label={t('splitLabel')} />
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border p-3">
            <RulesFields kind={kind} value={rules} onChange={setRules} />
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <GroupSizePicker mode={groupMode} custom={groupCustom} onMode={setGroupMode} onCustom={setGroupCustom} idPrefix="pv-create" />
            {!groupOk ? (
              <p className="text-xs text-destructive">{t('groupSizeInvalid')}</p>
            ) : plan ? (
              <p className="text-sm font-medium" aria-live="polite">{plan}</p>
            ) : null}
          </div>

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

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-customer">{t('customerName')}</Label>
              <Input id="pv-customer" value={customerName} maxLength={200} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('customerPlaceholder')} />
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
                onValueChange={(v) => {
                  setCompanyId(String(v ?? ''));
                  setShopIds([]);
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
          {problems.length ? (
            <p className="text-xs text-muted-foreground">
              {t('missing', { list: problems.map((p) => t(`problem.${p}`)).join(', ') })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tc('cancel')}</Button>
          <Button onClick={() => create.mutate()} disabled={!canCreate || create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TicketCheck className="h-4 w-4" />}
            {t('submit', { count: Number.isFinite(n) ? n : 0 })}
          </Button>
        </DialogFooter>
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

function BatchCard({ b, onOpen }: { b: PrepaidVoucherBatch; onOpen: () => void }) {
  const t = useTranslations('prepaidVouchers');
  const termsText = useBatchTermsText()(b);
  const discount = isDiscountKind(b.kind);
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full space-y-2 rounded-xl bg-card p-3 text-start ring-1 ring-foreground/10 hover:ring-foreground/25">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{b.eventName || b.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {b.eventName ? `${b.name} · ` : ''}
              {contentsText(b, termsText.benefit)}
            </p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]',
            discount ? 'bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-300' : 'bg-muted')}>
            {termsText.kind}
          </span>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', b.status === 'cancelled' ? STATUS_STYLE.cancelled : STATUS_STYLE.active)}>
            {t(`batchStatus.${b.status}`)}
          </span>
        </div>
        <StatsBar b={b} />
        <p className="text-xs text-muted-foreground">
          {termsText.uses ?? (b.splitAllowed ? t('card.splitAllowed') : t('card.oneTime'))}
          {!discount && b.includeExtras ? ` · ${t('create.includeExtras')}` : ''}
          {b.validUntil ? ` · ${t('validUntil', { date: day(b.validUntil) })}` : ''}
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

function RedemptionHistory({ voucherId }: { voucherId: string }) {
  const t = useTranslations('prepaidVouchers.history');
  const tk = useTranslations('prepaidVouchers.kinds');
  const q = useQuery({ queryKey: ['prepaid-voucher', voucherId], queryFn: () => fetchPrepaidVoucher(voucherId) });
  // A discount voucher's use: its uses and the ₪ it took off (a discount on the sale, not a tender).
  const discountUseText = (r: { uses?: number | null; discountAmount?: number | null }) =>
    tk('historyUse', {
      uses: (r.uses ?? 1) === 1 ? tk('usesOne') : tk('usesMany', { n: r.uses ?? 1 }),
      amount: `₪${(r.discountAmount ?? 0).toFixed(2)}`,
    });
  if (q.isPending) return <Skeleton className="h-10 w-full" />;
  const rows = q.data?.redemptions ?? [];
  if (!rows.length) return <p className="text-xs text-muted-foreground">{t('empty')}</p>;
  // A weighed item reads by its unit ("0.3 ק״ג זיתים"), as the voucher's own items say.
  const byProduct = new Map((q.data?.items ?? []).map((i) => [i.productId, i]));
  const lineText = (i: { productId: string; name: string | null; quantity: number }) => {
    const item = byProduct.get(i.productId);
    return itemText({ name: i.name ?? '', quantity: i.quantity, weighed: item?.weighed, unitLabel: item?.unitLabel });
  };
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li key={r.id} className={cn('rounded border px-2 py-1', r.reversedAt && 'opacity-60')}>
          {r.reversedAt ? (
            <span className="me-1 rounded bg-muted px-1 font-medium">{t('reversed')}</span>
          ) : null}
          <span className={cn('font-medium', r.reversedAt && 'line-through')}>{time(r.redeemedAt)}</span>
          {' · '}
          {r.machineName ?? t('unknownTill')}
          {r.posUserName ? ` · ${r.posUserName}` : ''}
          {' — '}
          {r.uses ? discountUseText(r) : r.items.map(lineText).join(', ')}
          {(r.flags ?? []).map((f) => (
            <span key={f} className="ms-1 rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {tk.has(`flag.${f}`) ? tk(`flag.${f}`) : f}
            </span>
          ))}
          {r.forfeited.length ? (
            <span className="text-destructive">
              {' '}({t('forfeited', { items: r.forfeited.map(lineText).join(', ') })})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function BatchDetail({ batch, onBack }: { batch: PrepaidVoucherBatch; onBack: () => void }) {
  const t = useTranslations('prepaidVouchers');
  const tk = useTranslations('prepaidVouchers.kinds');
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

  const [statusFilter, setStatusFilter] = useState<'all' | PrepaidVoucherStatus>('all');
  const [serialText, setSerialText] = useState('');
  const [offset, setOffset] = useState(0);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [view, setView] = useState<'vouchers' | 'groups' | 'report'>('vouchers');
  const [addCount, setAddCount] = useState('10');
  const [busy, setBusy] = useState<string | null>(null);
  const [groupText, setGroupText] = useState('');
  const [codeText, setCodeText] = useState('');
  const [assignMode, setAssignMode] = useState<GroupMode>('10');
  const [assignCustom, setAssignCustom] = useState('');
  const planText = useGroupPlanText();
  const serial = parseInt(serialText, 10);
  const groupNo = parseInt(groupText, 10);
  const codeQuery = codeText.replace(/[^0-9a-z]/gi, '').length >= 4 ? codeText.trim() : '';

  const list = useQuery({
    queryKey: ['prepaid-vouchers', batch.id, statusFilter, serialText, offset, groupText, codeQuery],
    queryFn: () =>
      fetchPrepaidVouchers(batch.id, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        serial: Number.isFinite(serial) && serial > 0 ? serial : undefined,
        group: Number.isFinite(groupNo) && groupNo > 0 ? groupNo : undefined,
        code: codeQuery || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', batch.id] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-groups', batch.id] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', batch.id] });
  };

  // Print settings: only what the next print looks like changes (the code under the barcode,
  // the goods on the voucher, the barcode).
  const saveSettings = useMutation({
    mutationFn: (body: { showCode?: boolean; showItems?: boolean; showCredit?: boolean; barcodeType?: PrepaidBarcodeType }) =>
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
  const addMore = useMutation({
    mutationFn: () => addPrepaidVouchers(batch.id, parseInt(addCount, 10)),
    onSuccess: (b) => { toast.success(t('added', { total: b.stats.total })); refresh(); },
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
  const statuses: ('all' | PrepaidVoucherStatus)[] = ['all', 'active', 'partially_used', 'used', 'cancelled'];

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
            {discount ? ` · ${tk(`promotionPolicy.${batch.promotionPolicy ?? 'exclude'}`)}` : ''}
            {batch.validFrom ? ` · ${t('validFrom', { date: day(batch.validFrom) })}` : ''}
            {batch.validUntil ? ` · ${t('validUntil', { date: day(batch.validUntil) })}` : ''}
            {' · '}
            {batch.shops.length ? batch.shops.map((s) => s.name).join(', ') : t('allShopsOf', { company: batch.companyName ?? '' })}
          </p>
          {batch.customerName || batch.orderRef ? (
            <p className="text-xs text-muted-foreground">
              {[
                batch.customerName ? t('production.customer', { name: batch.customerName }) : null,
                batch.orderRef ? t('production.order', { ref: batch.orderRef }) : null,
              ].filter(Boolean).join(' · ')}
            </p>
          ) : null}
        </div>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px]', cancelled ? STATUS_STYLE.cancelled : STATUS_STYLE.active)}>
          {t(`batchStatus.${batch.status}`)}
        </span>
      </div>

      <StatsBar b={batch} />

      <div className="flex gap-1 print:hidden" role="tablist" aria-label={t('viewLabel')}>
        {(['vouchers', 'groups', 'report'] as const).map((v) => (
          <Button key={v} role="tab" aria-selected={view === v} size="sm"
            variant={view === v ? 'default' : 'outline'} onClick={() => setView(v)}>
            {t(`view.${v}`)}
          </Button>
        ))}
      </div>

      {view === 'report' ? <PrepaidBatchReportView batch={batch} /> : view === 'groups' ? (
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

      <BatchRulesCard key={`${batch.stacking}:${batch.promotionPolicy}:${batch.maxUsesPerSale}:${batch.maxUsesPerDay}`}
        batch={batch} onSaved={refresh} />

      {!cancelled ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="pv-add">{t('addLabel')}</Label>
            <Input id="pv-add" type="number" min={1} max={5000} className="h-9 w-28" value={addCount} onChange={(e) => setAddCount(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" disabled={addMore.isPending || !(parseInt(addCount, 10) >= 1)} onClick={() => addMore.mutate()}>
            <Plus className="h-4 w-4" /> {t('add')}
          </Button>
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
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>{t('filterStatus')}</Label>
            <Select
              value={statusFilter}
              onValueChange={(v) => { if (v) { setStatusFilter(v as typeof statusFilter); setOffset(0); } }}
              items={statuses.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            >
              <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s} value={s} label={t(`status.${s}`)}>{t(`status.${s}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pv-serial">{t('serialSearch')}</Label>
            <Input id="pv-serial" inputMode="numeric" className="h-9 w-28" value={serialText}
              onChange={(e) => { setSerialText(e.target.value.replace(/\D/g, '')); setOffset(0); }} />
          </div>
          {grouped ? (
            <div className="space-y-1">
              <Label htmlFor="pv-group">{t('groupFilter')}</Label>
              <Input id="pv-group" inputMode="numeric" className="h-9 w-24" value={groupText} placeholder={t('groupAll')}
                onChange={(e) => { setGroupText(e.target.value.replace(/\D/g, '')); setOffset(0); }} />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="pv-code">{t('codeSearch')}</Label>
            <Input id="pv-code" dir="ltr" className="h-9 w-48 font-mono" value={codeText} placeholder="ABCD-EFGH-…"
              onChange={(e) => { setCodeText(e.target.value); setOffset(0); }} />
          </div>
          <span className="ms-auto text-xs text-muted-foreground">{list.data ? t('count', { n: list.data.total }) : null}</span>
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
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px]', STATUS_STYLE[v.status])}>{t(`status.${v.status}`)}</span>
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

export default function PrepaidVouchersPage() {
  const t = useTranslations('prepaidVouchers');
  const errorText = useErrorText();
  const [creating, setCreating] = useState(false);
  // `?batch=<id>`: the control board's "שוברים" card opens a voucher's batch directly.
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('batch'));

  const batches = useQuery({ queryKey: ['prepaid-voucher-batches'], queryFn: fetchPrepaidBatches });
  const selected = batches.data?.find((b) => b.id === selectedId) ?? null;
  // The list's filters (the spec's §10.1): words over name / event / customer / order, status, kind, company.
  const [filters, setFilters] = useState<BatchFilters>(NO_BATCH_FILTERS);
  const shown = filterBatches(batches.data ?? [], filters);
  const companies = Array.from(new Map((batches.data ?? []).map((b) => [b.companyId, b.companyName ?? b.companyId])));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {!selected ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t('new')}
          </Button>
        ) : null}
      </div>

      {selected ? (
        <BatchDetail key={selected.id} batch={selected} onBack={() => setSelectedId(null)} />
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
              <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
              <Input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                placeholder={t('filters.search')} aria-label={t('filters.search')} className="ps-8" />
            </div>
            <select className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" aria-label={t('filters.statusLabel')}
              value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as BatchFilters['status'] })}>
              {(['all', 'active', 'cancelled'] as const).map((s) => <option key={s} value={s}>{t(`filters.status.${s}`)}</option>)}
            </select>
            <select className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" aria-label={t('filters.kindLabel')}
              value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value as BatchFilters['kind'] })}>
              {(['all', 'items', 'discount'] as const).map((k) => <option key={k} value={k}>{t(`filters.kind.${k}`)}</option>)}
            </select>
            {companies.length > 1 ? (
              <select className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30" aria-label={t('filters.companyLabel')}
                value={filters.companyId} onChange={(e) => setFilters({ ...filters, companyId: e.target.value })}>
                <option value="">{t('filters.allCompanies')}</option>
                {companies.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            ) : null}
            <span className="text-xs text-muted-foreground">{t('filters.count', { shown: shown.length, total: batches.data!.length })}</span>
          </div>
          {shown.length ? (
            <ul className="space-y-2">
              {shown.map((b) => (
                <BatchCard key={b.id} b={b} onOpen={() => setSelectedId(b.id)} />
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('filters.none')}</p>
          )}
        </>
      )}

      <CreateBatchDialog open={creating} onOpenChange={setCreating} onCreated={(b) => setSelectedId(b.id)} />
    </div>
  );
}
