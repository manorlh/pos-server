/**
 * One column definition drives the screen, the sort, the column chooser, Excel and the PDF
 * (P:\specs\reports-upgrade.md §2א). See §5 of the spec for a minimal page.
 */
import type { ReactNode } from 'react';
import type { ExcelCellKind, ExcelValue } from '@/lib/excelExport';

export interface ReportColumn<R> {
  /** Stable key, `[A-Za-z0-9_.:-]`: saved in the user's and the company's choices. */
  key: string;
  header: string;
  /** How the value is shown (default cell), sorted and written to Excel / PDF. */
  kind?: ExcelCellKind;
  /** The plain value: sorting, search, Excel and PDF. Money as a number (or the API's decimal string). */
  value(row: R): ExcelValue;
  /** A custom cell on screen (badges, bars, links). Default: the value, formatted by kind. */
  cell?(row: R): ReactNode;
  /** The totals row's value for this column (export and default cell); omit for an empty cell. */
  total?: ExcelValue;
  /**
   * The totals cell computed from the rows, when there is no `total` from the server: on screen
   * from the table's rows, in the export from the rows exported (a paged list's every page).
   */
  totalOf?(rows: R[]): ExcelValue;
  /** A custom totals cell on screen. */
  totalCell?: ReactNode;
  /** The row's name: never hidden. */
  required?: boolean;
  /** Hidden until the reader shows it. */
  defaultHidden?: boolean;
  /** Default true. */
  sortable?: boolean;
  /** The first click sorts this way (default: descending for numbers, ascending for text). */
  firstSort?: 'asc' | 'desc';
  /** Classes of the cells (`bg-muted/40` for a column group…). */
  className?: string;
  headClassName?: string;
  /** Excel width in characters. */
  width?: number;
  /** In the export only (e.g. a flag the screen shows as a badge). */
  exportOnly?: boolean;
  /** On screen only (e.g. a share bar). */
  screenOnly?: boolean;
  /**
   * A column that stands for several in the export, known only from the exported rows (one per
   * payment method the data has): chosen or left out as one, written as the columns this returns,
   * in its place (their keys `<key>:<theirs>`).
   */
  expandInExport?(rows: R[]): ReportColumn<R>[];
}

export interface ReportTableSpec<R> {
  /**
   * `main` for the report's table; others lower-case (`methods`, `days`…): with the report key
   * they name the user's saved columns (`tips.days`) and qualify export keys (`days.net`).
   */
  id: string;
  /** Section heading on screen and the Excel sheet's name. */
  title?: string;
  columns: ReportColumn<R>[];
  rows: R[];
  rowKey(row: R, index: number): string;
  /** Shows the totals row (from each column's `total`) with this label in the first column. */
  totalsLabel?: string;
  emptyText?: string;
  rowClassName?(row: R): string | undefined;
  /** A drill-down under the row (opened by a click on the row). */
  expand?(row: R): ReactNode;
  /** Not in Excel / PDF (default: exported). */
  noExport?: boolean;
  /** Lines of this sheet only, under the report's header. */
  sheetHeading?: string[];
  /**
   * The rows the export takes when they are not the rows on screen — every page of a paged
   * list, or a server export endpoint — fetched on the click. Default: `rows`.
   */
  exportRows?: () => Promise<R[]>;
  /** A click on the row (open its page / dialog). Not with `expand`, whose click opens the row. */
  onRowClick?(row: R): void;
  /**
   * Rows that come in runs of one group (a day): while the table is in the report's order a
   * heading row (`groupHeading`) opens each run. A sorted table shows no headings.
   */
  groupOf?(row: R): string;
  groupHeading?(group: string, rows: R[]): ReactNode;
}
