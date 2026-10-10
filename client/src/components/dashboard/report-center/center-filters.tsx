'use client';

/**
 * The filter bar of the report center pages (docs/SPEC_REPORTS.md): a range of days, the
 * shops (several, when the dashboard scope is above a shop) and the tills (several, when it
 * is above a till), and "הפק דוח". The scope bar still decides where the reader stands: a
 * shop in scope is the only shop, a till in scope the only till.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { findBySameId } from '@/lib/entityLookup';
import { numberedLabel } from '@/lib/orgNumber';
import type { ScopeContextValue } from '@/lib/scope';
import type { ScopeSelection } from '@/lib/types';

export interface CenterFiltersState {
  from: string;
  to: string;
  shopIds: string[];
  machineIds: string[];
}

/** The request's shops and tills: the scope's when it names one, else the reader's picks. */
export function scopedIds(
  value: CenterFiltersState,
  effective: ScopeSelection,
  scope: ScopeContextValue,
): { shopIds: string[]; machineIds: string[] } {
  if (effective.machineId) return { shopIds: [], machineIds: [effective.machineId] };
  if (effective.shopId) return { shopIds: [effective.shopId], machineIds: value.machineIds };
  if (value.shopIds.length) return { shopIds: value.shopIds, machineIds: value.machineIds };
  if (effective.companyId) {
    // A company in scope: its shops (the server has no company filter on these reports).
    const shops = scope.shops.filter((s) => s.companyId === effective.companyId).map((s) => s.id);
    return { shopIds: shops.length ? shops : ['00000000-0000-0000-0000-000000000000'], machineIds: value.machineIds };
  }
  return { shopIds: [], machineIds: value.machineIds };
}

export function CenterFilters({
  value,
  onChange,
  onRun,
  busy,
  effective,
  scope,
}: {
  value: CenterFiltersState;
  onChange: (next: CenterFiltersState) => void;
  onRun: () => void;
  busy?: boolean;
  effective: ScopeSelection;
  scope: ScopeContextValue;
}) {
  const t = useTranslations('reportCenter');
  const set = (patch: Partial<CenterFiltersState>) => onChange({ ...value, ...patch });

  const shopOptions = useMemo(
    () =>
      scope.shops
        .filter((s) => !effective.companyId || s.companyId === effective.companyId)
        .map((s) => ({ id: s.id, label: numberedLabel(s.shopNumber, s.name) })),
    [scope.shops, effective.companyId],
  );
  const shopIds = useMemo(
    () => (effective.shopId ? [effective.shopId] : value.shopIds),
    [effective.shopId, value.shopIds],
  );
  const tillOptions = useMemo(
    () =>
      scope.machines
        .filter((m) => shopIds.length === 0 || (m.shopId && shopIds.includes(m.shopId)))
        .filter((m) => !effective.companyId || shopOptions.some((s) => s.id === m.shopId))
        .map((m) => {
          const shop = findBySameId(scope.shops, m.shopId);
          return {
            id: m.id,
            label: m.posNumber ? `${t('tillPrefix')} ${m.posNumber} · ${m.name}` : m.name,
            hint: shop && !effective.shopId ? numberedLabel(shop.shopNumber, shop.name) : null,
          };
        }),
    [scope.machines, scope.shops, shopIds, effective.companyId, effective.shopId, shopOptions, t],
  );
  const valid = Boolean(value.from) && Boolean(value.to) && value.from <= value.to;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <DatePicker
            value={value.from}
            onChange={(e) => set({ from: e.target.value })}
            range={{ from: value.from, to: value.to, onSelect: (r) => set({ from: r.from, to: r.to }) }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <DatePicker
            value={value.to}
            onChange={(e) => set({ to: e.target.value })}
            range={{ from: value.from, to: value.to, onSelect: (r) => set({ from: r.from, to: r.to }) }}
          />
        </div>
        {effective.shopId || effective.machineId ? null : (
          <EntityMultiSelect
            label={t('shops')}
            options={shopOptions}
            selected={value.shopIds}
            onChange={(next) => set({ shopIds: next, machineIds: [] })}
            allLabel={t('allShops')}
            clearLabel={t('clear')}
            emptyLabel={t('noShops')}
          />
        )}
        {effective.machineId ? null : (
          <EntityMultiSelect
            label={t('tills')}
            options={tillOptions}
            selected={value.machineIds}
            onChange={(next) => set({ machineIds: next })}
            allLabel={t('allTills')}
            clearLabel={t('clear')}
            emptyLabel={t('noTills')}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={!valid || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {t('run')}
        </Button>
        {!valid ? <span className="text-destructive text-xs">{t('rangeInvalid')}</span> : null}
      </div>
    </div>
  );
}
