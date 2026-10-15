/**
 * An `ExcelSheet` a page already builds, as a `ReportTableSpec` the export bar takes
 * (P:\specs\reports-designed-pdf.md §2): the pages that wrote their own sheets for the old
 * Excel-only toolbar keep their columns and values, and get the designed PDF, the CSV and the
 * column chooser with them.
 *
 * The columns keep their sheet key when they have one, else `c<index>`; the totals row stays
 * the sheet's. A paged list passes `full`: the sheet of every row, built on the click.
 */
import type { ExcelSheet, ExcelValue } from '@/lib/excelExport';
import type { ReportColumn, ReportTableSpec } from './types';

/** One sheet row: its cells, in the sheet's column order, and its fill. */
export interface SheetRow {
  cells: ExcelValue[];
  fill?: string | null;
}

const KEY = /^[A-Za-z0-9_.:-]+$/;

function rowsOf(sheet: ExcelSheet): SheetRow[] {
  return sheet.rows.map((cells, i) => ({ cells, fill: sheet.rowFills?.[i] ?? null }));
}

/**
 * The sheet as a report table. `id`: `main` for the report's own table, else lower-case.
 * `full`: the sheet with every row (a paged list), fetched when the export runs.
 */
export function sheetAsTable(
  sheet: ExcelSheet,
  id: string,
  options: { full?: () => Promise<ExcelSheet>; title?: string } = {},
): ReportTableSpec<SheetRow> {
  const used = new Set<string>();
  const totals = sheet.totals;
  const label = typeof totals?.[0] === 'string' && totals[0] ? totals[0] : undefined;
  // A paged list's totals are those of the sheet the export fetched, not of the page shown.
  let fetched: ExcelSheet | null = null;
  const columns: ReportColumn<SheetRow>[] = sheet.columns.map((c, i) => {
    let key = c.key && KEY.test(c.key) ? c.key : `c${i}`;
    if (used.has(key)) key = `${key}_${i}`;
    used.add(key);
    return {
      key,
      header: c.header,
      kind: c.kind,
      width: c.width,
      value: (r: SheetRow) => r.cells[i] ?? null,
      ...(totals ? { totalOf: () => (fetched ?? sheet).totals?.[i] ?? null } : {}),
      ...(i === 0 ? { required: true } : {}),
    };
  });
  return {
    id,
    title: options.title ?? sheet.name,
    columns,
    rows: rowsOf(sheet),
    rowKey: (_r, i) => String(i),
    ...(totals ? { totalsLabel: label ?? ' ' } : {}),
    ...(sheet.heading?.length ? { sheetHeading: sheet.heading } : {}),
    ...(sheet.rowFills?.some(Boolean) ? { rowFill: (r: SheetRow) => r.fill ?? null } : {}),
    ...(sheet.autoFilter === false ? { autoFilter: false } : {}),
    ...(options.full
      ? {
          exportRows: async () => {
            fetched = await options.full!();
            return rowsOf(fetched);
          },
        }
      : {}),
  };
}

/** Several sheets as tables: the first is `main`, the rest `t2`, `t3`… */
export function sheetsAsTables(sheets: readonly ExcelSheet[]): ReportTableSpec<unknown>[] {
  return sheets.map((s, i) => sheetAsTable(s, i === 0 ? 'main' : `t${i + 1}`) as ReportTableSpec<unknown>);
}
