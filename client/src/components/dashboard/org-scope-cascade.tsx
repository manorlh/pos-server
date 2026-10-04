'use client';

/**
 * The cascading target picker: company › shop › point of sale (area) › till.
 *
 * Pick a company, then optionally narrow to one of its shops, one of that shop's
 * points of sale and one till; the deepest level chosen is the target. Used where
 * something is set or sent per level — the payment methods page and the app updates
 * page. Lists what the dashboard lists elsewhere: the active organization's companies,
 * shops, live areas and tills, from the same query caches.
 *
 * With `allowAll` the company picker also offers the whole organization, which the
 * caller reads as the tenant level.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { fetchCompanies, fetchMachines, fetchShops } from '@/lib/api';
import { registerNumberOf } from '@/lib/registerNumber';
import { numberedLabel } from '@/lib/orgNumber';
import type { Company, PosMachine, Shop } from '@/lib/types';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useShopAreas } from './areas/use-shop-areas';

/** `companyId` is this when the whole organization is chosen (`allowAll`). */
export const ALL_COMPANIES = '__all__';
/** A select's "nothing narrower" item. Base UI's Select needs a non-empty value. */
const ANY = '__any__';

export interface OrgScope {
  companyId: string;
  shopId: string;
  areaId: string;
  machineId: string;
}

export const EMPTY_ORG_SCOPE: OrgScope = { companyId: '', shopId: '', areaId: '', machineId: '' };

export type OrgScopeLevel = 'tenant' | 'company' | 'shop' | 'area' | 'machine';

/** The deepest level chosen, and its id (`null` id for the whole organization). */
export function deepestOrgScope(
  scope: OrgScope,
): { level: OrgScopeLevel; id: string | null } | null {
  if (scope.machineId) return { level: 'machine', id: scope.machineId };
  if (scope.areaId) return { level: 'area', id: scope.areaId };
  if (scope.shopId) return { level: 'shop', id: scope.shopId };
  if (scope.companyId === ALL_COMPANIES) return { level: 'tenant', id: null };
  if (scope.companyId) return { level: 'company', id: scope.companyId };
  return null;
}

interface Option {
  value: string;
  label: string;
}

function CascadeSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  anyLabel,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder: string;
  /** When set, the select offers "no narrower level" as its first item. */
  anyLabel?: string;
  disabled?: boolean;
}) {
  const items = anyLabel ? [{ value: ANY, label: anyLabel }, ...options] : options;
  return (
    <div className="space-y-1 min-w-0">
      <Label>{label}</Label>
      <Select
        value={value || (anyLabel ? ANY : null)}
        onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value} label={o.label}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function OrgScopeCascade({
  value,
  onChange,
  allowAll = false,
  disabled = false,
}: {
  value: OrgScope;
  onChange: (next: OrgScope) => void;
  allowAll?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations('orgScope');

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
  });
  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
  });
  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: !!value.shopId,
  });
  const { data: areas = [] } = useShopAreas(value.shopId || null);

  const realCompany = value.companyId && value.companyId !== ALL_COMPANIES ? value.companyId : '';
  const companyShops = realCompany ? shops.filter((s) => s.companyId === realCompany) : [];
  const shopMachines = value.shopId
    ? machines.filter(
        (m) => m.shopId === value.shopId && (!value.areaId || m.areaId === value.areaId),
      )
    : [];
  const machineLabel = (m: PosMachine) => {
    const n = registerNumberOf(m);
    return n ? `${m.name} (${t('register', { n })})` : m.name;
  };

  const companyOptions: Option[] = [
    ...(allowAll ? [{ value: ALL_COMPANIES, label: t('allCompanies') }] : []),
    ...companies.map((c) => ({ value: c.id, label: numberedLabel(c.companyNumber, c.name) })),
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <CascadeSelect
        label={t('company')}
        value={value.companyId}
        onChange={(companyId) => onChange({ ...EMPTY_ORG_SCOPE, companyId })}
        options={companyOptions}
        placeholder={t('chooseCompany')}
        disabled={disabled}
      />
      <CascadeSelect
        label={t('shop')}
        value={value.shopId}
        onChange={(shopId) => onChange({ ...value, shopId, areaId: '', machineId: '' })}
        options={companyShops.map((s) => ({ value: s.id, label: numberedLabel(s.shopNumber, s.name) }))}
        placeholder={t('chooseShop')}
        anyLabel={t('allShops')}
        disabled={disabled || !realCompany}
      />
      <CascadeSelect
        label={t('area')}
        value={value.areaId}
        onChange={(areaId) => onChange({ ...value, areaId, machineId: '' })}
        options={areas.map((a) => ({ value: a.id, label: a.name }))}
        placeholder={t('chooseArea')}
        anyLabel={value.shopId && areas.length === 0 ? t('noAreas') : t('allAreas')}
        disabled={disabled || !value.shopId || areas.length === 0}
      />
      <CascadeSelect
        label={t('machine')}
        value={value.machineId}
        onChange={(machineId) => onChange({ ...value, machineId })}
        options={shopMachines.map((m) => ({ value: m.id, label: machineLabel(m) }))}
        placeholder={t('chooseMachine')}
        anyLabel={t('allMachines')}
        disabled={disabled || !value.shopId}
      />
    </div>
  );
}
