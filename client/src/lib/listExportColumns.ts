/**
 * The columns of the lists' server exports as report columns (P:\specs\reports-upgrade.md §2ב):
 * the transactions export (`GET /transactions/export`) and the consolidated Z table
 * (`GET /report-center/z-table`). Each column has a stable key — what a reader ticks in
 * "עמודות לייצוא" and what a company saves as its default — its header, kind, width, the
 * cell of a row and, where the sheet has one, its total over every exported row.
 *
 * The same columns, cells and totals as `transactionsSheet` / `zTableSheets`
 * (lib/reportSheets.ts; the tests hold them to it), plus the tip's tender on a document.
 *
 * Pure: headers come through `t` (the page's `reportCenter.cols`), labels through functions.
 */
import type { ExcelCellKind, ExcelValue } from './excelExport';
import type { TransactionExportRow, ZTableRow, ZTableTillRow, ZTransmissionLink } from './reportCenterTypes';

export type ColumnText = (key: string) => string;

export interface ListExportColumn<R> {
  key: string;
  header: string;
  kind?: ExcelCellKind;
  width?: number;
  value(row: R): ExcelValue;
  /** The totals row's cell over every exported row (none: empty). */
  total?(rows: R[]): ExcelValue;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Money summed to the agora (decimal strings too); empty cells count as nothing. */
export function sumMoney(values: (string | number | null | undefined)[]): number {
  return Math.round(values.reduce<number>((acc, v) => acc + (num(v) ?? 0), 0) * 100) / 100;
}

function column<R>(
  t: ColumnText,
  key: string,
  value: (row: R) => ExcelValue,
  kind?: ExcelCellKind,
  width?: number,
  total?: (rows: R[]) => ExcelValue,
): ListExportColumn<R> {
  return { key, header: t(key), kind, width, value, ...(total ? { total } : {}) };
}

const moneyTotal =
  <R>(pick: (row: R) => string | number | null | undefined) =>
  (rows: R[]) =>
    sumMoney(rows.map(pick));

// ── Transactions ─────────────────────────────────────────────────────────────

export interface TxExportLabels {
  documentType: (n: number | null) => string;
  status: (s: string) => string;
  method: (m: string) => string;
}

/**
 * Every column of the transactions export, in the sheet's order. `tipMethod` (the tender the
 * tip went on, §4.2) is new beside the tip; its header comes through `t` like the others.
 */
export function transactionExportColumns(t: ColumnText, l: TxExportLabels): ListExportColumn<TransactionExportRow>[] {
  type R = TransactionExportRow;
  return [
    column<R>(t, 'createdAt', (r) => r.createdAt, 'datetime'),
    column<R>(t, 'documentNumber', (r) => r.documentNumber, 'text', 14, (rows) => `${rows.length}`),
    column<R>(t, 'documentType', (r) => l.documentType(r.documentType), 'text', 16),
    column<R>(t, 'status', (r) => l.status(r.status), 'text', 12),
    column<R>(t, 'shop', (r) => r.shopName),
    column<R>(t, 'till', (r) => r.machineName, 'text', 16),
    column<R>(t, 'posNumber', (r) => r.posNumber, 'text', 8),
    column<R>(t, 'employee', (r) => r.cashierName ?? r.cashierId, 'text', 16),
    column<R>(t, 'paymentMethod', (r) => (r.paymentMethod ? l.method(r.paymentMethod) : null), 'text', 12),
    column<R>(t, 'totalAmount', (r) => r.totalAmount, 'money', undefined, moneyTotal((r) => r.totalAmount)),
    column<R>(t, 'discount', (r) => r.documentDiscount, 'money', undefined, moneyTotal((r) => r.documentDiscount)),
    column<R>(t, 'collected', (r) => r.collected, 'money'),
    column<R>(t, 'signedAmount', (r) => r.signedAmount, 'money', undefined, moneyTotal((r) => r.signedAmount)),
    column<R>(t, 'vat', (r) => r.vatAmount, 'money'),
    column<R>(t, 'netOfVat', (r) => r.netOfVat, 'money'),
    column<R>(t, 'tip', (r) => r.tipAmount, 'money', undefined, moneyTotal((r) => r.tipAmount)),
    column<R>(t, 'tipMethod', (r) => (r.tipPaymentMethod && num(r.tipAmount) ? l.method(r.tipPaymentMethod) : null), 'text', 12),
    column<R>(t, 'cash', (r) => r.cash, 'money'),
    column<R>(t, 'card', (r) => r.card, 'money'),
    column<R>(t, 'productionVoucher', (r) => r.productionVoucher ?? null, 'money'),
    column<R>(t, 'other', (r) => r.other, 'money'),
    column<R>(t, 'cardBrands', (r) => r.cardBrands.join(', ') || null, 'text', 14),
    column<R>(t, 'cardLast4', (r) => r.cardLast4.join(', ') || null, 'text', 10),
    column<R>(t, 'approvalNumbers', (r) => r.approvalNumbers.join(', ') || null, 'text', 14),
    column<R>(t, 'refundOf', (r) => r.refundOf, 'text', 14),
    column<R>(t, 'shiftNumber', (r) => r.shiftNumber, 'number'),
    column<R>(t, 'zNumber', (r) => r.zNumber, 'number'),
    column<R>(t, 'customer', (r) => r.customerName, 'text', 16),
    column<R>(t, 'customerVatNumber', (r) => r.customerVatNumber || null, 'text', 14),
  ];
}

// ── The consolidated Z table ─────────────────────────────────────────────────

/** A payment method's column key (`pay:cash`). */
export function paymentColumnKey(method: string): string {
  return `pay:${method.replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
}

function transmissionColumns<R>(t: ColumnText, link: (row: R) => ZTransmissionLink): ListExportColumn<R>[] {
  return [
    column<R>(t, 'transmissionBatches', (r) => link(r).successfulBatches, 'number'),
    column<R>(t, 'batchNumbers', (r) => link(r).batchNumbers.join(', ') || link(r).zBatchNumber || null, 'text'),
    column<R>(t, 'batchesAmount', (r) => link(r).batchesAmount ?? link(r).zBatchAmount ?? null, 'money'),
    column<R>(t, 'cardLegs', (r) => link(r).cardLegs, 'number'),
    column<R>(t, 'transmittedLegs', (r) => link(r).transmittedLegs, 'number'),
    column<R>(t, 'untransmittedLegs', (r) => link(r).untransmittedLegs, 'number'),
    column<R>(t, 'untransmittedAmount', (r) => link(r).untransmittedAmount, 'money'),
  ];
}

/** One row per Z: every money column (the payment methods' too) totalled, and the documents. */
export function zTableColumns(t: ColumnText, methodLabel: (m: string) => string, methods: string[]): ListExportColumn<ZTableRow>[] {
  type R = ZTableRow;
  const cols: ListExportColumn<R>[] = [
    column<R>(t, 'zNumber', (z) => z.zNumber, 'number'),
    column<R>(t, 'zType', (z) => z.zTypeLabel, 'text', 14),
    column<R>(t, 'shop', (z) => z.shopName),
    column<R>(t, 'tills', (z) => z.tills, 'text', 26),
    column<R>(t, 'businessDate', (z) => z.businessDate, 'date'),
    column<R>(t, 'openedAt', (z) => z.openedAt, 'datetime'),
    column<R>(t, 'closedAt', (z) => z.closedAt, 'datetime'),
    column<R>(t, 'invoiceRange', (z) => z.invoiceRange, 'text', 26),
    column<R>(t, 'creditNoteRange', (z) => z.creditNoteRange, 'text', 20),
    column<R>(t, 'receiptRange', (z) => z.receiptRange, 'text', 20),
    column<R>(t, 'shifts', (z) => z.shiftCount, 'number'),
    column<R>(t, 'documents', (z) => z.transactionsCount, 'number', undefined, (rows) =>
      rows.reduce<number>((a, z) => a + (num(z.transactionsCount) ?? 0), 0),
    ),
    column<R>(t, 'salesCount', (z) => z.salesCount, 'number'),
    column<R>(t, 'creditNotesCount', (z) => z.creditNotesCount, 'number'),
    column<R>(t, 'grossSales', (z) => z.grossSales, 'money'),
    column<R>(t, 'discount', (z) => z.discountsTotal, 'money'),
    column<R>(t, 'totalSales', (z) => z.totalSales, 'money'),
    column<R>(t, 'refunds', (z) => z.totalRefunds, 'money'),
    column<R>(t, 'netSales', (z) => z.netSales, 'money'),
    column<R>(t, 'vat', (z) => z.vatTotal, 'money'),
    column<R>(t, 'netOfVat', (z) => z.netOfVat, 'money'),
    ...methods.map((m) => ({ key: paymentColumnKey(m), header: methodLabel(m), kind: 'money' as const, value: (z: R) => z.payments[m] ?? null })),
    column<R>(t, 'tips', (z) => z.totalTips, 'money'),
    column<R>(t, 'cashTips', (z) => z.cashTips, 'money'),
    column<R>(t, 'cardTips', (z) => z.cardTips, 'money'),
    column<R>(t, 'discrepancy', (z) => z.discrepancy, 'money'),
    ...transmissionColumns<R>(t, (z) => z.transmission),
    column<R>(t, 'lateDocuments', (z) => z.lateDocuments, 'number'),
    column<R>(
      t,
      'notes',
      (z) =>
        [z.totalsMismatch ? t('noteMismatch') : '', z.builtOffline ? t('noteOffline') : '', z.amendedDocuments ? t('noteAmended') : '']
          .filter(Boolean)
          .join(' · ') || null,
      'text',
      24,
    ),
  ];
  // Every money column sums, as the Z sheet always did.
  return cols.map((c) => (c.kind === 'money' && !c.total ? { ...c, total: (rows: R[]) => sumMoney(rows.map((z) => c.value(z) as string | null)) } : c));
}

/** One row per till of each Z (no totals: a till's figures are inside its Z's). */
export function zTillColumns(t: ColumnText, methodLabel: (m: string) => string, methods: string[]): ListExportColumn<ZTableTillRow>[] {
  type R = ZTableTillRow;
  return [
    column<R>(t, 'zNumber', (l) => l.zNumber, 'number'),
    column<R>(t, 'zType', (l) => l.zTypeLabel, 'text', 14),
    column<R>(t, 'shop', (l) => l.shopName),
    column<R>(t, 'posNumber', (l) => l.posNumber, 'text', 8),
    column<R>(t, 'till', (l) => l.machineName, 'text', 16),
    column<R>(t, 'businessDate', (l) => l.businessDate, 'date'),
    column<R>(t, 'shifts', (l) => l.shiftCount, 'number'),
    column<R>(t, 'invoiceFirst', (l) => l.invoiceFirst, 'text', 14),
    column<R>(t, 'invoiceLast', (l) => l.invoiceLast, 'text', 14),
    column<R>(t, 'creditNoteFirst', (l) => l.creditNoteFirst, 'text', 14),
    column<R>(t, 'creditNoteLast', (l) => l.creditNoteLast, 'text', 14),
    column<R>(t, 'receiptFirst', (l) => l.receiptFirst, 'text', 14),
    column<R>(t, 'receiptLast', (l) => l.receiptLast, 'text', 14),
    column<R>(t, 'documents', (l) => l.transactionsCount, 'number'),
    column<R>(t, 'grossSales', (l) => l.grossSales, 'money'),
    column<R>(t, 'discount', (l) => l.discountsTotal, 'money'),
    column<R>(t, 'totalSales', (l) => l.totalSales, 'money'),
    column<R>(t, 'refunds', (l) => l.totalRefunds, 'money'),
    column<R>(t, 'netSales', (l) => l.netSales, 'money'),
    column<R>(t, 'vat', (l) => l.vatTotal, 'money'),
    column<R>(t, 'netOfVat', (l) => l.netOfVat, 'money'),
    ...methods.map((m) => ({ key: paymentColumnKey(m), header: methodLabel(m), kind: 'money' as const, value: (l: R) => l.payments[m] ?? null })),
    column<R>(t, 'tips', (l) => l.totalTips, 'money'),
    column<R>(t, 'overShort', (l) => l.overShort, 'money'),
    ...transmissionColumns<R>(t, (l) => l.transmission),
  ];
}

/** Columns + rows → the sheet's cells and its totals line (the label in the first column). */
export function listSheetCells<R>(
  columns: ListExportColumn<R>[],
  rows: R[],
  totalLabel?: string,
): { rows: ExcelValue[][]; totals?: ExcelValue[] } {
  const cells = rows.map((r) => columns.map((c) => c.value(r)));
  if (!totalLabel) return { rows: cells };
  return { rows: cells, totals: columns.map((c, i) => (c.total ? c.total(rows) : i === 0 ? totalLabel : null)) };
}
