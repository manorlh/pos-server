/**
 * The control board's scope (company › shop › point of sale › till) as the insights'
 * query parameters. The server narrows within the caller's own role scope, so "all"
 * simply sends nothing.
 */
import { ALL_COMPANIES, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import type { InsightScopeParams } from '@/lib/insightsApi';

export function scopeParams(scope: OrgScope): InsightScopeParams {
  const companyId = scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined;
  return {
    companyId: scope.shopId || scope.machineId ? undefined : companyId,
    shopId: scope.machineId ? undefined : scope.shopId || undefined,
    areaId: scope.machineId ? undefined : scope.areaId || undefined,
    machineId: scope.machineId || undefined,
  };
}
