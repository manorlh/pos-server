'use client';

/**
 * Search and filters above the products list. On md and up they sit in a row; below,
 * the search stays and the rest move into a bottom sheet behind a "סינון" button.
 *
 * Search is debounced and sent as typed: the server normalizes it (niqqud and quote
 * marks dropped, as the sidebar search does) — see app/services/product_list_filters.py.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { MapPin, Search, SlidersHorizontal, X } from 'lucide-react';
import { fetchCompanies, fetchMachines, fetchShops } from '@/lib/api';
import { numberedLabel } from '@/lib/orgNumber';
import { registerNumberOf } from '@/lib/registerNumber';
import type { Category, Company, PosMachine, Shop } from '@/lib/types';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  UNCATEGORIZED,
  activeFilterCount,
  type LevelFilter,
  type ProductListFilters,
  type StatusFilter,
} from './product-list-params';

const SEARCH_DEBOUNCE_MS = 300;

/** "סניף מרכז › קופה 2" for the chosen "available at" scope, or null. */
function useScopeLabel(scope: OrgScope): string | null {
  const t = useTranslations('productsList.filters');
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const { data: shops = [] } = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: !!scope.machineId,
  });
  const { data: areas = [] } = useShopAreas(scope.areaId ? scope.shopId || null : null);
  const deepest = deepestOrgScope(scope);
  if (!deepest || deepest.level === 'tenant') return null;
  const parts: string[] = [];
  const company = companies.find((c) => c.id === scope.companyId);
  const shop = shops.find((s) => s.id === scope.shopId);
  const area = areas.find((a) => a.id === scope.areaId);
  const machine = machines.find((m) => m.id === scope.machineId);
  if (deepest.level === 'company') parts.push(company ? numberedLabel(company.companyNumber, company.name) : t('company'));
  if (shop) parts.push(numberedLabel(shop.shopNumber, shop.name));
  if (area) parts.push(area.name);
  if (machine) {
    const n = registerNumberOf(machine);
    parts.push(n ? t('till', { n }) : machine.name);
  }
  return parts.join(' › ') || null;
}

function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const t = useTranslations('productsList.filters');
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  // The URL changed under us (back button, "clear"): follow it.
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  useEffect(() => {
    if (text === value) return;
    const id = window.setTimeout(() => onChange(text), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text, value, onChange]);
  return (
    <div className="relative min-w-0 flex-1 md:max-w-sm">
      <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        className="ps-8"
      />
    </div>
  );
}

function AvailableAtPicker({
  value,
  onChange,
}: {
  value: OrgScope;
  onChange: (next: OrgScope) => void;
}) {
  const t = useTranslations('productsList.filters');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<OrgScope>(value);
  const label = useScopeLabel(value);
  return (
    <div className="space-y-1.5 min-w-0">
      <span className="text-sm font-medium">{t('availableAt')}</span>
      <div className="flex gap-1">
        <Button
          variant="outline"
          className="w-full min-w-0 justify-start font-normal"
          onClick={() => {
            setDraft(value);
            setOpen(true);
          }}
        >
          <MapPin className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
          <span className="truncate">{label ?? t('availableAnywhere')}</span>
        </Button>
        {label ? (
          <Button variant="ghost" size="icon" aria-label={t('clearAvailableAt')} onClick={() => onChange(EMPTY_ORG_SCOPE)}>
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('availableAtTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t('availableAtHint')}</p>
          <OrgScopeCascade value={draft} onChange={setDraft} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(EMPTY_ORG_SCOPE)}>
              {t('clearAvailableAt')}
            </Button>
            <Button
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              {t('apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterFields({
  filters,
  setFilters,
  categories,
}: {
  filters: ProductListFilters;
  setFilters: (patch: Partial<ProductListFilters>) => void;
  categories: Category[];
}) {
  const t = useTranslations('productsList.filters');
  const categoryOptions = useMemo(
    () => [
      ...categories.map((c) => ({ id: c.id, label: c.name, hint: c.isActive ? null : t('inactiveCategory') })),
      { id: UNCATEGORIZED, label: t('uncategorized') },
    ],
    [categories, t],
  );
  const statusItems = [
    { value: 'all', label: t('statusAll') },
    { value: 'active', label: t('statusActive') },
    { value: 'inactive', label: t('statusInactive') },
  ];
  const levelItems = [
    { value: 'all', label: t('levelAll') },
    { value: 'global', label: t('levelGlobal') },
    { value: 'local', label: t('levelLocal') },
  ];
  const scoped = !!deepestOrgScope(filters.availableAt);
  return (
    <>
      <div className="min-w-0 md:w-56">
        <EntityMultiSelect
          label={t('category')}
          options={categoryOptions}
          selected={filters.categories}
          onChange={(categories) => setFilters({ categories })}
          allLabel={t('allCategories')}
          clearLabel={t('clearCategories')}
          emptyLabel={t('allCategories')}
        />
      </div>
      <div className="min-w-0 space-y-1.5 md:w-44">
        <Label>{t('status')}</Label>
        <Select
          value={filters.status}
          onValueChange={(v) => setFilters({ status: (v ?? 'all') as StatusFilter })}
          items={statusItems}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusItems.map((o) => (
              <SelectItem key={o.value} value={o.value} label={o.label}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{scoped ? t('statusAtScopeHint') : t('statusAnywhereHint')}</p>
      </div>
      <div className="min-w-0 space-y-1.5 md:w-36">
        <Label>{t('level')}</Label>
        <Select
          value={filters.level}
          onValueChange={(v) => setFilters({ level: (v ?? 'all') as LevelFilter })}
          items={levelItems}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {levelItems.map((o) => (
              <SelectItem key={o.value} value={o.value} label={o.label}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-0 md:w-64">
        <AvailableAtPicker value={filters.availableAt} onChange={(availableAt) => setFilters({ availableAt })} />
      </div>
    </>
  );
}

export function ProductFilters({
  filters,
  setFilters,
  clearFilters,
  categories,
}: {
  filters: ProductListFilters;
  setFilters: (patch: Partial<ProductListFilters>) => void;
  clearFilters: () => void;
  categories: Category[];
}) {
  const t = useTranslations('productsList.filters');
  const [sheetOpen, setSheetOpen] = useState(false);
  const count = activeFilterCount(filters);
  const onSearch = useMemo(() => (q: string) => setFilters({ q }), [setFilters]);
  const anything = count > 0 || !!filters.q.trim();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SearchBox value={filters.q} onChange={onSearch} />
        <Button variant="outline" className="md:hidden" onClick={() => setSheetOpen(true)}>
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          {t('filters')}
          {count > 0 ? <Badge className="ms-1">{count}</Badge> : null}
        </Button>
        {anything ? (
          <Button variant="ghost" size="sm" className="hidden md:inline-flex" onClick={clearFilters}>
            <X className="h-3.5 w-3.5" aria-hidden />
            {t('clearAll')}
          </Button>
        ) : null}
      </div>

      <div className="hidden md:flex md:flex-wrap md:items-start md:gap-3">
        <FilterFields filters={filters} setFilters={setFilters} categories={categories} />
      </div>

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        {/* A bottom sheet on a phone: pinned to the bottom edge, full width. */}
        <DialogContent className="top-auto bottom-0 max-w-none w-full translate-y-0 rounded-b-none data-open:slide-in-from-bottom-10 data-open:zoom-in-100 md:hidden">
          <DialogHeader>
            <DialogTitle>{t('filters')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <FilterFields filters={filters} setFilters={setFilters} categories={categories} />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                clearFilters();
                setSheetOpen(false);
              }}
            >
              {t('clearAll')}
            </Button>
            <Button onClick={() => setSheetOpen(false)}>{t('showResults')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
