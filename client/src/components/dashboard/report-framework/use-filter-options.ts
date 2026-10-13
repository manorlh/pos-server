'use client';

/**
 * The option lists of the filter bar, and the names of the chosen values for the export's
 * "סינון:" line. Both read the same query caches, so naming a choice never fetches twice.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api, AREA_NONE } from '@/lib/api';
import { fetchPromoCategories, fetchPromoProduct, type PromoCategoryOption } from '@/lib/promotionsApi';
import { categoryPath } from '@/lib/categoryTree';
import { receiptDocumentKey } from '@/lib/dealerType';
import { formatHour } from '@/lib/format';
import type { ReportFilterValues } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import type { PosUser } from '@/lib/types';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import type { ReportFiltersController } from './use-report-filters';

export interface FilterOption {
  value: string;
  label: string;
  hint?: string | null;
}

/** The document types a report can be narrowed to (as the transactions search offers them). */
export const REPORT_DOCUMENT_TYPES = [320, 330, 400, -400] as const;

export function useDocTypeOptions(): FilterOption[] {
  const tt = useTranslations('transactions');
  const tb = useTranslations('businessType');
  return REPORT_DOCUMENT_TYPES.map((n) => {
    const receipt = receiptDocumentKey(n);
    return { value: String(n), label: receipt ? tb(receipt) : tt(`documentTypes.${n}`) };
  });
}

/** A shop's cashiers, former ones too (history keeps pointing at them). */
export function useCashierOptions(shopId: string | null | undefined, enabled = true): FilterOption[] {
  const t = useTranslations('reportFramework.filters');
  const { data } = useQuery<PosUser[]>({
    queryKey: ['pos-users', shopId ?? null, true],
    queryFn: () => api.get(`/shops/${shopId}/pos-users`, { params: { include_inactive: true } }).then((r) => r.data),
    enabled: enabled && !!shopId,
    staleTime: 60_000,
  });
  return useMemo(
    () =>
      (data ?? []).map((u) => {
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username;
        return {
          value: u.id,
          label: u.isActive ? name : t('inactive', { name }),
          hint: u.workerNumber ?? null,
        };
      }),
    [data, t],
  );
}

export function useCategoryOptions(enabled: boolean): { options: FilterOption[]; categories: PromoCategoryOption[] } {
  const { data } = useQuery<PromoCategoryOption[]>({
    queryKey: ['report-filter-categories'],
    queryFn: fetchPromoCategories,
    enabled,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const categories = data ?? [];
    const options = categories
      .map((c) => ({ value: c.id, label: categoryPath(categories, c.id) || c.name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'he'));
    return { options, categories };
  }, [data]);
}

/** The first 200 products of the catalogue, and the chosen one's name if it is not among them. */
export function useProductOptions(enabled: boolean, chosenId: string): FilterOption[] {
  const { data } = useQuery<FilterOption[]>({
    queryKey: ['report-filter-products'],
    queryFn: async () => {
      const { data: page } = await api.get<{ items: Record<string, unknown>[] }>('/products', {
        params: { page: 1, pageSize: 200 },
      });
      return (page.items ?? []).map((p) => ({
        value: String(p.id),
        label: String(p.name ?? ''),
        hint: (p.sku as string | null | undefined) ?? null,
      }));
    },
    enabled,
    staleTime: 5 * 60_000,
  });
  const missing = Boolean(chosenId) && !(data ?? []).some((o) => o.value === chosenId);
  const { data: chosen } = useQuery({
    queryKey: ['report-filter-product', chosenId],
    queryFn: () => fetchPromoProduct(chosenId),
    enabled: enabled && missing,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const list = data ?? [];
    return chosen && missing ? [{ value: chosen.id, label: chosen.name, hint: chosen.sku }, ...list] : list;
  }, [chosen, data, missing]);
}

export interface FilterBarOptions {
  /** The shop whose areas and cashiers are offered (the scope's). */
  shopId?: string | null;
  /** The payment methods to offer, with their labels (the report's own names). */
  methodOptions?: FilterOption[];
}

/**
 * The applied filters as the export header says them: "קופאי: דנה · אמצעי תשלום: מזומן".
 * The hour band is its own line (`hours`).
 */
export function useFilterDescription(
  filters: ReportFiltersController,
  options: FilterBarOptions,
): { lines: ReportFilterLine[]; hours: string | null } {
  const t = useTranslations('reportFramework.filters');
  const ta = useTranslations('areas');
  const offered = filters.spec.filters;
  const values: ReportFilterValues | null = filters.applied?.values ?? null;
  const { data: areas = [] } = useShopAreas(offered.includes('area') ? options.shopId : null, true);
  const cashiers = useCashierOptions(options.shopId, offered.includes('cashier') && Boolean(values?.cashierId));
  const { options: categories } = useCategoryOptions(offered.includes('category') && Boolean(values?.categoryId));
  const products = useProductOptions(offered.includes('product') && Boolean(values?.productId), values?.productId ?? '');
  const docTypes = useDocTypeOptions();

  return useMemo(() => {
    if (!values) return { lines: [], hours: null };
    const name = (list: FilterOption[], id: string) => list.find((o) => o.value === id)?.label ?? id;
    const lines: ReportFilterLine[] = [];
    if (offered.includes('area') && values.areaId) {
      lines.push({
        label: ta('filter.label'),
        value: values.areaId === AREA_NONE ? ta('filter.none') : (areas.find((a) => a.id === values.areaId)?.name ?? values.areaId),
      });
    }
    if (offered.includes('cashier') && values.cashierId) lines.push({ label: t('cashier'), value: name(cashiers, values.cashierId) });
    if (offered.includes('method') && values.method) {
      lines.push({ label: t('method'), value: name(options.methodOptions ?? [], values.method) });
    }
    if (offered.includes('category') && values.categoryId) lines.push({ label: t('category'), value: name(categories, values.categoryId) });
    if (offered.includes('product') && values.productId) lines.push({ label: t('product'), value: name(products, values.productId) });
    if (offered.includes('docType') && values.docType) lines.push({ label: t('docType'), value: name(docTypes, values.docType) });
    if (offered.includes('search') && values.q) lines.push({ label: t('search'), value: `"${values.q}"` });
    const whole = values.fromHour === 0 && values.toHour === 24;
    const hours = offered.includes('hours') && !whole ? `${formatHour(values.fromHour)}–${formatHour(values.toHour)}` : null;
    return { lines, hours };
  }, [areas, cashiers, categories, docTypes, offered, options.methodOptions, products, t, ta, values]);
}
