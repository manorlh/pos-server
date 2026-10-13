'use client';

/**
 * `ReportPage` (P:\specs\reports-upgrade.md §2א): the one frame every report sits in —
 * heading, the unified filter bar, then (once run) the export bar and the report itself, with
 * the loading, error and empty states in one shape. The page brings its data, its stat cards
 * and its `ReportTable`s as children. See §5 of the spec for a minimal page.
 */
import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { findBySameId } from '@/lib/entityLookup';
import type { PageScopeResolution } from '@/lib/pageScope';
import { useScope } from '@/lib/scope';
import type { ExcelSheet } from '@/lib/excelExport';
import type { ReportFilterLine } from '@/lib/reportExport';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportContext } from './report-context';
import { ReportExportBar } from './report-export-bar';
import { ReportFilterBar, type ReportFilterBarProps } from './report-filter-bar';
import { useFilterDescription } from './use-filter-options';
import type { ReportFiltersController } from './use-report-filters';
import type { ReportTableSpec } from './types';

export interface ReportQueryState {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error?: unknown;
  /** The report's data is there to show. */
  hasData: boolean;
}

/** A react-query result as `ReportPage` reads it. */
export function reportQueryState(q: {
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
}): ReportQueryState {
  return { isLoading: q.isLoading, isFetching: q.isFetching, isError: q.isError, error: q.error, hasData: q.data !== undefined };
}

export interface ReportExportConfig {
  /** The tables that go to Excel (each a sheet) and the PDF (the first, or `pdfTableId`). */
  tables: ReportTableSpec<unknown>[];
  /** Sheets that are not a table of the page; may load first. */
  extraSheets?: () => ExcelSheet[] | Promise<ExcelSheet[]>;
  /** The extra sheets before the tables' (default: after). */
  extraSheetsFirst?: boolean;
  /** A workbook the server builds, instead of the client's Excel. */
  excel?: () => Promise<void>;
  /** More buttons in the export bar (a CSV, a ZIP). */
  actions?: ReactNode;
  pdfTableId?: string;
  /** The range the server used (`data.window`), else the applied one. */
  from?: string | null;
  to?: string | null;
  /** What the report covers, when not the scope's shop · till. */
  place?: string | null;
  /** The export's title, when not the page's (a mode of the report). */
  title?: string;
  /** Excel only (no PDF / print): a page that prints its own documents. */
  excelOnly?: boolean;
  /**
   * The report's own filters (its `extras`, not in the unified bar: a status, a list of tills…)
   * as the export header's "סינון:" line names them, after the bar's ("סטטוס: פתוחות").
   */
  filterLines?: ReportFilterLine[];
  /** No rows yet: the buttons wait. */
  disabled?: boolean;
}

export interface ReportPageProps {
  /** The report's key: saved columns, the company's export default (`product-sales`…). */
  reportKey: string;
  title: string;
  subtitle?: string;
  /** Between the heading and the bar (a mode switch). */
  headerExtra?: ReactNode;
  resolution: PageScopeResolution;
  filters: ReportFiltersController;
  bar?: Omit<ReportFilterBarProps, 'filters' | 'isFetching'>;
  query: ReportQueryState;
  /** Shown before the first run. */
  prompt: string;
  export?: ReportExportConfig | null;
  /** The report runs without a range in the URL (a link to one shift). Default: the URL has one. */
  ready?: boolean;
  /** Skeleton shape while loading. */
  loading?: 'cards' | 'table';
  children?: ReactNode;
}

/**
 * What an export says about where it stands — the business (company) and the place (shop ·
 * till) of the dashboard's scope, and the company whose export defaults apply. `ReportPage`
 * uses it; a page with its own filters uses it beside a `ReportExportBar` of its own.
 */
export function useReportExportScope(placeOverride?: string | null) {
  const te = useTranslations('reportFramework.export');
  const scope = useScope();
  const companyId = scope.company?.id ?? scope.shop?.companyId ?? null;
  const companyName = scope.company?.name ?? (companyId ? findBySameId(scope.companies, companyId)?.name : null) ?? null;
  const business = companyName ?? te('allOrganization');
  const place = placeOverride ?? ([scope.shop?.name, scope.machine?.name].filter(Boolean).join(' · ') || null);
  return { companyId, companyName, business, place };
}

export function ReportPage({
  reportKey,
  title,
  subtitle,
  headerExtra,
  resolution,
  filters,
  bar,
  query,
  prompt,
  export: exportConfig,
  loading = 'cards',
  ready,
  children,
}: ReportPageProps) {
  const tc = useTranslations('common');
  const description = useFilterDescription(filters, { shopId: bar?.shopId, methodOptions: bar?.methodOptions });

  const search = filters.isClient('search') ? (filters.applied?.values.q ?? '') : '';
  const context = useMemo(() => ({ reportKey, search }), [reportKey, search]);

  const { companyId, companyName, business, place } = useReportExportScope(exportConfig?.place);

  return (
    <ReportContext.Provider value={context}>
      <div className="min-w-0 space-y-4 max-sm:px-1">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle ? <p className="text-muted-foreground text-sm">{subtitle}</p> : null}
        </div>
        {headerExtra}

        <ScopeGate resolution={resolution}>
          <ReportFilterBar filters={filters} isFetching={query.isFetching} {...bar} />

          {!(ready ?? filters.applied !== null) ? (
            <p className="text-muted-foreground py-12 text-center text-sm">{prompt}</p>
          ) : query.isLoading ? (
            <div className="space-y-4" aria-busy="true">
              {loading === 'cards' ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full" />
                  ))}
                </div>
              ) : null}
              <Skeleton className="h-64 w-full" />
            </div>
          ) : query.isError ? (
            <ReportErrorState message={axiosErrorToToastMessage(query.error, tc('error'))} />
          ) : query.hasData ? (
            <div className="min-w-0 space-y-4">
              {exportConfig ? (
                <ReportExportBar
                  reportKey={reportKey}
                  title={exportConfig.title ?? title}
                  tables={exportConfig.tables}
                  extraSheets={exportConfig.extraSheets}
                  extraSheetsFirst={exportConfig.extraSheetsFirst}
                  excel={exportConfig.excel}
                  actions={exportConfig.actions}
                  pdfTableId={exportConfig.pdfTableId}
                  from={exportConfig.from ?? filters.applied?.values.from}
                  to={exportConfig.to ?? filters.applied?.values.to}
                  business={business}
                  place={place}
                  filterLines={exportConfig.filterLines?.length ? [...description.lines, ...exportConfig.filterLines] : description.lines}
                  hours={description.hours}
                  companyId={companyId}
                  companyName={companyName}
                  excelOnly={exportConfig.excelOnly}
                  disabled={exportConfig.disabled}
                />
              ) : null}
              {children}
            </div>
          ) : null}
        </ScopeGate>
      </div>
    </ReportContext.Provider>
  );
}
