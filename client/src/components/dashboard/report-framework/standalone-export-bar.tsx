'use client';

/**
 * The report export bar (Excel · PDF · print · export columns) for a page that is not a
 * `ReportPage` — a Z, a shift's X, a live board, a management page with its report — with the
 * business, the place and the company (its export defaults) taken from the dashboard's scope,
 * as `ReportPage` passes them. Its tables are `ReportTableSpec`s like any report's: on screen
 * a `ReportTable` given the same `reportKey` shares the reader's columns with it.
 */
import { useTranslations } from 'next-intl';
import { findBySameId } from '@/lib/entityLookup';
import type { ReportFilterLine } from '@/lib/reportExport';
import { useScope } from '@/lib/scope';
import { ReportExportBar, type ReportExportBarProps } from './report-export-bar';

export type StandaloneExportBarProps = Omit<
  ReportExportBarProps,
  'business' | 'place' | 'filterLines' | 'companyId' | 'companyName'
> & {
  /** What the report covers; default: the scope's shop · till. */
  place?: string | null;
  filterLines?: ReportFilterLine[];
  /** The company whose export defaults apply, when not the scope's (a Z of another company). */
  companyId?: string | null;
};

export function StandaloneExportBar({ place, filterLines, companyId: companyProp, ...props }: StandaloneExportBarProps) {
  const te = useTranslations('reportFramework.export');
  const scope = useScope();
  const companyId = companyProp ?? scope.company?.id ?? scope.shop?.companyId ?? null;
  const companyName =
    (companyId && scope.company?.id === companyId ? scope.company.name : null) ??
    (companyId ? findBySameId(scope.companies, companyId)?.name : null) ??
    null;
  const where = place !== undefined ? place : [scope.shop?.name, scope.machine?.name].filter(Boolean).join(' · ') || null;
  return (
    <ReportExportBar
      {...props}
      business={companyName ?? te('allOrganization')}
      place={where}
      filterLines={filterLines ?? []}
      companyId={companyId}
      companyName={companyName}
    />
  );
}
