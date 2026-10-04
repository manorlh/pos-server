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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { he } from 'date-fns/locale';
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
  cancelPrepaidBatch,
  cancelPrepaidVoucher,
  createPrepaidBatch,
  downloadPrepaidVouchersFile,
  fetchAllPrepaidVouchers,
  fetchPrepaidBatches,
  fetchPrepaidVoucher,
  fetchPrepaidVouchers,
  searchPrepaidProducts,
  type PrepaidProductOption,
  type PrepaidVoucher,
  type PrepaidVoucherBatch,
  type PrepaidVoucherStatus,
} from '@/lib/prepaidVouchersApi';
import { cn } from '@/lib/utils';
import {
  PAGE_PRESETS,
  VoucherPreview,
  printVouchers,
  type PagePresetId,
  type PrintLayout,
  type VoucherLabels,
} from '@/components/dashboard/prepaid-vouchers/voucher-print';
import { PrepaidBatchReportView } from '@/components/dashboard/prepaid-vouchers/batch-report';
import { VoucherNote, VoucherNoteButton } from '@/components/dashboard/prepaid-vouchers/voucher-note';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const PAGE_SIZE = 100;
const LAYOUT_KEY = 'prepaidVouchers.layout';

function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'dd/MM/yyyy', { locale: he });
}

function time(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'dd/MM/yy HH:mm', { locale: he });
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

function useCardLabels(): VoucherLabels {
  const t = useTranslations('prepaidVouchers.card');
  return useMemo(
    () => ({ serial: (n: string) => t('serial', { n }), splitAllowed: t('splitAllowed'), oneTime: t('oneTime') }),
    [t],
  );
}

// ── Create ────────────────────────────────────────────────────────────────────

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

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const companies = useQuery({ queryKey: ['companies'], queryFn: fetchCompanies, enabled: open });
  useEffect(() => {
    if (!companyId && companies.data?.length === 1) setCompanyId(companies.data[0].id);
  }, [companies.data, companyId]);
  const shops = useQuery({ queryKey: ['shops', companyId], queryFn: () => fetchShops(companyId), enabled: open && !!companyId });
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', debounced],
    queryFn: () => searchPrepaidProducts(debounced),
    enabled: open,
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
  };

  const n = parseInt(count, 10);
  const canCreate = name.trim() && companyId && items.length > 0 && n >= 1 && n <= 5000 &&
    (!validFrom || !validUntil || validFrom <= validUntil);

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
        splitAllowed,
        items: items.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
        count: n,
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

  const addItem = (p: PrepaidProductOption) =>
    setItems((cur) => (cur.some((i) => i.product.id === p.id) ? cur : [...cur, { product: p, quantity: 1 }]));
  const setQty = (id: string, q: number) =>
    setItems((cur) => cur.map((i) => (i.product.id === id ? { ...i, quantity: Math.max(1, Math.min(100, q)) } : i)));

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

          <div className="space-y-2">
            <Label>{t('items')}</Label>
            {items.length ? (
              <ul className="divide-y rounded-lg border">
                {items.map((i) => (
                  <li key={i.product.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{i.product.name}</span>
                    <Button type="button" size="icon-sm" variant="outline" aria-label={t('less')} onClick={() => setQty(i.product.id, i.quantity - 1)}>
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                    <span className="w-6 text-center tabular-nums">{i.quantity}</span>
                    <Button type="button" size="icon-sm" variant="outline" aria-label={t('more')} onClick={() => setQty(i.product.id, i.quantity + 1)}>
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
            <div className="max-h-40 overflow-y-auto rounded-lg border">
              {products.isPending ? (
                <p className="p-2 text-xs text-muted-foreground">{tc('loading')}</p>
              ) : (products.data ?? []).length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">{t('noProducts')}</p>
              ) : (
                <ul>
                  {products.data!.map((p) => {
                    const added = items.some((i) => i.product.id === p.id);
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          disabled={added}
                          onClick={() => addItem(p)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-muted disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">₪{p.price.toFixed(2)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-count">{t('count')}</Label>
              <Input id="pv-count" type="number" min={1} max={5000} value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{splitAllowed ? t('splitOn') : t('splitOff')}</p>
                <p className="text-xs text-muted-foreground">{splitAllowed ? t('splitOnHint') : t('splitOffHint')}</p>
              </div>
              <Switch checked={splitAllowed} onCheckedChange={(v) => setSplitAllowed(!!v)} aria-label={t('splitLabel')} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pv-from">{t('validFrom')}</Label>
              <Input id="pv-from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-until">{t('validUntil')}</Label>
              <Input id="pv-until" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pv-text">{t('freeText')}</Label>
            <textarea
              id="pv-text"
              rows={2}
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
                onValueChange={(v) => { setCompanyId(String(v ?? '')); setShopIds([]); }}
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

function BatchCard({ b, onOpen }: { b: PrepaidVoucherBatch; onOpen: () => void }) {
  const t = useTranslations('prepaidVouchers');
  return (
    <li>
      <button type="button" onClick={onOpen} className="w-full space-y-2 rounded-xl bg-card p-3 text-start ring-1 ring-foreground/10 hover:ring-foreground/25">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{b.eventName || b.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {b.eventName ? `${b.name} · ` : ''}
              {b.items.map((i) => `${i.quantity}× ${i.name}`).join(' + ')}
            </p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px]', b.status === 'cancelled' ? STATUS_STYLE.cancelled : STATUS_STYLE.active)}>
            {t(`batchStatus.${b.status}`)}
          </span>
        </div>
        <StatsBar b={b} />
        <p className="text-xs text-muted-foreground">
          {b.splitAllowed ? t('card.splitAllowed') : t('card.oneTime')}
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
  const q = useQuery({ queryKey: ['prepaid-voucher', voucherId], queryFn: () => fetchPrepaidVoucher(voucherId) });
  if (q.isPending) return <Skeleton className="h-10 w-full" />;
  const rows = q.data?.redemptions ?? [];
  if (!rows.length) return <p className="text-xs text-muted-foreground">{t('empty')}</p>;
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
          {r.items.map((i) => `${i.quantity}× ${i.name ?? ''}`).join(', ')}
          {r.forfeited.length ? (
            <span className="text-destructive">
              {' '}({t('forfeited', { items: r.forfeited.map((i) => `${i.quantity}× ${i.name ?? ''}`).join(', ') })})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function BatchDetail({ batch, onBack }: { batch: PrepaidVoucherBatch; onBack: () => void }) {
  const t = useTranslations('prepaidVouchers');
  const errorText = useErrorText();
  const labels = useCardLabels();
  const qc = useQueryClient();

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
  const [view, setView] = useState<'vouchers' | 'report'>('vouchers');
  const [addCount, setAddCount] = useState('10');
  const [busy, setBusy] = useState<string | null>(null);
  const serial = parseInt(serialText, 10);

  const list = useQuery({
    queryKey: ['prepaid-vouchers', batch.id, statusFilter, serialText, offset],
    queryFn: () =>
      fetchPrepaidVouchers(batch.id, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        serial: Number.isFinite(serial) && serial > 0 ? serial : undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
    void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', batch.id] });
  };

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
  const serverFile = (format: 'pdf' | 'zip', l: PrintLayout, fileName: string, voucherId?: string) =>
    downloadPrepaidVouchersFile(batch.id, {
      format,
      layout: l.preset,
      width: l.preset === 'custom' ? l.width : undefined,
      height: l.preset === 'custom' ? l.height : undefined,
      voucherId,
      fileName,
    });

  const runAll = async (kind: 'print' | 'pdf' | 'zip') => {
    setBusy(kind === 'print' ? t('printPreparing') : t('fileServerPreparing'));
    try {
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
      await printVouchers(batch, all, layout, labels, fileBase);
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
      if (kind === 'print') await printVouchers(batch, [v], one, labels, name);
      else await serverFile('pdf', one, `${name}.pdf`, v.id);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const sample = list.data?.items[0] ?? {
    id: 'sample', serial: 1, displayCode: 'XXXX-XXXX-XXXX-XXXX', qrPayload: 'PV:SAMPLE',
  };
  const cancelled = batch.status === 'cancelled';
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
            {batch.items.map((i) => `${i.quantity}× ${i.name}`).join(' + ')}
          </p>
          <p className="text-xs text-muted-foreground">
            {batch.splitAllowed ? t('card.splitAllowed') : t('card.oneTime')}
            {batch.validFrom ? ` · ${t('validFrom', { date: day(batch.validFrom) })}` : ''}
            {batch.validUntil ? ` · ${t('validUntil', { date: day(batch.validUntil) })}` : ''}
            {' · '}
            {batch.shops.length ? batch.shops.map((s) => s.name).join(', ') : t('allShopsOf', { company: batch.companyName ?? '' })}
          </p>
        </div>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px]', cancelled ? STATUS_STYLE.cancelled : STATUS_STYLE.active)}>
          {t(`batchStatus.${batch.status}`)}
        </span>
      </div>

      <StatsBar b={batch} />

      <div className="flex gap-1 print:hidden" role="tablist" aria-label={t('viewLabel')}>
        {(['vouchers', 'report'] as const).map((v) => (
          <Button key={v} role="tab" aria-selected={view === v} size="sm"
            variant={view === v ? 'default' : 'outline'} onClick={() => setView(v)}>
            {t(`view.${v}`)}
          </Button>
        ))}
      </div>

      {view === 'report' ? <PrepaidBatchReportView batch={batch} /> : (<>
      <Card>
        <CardHeader>
          <CardTitle>{t('printTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <LayoutPicker layout={layout} onChange={setLayout} />
          <div className="overflow-x-auto py-1">
            <VoucherPreview batch={batch} voucher={sample} layout={layout} labels={labels} />
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
            {busy ? (
              <span className="flex items-center gap-1 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy}
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {!cancelled ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="pv-add">{t('addLabel')}</Label>
            <Input id="pv-add" type="number" min={1} max={5000} className="h-9 w-28" value={addCount} onChange={(e) => setAddCount(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" disabled={addMore.isPending || !(parseInt(addCount, 10) >= 1)} onClick={() => addMore.mutate()}>
            <Plus className="h-4 w-4" /> {t('add')}
          </Button>
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
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px]', STATUS_STYLE[v.status])}>{t(`status.${v.status}`)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {v.items.map((i) => t('remainingOf', { name: i.name, left: i.remaining, total: i.quantity })).join(' · ')}
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const batches = useQuery({ queryKey: ['prepaid-voucher-batches'], queryFn: fetchPrepaidBatches });
  const selected = batches.data?.find((b) => b.id === selectedId) ?? null;

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
        <ul className="space-y-2">
          {batches.data!.map((b) => (
            <BatchCard key={b.id} b={b} onOpen={() => setSelectedId(b.id)} />
          ))}
        </ul>
      )}

      <CreateBatchDialog open={creating} onOpenChange={setCreating} onCreated={(b) => setSelectedId(b.id)} />
    </div>
  );
}
