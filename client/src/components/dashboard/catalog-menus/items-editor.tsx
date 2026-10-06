'use client';

/**
 * "קטגוריות ומוצרים" — what a menu sells, in its order: categories (each "כל המוצרים" —
 * the listed products first, then the rest of the category — or "רק מוצרים נבחרים"),
 * and within each category its listed products, each with an optional price while the
 * menu is active (empty: the catalog's; VAT follows the product). Drag to reorder.
 * Saved as two arrays in the order shown: the categories, and the products by category.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, Plus, Search, Trash2, X } from 'lucide-react';
import { fetchCategoryProducts, fetchMenuCategories, type CatalogMenu } from '@/lib/catalogMenusApi';
import { formatCurrency } from '@/lib/format';
import { MENU_PRICE_MAX } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IosCard, IosFootnote, IosSegmented, IosTag } from '@/components/dashboard/menu/ios';

export interface DraftProduct {
  productId: string;
  name: string;
  catalogPrice: number | null;
  /** '' — the catalog's price. */
  price: string;
}

export interface DraftCategory {
  key: string;
  /** Null: the products the menu lists that have no category (kept as they were). */
  categoryId: string | null;
  name: string;
  allProducts: boolean;
  products: DraftProduct[];
}

let keySeq = 0;
const newKey = () => `c${++keySeq}`;

function priceText(price: number | null): string {
  return price === null || price === undefined ? '' : String(price);
}

/**
 * A saved menu as the editor shows it: its categories in order, each with its listed
 * products; a product listed from a category the menu does not name brings that
 * category after the others with only its listed products — exactly where the till
 * puts it — and products with no category go last.
 */
export function draftCategoriesOf(menu: CatalogMenu | null): DraftCategory[] {
  if (!menu) return [];
  const out: DraftCategory[] = menu.categories.map((c) => ({
    key: newKey(),
    categoryId: c.categoryId,
    name: c.name,
    allProducts: c.allProducts,
    products: [],
  }));
  const byId = new Map(out.map((c) => [c.categoryId, c]));
  let loose: DraftCategory | null = null;
  for (const p of menu.products) {
    const product: DraftProduct = {
      productId: p.productId,
      name: p.name,
      catalogPrice: p.catalogPrice,
      price: priceText(p.price),
    };
    if (p.categoryId === null) {
      if (!loose) loose = { key: newKey(), categoryId: null, name: '', allProducts: false, products: [] };
      loose.products.push(product);
      continue;
    }
    let cat = byId.get(p.categoryId);
    if (!cat) {
      cat = { key: newKey(), categoryId: p.categoryId, name: '', allProducts: false, products: [] };
      byId.set(p.categoryId, cat);
      out.push(cat);
    }
    cat.products.push(product);
  }
  return loose ? [...out, loose] : out;
}

const PRICE = /^\d{1,7}(\.\d{1,2})?$/;

/** A price box is fine: empty (the catalog's), or money up to the server's maximum. */
export function priceOk(text: string): boolean {
  const s = text.trim();
  if (!s) return true;
  return PRICE.test(s) && Number(s) <= MENU_PRICE_MAX;
}

/** The PUT body's two arrays, in the order shown. */
export function itemsInput(categories: DraftCategory[]): {
  categories: { categoryId: string; allProducts: boolean }[];
  products: { productId: string; price: number | null }[];
} {
  return {
    categories: categories
      .filter((c): c is DraftCategory & { categoryId: string } => c.categoryId !== null)
      .map((c) => ({ categoryId: c.categoryId, allProducts: c.allProducts })),
    products: categories.flatMap((c) =>
      c.products.map((p) => ({ productId: p.productId, price: p.price.trim() ? Number(p.price.trim()) : null })),
    ),
  };
}

/** The catalog's categories, each named with its parent path ("שתייה › קלה"), in catalog order. */
function useMenuCategoryOptions(): { id: string; label: string; isActive: boolean }[] {
  const { data = [] } = useQuery({ queryKey: ['catalog-menus-categories'], queryFn: fetchMenuCategories, staleTime: 60_000 });
  return useMemo(() => {
    const byId = new Map(data.map((c) => [c.id, c]));
    const path = (id: string): string => {
      const names: string[] = [];
      let c = byId.get(id);
      let guard = 0;
      while (c && guard++ < 10) {
        names.unshift(c.name);
        c = c.parentId ? byId.get(c.parentId) : undefined;
      }
      return names.join(' › ');
    };
    return data.map((c) => ({ id: c.id, label: path(c.id), isActive: c.isActive }));
  }, [data]);
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function ItemsEditor({
  value,
  onChange,
  disabled,
}: {
  value: DraftCategory[];
  onChange: (next: DraftCategory[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('catalogMenus.items');
  const categoryOptions = useMenuCategoryOptions();
  const labelOf = useMemo(() => new Map(categoryOptions.map((o) => [o.id, o.label])), [categoryOptions]);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [dragCat, setDragCat] = useState<string | null>(null);

  const inMenu = new Set(value.map((c) => c.categoryId));
  const q = search.trim().toLowerCase();
  const available = categoryOptions.filter((o) => !inMenu.has(o.id) && (!q || o.label.toLowerCase().includes(q)));

  const setCategory = (key: string, patch: Partial<DraftCategory>) =>
    onChange(value.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const dropCategory = (targetKey: string) => {
    if (!dragCat || dragCat === targetKey) return;
    const from = value.findIndex((c) => c.key === dragCat);
    const to = value.findIndex((c) => c.key === targetKey);
    onChange(move(value, from, to));
  };

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <IosCard className="p-4 text-center text-[14px] text-[#6D6D72]">{t('empty')}</IosCard>
      ) : (
        value.map((c, index) => (
          <div
            key={c.key}
            onDragOver={(e) => {
              if (dragCat) e.preventDefault();
            }}
            onDrop={() => {
              dropCategory(c.key);
              setDragCat(null);
            }}
            className={cn(dragCat === c.key && 'opacity-50')}
          >
            <CategoryBlock
              category={c}
              name={c.categoryId === null ? t('uncategorized') : labelOf.get(c.categoryId) || c.name || t('unknownCategory')}
              disabled={disabled}
              first={index === 0}
              last={index === value.length - 1}
              onDragStart={() => setDragCat(c.key)}
              onDragEnd={() => setDragCat(null)}
              onChange={(patch) => setCategory(c.key, patch)}
              onMove={(delta) => onChange(move(value, index, index + delta))}
              onRemove={() => onChange(value.filter((x) => x.key !== c.key))}
            />
          </div>
        ))
      )}

      {disabled ? null : picking ? (
        <IosCard className="space-y-2 p-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5"
              aria-hidden
            />
            <Input value={search} autoFocus onChange={(e) => setSearch(e.target.value)} placeholder={t('searchCategories')} className="ps-8" />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {available.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">{t('noCategories')}</p>
            ) : (
              <ul>
                {available.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onChange([
                          ...value,
                          { key: newKey(), categoryId: o.id, name: o.label, allProducts: true, products: [] },
                        ])
                      }
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted',
                        !o.isActive && 'opacity-60',
                      )}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPicking(false)}>
            {t('done')}
          </Button>
        </IosCard>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
          <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
          {t('addCategory')}
        </Button>
      )}
      <IosFootnote>{t('priceHint')}</IosFootnote>
    </div>
  );
}

function CategoryBlock({
  category: c,
  name,
  disabled,
  first,
  last,
  onDragStart,
  onDragEnd,
  onChange,
  onMove,
  onRemove,
}: {
  category: DraftCategory;
  name: string;
  disabled?: boolean;
  first: boolean;
  last: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onChange: (patch: Partial<DraftCategory>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('catalogMenus.items');
  const [adding, setAdding] = useState(false);
  const [dragProduct, setDragProduct] = useState<string | null>(null);

  const setProduct = (productId: string, patch: Partial<DraftProduct>) =>
    onChange({ products: c.products.map((p) => (p.productId === productId ? { ...p, ...patch } : p)) });

  const dropProduct = (targetId: string) => {
    if (!dragProduct || dragProduct === targetId) return;
    const from = c.products.findIndex((p) => p.productId === dragProduct);
    const to = c.products.findIndex((p) => p.productId === targetId);
    onChange({ products: move(c.products, from, to) });
  };

  return (
    <IosCard>
      <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.08] px-3 py-2.5 dark:border-white/[0.1]">
        {!disabled ? (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            className="cursor-grab"
            title={t('dragHint')}
          >
            <GripVertical className="h-4 w-4 text-[#C7C7CC]" aria-label={t('dragHint')} />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{name}</span>
        <span className="text-[12px] text-[#8E8E93]">{t('productCount', { count: c.products.length })}</span>
        {!disabled ? (
          <div className="flex items-center">
            <Button size="icon-sm" variant="ghost" aria-label={t('up')} title={t('up')} disabled={first} onClick={() => onMove(-1)}>
              <ArrowUp className="h-4 w-4" aria-hidden />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={t('down')} title={t('down')} disabled={last} onClick={() => onMove(1)}>
              <ArrowDown className="h-4 w-4" aria-hidden />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={t('removeCategory')} title={t('removeCategory')} onClick={onRemove}>
              <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
      {c.categoryId !== null ? (
        <div className="space-y-1.5 px-3 py-2">
          <IosSegmented
            value={c.allProducts ? 'all' : 'selected'}
            disabled={disabled}
            onChange={(v) => onChange({ allProducts: v === 'all' })}
            options={[
              { id: 'all', label: t('allProducts') },
              { id: 'selected', label: t('onlySelected') },
            ]}
          />
          <p className="text-[12px] text-[#6D6D72]">{c.allProducts ? t('allHint') : t('selectedHint')}</p>
          {!c.allProducts && c.products.length === 0 ? (
            <p className="text-[12px] font-medium text-[#C93400] dark:text-[#FF9F0A]">{t('noProductsWarning')}</p>
          ) : null}
        </div>
      ) : null}
      {c.products.length ? (
        <ul>
          {c.products.map((p) => {
            const ok = priceOk(p.price);
            return (
              <li
                key={p.productId}
                onDragOver={(e) => {
                  if (dragProduct) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                onDrop={(e) => {
                  if (!dragProduct) return;
                  e.stopPropagation();
                  dropProduct(p.productId);
                  setDragProduct(null);
                }}
                className={cn(
                  'flex items-center gap-2 border-t border-black/[0.06] px-3 py-1.5 dark:border-white/[0.08]',
                  dragProduct === p.productId && 'opacity-50',
                )}
              >
                {!disabled ? (
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = 'move';
                      setDragProduct(p.productId);
                    }}
                    onDragEnd={() => setDragProduct(null)}
                    className="cursor-grab"
                    title={t('dragHint')}
                  >
                    <GripVertical className="h-4 w-4 text-[#C7C7CC]" aria-label={t('dragHint')} />
                  </span>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]">{p.name}</div>
                  <div className="text-[11px] text-[#8E8E93]">{t('catalogPrice', { price: formatCurrency(p.catalogPrice) })}</div>
                </div>
                {p.price.trim() && ok ? <IosTag tone="orange">{t('menuPriceTag')}</IosTag> : null}
                <div className="flex items-center gap-1">
                  <span className="text-[13px] text-[#6D6D72]">₪</span>
                  <Input
                    value={p.price}
                    inputMode="decimal"
                    disabled={disabled}
                    onChange={(e) => setProduct(p.productId, { price: e.target.value.replace(/[^0-9.]/g, '').slice(0, 10) })}
                    placeholder={p.catalogPrice !== null ? p.catalogPrice.toFixed(2) : ''}
                    aria-label={t('menuPrice')}
                    title={t('menuPrice')}
                    className={cn(
                      'h-8 w-24 rounded-lg bg-[#7676801F] px-2 text-center text-[14px] tabular-nums shadow-none',
                      !ok && 'border-[#FF3B30] text-[#FF3B30]',
                    )}
                  />
                </div>
                {!disabled ? (
                  <button
                    type="button"
                    aria-label={t('removeProduct')}
                    title={t('removeProduct')}
                    onClick={() => onChange({ products: c.products.filter((x) => x.productId !== p.productId) })}
                    className="rounded-full p-1 text-[#8E8E93] hover:bg-black/5"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!disabled && c.categoryId !== null ? (
        <div className="border-t border-black/[0.06] px-3 py-2 dark:border-white/[0.08]">
          {adding ? (
            <ProductPicker
              categoryId={c.categoryId}
              chosen={c.products}
              onAdd={(items) => onChange({ products: [...c.products, ...items] })}
              onDone={() => setAdding(false)}
            />
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
              {t('addProducts')}
            </Button>
          )}
        </div>
      ) : null}
    </IosCard>
  );
}

function ProductPicker({
  categoryId,
  chosen,
  onAdd,
  onDone,
}: {
  categoryId: string;
  chosen: DraftProduct[];
  onAdd: (items: DraftProduct[]) => void;
  onDone: () => void;
}) {
  const t = useTranslations('catalogMenus.items');
  const [search, setSearch] = useState('');
  const { data = [], isPending } = useQuery({
    queryKey: ['catalog-menus-category-products', categoryId],
    queryFn: () => fetchCategoryProducts(categoryId),
    staleTime: 60_000,
  });
  const taken = new Set(chosen.map((p) => p.productId));
  const q = search.trim().toLowerCase();
  const left = data.filter((p) => !taken.has(p.id) && (!q || p.name.toLowerCase().includes(q)));
  const asDraft = (p: (typeof data)[number]): DraftProduct => ({ productId: p.id, name: p.name, catalogPrice: p.price, price: '' });

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5"
          aria-hidden
        />
        <Input value={search} autoFocus onChange={(e) => setSearch(e.target.value)} placeholder={t('searchProducts')} className="ps-8" />
      </div>
      <div className="max-h-48 overflow-y-auto">
        {isPending ? (
          <p className="p-2 text-xs text-muted-foreground">{t('loading')}</p>
        ) : left.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">{t('noProducts')}</p>
        ) : (
          <ul>
            {left.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onAdd([asDraft(p)])}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-muted',
                    !p.isActive && 'opacity-60',
                  )}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatCurrency(p.price)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        {left.length > 1 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onAdd(left.map(asDraft))}>
            {t('addAll', { count: left.length })}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('done')}
        </Button>
      </div>
    </div>
  );
}
