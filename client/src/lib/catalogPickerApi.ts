/**
 * The catalog the two-pane product & category picker loads (lib/catalogPicker.ts):
 * `GET /catalog-picker` — the organization's catalog in one lean answer (menus, promotions);
 * the production vouchers load their own (`/prepaid-vouchers/products|categories`, the save's
 * rule) through [usePrepaidPickerCatalog] in the vouchers' components.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { PickerCategory, PickerProduct } from './catalogPicker';

export interface PickerCatalog {
  categories: PickerCategory[];
  products: PickerProduct[];
  total: number;
  truncated: boolean;
}

export async function fetchPickerCatalog(): Promise<PickerCatalog> {
  const { data } = await api.get<Partial<PickerCatalog>>('/catalog-picker');
  return {
    categories: (data.categories ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      parentId: c.parentId ?? null,
      isActive: c.isActive !== false,
      sortOrder: Number(c.sortOrder ?? 0),
    })),
    products: (data.products ?? []).map((p) => ({
      id: String(p.id),
      name: String(p.name ?? ''),
      categoryId: p.categoryId ?? null,
      price: Number(p.price ?? 0),
      sku: p.sku ?? null,
      isActive: p.isActive !== false,
      inStock: p.inStock !== false,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    })),
    total: Number(data.total ?? 0),
    truncated: data.truncated === true,
  };
}

export const PICKER_CATALOG_KEY = ['catalog-picker'] as const;

/** The organization's catalog for the picker, cached a minute across the dashboard's screens. */
export function usePickerCatalog(enabled = true) {
  return useQuery({ queryKey: PICKER_CATALOG_KEY, queryFn: fetchPickerCatalog, staleTime: 60_000, enabled });
}
