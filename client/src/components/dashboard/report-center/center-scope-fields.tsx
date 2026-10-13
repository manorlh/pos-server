'use client';

/**
 * The report center's shops / tills multi-selects as fields of the framework's filter bar
 * (`ReportPage`'s `bar.children`), held in the URL as `?shops=a,b&tills=c` (the report's
 * `extras`, like the day summary). The same rules as `CenterFilters`: the scope bar still
 * decides where the reader stands — a shop in scope is the only shop, a till in scope the only
 * till — and what goes to the server is `scopedIds` of the applied picks.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { findBySameId } from '@/lib/entityLookup';
import { numberedLabel } from '@/lib/orgNumber';
import { idList } from '@/lib/reportCenterView';
import type { ReportFilterLine } from '@/lib/reportExport';
import type { ScopeContextValue } from '@/lib/scope';
import type { ScopeSelection } from '@/lib/types';
import type { ReportFiltersController } from '@/components/dashboard/report-framework';
import { scopedIds } from './center-filters';

/** The URL options every center report has (spread into its `extras`). */
export const CENTER_SCOPE_EXTRAS = { shops: '', tills: '' } as const;

/** The request's shops and tills for the applied (or any) extras: the scope's, else the picks. */
export function centerScopeIds(
  extras: Record<string, string>,
  effective: ScopeSelection,
  scope: ScopeContextValue,
): { shopIds: string[]; machineIds: string[] } {
  return scopedIds(
    { from: '', to: '', shopIds: idList(extras.shops), machineIds: idList(extras.tills) },
    effective,
    scope,
  );
}

function useCenterOptions(effective: ScopeSelection, scope: ScopeContextValue, shopIds: string[]) {
  const t = useTranslations('reportCenter');
  const shopOptions = useMemo(
    () =>
      scope.shops
        .filter((s) => !effective.companyId || s.companyId === effective.companyId)
        .map((s) => ({ id: s.id, label: numberedLabel(s.shopNumber, s.name) })),
    [scope.shops, effective.companyId],
  );
  const shopsKey = (effective.shopId ? [effective.shopId] : shopIds).join(',');
  const tillOptions = useMemo(() => {
    const shops = idList(shopsKey);
    return scope.machines
      .filter((m) => shops.length === 0 || (m.shopId && shops.includes(m.shopId)))
      .filter((m) => !effective.companyId || shopOptions.some((s) => s.id === m.shopId))
      .map((m) => {
        const shop = findBySameId(scope.shops, m.shopId);
        return {
          id: m.id,
          label: m.posNumber ? `${t('tillPrefix')} ${m.posNumber} · ${m.name}` : m.name,
          hint: shop && !effective.shopId ? numberedLabel(shop.shopNumber, shop.name) : null,
        };
      });
  }, [scope.machines, scope.shops, shopsKey, effective.companyId, effective.shopId, shopOptions, t]);
  return { shopOptions, tillOptions };
}

/** The bar's shops and tills (each hidden when the scope already names one). */
export function CenterScopeFields({
  filters,
  effective,
  scope,
}: {
  filters: ReportFiltersController;
  effective: ScopeSelection;
  scope: ScopeContextValue;
}) {
  const t = useTranslations('reportCenter');
  const shopIds = idList(filters.draftExtras.shops);
  const machineIds = idList(filters.draftExtras.tills);
  const { shopOptions, tillOptions } = useCenterOptions(effective, scope, shopIds);
  return (
    <>
      {effective.shopId || effective.machineId ? null : (
        <EntityMultiSelect
          label={t('shops')}
          options={shopOptions}
          selected={shopIds}
          onChange={(next) => {
            filters.setExtra('shops', next.join(','));
            // Tills of other shops would be a contradiction the server answers with nothing.
            filters.setExtra('tills', '');
          }}
          allLabel={t('allShops')}
          clearLabel={t('clear')}
          emptyLabel={t('noShops')}
        />
      )}
      {effective.machineId ? null : (
        <EntityMultiSelect
          label={t('tills')}
          options={tillOptions}
          selected={machineIds}
          onChange={(next) => filters.setExtra('tills', next.join(','))}
          allLabel={t('allTills')}
          clearLabel={t('clear')}
          emptyLabel={t('noTills')}
        />
      )}
    </>
  );
}

/** The picked shops / tills by name, for the export's "סינון:" line (only what narrows the request). */
export function useCenterScopeLines(
  extras: Record<string, string> | null | undefined,
  effective: ScopeSelection,
  scope: ScopeContextValue,
): ReportFilterLine[] {
  const t = useTranslations('reportCenter');
  const shopIds = idList(extras?.shops);
  const machineIds = idList(extras?.tills);
  const { shopOptions, tillOptions } = useCenterOptions(effective, scope, shopIds);
  const names = (ids: string[], options: { id: string; label: string }[]) =>
    ids.map((id) => options.find((o) => o.id === id)?.label).filter((x): x is string => Boolean(x)).join(', ');
  const lines: ReportFilterLine[] = [];
  if (!effective.shopId && !effective.machineId && shopIds.length) lines.push({ label: t('shops'), value: names(shopIds, shopOptions) });
  if (!effective.machineId && machineIds.length) lines.push({ label: t('tills'), value: names(machineIds, tillOptions) });
  return lines;
}
