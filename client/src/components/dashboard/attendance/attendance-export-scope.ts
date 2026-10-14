'use client';

/**
 * What an attendance tab's export says it covers: the tab's own company ▸ shop ▸ job title
 * (attendance-filters.tsx), not the dashboard's scope — the company whose export defaults
 * apply, the place line, and the filter lines. Read from the same cached lists the filters use.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { fetchCompanies, fetchShops } from '@/lib/api';
import { fetchRoles } from '@/lib/attendanceApi';
import type { ReportFilterLine } from '@/lib/reportExport';
import type { Company, Shop } from '@/lib/types';
import type { AttendanceScope } from './attendance-filters';

export function useAttendanceExportScope(scope: AttendanceScope, withRole = true) {
  const t = useTranslations('attendance');
  const to = useTranslations('orgScope');
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const { data: shops = [] } = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const roles = useQuery({ queryKey: ['attendance-roles', false], queryFn: () => fetchRoles(false), enabled: withRole && !!scope.roleId });
  const shop = scope.shopId ? shops.find((s) => s.id === scope.shopId) : undefined;
  const companyId = scope.companyId || shop?.companyId || null;
  const company = companyId ? companies.find((c) => c.id === companyId) : undefined;
  const roleName = scope.roleId ? (roles.data?.roles ?? []).find((r) => r.id === scope.roleId)?.name : undefined;
  const filterLines: ReportFilterLine[] = [
    ...(company && !shop ? [{ label: to('company'), value: company.name }] : []),
    ...(withRole && scope.roleId ? [{ label: t('filters.role'), value: roleName ?? '—' }] : []),
  ];
  return {
    /** The company whose export defaults apply; null: the dashboard scope's. */
    companyId,
    place: shop?.name ?? company?.name ?? null,
    filterLines,
  };
}
