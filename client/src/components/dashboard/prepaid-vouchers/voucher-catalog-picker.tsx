'use client';

/**
 * The production vouchers' pickers in the shared two-pane picker
 * (components/dashboard/catalog/product-category-picker.tsx): goods with a quantity, a group's
 * items and exclusions, an item discount's targets. The catalog is the vouchers' own — every
 * product a batch of the company may be looking for, each with whether it can go on and why
 * not (`GET /prepaid-vouchers/products`, the save's own rule, §7.14), and the categories it may
 * name (`GET /prepaid-vouchers/categories`). A product that cannot go on is shown greyed with
 * its reason instead of being left out.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchPrepaidCategories, searchPrepaidProducts } from '@/lib/prepaidVouchersApi';
import {
  DEFAULT_WEIGHT_UNIT,
  blockKeyOf,
  noteKeysOf,
  type PrepaidProductOption,
  type PrepaidProductPurpose,
} from '@/lib/prepaidVoucherProducts';
import {
  buildIndex,
  compressWhole,
  expandWhole,
  groupOf,
  selectionOf,
  type PickerCategory,
  type PickerProduct,
} from '@/lib/catalogPicker';
import { ProductCategoryPicker } from '@/components/dashboard/catalog/product-category-picker';

/** The most products the picker loads at once (the cloud's `PRODUCTS_LIMIT_MAX`). */
const LIMIT = 5000;

export interface PrepaidPickerCatalog {
  categories: PickerCategory[];
  products: PickerProduct[];
  /** The cloud's rows by id (names, weights, units — what the screens keep). */
  options: Map<string, PrepaidProductOption>;
  loading: boolean;
}

export function usePrepaidPickerCatalog(
  companyId: string,
  purpose: PrepaidProductPurpose,
  shopIds: string[] | undefined,
): PrepaidPickerCatalog {
  const te = useTranslations('prepaidVouchers.eligibility');
  const ids = shopIds ?? [];
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', companyId, '', purpose, ids, 'all'],
    queryFn: () => searchPrepaidProducts('', companyId, { purpose, shopIds: ids, limit: LIMIT }),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  const categories = useQuery({
    queryKey: ['prepaid-voucher-categories', companyId],
    queryFn: () => fetchPrepaidCategories(companyId),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const rows = products.data ?? [];
    return {
      categories: (categories.data ?? []).map((c) => ({ id: c.id, name: c.name, parentId: c.parentId })),
      products: rows.map((p): PickerProduct => {
        const block = blockKeyOf(p, purpose);
        const unit = p.unitLabel || DEFAULT_WEIGHT_UNIT;
        return {
          id: p.id,
          name: p.name,
          categoryId: p.categoryId ?? null,
          price: p.price,
          sku: p.sku ?? null,
          isActive: p.isActive !== false,
          blocked: block ? te(`blocked.${block}`) : null,
          notes: noteKeysOf(p, purpose).map((n) => te(`notes.${n}`, { unit, shop: p.shopName ?? '' })),
        };
      }),
      options: new Map(rows.map((p) => [p.id, p])),
      loading: !!companyId && (products.isPending || categories.isPending),
    };
  }, [products.data, categories.data, products.isPending, categories.isPending, companyId, purpose, te]);
}

export interface VoucherPickValue {
  categoryIds: string[];
  productIds: string[];
}

/**
 * Categories (whole) and products, as a voucher screen stores them. [withSubcategories]: a
 * stored category stands for its sub-categories too (a group's "כולל תתי-קטגוריות").
 */
export function VoucherItemsPicker({
  companyId,
  shopIds,
  purpose,
  value,
  onChange,
  wholeCategories = true,
  withSubcategories = false,
  renderItemExtra,
  unavailableText,
  listHeight = 360,
}: {
  companyId: string;
  shopIds?: string[];
  purpose: PrepaidProductPurpose;
  value: VoucherPickValue;
  onChange: (next: VoucherPickValue, options: Map<string, PrepaidProductOption>) => void;
  wholeCategories?: boolean;
  withSubcategories?: boolean;
  renderItemExtra?: (p: PickerProduct) => ReactNode;
  unavailableText?: string | null;
  listHeight?: number;
}) {
  const catalog = usePrepaidPickerCatalog(companyId, purpose, shopIds);
  const index = useMemo(() => buildIndex(catalog.categories, catalog.products), [catalog.categories, catalog.products]);
  const selection = useMemo(
    () => selectionOf(index, withSubcategories ? expandWhole(index, value.categoryIds) : value.categoryIds, value.productIds),
    [index, value.categoryIds, value.productIds, withSubcategories],
  );
  return (
    <ProductCategoryPicker
      categories={catalog.categories}
      products={catalog.products}
      loading={catalog.loading}
      unavailableText={unavailableText}
      value={selection}
      wholeCategories={wholeCategories}
      onChange={(next) => {
        const g = groupOf(index, next);
        onChange(
          { categoryIds: withSubcategories ? compressWhole(index, g.categoryIds) : g.categoryIds, productIds: g.productIds },
          catalog.options,
        );
      }}
      renderItemExtra={renderItemExtra}
      listHeight={listHeight}
    />
  );
}
