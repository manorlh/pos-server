/**
 * Client-side Excel for the report toolbar (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.1, §5).
 *
 * Built from the rows the page already holds, with `exceljs` loaded only when someone
 * clicks — it is a large library and most visits never export. The sheet is
 * right-to-left, numbers are real numbers (never text, so a bookkeeper can sum them),
 * and a totals row closes the table when the page has one.
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
}

const NUM_FMT: Partial<Record<ExcelCellKind, string>> = {
  money: '#,##0.00',
  number: '#,##0.###',
  percent: '0.00"%"',
  date: 'dd/mm/yyyy',
  datetime: 'dd/mm/yyyy hh:mm',
};

const DEFAULT_WIDTH: Record<ExcelCellKind, number> = {
  text: 22,
  money: 14,
  number: 10,
  percent: 10,
  date: 12,
  datetime: 17,
};

/** An ISO date ("2026-09-27") or timestamp, as a Date Excel shows in local wall time. */
function toExcelDate(value: string, kind: ExcelCellKind): Date | string {
  if (kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // exceljs writes UTC; shift so the cell reads the viewer's wall-clock time.
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
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

export async function buildWorkbook(sheets: ExcelSheet[]): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31) || 'Report', {
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
    const addRow = (values: ExcelValue[], bold = false) => {
      const row = ws.addRow(values.map((v, i) => cellValue(v, kinds[i] ?? 'text')));
      kinds.forEach((kind, i) => {
        const fmt = NUM_FMT[kind];
        if (fmt) row.getCell(i + 1).numFmt = fmt;
      });
      if (bold) {
        row.font = { bold: true };
        row.eachCell((cell) => {
          cell.border = { top: { style: 'thin' } };
        });
      }
    };
    sheet.rows.forEach((r) => addRow(r));
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
