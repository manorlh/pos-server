/**
 * The report framework (P:\specs\reports-upgrade.md §2, §5): `ReportPage`, the unified filter
 * bar, `ReportTable` and the export bar. Pure logic lives in lib/reportFilters.ts,
 * lib/reportColumns.ts, lib/reportExport.ts and lib/excelExport.ts.
 */
export { ReportPage, reportQueryState, useReportExportScope, type ReportPageProps, type ReportExportConfig, type ReportQueryState } from './report-page';
export { ReportTable, formatReportValue, searchRows } from './report-table';
export { ReportFilterBar, type ReportFilterBarProps } from './report-filter-bar';
export { ReportExportBar, toExportTable, type ReportExportBarProps, type ReportKpi, type ReportChart, type PreviousPeriod } from './report-export-bar';
export { sheetAsTable, sheetsAsTables, type SheetRow } from './sheet-table';
export { StandaloneExportBar, type StandaloneExportBarProps } from './standalone-export-bar';
export { useReportFilters, type ReportFiltersController } from './use-report-filters';
export { useReportContext } from './report-context';
export { useCashierOptions, useCategoryOptions, type FilterOption } from './use-filter-options';
export type { ReportColumn, ReportTableSpec } from './types';
