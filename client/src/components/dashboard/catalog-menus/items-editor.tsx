'use client';

/**
 * "קטגוריות ומוצרים" — what a menu sells, in its order, in the shared two-pane picker
 * (components/dashboard/catalog/product-category-picker.tsx): a ticked category is "כל
 * המוצרים" (its listed products first, then the rest of it), a category with only some
 * products ticked sells only those. A picked item can carry its "מחיר בתפריט" while the menu is
 * active (empty: the catalog's; VAT follows the product), and the bulk bar sets one price or a
 * percent on every picked item. "נבחרו" reorders categories and items.
 *
 * Saved as two arrays: the categories in order (whole → `allProducts`), and the listed products
 * in order (the order within each category is what the till keeps).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CatalogMenu } from '@/lib/catalogMenusApi';
import {
  EMPTY_SELECTION,
  buildIndex,
  bulkPrices,
  materialize,
  type PickerCategory,
  type PickerProduct,
  type PickerSelection,
} from '@/lib/catalogPicker';
import { usePickerCatalog } from '@/lib/catalogPickerApi';
import { formatCurrency } from '@/lib/format';
import { MENU_PRICE_MAX } from '@/lib/menuSchedule';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IosFootnote } from '@/components/dashboard/menu/ios';
import { ProductCategoryPicker } from '@/components/dashboard/catalog/product-category-picker';

export interface MenuItemsDraft {
  selection: PickerSelection;
  /** By product id; '' or absent — the catalog's price. */
  prices: Record<string, string>;
  /** What the menu names that the catalog no longer lists (kept, shown as they were). */
  extraCategories: PickerCategory[];
  extraProducts: PickerProduct[];
}

export const EMPTY_ITEMS: MenuItemsDraft = { selection: EMPTY_SELECTION, prices: {}, extraCategories: [], extraProducts: [] };

function priceText(price: number | null | undefined): string {
  return price === null || price === undefined ? '' : String(price);
}

/** A saved menu as the picker shows it. */
export function itemsDraftOf(menu: CatalogMenu | null): MenuItemsDraft {
  if (!menu) return EMPTY_ITEMS;
  const categories = menu.categories.map((c) => ({ id: c.categoryId, whole: c.allProducts }));
  const named = new Set(categories.map((c) => c.id));
  // A product listed from a category the menu does not name brings that category, partial.
  for (const p of menu.products) {
    if (p.categoryId && !named.has(p.categoryId)) {
      named.add(p.categoryId);
      categories.push({ id: p.categoryId, whole: false });
    }
  }
  const prices: Record<string, string> = {};
  for (const p of menu.products) if (p.price !== null) prices[p.productId] = priceText(p.price);
  return {
    selection: { categories, products: menu.products.map((p) => p.productId) },
    prices,
    extraCategories: menu.categories.map((c) => ({ id: c.categoryId, name: c.name, parentId: null, isActive: false, sortOrder: 9999 })),
    extraProducts: menu.products.map((p) => ({
      id: p.productId,
      name: p.name,
      categoryId: p.categoryId,
      price: p.catalogPrice ?? 0,
      isActive: false,
    })),
  };
}

const PRICE = /^\d{1,7}(\.\d{1,2})?$/;

/** A price box is fine: empty (the catalog's), or money up to the server's maximum. */
export function priceOk(text: string | undefined): boolean {
  const s = (text ?? '').trim();
  if (!s) return true;
  return PRICE.test(s) && Number(s) <= MENU_PRICE_MAX;
}

/** The PUT body's two arrays. */
export function itemsInput(d: MenuItemsDraft): {
  categories: { categoryId: string; allProducts: boolean }[];
  products: { productId: string; price: number | null }[];
} {
  return {
    categories: d.selection.categories.map((c) => ({ categoryId: c.id, allProducts: c.whole })),
    products: d.selection.products.map((id) => {
      const text = (d.prices[id] ?? '').trim();
      return { productId: id, price: text ? Number(text) : null };
    }),
  };
}

/** The first listed product whose price box is wrong, if any. */
export function badPriceOf(d: MenuItemsDraft): string | null {
  return d.selection.products.find((id) => !priceOk(d.prices[id])) ?? null;
}

/** Nothing to sell: no whole category and no listed product. */
export function itemsEmpty(d: MenuItemsDraft): boolean {
  return d.selection.products.length === 0 && !d.selection.categories.some((c) => c.whole);
}

/** The catalog, with what the menu names that it no longer lists. */
function useMenuCatalog(d: MenuItemsDraft) {
  const q = usePickerCatalog();
  const { extraCategories, extraProducts } = d;
  const merged = useMemo(() => {
    const cats = q.data?.categories ?? [];
    const prods = q.data?.products ?? [];
    const haveCat = new Set(cats.map((c) => c.id));
    const haveProd = new Set(prods.map((p) => p.id));
    return {
      categories: [...cats, ...extraCategories.filter((c) => !haveCat.has(c.id))],
      products: [...prods, ...extraProducts.filter((p) => !haveProd.has(p.id))],
    };
  }, [q.data, extraCategories, extraProducts]);
  return { ...merged, loading: q.isPending, truncated: q.data?.truncated ?? false };
}

export function ItemsEditor({
  value,
  onChange,
  disabled,
}: {
  value: MenuItemsDraft;
  onChange: (next: MenuItemsDraft) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('catalogMenus.items');
  const catalog = useMenuCatalog(value);
  const index = useMemo(() => buildIndex(catalog.categories, catalog.products), [catalog.categories, catalog.products]);

  const setSelection = (selection: PickerSelection) => onChange({ ...value, selection });

  /** A price on one item; an item of a whole category is listed first (with its category, in order). */
  const setPrice = (id: string, text: string) => {
    let selection = value.selection;
    if (!selection.products.includes(id)) selection = materialize(index, selection, index.nodeOf(id));
    onChange({ ...value, selection, prices: { ...value.prices, [id]: text } });
  };

  return (
    <div className="space-y-2">
      <ProductCategoryPicker
        categories={catalog.categories}
        products={catalog.products}
        loading={catalog.loading}
        value={value.selection}
        onChange={setSelection}
        orderable
        disabled={disabled}
        renderItemExtra={(p) => (
          <MenuPriceBox
            product={p}
            value={value.prices[p.id] ?? ''}
            disabled={disabled}
            onChange={(text) => setPrice(p.id, text)}
          />
        )}
        renderBulk={disabled ? undefined : ({ index: ix, picked }) => (
          <BulkPrices
            count={picked.length}
            onApply={(mode, n) => {
              let selection = value.selection;
              for (const c of selection.categories) if (c.whole) selection = materialize(ix, selection, c.id);
              onChange({ ...value, selection, prices: { ...value.prices, ...bulkPrices(picked, mode, n) } });
            }}
            onClear={() => {
              const prices = { ...value.prices };
              for (const p of picked) delete prices[p.id];
              onChange({ ...value, prices });
            }}
          />
        )}
      />
      {catalog.truncated ? <p className="text-xs text-[#C93400]">{t('truncated')}</p> : null}
      <IosFootnote>{t('priceHint')}</IosFootnote>
    </div>
  );
}

function MenuPriceBox({
  product,
  value,
  disabled,
  onChange,
}: {
  product: PickerProduct;
  value: string;
  disabled?: boolean;
  onChange: (text: string) => void;
}) {
  const t = useTranslations('catalogMenus.items');
  const ok = priceOk(value);
  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline" title={t('catalogPrice', { price: formatCurrency(product.price) })}>
        {t('basePrice', { price: formatCurrency(product.price) })}
      </span>
      <span className="text-[13px] text-[#6D6D72]">₪</span>
      <Input
        value={value}
        inputMode="decimal"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, '').slice(0, 10))}
        placeholder={product.price.toFixed(2)}
        aria-label={t('menuPriceOf', { name: product.name })}
        title={t('menuPrice')}
        className={cn(
          'h-8 w-20 rounded-lg px-2 text-center text-[14px] tabular-nums shadow-none',
          value.trim() && ok && 'border-[#FF9500] bg-[#FF9500]/10',
          !ok && 'border-[#FF3B30] text-[#FF3B30]',
        )}
      />
    </div>
  );
}

/** "קבע מחיר / אחוז לכל הנבחרים". */
function BulkPrices({
  count,
  onApply,
  onClear,
}: {
  count: number;
  onApply: (mode: 'set' | 'percent', value: number) => void;
  onClear: () => void;
}) {
  const t = useTranslations('catalogMenus.items');
  const [mode, setMode] = useState<'set' | 'percent'>('set');
  const [text, setText] = useState('');
  const n = Number(text.replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(n) && (mode === 'percent' ? n >= -100 && n <= 1000 : n >= 0 && n <= MENU_PRICE_MAX);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-sm">
      <span className="font-medium">{t('bulkTitle', { count })}</span>
      <select
        aria-label={t('bulkMode')}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'set' | 'percent')}
        className="h-8 rounded-lg border bg-background px-2 text-sm"
      >
        <option value="set">{t('bulkSet')}</option>
        <option value="percent">{t('bulkPercent')}</option>
      </select>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.,-]/g, '').slice(0, 10))}
        inputMode="decimal"
        aria-label={mode === 'set' ? t('bulkSet') : t('bulkPercent')}
        placeholder={mode === 'set' ? '₪' : t('bulkPercentPlaceholder')}
        className="h-8 w-24 text-center tabular-nums"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!valid}
        onClick={() => {
          onApply(mode, n);
          setText('');
        }}
      >
        {t('bulkApply')}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onClear}>
        {t('bulkClear')}
      </Button>
    </div>
  );
}
