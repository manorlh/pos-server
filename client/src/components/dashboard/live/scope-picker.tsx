'use client';

/**
 * The org cascade (company › shop › point of sale › till) folded into one line on a
 * phone: a 44px button that says what is chosen and opens the four selects under it.
 * Always open from `md` up, where there is room for the grid.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Crosshair } from 'lucide-react';
import { fetchCompanies, fetchMachines, fetchShops } from '@/lib/api';
import type { Company, PosMachine, Shop } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  ALL_COMPANIES,
  OrgScopeCascade,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';

/** "Acme › Center › Bar › Till 2", from the lists the cascade already caches. */
export function useOrgScopeLabel(scope: OrgScope): string {
  const t = useTranslations('liveBoard.scope');
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const { data: shops = [] } = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: !!scope.machineId,
  });
  const { data: areas = [] } = useShopAreas(scope.shopId || null);
  if (!scope.companyId) return t('none');
  if (scope.companyId === ALL_COMPANIES) return t('all');
  const parts = [
    companies.find((c) => c.id === scope.companyId)?.name,
    shops.find((s) => s.id === scope.shopId)?.name,
    areas.find((a) => a.id === scope.areaId)?.name,
    machines.find((m) => m.id === scope.machineId)?.name,
  ].filter(Boolean);
  return parts.join(' › ') || t('none');
}

export function ScopePicker({
  value,
  onChange,
  allowAll = false,
  disabled = false,
  defaultOpen = false,
}: {
  value: OrgScope;
  onChange: (next: OrgScope) => void;
  allowAll?: boolean;
  disabled?: boolean;
  defaultOpen?: boolean;
}) {
  const t = useTranslations('liveBoard.scope');
  const [open, setOpen] = useState(defaultOpen);
  const label = useOrgScopeLabel(value);
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl border bg-card px-3 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:hidden"
      >
        <Crosshair className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-muted-foreground">{t('label')}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      <div className={cn(open ? 'block' : 'hidden', 'md:block')}>
        <OrgScopeCascade value={value} onChange={onChange} allowAll={allowAll} disabled={disabled} />
      </div>
    </div>
  );
}
