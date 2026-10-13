'use client';

/**
 * The insights dashboards' view (period, own scope, the sections' options) held in the URL
 * (lib/insightsView.ts): what the page shows is what the link says, so a copied link, a
 * refresh or Back land on the same view. A change takes effect at once and replaces the
 * URL (no history entry per tap). After an organization switch the scope and the options
 * (ids of the previous organization) are dropped; the period stays.
 *
 * `spec` must be a module constant (it is compared by identity).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchCompanies } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { findBySameId } from '@/lib/entityLookup';
import { todayIso } from '@/lib/reportWindow';
import type { Company } from '@/lib/types';
import { useReportExportScope } from '@/components/dashboard/report-framework';
import {
  insightsViewForNewTenant,
  readInsightsView,
  writeInsightsView,
  type InsightsRange,
  type InsightsScope,
  type InsightsView,
  type InsightsViewSpec,
} from '@/lib/insightsView';

export interface InsightsViewPatch {
  range?: InsightsRange;
  from?: string;
  to?: string;
  scope?: InsightsScope;
  extras?: Record<string, string>;
}

export function useInsightsView(spec: InsightsViewSpec) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const today = todayIso();

  const view = useMemo(() => readInsightsView(new URLSearchParams(query), spec, today), [query, spec, today]);

  const write = useCallback(
    (next: InsightsView) => {
      const qs = writeInsightsView(new URLSearchParams(query), next, spec).toString();
      if (qs === query) return;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, query, router, spec],
  );

  /** One change, all its fields at once (two calls in one tick: the second wins). */
  const update = useCallback(
    (patch: InsightsViewPatch) =>
      write({
        ...view,
        ...patch,
        scope: patch.scope ?? view.scope,
        extras: { ...view.extras, ...patch.extras },
      }),
    [view, write],
  );

  const tenant = useAuth((s) => s.activeTenantId);
  const seenTenant = useRef(tenant);
  useEffect(() => {
    const previous = seenTenant.current;
    seenTenant.current = tenant;
    if (previous && tenant && previous !== tenant) write(insightsViewForNewTenant(view, spec));
  }, [spec, tenant, view, write]);

  return { view, update };
}

/**
 * What the export bar says about where the report stands: the business as the dashboard's
 * scope names it and the page's own scope line as the place (as the old toolbar did), and
 * the company whose export defaults apply — the page's own company when one is picked.
 */
export function useInsightsExportScope(scope: InsightsScope, allCompanies: string, place: string) {
  const dashboard = useReportExportScope(place);
  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ['companies'], queryFn: fetchCompanies });
  const own = scope.companyId && scope.companyId !== allCompanies ? scope.companyId : null;
  if (!own) return dashboard;
  return { ...dashboard, companyId: own, companyName: findBySameId(companies, own)?.name ?? null };
}
