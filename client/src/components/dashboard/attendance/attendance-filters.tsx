'use client';

/**
 * "נוכחות עובדים" — the filters every attendance tab shares: company ▸ shop, the job title
 * ("תפקיד") and, where asked, the employee. Company and shop come from the same lists as
 * the rest of the dashboard; the job titles are the tenant's (`/attendance/roles`).
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { fetchCompanies, fetchShops } from '@/lib/api';
import { fetchEmployees, fetchRoles } from '@/lib/attendanceApi';
import { numberedLabel } from '@/lib/orgNumber';
import type { Company, Shop } from '@/lib/types';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export const ANY = '__any__';

export interface AttendanceScope {
  companyId: string;
  shopId: string;
  roleId: string;
  posUserId: string;
}

export const EMPTY_ATTENDANCE_SCOPE: AttendanceScope = { companyId: '', shopId: '', roleId: '', posUserId: '' };

export function PickSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  anyLabel?: string;
  disabled?: boolean;
}) {
  const items = [...(anyLabel ? [{ value: ANY, label: anyLabel }] : []), ...options];
  return (
    <div className="space-y-1 min-w-0">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value || (anyLabel ? ANY : undefined)}
        onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
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

export function AttendanceFilters({
  value,
  onChange,
  withEmployee = false,
}: {
  value: AttendanceScope;
  onChange: (next: AttendanceScope) => void;
  withEmployee?: boolean;
}) {
  const t = useTranslations('attendance');
  const to = useTranslations('orgScope');
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const { data: shops = [] } = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const roles = useQuery({ queryKey: ['attendance-roles', false], queryFn: () => fetchRoles(false) });
  const employees = useQuery({
    queryKey: ['attendance-employees', value.shopId],
    queryFn: () => fetchEmployees(value.shopId),
    enabled: withEmployee && !!value.shopId,
  });
  const companyShops = value.companyId ? shops.filter((s) => s.companyId === value.companyId) : shops;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <PickSelect
        label={to('company')}
        value={value.companyId}
        onChange={(companyId) => onChange({ ...value, companyId, shopId: '', posUserId: '' })}
        options={companies.map((c) => ({ value: c.id, label: numberedLabel(c.companyNumber, c.name) }))}
        anyLabel={to('allCompanies')}
      />
      <PickSelect
        label={to('shop')}
        value={value.shopId}
        onChange={(shopId) => onChange({ ...value, shopId, posUserId: '' })}
        options={companyShops.map((s) => ({ value: s.id, label: numberedLabel(s.shopNumber, s.name) }))}
        anyLabel={t('filters.allShops')}
      />
      <PickSelect
        label={t('filters.role')}
        value={value.roleId}
        onChange={(roleId) => onChange({ ...value, roleId })}
        options={(roles.data?.roles ?? []).map((r) => ({ value: r.id, label: r.name }))}
        anyLabel={t('filters.allRoles')}
      />
      {withEmployee ? (
        <PickSelect
          label={t('filters.employee')}
          value={value.posUserId}
          onChange={(posUserId) => onChange({ ...value, posUserId })}
          options={(employees.data?.employees ?? []).map((e) => ({ value: e.id, label: e.name || e.username }))}
          anyLabel={value.shopId ? t('filters.allEmployees') : t('filters.chooseShopFirst')}
          disabled={!value.shopId}
        />
      ) : null}
    </div>
  );
}

/** The scope as the API takes it. */
export function scopeParams(scope: AttendanceScope) {
  return {
    companyId: scope.companyId || null,
    shopId: scope.shopId || null,
    roleId: scope.roleId || null,
  };
}
