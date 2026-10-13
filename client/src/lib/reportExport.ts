/**
 * What every exported report says about itself (P:\specs\reports-upgrade.md §2ג–ד): the
 * header lines on top of each Excel sheet and each PDF page, and a file name a person can
 * read ("מכירות לפי מוצר — סניף X — 01.10–13.10.xlsx").
 *
 * Pure: the Hebrew words come in through `words`, so node tests need no translator.
 */
import { selectSheetColumns, type ExcelCellKind, type ExcelSheet, type ExcelValue } from './excelExport';

export interface ReportFilterLine {
  /** "קופאי", "אמצעי תשלום"… */
  label: string;
  /** The chosen value as a reader names it ("דנה כהן"), never an id. */
  value: string;
}

export interface ReportHeaderInput {
  title: string;
  /** The business (company / organization). */
  business?: string | null;
  /** The shop / till / area the report covers. */
  place?: string | null;
  from?: string | null;
  to?: string | null;
  /** The hour band on each day ("18:00–22:00"), when one is set. */
  hours?: string | null;
  filters?: readonly ReportFilterLine[];
  /** ISO timestamp. */
  generatedAt: string;
}

export interface ReportHeaderWords {
  range: (range: string) => string;
  hours: (band: string) => string;
  filters: (list: string) => string;
  generatedAt: (at: string) => string;
  /** How a timestamp is written ("13/10/2026 14:05"). */
  formatDateTime: (iso: string) => string;
}

/** `2026-10-13` → `13/10/2026`. */
export function dmy(iso?: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

/** The range as a header writes it: one day, or "from – to". */
export function rangeText(from?: string | null, to?: string | null): string {
  if (!from && !to) return '';
  if (!from || !to || from === to) return dmy(from || to);
  return `${dmy(from)} – ${dmy(to)}`;
}

/**
 * The lines above the table, in order: title · business and place · range · hours ·
 * the chosen filters · generated at. Empty lines are dropped.
 */
export function reportHeaderLines(input: ReportHeaderInput, words: ReportHeaderWords): string[] {
  const range = rangeText(input.from, input.to);
  const filters = (input.filters ?? [])
    .filter((f) => f.value.trim() !== '')
    .map((f) => `${f.label}: ${f.value}`)
    .join(' · ');
  return [
    input.title,
    [input.business, input.place].filter((s) => s && s.trim()).join(' · '),
    range ? words.range(range) : '',
    input.hours ? words.hours(input.hours) : '',
    filters ? words.filters(filters) : '',
    words.generatedAt(words.formatDateTime(input.generatedAt)),
  ].filter((line) => line.trim() !== '');
}

/** Characters no file system takes, as a dash; spaces stay (a person reads this name). */
export function readableFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 150) || 'report';
}

/** `2026-10-01`/`2026-10-13` → `01.10–13.10`; across years, with the years; one day, with its year. */
export function fileRange(from?: string | null, to?: string | null): string {
  const dot = (iso: string, withYear: boolean) => {
    const [y, m, d] = iso.split('-');
    if (!y || !m || !d) return iso;
    return withYear ? `${d}.${m}.${y}` : `${d}.${m}`;
  };
  if (!from && !to) return '';
  if (!from || !to || from === to) return dot((from || to)!, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${dot(from, !sameYear)}–${dot(to, !sameYear)}`;
}

/** "מכירות לפי מוצר — סניף X — 01.10–13.10" (no extension). */
export function reportFileName(title: string, place?: string | null, from?: string | null, to?: string | null): string {
  return readableFileName(
    [title, place?.trim() || '', fileRange(from, to)].filter(Boolean).join(' — '),
  );
}

/** Portrait up to this many columns, landscape beyond (the PDF's "auto"). */
export const PDF_PORTRAIT_MAX_COLUMNS = 7;

export function pdfOrientation(columnCount: number, choice: 'auto' | 'portrait' | 'landscape' = 'auto'): 'portrait' | 'landscape' {
  if (choice !== 'auto') return choice;
  return columnCount > PDF_PORTRAIT_MAX_COLUMNS ? 'landscape' : 'portrait';
}

// ── One table → an Excel sheet / a PDF body ──

/** A PDF cell's kind (`POST /reports/pdf`, P:\specs\reports-upgrade.md §4.5). */
export type PdfCellKind = 'text' | 'money' | 'number' | 'percent' | 'date';

export interface ReportPdfBody {
  title: string;
  subtitleLines?: string[];
  filterLines?: string[];
  columns: { key: string; label: string; kind?: PdfCellKind; align?: 'start' | 'end' | 'center' }[];
  rows: (string | number | null)[][];
  totals?: Record<string, string | number | null>;
  orientation?: 'portrait' | 'landscape' | 'auto';
  companyId?: string;
  fileName?: string;
}

/** A report table as the exports see it: keyed columns, plain values, a totals row. */
export interface ExportTable {
  tableId: string;
  /** The sheet's name (and the PDF's section, when it is the one printed). */
  name: string;
  columns: { key: string; header: string; kind?: ExcelCellKind; width?: number }[];
  rows: ExcelValue[][];
  /** One value per column; the first text cell carries the label ("סה״כ"). */
  totals?: ExcelValue[];
  /** Lines of this sheet only, under the report's header lines. */
  heading?: string[];
}

/** The table as an Excel sheet with only `keys` (bare column keys, in order); null = all. */
export function exportTableSheet(table: ExportTable, keys: readonly string[] | null): ExcelSheet {
  return selectSheetColumns(
    {
      name: table.name,
      heading: table.heading,
      columns: table.columns.map((c) => ({ key: c.key, header: c.header, kind: c.kind, width: c.width })),
      rows: table.rows,
      totals: table.totals,
    },
    keys,
  );
}

const PDF_KIND: Record<ExcelCellKind, 'text' | 'money' | 'number' | 'percent' | 'date'> = {
  text: 'text',
  money: 'money',
  number: 'number',
  percent: 'percent',
  date: 'date',
  datetime: 'date',
};

/** `POST /reports/pdf`'s body (§4.5) for one table, cut to `keys`. */
export function exportTablePdfBody(
  table: ExportTable,
  keys: readonly string[] | null,
  header: { title: string; subtitleLines: string[]; filterLines: string[]; fileName: string; companyId?: string | null },
  orientation: 'auto' | 'portrait' | 'landscape' = 'auto',
): ReportPdfBody {
  const sheet = exportTableSheet(table, keys);
  const columns = sheet.columns.slice(0, 40).map((c) => ({
    key: c.key ?? c.header,
    label: c.header,
    kind: PDF_KIND[c.kind ?? 'text'],
  }));
  const plain = (v: ExcelValue): string | number | null => (v === undefined || v === '' ? null : v);
  const totals = sheet.totals
    ? Object.fromEntries(columns.map((c, i) => [c.key, plain(sheet.totals![i])]).filter(([, v]) => v !== null))
    : undefined;
  return {
    title: header.title.slice(0, 200),
    subtitleLines: header.subtitleLines.slice(0, 10),
    filterLines: header.filterLines.slice(0, 30),
    columns,
    rows: sheet.rows.map((r) => columns.map((_, i) => plain(r[i]))),
    totals,
    orientation: orientation === 'auto' ? pdfOrientation(columns.length) : orientation,
    ...(header.companyId ? { companyId: header.companyId } : {}),
    fileName: header.fileName,
  };
}
