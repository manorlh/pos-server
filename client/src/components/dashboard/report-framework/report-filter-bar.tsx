'use client';

/**
 * The reports' one filter bar (P:\specs\reports-upgrade.md §2א): the days with quick ranges,
 * the hours on each day, the shop and the till (the dashboard's shared scope), the area, the
 * cashier, the payment method, the department and the product, the document type and a free
 * search — each only when the report says its endpoint takes it (`spec.filters`). Every
 * applied filter is in the URL; "נקה הכל" goes back to the defaults.
 */
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Info, Loader2, Play, Search, X } from 'lucide-react';
import { AREA_NONE } from '@/lib/api';
import { useScope } from '@/lib/scope';
import { numberedLabel } from '@/lib/orgNumber';
import { registerNumberOf } from '@/lib/registerNumber';
import { RANGE_PRESETS, matchingPreset, presetRange, type RangePresetKey } from '@/lib/calendar';
import { businessToday, formatHour } from '@/lib/format';
import {
  HOUR_OPTIONS_FROM,
  HOUR_OPTIONS_TO,
  dayCount,
  isValidHourWindow,
  wrapsMidnight,
} from '@/lib/reportWindow';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AreaFilterSelect } from '@/components/dashboard/areas/area-filter';
import type { ReportFiltersController } from './use-report-filters';
import {
  useCashierOptions,
  useCategoryOptions,
  useDocTypeOptions,
  useProductOptions,
  type FilterBarOptions,
} from './use-filter-options';

const ALL = '__all__';
/** The quick ranges shown as chips (the date picker offers them all). */
const QUICK: RangePresetKey[] = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth'];

export interface ReportFilterBarProps extends FilterBarOptions {
  filters: ReportFiltersController;
  isFetching?: boolean;
  /** Offer the scope's shop / till here too (they write the shared scope, as the bar on top does). */
  scopeFields?: { shop?: boolean; till?: boolean };
  /** The report's own options (a row limit, "meals as…"), beside the filters. */
  children?: React.ReactNode;
  /** A line under the bar (what the report counts, a caveat). */
  hint?: string;
}

function SimpleSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
  className?: string;
}) {
  const items = [{ value: ALL, label: allLabel }, ...options];
  return (
    <div className={`min-w-0 space-y-1 ${className ?? ''}`}>
      <Label className="text-xs">{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(!v || v === ALL ? '' : String(v))} items={items}>
        <SelectTrigger className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value} label={o.label}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ReportFilterBar({
  filters,
  isFetching = false,
  scopeFields,
  shopId,
  methodOptions = [],
  children,
  hint,
}: ReportFilterBarProps) {
  const t = useTranslations('reportFramework.filters');
  const tp = useTranslations('datePicker.presets');
  const scope = useScope();
  const offered = filters.spec.filters;
  const has = (key: (typeof offered)[number]) => offered.includes(key);
  const v = filters.draft;
  const set = filters.set;

  const cashiers = useCashierOptions(shopId, has('cashier'));
  const { options: categories } = useCategoryOptions(has('category'));
  const products = useProductOptions(has('product'), v.productId);
  const docTypes = useDocTypeOptions();

  // An area and a cashier belong to one shop: a new shop in scope drops them.
  const lastShop = useRef(shopId);
  const latest = useRef({ v, set });
  useEffect(() => {
    latest.current = { v, set };
  });
  useEffect(() => {
    if (lastShop.current === shopId) return;
    lastShop.current = shopId;
    const { v: current, set: update } = latest.current;
    const patch: Partial<typeof current> = {};
    if (current.areaId && current.areaId !== AREA_NONE) patch.areaId = '';
    if (current.cashierId) patch.cashierId = '';
    if (Object.keys(patch).length) update(patch);
  }, [shopId]);

  const today = businessToday();
  const rangeInvalid = !v.from || !v.to || v.from > v.to;
  const hours = { fromHour: v.fromHour, toHour: v.toHour };
  const wholeDay = v.fromHour === 0 && v.toHour === 24;
  const hoursInvalid = has('hours') && !isValidHourWindow(hours);
  const canRun = !rangeInvalid && !hoursInvalid && !isFetching;
  const preset = matchingPreset({ from: v.from, to: v.to }, today);
  const days = dayCount(v.from, v.to);
  const activeCount = filters.active.length;

  const machineLabel = (m: (typeof scope.machineOptions)[number]) => {
    const n = registerNumberOf(m);
    return n ? `${m.name} (${n})` : m.name;
  };

  const withUnknown = (list: { value: string; label: string; hint?: string | null }[], value: string) =>
    value && !list.some((o) => o.value === value) ? [{ value, label: t('unknownChoice') }, ...list] : list;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3 sm:p-4 print:hidden" role="search">
      {/* Days and quick ranges */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[calc(50%-0.375rem)] space-y-1 sm:w-40">
          <Label className="text-xs">{t('from')}</Label>
          <DatePicker
            value={v.from}
            max={v.to || undefined}
            aria-invalid={rangeInvalid || undefined}
            onChange={(e) => set({ from: e.target.value })}
            range={{ from: v.from, to: v.to, onSelect: (r) => set({ from: r.from, to: r.to }) }}
          />
        </div>
        <div className="w-[calc(50%-0.375rem)] space-y-1 sm:w-40">
          <Label className="text-xs">{t('to')}</Label>
          <DatePicker
            value={v.to}
            min={v.from || undefined}
            aria-invalid={rangeInvalid || undefined}
            onChange={(e) => set({ to: e.target.value })}
            range={{ from: v.from, to: v.to, onSelect: (r) => set({ from: r.from, to: r.to }) }}
          />
        </div>
        <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label={t('quick')}>
          {QUICK.filter((k) => RANGE_PRESETS.includes(k)).map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={preset === key ? 'default' : 'outline'}
              className="h-7 px-2 text-xs"
              onClick={() => set(presetRange(key, today))}
            >
              {tp(key)}
            </Button>
          ))}
        </div>
      </div>
      {rangeInvalid && v.from && v.to ? <p className="text-destructive text-xs">{t('rangeInvalid')}</p> : null}

      {/* The filters the report takes */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {has('hours') ? (
          <div className="min-w-0 space-y-1">
            <Label className="text-xs">{t('hours')}</Label>
            <div className="flex items-center gap-1.5">
              <Select
                value={String(v.fromHour)}
                onValueChange={(x) => set({ fromHour: Number(x ?? 0) })}
                items={HOUR_OPTIONS_FROM.map((h) => ({ value: String(h), label: formatHour(h) }))}
              >
                <SelectTrigger className="min-w-0 flex-1" aria-label={t('from')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS_FROM.map((h) => (
                    <SelectItem key={h} value={String(h)} label={formatHour(h)}>
                      {formatHour(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">–</span>
              <Select
                value={String(v.toHour)}
                onValueChange={(x) => set({ toHour: Number(x ?? 24) })}
                items={HOUR_OPTIONS_TO.map((h) => ({ value: String(h), label: formatHour(h) }))}
              >
                <SelectTrigger className="min-w-0 flex-1" aria-label={t('to')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS_TO.map((h) => (
                    <SelectItem key={h} value={String(h)} label={formatHour(h)}>
                      {formatHour(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={wholeDay}
                onClick={() => set({ fromHour: 0, toHour: 24 })}
              >
                {t('wholeDay')}
              </Button>
            </div>
          </div>
        ) : null}

        {scopeFields?.shop ? (
          <SimpleSelect
            label={t('shop')}
            value={scope.shopId ?? ''}
            onChange={(id) => scope.setShop(id || null)}
            options={scope.shopOptions.map((s) => ({ value: s.id, label: numberedLabel(s.shopNumber, s.name) }))}
            allLabel={t('allShops')}
          />
        ) : null}
        {scopeFields?.till ? (
          <SimpleSelect
            label={t('till')}
            value={scope.machineId ?? ''}
            onChange={(id) => scope.setMachine(id || null)}
            options={scope.machineOptions.map((m) => ({ value: m.id, label: machineLabel(m) }))}
            allLabel={t('allTills')}
          />
        ) : null}

        {has('area') ? (
          <AreaFilterSelect shopId={shopId} value={v.areaId} onChange={(areaId) => set({ areaId })} className="min-w-0" />
        ) : null}

        {has('cashier') ? (
          <div className="min-w-0 space-y-1">
            <Label className="text-xs">{t('cashier')}</Label>
            <Combobox
              options={withUnknown(cashiers, v.cashierId).map((o) => ({
                value: o.value,
                label: o.label,
                description: o.hint ?? undefined,
              }))}
              value={v.cashierId}
              onValueChange={(id) => set({ cashierId: id ?? '' })}
              placeholder={shopId ? t('allCashiers') : t('cashierNeedsShop')}
              disabled={!shopId && !v.cashierId}
              clearable
              size="sm"
              aria-label={t('cashier')}
            />
          </div>
        ) : null}

        {has('method') ? (
          <SimpleSelect
            label={t('method')}
            value={v.method}
            onChange={(method) => set({ method })}
            options={withUnknown(methodOptions, v.method)}
            allLabel={t('allMethods')}
          />
        ) : null}

        {has('category') ? (
          <div className="min-w-0 space-y-1">
            <Label className="text-xs">{t('category')}</Label>
            <Combobox
              options={withUnknown(categories, v.categoryId)}
              value={v.categoryId}
              onValueChange={(id) => set({ categoryId: id ?? '' })}
              placeholder={t('allCategories')}
              clearable
              size="sm"
              aria-label={t('category')}
            />
          </div>
        ) : null}

        {has('product') ? (
          <div className="min-w-0 space-y-1">
            <Label className="text-xs">{t('product')}</Label>
            <Combobox
              options={withUnknown(products, v.productId).map((o) => ({
                value: o.value,
                label: o.label,
                keywords: o.hint ? [o.hint] : undefined,
              }))}
              value={v.productId}
              onValueChange={(id) => set({ productId: id ?? '' })}
              placeholder={t('allProducts')}
              clearable
              size="sm"
              aria-label={t('product')}
            />
          </div>
        ) : null}

        {has('docType') ? (
          <SimpleSelect
            label={t('docType')}
            value={v.docType}
            onChange={(docType) => set({ docType })}
            options={docTypes}
            allLabel={t('allDocTypes')}
          />
        ) : null}

        {has('search') ? (
          <div className="min-w-0 space-y-1">
            <Label className="text-xs" htmlFor="report-search">
              {t('search')}
            </Label>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden />
              <Input
                id="report-search"
                type="search"
                value={v.q}
                placeholder={t('searchPlaceholder')}
                className="ps-8"
                onChange={(e) => set({ q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canRun && !filters.isClient('search')) filters.run();
                }}
              />
            </div>
          </div>
        ) : null}

        {children}
      </div>

      {has('hours') && !wholeDay ? (
        <p
          role="note"
          className={`flex gap-2 text-xs ${hoursInvalid ? 'text-destructive' : 'text-amber-800 dark:text-amber-200'}`}
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {hoursInvalid
              ? t('hoursInvalid')
              : [
                  t('hoursEachDay', { band: `${formatHour(v.fromHour)}–${formatHour(v.toHour)}`, days }),
                  wrapsMidnight(hours) ? t('hoursWrap', { fromHour: formatHour(v.fromHour), toHour: formatHour(v.toHour) }) : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={filters.run} disabled={!canRun}>
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {isFetching ? t('running') : t('run')}
        </Button>
        <Button variant="ghost" size="sm" onClick={filters.clearAll}>
          <X className="h-4 w-4" aria-hidden />
          {t('clearAll')}
        </Button>
        {activeCount > 0 ? <Badge variant="secondary">{t('active', { count: activeCount })}</Badge> : null}
        {filters.applied && filters.dirty ? (
          <span className="text-muted-foreground text-xs">{t('pending')}</span>
        ) : filters.applied ? (
          <span className="text-muted-foreground hidden text-xs sm:inline">{t('linkHint')}</span>
        ) : null}
      </div>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
