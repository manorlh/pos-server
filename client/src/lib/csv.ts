/**
 * CSV for the reports' "export" buttons, built from the JSON the page already shows.
 *
 * Values go out as the server sent them (money as its decimal strings), not as the
 * page formats them — a spreadsheet should get numbers, not "₪1,234.50". A byte-order
 * mark leads the file so Excel reads the Hebrew as UTF-8.
 */

export type CsvCell = string | number | boolean | null | undefined;

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote anything that would break the row, and neutralise a leading formula sign so
  // an area named "=SUM(…)" stays text in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
