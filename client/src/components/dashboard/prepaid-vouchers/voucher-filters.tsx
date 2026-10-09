'use client';

/**
 * The vouchers' one filter bar (lib/prepaidVoucherFilters.ts): "עבור מי" first and widest, then the
 * event, the voucher type, the shop and the dates the view needs; the rest behind "סינונים נוספים".
 * The page keeps the filters in its URL (`useVoucherPageState`), so the batch list, "כל השוברים" and
 * "מימושים לפי קופה" read the same filters and a filtered view is a link.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, Filter, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchPrepaidFacets, type PrepaidFacets } from '@/lib/prepaidVouchersApi';
import {
  ACCOUNTING_FILTERS,
  BATCH_STATUSES,
  EMPTY_FILTERS,
  KIND_FILTERS,
  PRICING_FILTERS,
  VOUCHER_STATES,
  YES_NO,
  activeFilterCount,
  pageStateFromQuery,
  pageStateToQuery,
  type PageState,
  type VoucherFilters,
  type VoucherView,
} from '@/lib/prepaidVoucherFilters';
import { cn } from '@/lib/utils';

const SELECT = 'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30';

/** The page's view, sort and filters, read from and written to its URL. */
export function useVoucherPageState(): [PageState, (next: PageState) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = params?.toString() ?? '';
  const state = useMemo(() => pageStateFromQuery(query), [query]);
  const set = useCallback(
    (next: PageState) => {
      const q = pageStateToQuery(next);
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router],
  );
  return [state, set];
}

export function useVoucherFacets() {
  return useQuery({ queryKey: ['prepaid-voucher-facets'], queryFn: fetchPrepaidFacets, staleTime: 60_000 });
}

interface PickerOption {
  id: string;
  label: string;
  hint?: string | null;
}

/** A searchable multi-choice dropdown: the button says what is chosen, the panel filters as you type. */
export function MultiPicker({
  label,
  allLabel,
  options,
  value,
  onChange,
  className,
  prominent = false,
}: {
  label: string;
  allLabel: string;
  options: PickerOption[];
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
  prominent?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.scope');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const chosen = new Set(value);
  const words = text.trim().toLowerCase();
  const shown = words ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(words)) : options;
  const names = options.filter((o) => chosen.has(o.id)).map((o) => o.label);
  // A value from the URL that is not (or no longer) an option still shows, by itself.
  const unknown = value.filter((v) => !options.some((o) => o.id === v));
  const summary = value.length === 0 ? allLabel : [...names, ...unknown].slice(0, 2).join(', ') + (value.length > 2 ? ` +${value.length - 2}` : '');
  return (
    <div ref={box} className={cn('relative space-y-1', className)}>
      <span className={cn('block text-xs font-medium text-muted-foreground', prominent && 'text-sm text-foreground')}>{label}</span>
      <Button type="button" variant="outline" aria-expanded={open} aria-haspopup="listbox"
        className={cn('w-full justify-between font-normal', prominent && 'h-10 border-primary/40', value.length && 'font-medium')}
        onClick={() => setOpen(!open)}>
        <span className="truncate">{summary}</span>
        <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
      </Button>
      {open ? (
        <div className="absolute z-30 mt-1 w-72 max-w-[90vw] rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2 rtl:right-2" aria-hidden />
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('pickerSearch')} className="h-8 ps-7" />
          </div>
          <ul role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto">
            {value.length ? (
              <li>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-start text-xs text-muted-foreground hover:bg-muted"
                  onClick={() => onChange([])}>
                  {t('clear')}
                </button>
              </li>
            ) : null}
            {shown.map((o) => {
              const on = chosen.has(o.id);
              return (
                <li key={o.id} role="option" aria-selected={on}>
                  <button type="button" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted"
                    onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}>
                    <Check className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'opacity-100' : 'opacity-0')} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate">{o.label}</span>
                      {o.hint ? <span className="block truncate text-xs text-muted-foreground">{o.hint}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">{t('noMatch')}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ChoiceSelect<T extends string>({
  label,
  allLabel,
  options,
  value,
  onChange,
  labelOf,
}: {
  label: string;
  allLabel: string;
  options: readonly T[];
  value: '' | T;
  onChange: (v: '' | T) => void;
  labelOf: (v: T) => string;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value as '' | T)}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o} value={o}>{labelOf(o)}</option>)}
      </select>
    </label>
  );
}

function DayRange({ label, from, to, onChange }: { label: string; from: string; to: string; onChange: (from: string, to: string) => void }) {
  const t = useTranslations('prepaidVouchers.scope');
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <Input type="date" aria-label={`${label} — ${t('fromLabel')}`} className="h-9 min-w-0" value={from} max={to || undefined}
          onChange={(e) => onChange(e.target.value, to)} />
        <span className="text-xs text-muted-foreground">–</span>
        <Input type="date" aria-label={`${label} — ${t('toLabel')}`} className="h-9 min-w-0" value={to} min={from || undefined}
          onChange={(e) => onChange(from, e.target.value)} />
      </div>
    </div>
  );
}

function AmountRange({ label, min, max, onChange }: { label: string; min: string; max: string; onChange: (min: string, max: string) => void }) {
  const t = useTranslations('prepaidVouchers.scope');
  const clean = (s: string) => s.replace(/[^\d.,]/g, '');
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <Input inputMode="decimal" placeholder={t('min')} aria-label={`${label} — ${t('min')}`} className="h-9 min-w-0" value={min}
          onChange={(e) => onChange(clean(e.target.value), max)} />
        <span className="text-xs text-muted-foreground">–</span>
        <Input inputMode="decimal" placeholder={t('max')} aria-label={`${label} — ${t('max')}`} className="h-9 min-w-0" value={max}
          onChange={(e) => onChange(min, clean(e.target.value))} />
      </div>
    </div>
  );
}

/** Which filters a view shows (the batch list has no voucher state; the tills report no issue dates up front). */
const PRIMARY_DATES: Record<VoucherView, 'issued' | 'redeemed' | null> = {
  batches: 'issued',
  vouchers: 'redeemed',
  tills: 'redeemed',
  types: null,
  productions: null,
  settlement: null,
  reports: 'redeemed',
  extras: null,
};

export function VoucherFilterBar({
  view,
  value,
  onChange,
  facets,
}: {
  view: VoucherView;
  value: VoucherFilters;
  onChange: (next: VoucherFilters) => void;
  facets: PrepaidFacets | undefined;
}) {
  const t = useTranslations('prepaidVouchers.scope');
  const [more, setMore] = useState(false);
  const set = <K extends keyof VoucherFilters>(k: K, v: VoucherFilters[K]) => onChange({ ...value, [k]: v });
  const omit: (keyof VoucherFilters)[] = view === 'batches' ? ['state', 'group', 'q'] : ['q'];
  const count = activeFilterCount(value, omit);
  const f = facets;
  const opts = {
    customers: (f?.customers ?? []).map((c) => ({ id: c.value, label: c.value, hint: t('batchesN', { n: c.batches }) })),
    events: (f?.events ?? []).map((c) => ({ id: c.value, label: c.value, hint: t('batchesN', { n: c.batches }) })),
    types: (f?.types ?? []).map((x) => ({ id: x.id, label: x.name })),
    shops: (f?.shops ?? []).map((x) => ({ id: x.id, label: x.name })),
    batches: (f?.batches ?? []).map((x) => ({ id: x.id, label: x.name, hint: [x.customerName, x.eventName].filter(Boolean).join(' · ') || null })),
    tills: (f?.tills ?? []).map((x) => ({ id: x.id, label: x.name ?? x.id, hint: x.shopName })),
    employees: (f?.employees ?? []).map((x) => ({ id: x.id, label: x.name })),
  };
  const dates = PRIMARY_DATES[view];
  const issued = (
    <DayRange label={t('issued')} from={value.issuedFrom} to={value.issuedTo}
      onChange={(a, b) => onChange({ ...value, issuedFrom: a, issuedTo: b })} />
  );
  const redeemed = (
    <DayRange label={t('redeemed')} from={value.from} to={value.to} onChange={(a, b) => onChange({ ...value, from: a, to: b })} />
  );
  return (
    <div className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <MultiPicker prominent className="sm:col-span-2" label={t('forWhom')} allLabel={t('forWhomAll')} options={opts.customers}
          value={value.customer} onChange={(v) => set('customer', v)} />
        <MultiPicker label={t('event')} allLabel={t('eventAll')} options={opts.events} value={value.event} onChange={(v) => set('event', v)} />
        <MultiPicker label={t('type')} allLabel={t('typeAll')} options={opts.types} value={value.typeId} onChange={(v) => set('typeId', v)} />
        <MultiPicker label={t('shop')} allLabel={t('shopAll')} options={opts.shops} value={value.shopId} onChange={(v) => set('shopId', v)} />
        {view === 'batches' ? (
          <ChoiceSelect label={t('batchStatus')} allLabel={t('batchStatusAll')} options={BATCH_STATUSES} value={value.batchStatus}
            onChange={(v) => set('batchStatus', v)} labelOf={(s) => t(`batchStatuses.${s}`)} />
        ) : (
          <ChoiceSelect label={t('state')} allLabel={t('stateAll')} options={VOUCHER_STATES} value={value.state}
            onChange={(v) => set('state', v)} labelOf={(s) => t(`states.${s}`)} />
        )}
        {dates === 'issued' ? <div className="sm:col-span-2">{issued}</div> : dates === 'redeemed' ? <div className="sm:col-span-2">{redeemed}</div> : null}
        {view !== 'batches' ? (
          <MultiPicker label={t('till')} allLabel={t('tillAll')} options={opts.tills} value={value.machineId} onChange={(v) => set('machineId', v)} />
        ) : null}
        {view !== 'batches' ? (
          <MultiPicker label={t('employee')} allLabel={t('employeeAll')} options={opts.employees} value={value.employee}
            onChange={(v) => set('employee', v)} />
        ) : null}
      </div>
      {more ? (
        <div className="grid gap-2 border-t pt-2 sm:grid-cols-2 lg:grid-cols-6">
          {view !== 'batches' ? (
            <MultiPicker className="sm:col-span-2" label={t('batch')} allLabel={t('batchAll')} options={opts.batches} value={value.batchId}
              onChange={(v) => set('batchId', v)} />
          ) : null}
          {dates !== 'issued' ? <div className="sm:col-span-2">{issued}</div> : null}
          {dates !== 'redeemed' ? <div className="sm:col-span-2">{redeemed}</div> : null}
          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">{t('validOn')}</span>
            <Input type="date" className="h-9" value={value.validOn} onChange={(e) => set('validOn', e.target.value)} />
          </label>
          {view === 'batches' ? (
            <MultiPicker label={t('till')} allLabel={t('tillAll')} options={opts.tills} value={value.machineId} onChange={(v) => set('machineId', v)} />
          ) : null}
          {view === 'batches' ? (
            <MultiPicker label={t('employee')} allLabel={t('employeeAll')} options={opts.employees} value={value.employee}
              onChange={(v) => set('employee', v)} />
          ) : null}
          <ChoiceSelect label={t('kind')} allLabel={t('any')} options={KIND_FILTERS} value={value.kind} onChange={(v) => set('kind', v)}
            labelOf={(s) => t(`kindOptions.${s}`)} />
          <ChoiceSelect label={t('accounting')} allLabel={t('accountingAll')} options={ACCOUNTING_FILTERS} value={value.accounting}
            onChange={(v) => set('accounting', v)} labelOf={(s) => t(`accountingOptions.${s}`)} />
          <ChoiceSelect label={t('pricing')} allLabel={t('pricingAll')} options={PRICING_FILTERS} value={value.pricing}
            onChange={(v) => set('pricing', v)} labelOf={(s) => t(`pricingOptions.${s}`)} />
          <ChoiceSelect label={t('override')} allLabel={t('any')} options={YES_NO} value={value.override}
            onChange={(v) => set('override', v)} labelOf={(s) => t(`overrideOptions.${s}`)} />
          <ChoiceSelect label={t('offline')} allLabel={t('any')} options={YES_NO} value={value.offline}
            onChange={(v) => set('offline', v)} labelOf={(s) => t(`offlineOptions.${s}`)} />
          <AmountRange label={t('value')} min={value.valueMin} max={value.valueMax}
            onChange={(a, b) => onChange({ ...value, valueMin: a, valueMax: b })} />
          {f?.pricesVisible ? (
            <AmountRange label={t('price')} min={value.priceMin} max={value.priceMax}
              onChange={(a, b) => onChange({ ...value, priceMin: a, priceMax: b })} />
          ) : null}
          <label className="block space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">{t('createdBy')}</span>
            <select className={SELECT} value={value.createdBy} onChange={(e) => set('createdBy', e.target.value)}>
              <option value="">{t('createdByAll')}</option>
              {(f?.creators ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {view !== 'batches' ? (
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('group')}</span>
              <Input inputMode="numeric" className="h-9" value={value.group} onChange={(e) => set('group', e.target.value.replace(/\D/g, ''))} />
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setMore(!more)} aria-expanded={more}>
          <Filter className="h-4 w-4" /> {more ? t('less') : t('more')}
        </Button>
        {count ? (
          <>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{t('active', { n: count })}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...EMPTY_FILTERS, q: value.q })}>
              <X className="h-4 w-4" /> {t('clearAll')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
