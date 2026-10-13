'use client';

/**
 * A report center sheet (lib/reportSheets.ts) as a framework table (P:\specs\reports-upgrade.md
 * §5): its columns keyed (lib/reportCenterView.ts `keyedSheets`), its values, totals and row
 * fills exactly as the workbook had them; the page picks which columns are on screen (the rest
 * are export-only) and how a cell looks there (a link, a badge).
 *
 * And `CenterTable`: a `ReportTable` with the center's screen cap ("עוד N שורות — כולן בקובץ
 * האקסל") and a note under it. The export always has every row.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { ExcelValue } from '@/lib/excelExport';
import type { KeyedSheet } from '@/lib/reportCenterView';
import { ReportTable, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';

export interface SheetRow<T> {
  /** The row's place in the sheet. */
  index: number;
  cells: ExcelValue[];
  /** The API row behind it (when the sheet has one row per item of a list). */
  src: T;
}

export interface SheetTableOptions<T> {
  id: string;
  /** The list the sheet has one row per item of. */
  src?: readonly T[];
  /** The columns on screen, by key; the others are export-only. Omit: all. */
  screen?: readonly string[];
  cells?: Partial<Record<string, (row: SheetRow<T>) => ReactNode>>;
  classNames?: Partial<Record<string, string>>;
  /** Columns after the sheet's (e.g. one the screen always had). */
  extra?: ReportColumn<SheetRow<T>>[];
  rowClassName?: (row: SheetRow<T>) => string | undefined;
  title?: string;
  emptyText?: string;
}

export function sheetTable<T = unknown>(ks: KeyedSheet, opts: SheetTableOptions<T>): ReportTableSpec<SheetRow<T>> {
  const { sheet, columnKeys } = ks;
  const totals = sheet.totals;
  const columns: ReportColumn<SheetRow<T>>[] = columnKeys.map((key, i) => {
    const c = sheet.columns[i];
    return {
      key,
      header: c.header,
      kind: c.kind,
      width: c.width,
      value: (r) => r.cells[i] ?? null,
      // The first cell is the label ("סה״כ"): `totalsLabel` carries it.
      total: totals && i > 0 ? (totals[i] ?? null) : undefined,
      required: i === 0,
      exportOnly: opts.screen && !opts.screen.includes(key) ? true : undefined,
      cell: opts.cells?.[key],
      className: opts.classNames?.[key],
    };
  });
  const fills = sheet.rowFills;
  return {
    id: opts.id,
    title: opts.title ?? sheet.name,
    columns: [...columns, ...(opts.extra ?? [])],
    rows: sheet.rows.map((cells, index) => ({ index, cells, src: opts.src?.[index] as T })),
    rowKey: (r) => String(r.index),
    totalsLabel: totals ? String(totals[0] ?? '') : undefined,
    emptyText: opts.emptyText,
    rowClassName: opts.rowClassName,
    ...(fills ? { rowFill: (r: SheetRow<T>) => fills[r.index] ?? null } : {}),
    // A label / value sheet (summary, discounts, tips) keeps its autofilter off.
    ...(sheet.autoFilter === false ? { autoFilter: false } : {}),
  };
}

/**
 * A table of the page with the center's screen cap: the first `limit` rows, and the totals row
 * only when every row is shown (it sums them all).
 */
export function CenterTable<R>({
  table,
  limit,
  note,
  className,
}: {
  table: ReportTableSpec<R>;
  limit?: number;
  /** A line under the table (what it counts, what was cut). */
  note?: ReactNode;
  className?: string;
}) {
  const tr = useTranslations('reportCenter');
  const hidden = limit && table.rows.length > limit ? table.rows.length - limit : 0;
  const shown = hidden ? { ...table, rows: table.rows.slice(0, limit), totalsLabel: undefined } : table;
  return (
    <div className={`min-w-0 space-y-1 ${className ?? ''}`}>
      <ReportTable table={shown} />
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      {hidden ? <p className="text-muted-foreground text-xs">{tr('moreInExcel', { count: hidden })}</p> : null}
    </div>
  );
}
