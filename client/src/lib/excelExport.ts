/**
 * Client-side Excel for the report toolbar (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.1, §5,
 * docs/SPEC_REPORTS.md §2) — the one export path of every report page.
 *
 * Built from the rows the page holds (or, for a paged list, from every page the current
 * filters match — `lib/fetchAllPages.ts` / a server export endpoint), with `exceljs` loaded
 * only when someone clicks — it is a large library and most visits never export. Every
 * sheet is right-to-left with a frozen header row and an autofilter; numbers are real
 * numbers (never text, so a bookkeeper can sum them), money in ₪ with 2 decimals, dates
 * are real date cells in Israel time (dd/mm/yyyy, dd/mm/yyyy hh:mm), and a totals row
 * closes the table when the page has one.
 */

export type ExcelCellKind = 'text' | 'money' | 'number' | 'percent' | 'date' | 'datetime';

export interface ExcelColumn {
  header: string;
  kind?: ExcelCellKind;
  /** Character width; defaults by kind. */
  width?: number;
}

export type ExcelValue = string | number | null | undefined;

export interface ExcelSheet {
  /** Sheet tab name (≤ 31 characters; trimmed if longer). */
  name: string;
  /** Lines above the table: report name, scope, range, generated at. */
  heading?: string[];
  columns: ExcelColumn[];
  rows: ExcelValue[][];
  /** The totals row, one value per column (blank cells as null). */
  totals?: ExcelValue[];
  /**
   * A fill per data row (ARGB, e.g. `FFFFE5E3`), null for none — how a status column
   * ("תואם / הפרש / חסר") is highlighted. Same order as `rows`.
   */
  rowFills?: (string | null | undefined)[];
  /** Autofilter on the header row (default true). */
  autoFilter?: boolean;
}

/** Row fills for the reconciliation statuses: missing (red), difference (orange). */
export const EXCEL_FILL = {
  missing: 'FFFFE5E3',
  difference: 'FFFFF3E0',
  info: 'FFE8F2FF',
} as const;

const NUM_FMT: Partial<Record<ExcelCellKind, string>> = {
  money: '#,##0.00" ₪"',
  number: '#,##0.###',
  percent: '0.00"%"',
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm',
};

/** Israel time: every date in an export is the shop's wall clock, wherever it is opened. */
export const EXCEL_TIMEZONE = 'Asia/Jerusalem';

const DEFAULT_WIDTH: Record<ExcelCellKind, number> = {
  text: 22,
  money: 14,
  number: 10,
  percent: 10,
  date: 12,
  datetime: 17,
};

/**
 * [instant] as the wall clock in [timeZone], encoded as a UTC Date — what exceljs writes
 * into a cell (it writes the UTC fields). DST included: Intl applies the zone's rules.
 */
export function wallClockUtc(instant: Date, timeZone: string = EXCEL_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')));
}

/** An ISO date ("2026-09-27") or timestamp, as a Date Excel shows in Israel wall time. */
export function toExcelDate(value: string, kind: ExcelCellKind): Date | string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // A plain calendar date (a business date) is that day, never shifted by a zone.
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const wall = wallClockUtc(parsed);
  return kind === 'date'
    ? new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()))
    : wall;
}

function cellValue(value: ExcelValue, kind: ExcelCellKind): string | number | Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (kind === 'money' || kind === 'number' || kind === 'percent') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : String(value);
  }
  if ((kind === 'date' || kind === 'datetime') && typeof value === 'string') {
    return toExcelDate(value, kind);
  }
  return value;
}

/**
 * A sheet name Excel accepts: ≤ 31 characters, none of `\ / ? * [ ] :`, and unique in the
 * workbook (exceljs throws on a repeat) — a repeat gets " (2)".
 */
export function uniqueSheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[\\/?*[\]:]+/g, ' ').trim() || 'Report').slice(0, 31);
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function buildWorkbook(sheets: ExcelSheet[]): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const used = new Set<string>();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(uniqueSheetName(sheet.name, used), {
      views: [{ rightToLeft: true, state: 'frozen', ySplit: (sheet.heading?.length ?? 0) + 1 }],
    });

    for (const line of sheet.heading ?? []) {
      const row = ws.addRow([line]);
      row.font = { bold: row.number === 1, size: row.number === 1 ? 13 : 10 };
    }

    const header = ws.addRow(sheet.columns.map((c) => c.header));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    const kinds = sheet.columns.map((c) => c.kind ?? 'text');
    const addRow = (values: ExcelValue[], bold = false, fill?: string | null) => {
      const row = ws.addRow(values.map((v, i) => cellValue(v, kinds[i] ?? 'text')));
      kinds.forEach((kind, i) => {
        const fmt = NUM_FMT[kind];
        if (fmt) row.getCell(i + 1).numFmt = fmt;
        if (fill) {
          row.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        }
      });
      if (bold) {
        row.font = { bold: true };
        row.eachCell((cell) => {
          cell.border = { top: { style: 'thin' } };
        });
      }
    };
    sheet.rows.forEach((r, i) => addRow(r, false, sheet.rowFills?.[i]));
    // On the header and the data rows only: sorting must never move the totals row.
    if (sheet.autoFilter !== false && sheet.columns.length > 0) {
      const last = header.number + sheet.rows.length;
      ws.autoFilter = {
        from: { row: header.number, column: 1 },
        to: { row: last, column: sheet.columns.length },
      };
    }
    if (sheet.totals) addRow(sheet.totals, true);

    sheet.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width ?? DEFAULT_WIDTH[kinds[i] ?? 'text'];
    });
  }

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** Characters Windows refuses in a file name, and runs of spaces, become "_". */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 120);
}

export function downloadBlob(data: BlobPart, fileName: string, type: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadExcel(sheets: ExcelSheet[], fileName: string): Promise<void> {
  const buffer = await buildWorkbook(sheets);
  downloadBlob(
    buffer,
    `${safeFileName(fileName)}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}
