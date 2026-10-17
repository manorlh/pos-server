'use client';

/**
 * What a promotion speaks of ("קבוצת מבצע"): products, categories (with their
 * sub-categories), or the whole basket — and the exclusions taken out of it.
 *
 * The group's products and categories are picked in the shared two-pane picker (a category's
 * tick = all its items, its sub-categories with it); `ProductListPicker` stays for the screens
 * that pick a product or two by search.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import {
  fetchPromoCategories,
  fetchPromoProduct,
  searchPromoProducts,
  type PromoCategoryOption,
  type PromoGroup,
} from '@/lib/promotionsApi';
import { type MultiSelectOption } from '@/components/dashboard/entity-multi-select';
import { buildIndex, compressWhole, expandWhole, groupOf, selectionOf, type PickerCategory, type PickerProduct } from '@/lib/catalogPicker';
import { usePickerCatalog } from '@/lib/catalogPickerApi';
import { ProductCategoryPicker } from '@/components/dashboard/catalog/product-category-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/** Categories as options, each named with its parent path. */
export function useCategoryOptions(): MultiSelectOption[] {
  const { data = [] } = useQuery<PromoCategoryOption[]>({
    queryKey: ['promo-categories'],
    queryFn: fetchPromoCategories,
  });
  return useMemo(() => {
    const byId = new Map(data.map((c) => [c.id, c]));
    const path = (c: PromoCategoryOption): string => {
      const names = [c.name];
      let parent = c.parentId ? byId.get(c.parentId) : undefined;
      let guard = 0;
      while (parent && guard++ < 10) {
        names.unshift(parent.name);
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      return names.join(' › ');
    };
    return data
      .map((c) => ({ id: c.id, label: path(c) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'he'));
  }, [data]);
}

function ProductChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const t = useTranslations('promotions.group');
  const { data } = useQuery({ queryKey: ['promo-product', id], queryFn: () => fetchPromoProduct(id), staleTime: 300_000 });
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-2.5 pe-1 text-xs">
      <span className="truncate">{data?.name ?? '…'}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('removeProduct')}
        className="rounded-full p-0.5 hover:bg-muted"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}

/** A product list: chips of what is chosen, and a search to add more. */
export function ProductListPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations('promotions.group');
  const tc = useTranslations('common');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const products = useQuery({
    queryKey: ['promo-products', debounced],
    queryFn: () => searchPromoProducts(debounced),
    enabled: open,
  });
  const chosen = new Set(value);

  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <ProductChip key={id} id={id} onRemove={() => onChange(value.filter((x) => x !== id))} />
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="space-y-1.5 rounded-lg border p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5"
              aria-hidden
            />
            <Input
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchProducts')}
              className="ps-8"
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            {products.isPending ? (
              <p className="p-2 text-xs text-muted-foreground">{tc('loading')}</p>
            ) : (products.data ?? []).length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">{t('noProducts')}</p>
            ) : (
              <ul>
                {products.data!.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={chosen.has(p.id)}
                      onClick={() => onChange([...value, p.id])}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">₪{p.price.toFixed(2)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t('doneAdding')}
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
          {t('addProducts')}
        </Button>
      )}
    </div>
  );
}

/**
 * Products and categories (a category with its sub-categories) in the shared two-pane picker
 * (components/dashboard/catalog/product-category-picker.tsx) — `GET /catalog-picker`.
 */
function GroupItems({
  categoryIds,
  productIds,
  onChange,
  listHeight,
}: {
  categoryIds: string[];
  productIds: string[];
  onChange: (next: { categoryIds: string[]; productIds: string[] }) => void;
  listHeight?: number;
}) {
  const q = usePickerCatalog();
  const categories = q.data?.categories ?? NO_CATEGORIES;
  const products = q.data?.products ?? NO_PRODUCTS;
  const index = useMemo(() => buildIndex(categories, products), [categories, products]);
  const selection = useMemo(() => selectionOf(index, expandWhole(index, categoryIds), productIds), [index, categoryIds, productIds]);
  return (
    <ProductCategoryPicker
      categories={categories}
      products={products}
      loading={q.isPending}
      value={selection}
      listHeight={listHeight}
      onChange={(next) => {
        const g = groupOf(index, next);
        onChange({ categoryIds: compressWhole(index, g.categoryIds), productIds: g.productIds });
      }}
    />
  );
}

const NO_CATEGORIES: PickerCategory[] = [];
const NO_PRODUCTS: PickerProduct[] = [];

/** A whole group: everything, or products and categories; and its exclusions. */
export function GroupPicker({
  value,
  onChange,
  allowAll = false,
  allLabel,
}: {
  value: PromoGroup;
  onChange: (next: PromoGroup) => void;
  /** Offer "the whole basket" (a spend threshold counts it by default). */
  allowAll?: boolean;
  allLabel?: string;
}) {
  const t = useTranslations('promotions.group');
  const [showExclusions, setShowExclusions] = useState(
    !!(value.excludeProductIds?.length || value.excludeCategoryIds?.length),
  );
  const set = (patch: Partial<PromoGroup>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {allowAll ? (
        <div className="flex items-center justify-between gap-3">
          <Label>{allLabel ?? t('all')}</Label>
          <Switch checked={!!value.all} onCheckedChange={(c) => set({ all: !!c })} aria-label={allLabel ?? t('all')} />
        </div>
      ) : null}
      {!value.all ? (
        <>
          <span className="text-sm font-medium">{t('itemsPick')}</span>
          <GroupItems
            categoryIds={value.categoryIds ?? []}
            productIds={value.productIds ?? []}
            onChange={(g) => set({ categoryIds: g.categoryIds, productIds: g.productIds })}
          />
          <p className="text-xs text-muted-foreground">{t('subcategoriesHint')}</p>
        </>
      ) : null}
      {showExclusions ? (
        <div className="space-y-3 border-t pt-3">
          <p className="text-sm font-medium">{t('exclusions')}</p>
          <GroupItems
            listHeight={280}
            categoryIds={value.excludeCategoryIds ?? []}
            productIds={value.excludeProductIds ?? []}
            onChange={(g) => set({ excludeCategoryIds: g.categoryIds, excludeProductIds: g.productIds })}
          />
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowExclusions(true)}>
          {t('addExclusions')}
        </Button>
      )}
    </div>
  );
}

/** Does the group name anything at all. */
export function groupIsSet(g: PromoGroup | undefined): boolean {
  return !!g && (!!g.all || !!g.productIds?.length || !!g.categoryIds?.length);
}
