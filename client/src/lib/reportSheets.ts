/**
 * The report center's Excel sheets (docs/SPEC_REPORTS.md §2–7), built with the one export
 * helper (`lib/excelExport.ts`): the transactions search, the consolidated Z table, the
 * all-in-one workbook, the reconciliation and the transmissions.
 *
 * Pure: headers come through [t] (the page's `reportCenter.cols` translator) and payment
 * methods through [method], so the tests run without React or a network.
 */
import { EXCEL_FILL, type ExcelColumn, type ExcelSheet, type ExcelValue } from './excelExport';
import type {
  AllInOneReport,
  Reconciliation,
  ReconciliationRow,
  TransactionExportRow,
  TransmissionItem,
  TransmissionsReport,
  ZTable,
} from './reportCenterTypes';

export type Tr = (key: string) => string;

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const sum = (values: (string | number | null | undefined)[]): number =>
  Math.round(values.reduce<number>((acc, v) => acc + (num(v) ?? 0), 0) * 100) / 100;

function col(t: Tr, key: string, kind?: ExcelColumn['kind'], width?: number): ExcelColumn {
  return { header: t(key), kind, width };
}

// ── Transactions ─────────────────────────────────────────────────────────────

export function transactionsSheet(
  rows: TransactionExportRow[],
  t: Tr,
  name: string,
  labels: { documentType: (n: number | null) => string; status: (s: string) => string; method: (m: string) => string },
): ExcelSheet {
  const columns = [
    col(t, 'createdAt', 'datetime'),
    col(t, 'documentNumber', 'text', 14),
    col(t, 'documentType', 'text', 16),
    col(t, 'status', 'text', 12),
    col(t, 'shop'),
    col(t, 'till', 'text', 16),
    col(t, 'posNumber', 'text', 8),
    col(t, 'employee', 'text', 16),
    col(t, 'paymentMethod', 'text', 12),
    col(t, 'totalAmount', 'money'),
    col(t, 'discount', 'money'),
    col(t, 'collected', 'money'),
    col(t, 'signedAmount', 'money'),
    col(t, 'vat', 'money'),
    col(t, 'netOfVat', 'money'),
    col(t, 'tip', 'money'),
    col(t, 'cash', 'money'),
    col(t, 'card', 'money'),
    col(t, 'productionVoucher', 'money'),
    col(t, 'other', 'money'),
    col(t, 'cardBrands', 'text', 14),
    col(t, 'cardLast4', 'text', 10),
    col(t, 'approvalNumbers', 'text', 14),
    col(t, 'refundOf', 'text', 14),
    col(t, 'shiftNumber', 'number'),
    col(t, 'zNumber', 'number'),
    col(t, 'customer', 'text', 16),
  ];
  return {
    name,
    columns,
    rows: rows.map((r) => [
      r.createdAt, r.documentNumber, labels.documentType(r.documentType), labels.status(r.status),
      r.shopName, r.machineName, r.posNumber, r.cashierName ?? r.cashierId,
      r.paymentMethod ? labels.method(r.paymentMethod) : null,
      r.totalAmount, r.documentDiscount, r.collected, r.signedAmount, r.vatAmount, r.netOfVat, r.tipAmount,
      r.cash, r.card, r.other, r.cardBrands.join(', ') || null, r.cardLast4.join(', ') || null,
      r.approvalNumbers.join(', ') || null, r.refundOf, r.shiftNumber, r.zNumber, r.customerName,
    ]),
    totals: [
      t('total'), `${rows.length}`, null, null, null, null, null, null, null,
      sum(rows.map((r) => r.totalAmount)), sum(rows.map((r) => r.documentDiscount)), null,
      sum(rows.map((r) => r.signedAmount)), null, null, sum(rows.map((r) => r.tipAmount)),
      null, null, null, null, null, null, null, null, null, null,
    ],
  };
}

// ── The Z table ──────────────────────────────────────────────────────────────

function transmissionCells(x: ZTable['zs'][number]['transmission']): ExcelValue[] {
  return [
    x.successfulBatches,
    x.batchNumbers.join(', ') || x.zBatchNumber || null,
    x.batchesAmount ?? x.zBatchAmount ?? null,
    x.cardLegs,
    x.transmittedLegs,
    x.untransmittedLegs,
    x.untransmittedAmount,
  ];
}

const TRANSMISSION_COLS = [
  ['transmissionBatches', 'number'],
  ['batchNumbers', 'text'],
  ['batchesAmount', 'money'],
  ['cardLegs', 'number'],
  ['transmittedLegs', 'number'],
  ['untransmittedLegs', 'number'],
  ['untransmittedAmount', 'money'],
] as const;

/** "טבלת זדים מרוכזת": one sheet of every Z, and one of the tills' lines of each. */
export function zTableSheets(table: ZTable, t: Tr, method: (m: string) => string): ExcelSheet[] {
  const methods = table.paymentMethods;
  const zColumns: ExcelColumn[] = [
    col(t, 'zNumber', 'number'),
    col(t, 'zType', 'text', 14),
    col(t, 'shop'),
    col(t, 'tills', 'text', 26),
    col(t, 'businessDate', 'date'),
    col(t, 'openedAt', 'datetime'),
    col(t, 'closedAt', 'datetime'),
    col(t, 'invoiceRange', 'text', 26),
    col(t, 'creditNoteRange', 'text', 20),
    col(t, 'receiptRange', 'text', 20),
    col(t, 'shifts', 'number'),
    col(t, 'documents', 'number'),
    col(t, 'salesCount', 'number'),
    col(t, 'creditNotesCount', 'number'),
    col(t, 'grossSales', 'money'),
    col(t, 'discount', 'money'),
    col(t, 'totalSales', 'money'),
    col(t, 'refunds', 'money'),
    col(t, 'netSales', 'money'),
    col(t, 'vat', 'money'),
    col(t, 'netOfVat', 'money'),
    ...methods.map((m) => ({ header: method(m), kind: 'money' as const })),
    col(t, 'tips', 'money'),
    col(t, 'cashTips', 'money'),
    col(t, 'cardTips', 'money'),
    col(t, 'discrepancy', 'money'),
    ...TRANSMISSION_COLS.map(([k, kind]) => col(t, k, kind)),
    col(t, 'lateDocuments', 'number'),
    col(t, 'notes', 'text', 24),
  ];
  const zRows = table.zs.map((z) => [
    z.zNumber, z.zTypeLabel, z.shopName, z.tills, z.businessDate, z.openedAt, z.closedAt,
    z.invoiceRange, z.creditNoteRange, z.receiptRange, z.shiftCount, z.transactionsCount, z.salesCount,
    z.creditNotesCount, z.grossSales, z.discountsTotal, z.totalSales, z.totalRefunds, z.netSales, z.vatTotal,
    z.netOfVat, ...methods.map((m) => z.payments[m] ?? null), z.totalTips, z.cashTips, z.cardTips, z.discrepancy,
    ...transmissionCells(z.transmission), z.lateDocuments,
    [z.totalsMismatch ? t('noteMismatch') : '', z.builtOffline ? t('noteOffline') : '', z.amendedDocuments ? t('noteAmended') : '']
      .filter(Boolean).join(' · ') || null,
  ]);
  const moneyIdx = zColumns.map((c, i) => (c.kind === 'money' ? i : -1)).filter((i) => i >= 0);
  const zTotals: ExcelValue[] = zColumns.map((_, i) => (i === 0 ? t('total') : null));
  for (const i of moneyIdx) zTotals[i] = sum(zRows.map((r) => r[i] as string | null));
  zTotals[11] = zRows.reduce<number>((a, r) => a + (num(r[11] as number) ?? 0), 0);

  const tillColumns: ExcelColumn[] = [
    col(t, 'zNumber', 'number'),
    col(t, 'zType', 'text', 14),
    col(t, 'shop'),
    col(t, 'posNumber', 'text', 8),
    col(t, 'till', 'text', 16),
    col(t, 'businessDate', 'date'),
    col(t, 'shifts', 'number'),
    col(t, 'invoiceFirst', 'text', 14),
    col(t, 'invoiceLast', 'text', 14),
    col(t, 'creditNoteFirst', 'text', 14),
    col(t, 'creditNoteLast', 'text', 14),
    col(t, 'receiptFirst', 'text', 14),
    col(t, 'receiptLast', 'text', 14),
    col(t, 'documents', 'number'),
    col(t, 'grossSales', 'money'),
    col(t, 'discount', 'money'),
    col(t, 'totalSales', 'money'),
    col(t, 'refunds', 'money'),
    col(t, 'netSales', 'money'),
    col(t, 'vat', 'money'),
    col(t, 'netOfVat', 'money'),
    ...methods.map((m) => ({ header: method(m), kind: 'money' as const })),
    col(t, 'tips', 'money'),
    col(t, 'overShort', 'money'),
    ...TRANSMISSION_COLS.map(([k, kind]) => col(t, k, kind)),
  ];
  const tillRows = table.tills.map((l) => [
    l.zNumber, l.zTypeLabel, l.shopName, l.posNumber, l.machineName, l.businessDate, l.shiftCount,
    l.invoiceFirst, l.invoiceLast, l.creditNoteFirst, l.creditNoteLast, l.receiptFirst, l.receiptLast,
    l.transactionsCount, l.grossSales, l.discountsTotal, l.totalSales, l.totalRefunds, l.netSales, l.vatTotal,
    l.netOfVat, ...methods.map((m) => l.payments[m] ?? null), l.totalTips, l.overShort, ...transmissionCells(l.transmission),
  ]);
  return [
    { name: t('sheetZs'), columns: zColumns, rows: zRows, totals: zTotals },
    { name: t('sheetZTills'), columns: tillColumns, rows: tillRows },
  ];
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export function statusFill(status: ReconciliationRow['status']): string | null {
  if (status === 'missing') return EXCEL_FILL.missing;
  if (status === 'difference') return EXCEL_FILL.difference;
  if (status === 'pending') return EXCEL_FILL.info;
  return null;
}

function reconciliationColumns(t: Tr): ExcelColumn[] {
  return [
    col(t, 'status', 'text', 10),
    col(t, 'check', 'text', 20),
    col(t, 'shop'),
    col(t, 'till', 'text', 16),
    col(t, 'posNumber', 'text', 8),
    col(t, 'terminal', 'text', 18),
    col(t, 'day', 'date'),
    col(t, 'zNumber', 'text', 8),
    col(t, 'subject', 'text', 30),
    col(t, 'count', 'number'),
    col(t, 'expected', 'money'),
    col(t, 'actual', 'money'),
    col(t, 'difference', 'money'),
    col(t, 'reason', 'text', 70),
    col(t, 'container', 'text', 26),
    col(t, 'ownerAction', 'text', 40),
  ];
}

function reconciliationCells(r: ReconciliationRow): ExcelValue[] {
  // Numbering rows compare counts of numbers, not money: their expected/actual are counts.
  const counts = r.check === 'document_numbers' || r.check === 'z_numbers';
  return [
    r.statusLabel, r.checkLabel, r.shopName, r.machineName, r.posNumber, r.terminal, r.day,
    r.zNumber === null || r.zNumber === undefined ? null : String(r.zNumber), r.subject, r.count,
    counts ? null : r.expected, counts ? null : r.actual, counts ? null : r.difference, r.reason,
    r.container ?? null, r.action?.label ?? null,
  ];
}

/** The summary, every row, then one sheet per check — each row coloured by its status. */
export function reconciliationSheets(rec: Reconciliation, t: Tr): ExcelSheet[] {
  const summary: ExcelSheet = {
    name: t('sheetSummary'),
    columns: [
      col(t, 'check', 'text', 26),
      ...rec.statuses.map((s) => ({ header: s.label, kind: 'number' as const })),
    ],
    rows: rec.checks.map((c) => [c.label, ...rec.statuses.map((s) => rec.summary[c.key]?.[s.key] ?? 0)]),
    totals: [t('total'), ...rec.statuses.map((s) => rec.totals[s.key] ?? 0)],
  };
  const all: ExcelSheet = {
    name: t('sheetAllRows'),
    columns: reconciliationColumns(t),
    rows: rec.rows.map(reconciliationCells),
    rowFills: rec.rows.map((r) => statusFill(r.status)),
  };
  const perCheck = rec.checks.map((c) => {
    const rows = rec.rows.filter((r) => r.check === c.key);
    return {
      name: c.label,
      columns: reconciliationColumns(t),
      rows: rows.map(reconciliationCells),
      rowFills: rows.map((r) => statusFill(r.status)),
    } satisfies ExcelSheet;
  });
  return [summary, all, ...perCheck];
}

// ── Transmissions ────────────────────────────────────────────────────────────

export function transmissionItemsSheet(items: TransmissionItem[], t: Tr, name: string): ExcelSheet {
  return {
    name,
    columns: [
      col(t, 'till', 'text', 16),
      col(t, 'posNumber', 'text', 8),
      col(t, 'startedAt', 'datetime'),
      col(t, 'receivedAt', 'datetime'),
      col(t, 'trigger', 'text', 12),
      col(t, 'status', 'text', 10),
      col(t, 'batchNumber', 'text', 14),
      col(t, 'transactionCount', 'number'),
      col(t, 'amount', 'money'),
      col(t, 'namedTransactions', 'number'),
      col(t, 'assumedTransactions', 'number'),
      col(t, 'legsMatched', 'number'),
      col(t, 'error', 'text', 30),
    ],
    rows: items.map((x) => [
      x.machineName ?? x.machineId.slice(0, 8), x.posNumber ?? null, x.startedAt, x.receivedAt, x.trigger, x.status,
      x.batchNumber, x.transactionCount, x.amount, x.terminalTransactionCount, x.assumedTransactionCount,
      x.legsMatched, x.error ?? x.statusMessage,
    ]),
    rowFills: items.map((x) => (x.status === 'success' ? null : x.status === 'failed' ? EXCEL_FILL.missing : EXCEL_FILL.difference)),
    totals: [t('total'), null, null, null, null, null, null,
      items.reduce((a, x) => a + (x.status === 'success' ? x.transactionCount ?? 0 : 0), 0),
      sum(items.filter((x) => x.status === 'success').map((x) => x.amount)), null, null, null, null],
  };
}

export function transmissionsSheets(report: TransmissionsReport, t: Tr): ExcelSheet[] {
  return [
    {
      name: t('sheetTills'),
      columns: [
        col(t, 'till', 'text', 16),
        col(t, 'posNumber', 'text', 8),
        col(t, 'attempts', 'number'),
        col(t, 'success', 'number'),
        col(t, 'failed', 'number'),
        col(t, 'unknown', 'number'),
        col(t, 'transactionCount', 'number'),
        col(t, 'amount', 'money'),
        col(t, 'lastSuccessAt', 'datetime'),
        col(t, 'lastReceivedAt', 'datetime'),
        col(t, 'tillPending', 'number'),
        col(t, 'untransmittedLegs', 'number'),
        col(t, 'untransmittedAmount', 'money'),
      ],
      rows: report.tills.map((till) => {
        const row = report.byTill.find((b) => b.machineId === till.machineId);
        return [
          till.machineName, till.posNumber, row?.attempts ?? 0, row?.success ?? 0, row?.failed ?? 0, row?.unknown ?? 0,
          row?.transactions ?? 0, row?.amount ?? 0, till.lastTransmissionAt, row?.lastAttemptAt ?? null,
          till.tillPendingCount, till.untransmittedCardLegs, till.untransmittedCardAmount,
        ];
      }),
    },
    transmissionItemsSheet(report.items, t, t('sheetTransmissions')),
  ];
}

// ── All in one ───────────────────────────────────────────────────────────────

type MoneyLike = {
  documents: number; salesCount: number; refundsCount: number; gross: number; discounts: number; refunds: number;
  net: number; cash: number; card: number; productionVoucher?: number; other: number; tips: number;
};

const MONEY_KEYS: [keyof MoneyLike, ExcelColumn['kind']][] = [
  ['documents', 'number'], ['salesCount', 'number'], ['refundsCount', 'number'], ['gross', 'money'],
  ['discounts', 'money'], ['refunds', 'money'], ['net', 'money'], ['cash', 'money'], ['card', 'money'],
  ['productionVoucher', 'money'], ['other', 'money'], ['tips', 'money'],
];

function moneySheet<T extends MoneyLike>(name: string, t: Tr, lead: [string, ExcelColumn['kind']?][], rows: T[], leadCells: (r: T) => ExcelValue[]): ExcelSheet {
  const columns = [...lead.map(([k, kind]) => col(t, k, kind)), ...MONEY_KEYS.map(([k, kind]) => col(t, k, kind))];
  return {
    name,
    columns,
    rows: rows.map((r) => [...leadCells(r), ...MONEY_KEYS.map(([k]) => r[k])]),
    totals: [t('total'), ...lead.slice(1).map(() => null), ...MONEY_KEYS.map(([k]) => sum(rows.map((r) => r[k])))],
  };
}

export function allInOneSheets(r: AllInOneReport, t: Tr, method: (m: string) => string, brand: (b: string) => string): ExcelSheet[] {
  if (r.empty || !r.summary) return [{ name: t('sheetSummary'), columns: [col(t, 'item')], rows: [] }];
  const s = r.summary;
  const sheets: ExcelSheet[] = [
    {
      name: t('sheetSummary'),
      columns: [col(t, 'item', 'text', 30), col(t, 'value', 'money', 16)],
      rows: [
        [t('documents'), s.documents], [t('salesCount'), s.salesCount], [t('refundsCount'), s.refundsCount],
        [t('gross'), s.gross], [t('discounts'), s.discounts], [t('refunds'), s.refunds], [t('net'), s.net],
        [t('vat'), s.vat], [t('netOfVat'), s.netOfVat], [t('averageBasket'), s.averageBasket],
        [t('cash'), s.cash], [t('card'), s.card], [t('productionVoucher'), s.productionVoucher ?? 0], [t('other'), s.other],
        [t('tips'), s.tips],
        [t('cancelledDocuments'), s.cancelledDocuments], [t('cancelledAmount'), s.cancelledAmount],
        [t('failedAttempts'), s.failedAttempts], [t('zCount'), s.zCount], [t('transmissionsCount'), s.transmissions],
      ],
      autoFilter: false,
    },
    {
      name: t('sheetPayments'),
      columns: [col(t, 'paymentMethod', 'text', 16), col(t, 'documents', 'number'), col(t, 'amount', 'money'), col(t, 'share', 'percent')],
      rows: (r.byPaymentMethod ?? []).map((m) => [method(m.method), m.documents, m.amount, m.share]),
      totals: [t('total'), null, sum((r.byPaymentMethod ?? []).map((m) => m.amount)), 100],
    },
    {
      name: t('sheetCardBrands'),
      columns: [col(t, 'brand', 'text', 14), col(t, 'salesCount', 'number'), col(t, 'salesAmount', 'money'),
        col(t, 'refundsCount', 'number'), col(t, 'refundsAmount', 'money'), col(t, 'net', 'money')],
      rows: (r.cardBrands ?? []).map((b) => [brand(b.brand), b.salesCount, b.salesAmount, b.refundsCount, b.refundsAmount, b.net]),
      totals: [t('total'), null, sum((r.cardBrands ?? []).map((b) => b.salesAmount)), null,
        sum((r.cardBrands ?? []).map((b) => b.refundsAmount)), sum((r.cardBrands ?? []).map((b) => b.net))],
    },
    moneySheet(t('sheetTills'), t, [['till'], ['posNumber'], ['shop']], r.byTill ?? [],
      (x) => [x.machineName, x.posNumber, x.shopName]),
    moneySheet(t('sheetEmployees'), t, [['employee'], ['workerNumber']], r.byEmployee ?? [],
      (x) => [x.cashierName ?? x.cashierId, x.workerNumber]),
    moneySheet(t('sheetDays'), t, [['day', 'date']], r.byDay ?? [], (x) => [x.day]),
    {
      name: t('sheetCategories'),
      columns: [col(t, 'category', 'text', 20), col(t, 'units', 'number'), col(t, 'gross', 'money'),
        col(t, 'discounts', 'money'), col(t, 'refunds', 'money'), col(t, 'net', 'money'), col(t, 'share', 'percent')],
      rows: (r.byCategory ?? []).map((c) => [c.categoryName, c.units, c.gross, c.discounts, c.refunds, c.net, c.share]),
      totals: [t('total'), null, sum((r.byCategory ?? []).map((c) => c.gross)), sum((r.byCategory ?? []).map((c) => c.discounts)),
        sum((r.byCategory ?? []).map((c) => c.refunds)), sum((r.byCategory ?? []).map((c) => c.net)), 100],
    },
    {
      name: t('sheetItems'),
      columns: [col(t, 'item', 'text', 26), col(t, 'sku', 'text', 12), col(t, 'unitsSold', 'number'), col(t, 'unitsRefunded', 'number'),
        col(t, 'unitsNet', 'number'), col(t, 'gross', 'money'), col(t, 'discounts', 'money'), col(t, 'refunds', 'money'), col(t, 'net', 'money')],
      rows: (r.byItem ?? []).map((i) => [i.productName, i.sku, i.unitsSold, i.unitsRefunded, i.unitsNet, i.gross, i.discounts, i.refunds, i.net]),
      totals: [t('total'), null, null, null, null, sum((r.byItem ?? []).map((i) => i.gross)), sum((r.byItem ?? []).map((i) => i.discounts)),
        sum((r.byItem ?? []).map((i) => i.refunds)), sum((r.byItem ?? []).map((i) => i.net))],
    },
    {
      name: t('sheetRefunds'),
      columns: [col(t, 'createdAt', 'datetime'), col(t, 'documentNumber', 'text', 14), col(t, 'refundOf', 'text', 14),
        col(t, 'till', 'text', 16), col(t, 'employee', 'text', 16), col(t, 'paymentMethod', 'text', 12), col(t, 'amount', 'money')],
      rows: (r.refunds?.items ?? []).map((x) => [x.createdAt, x.documentNumber, x.originalNumber, x.machineName, x.cashierName,
        x.paymentMethod ? method(x.paymentMethod) : null, x.amount]),
      totals: [t('total'), `${r.refunds?.count ?? 0}`, null, null, null, null, r.refunds?.total ?? 0],
    },
    {
      name: t('sheetDiscounts'),
      columns: [col(t, 'item', 'text', 30), col(t, 'documents', 'number'), col(t, 'amount', 'money')],
      rows: [
        [t('documentDiscounts'), null, r.discounts?.documentDiscounts ?? 0],
        [t('lineDiscounts'), null, r.discounts?.lineDiscounts ?? 0],
        [t('promotionDiscounts'), null, r.discounts?.promotionDiscounts ?? 0],
        ...(r.discounts?.byKind ?? []).map((k) => [`${t('discountKind')}: ${k.kind}`, k.documents, k.amount] as ExcelValue[]),
        ...(r.discounts?.byTill ?? []).map((k) => [`${t('till')}: ${k.machineName ?? ''}`, null, k.discounts] as ExcelValue[]),
        ...(r.discounts?.byEmployee ?? []).map((k) => [`${t('employee')}: ${k.cashierName ?? ''}`, null, k.discounts] as ExcelValue[]),
      ],
      autoFilter: false,
    },
    {
      name: t('sheetTips'),
      columns: [col(t, 'item', 'text', 30), col(t, 'amount', 'money')],
      rows: [
        [t('tips'), r.tips?.total ?? 0], [t('cashTips'), r.tips?.cash ?? 0], [t('cardTips'), r.tips?.card ?? 0],
        ...(r.tips?.byTill ?? []).map((k) => [`${t('till')}: ${k.machineName ?? ''}`, k.tips] as ExcelValue[]),
        ...(r.tips?.byEmployee ?? []).map((k) => [`${t('employee')}: ${k.cashierName ?? ''}`, k.tips] as ExcelValue[]),
      ],
      autoFilter: false,
    },
    {
      name: t('sheetVat'),
      columns: [col(t, 'vatRate', 'percent'), col(t, 'documents', 'number'), col(t, 'gross', 'money'), col(t, 'vat', 'money'),
        col(t, 'netOfVat', 'money'), col(t, 'missingVat', 'number')],
      rows: (r.vat?.rows ?? []).map((v) => [v.rate, v.documents, v.gross, v.vat, v.netOfVat, v.missingVat]),
      totals: [t('total'), r.vat?.totals.documents ?? 0, r.vat?.totals.gross ?? 0, r.vat?.totals.vat ?? 0,
        r.vat?.totals.netOfVat ?? 0, r.vat?.totals.missingVat ?? 0],
    },
  ];
  if (r.zs) sheets.push(...zTableSheets(r.zs, t, method));
  if (r.transmissions) {
    sheets.push(transmissionItemsSheet(r.transmissions.items, t, t('sheetTransmissions')));
  }
  if (r.failedPayments) {
    sheets.push({
      name: t('sheetFailed'),
      columns: [col(t, 'occurredAt', 'datetime'), col(t, 'till', 'text', 16), col(t, 'employee', 'text', 16), col(t, 'amount', 'money'),
        col(t, 'paymentMethod', 'text', 10), col(t, 'outcome', 'text', 18), col(t, 'reason', 'text', 30), col(t, 'cardLast4', 'text', 8),
        col(t, 'paidLaterBy', 'text', 14)],
      rows: r.failedPayments.items.map((f) => [f.occurredAt, f.machineName, f.employeeName, f.amount, method(f.method), f.outcomeLabel,
        f.reason, f.cardLast4, f.paidLaterBy]),
      totals: [t('total'), null, null, sum(r.failedPayments.items.map((f) => f.amount)), null, null, null, null, null],
    });
  }
  if (r.meals) {
    sheets.push({
      name: t('sheetMeals'),
      columns: [col(t, 'occurredAt', 'datetime'), col(t, 'shop'), col(t, 'mealKind', 'text', 12), col(t, 'employee', 'text', 16),
        col(t, 'reason', 'text', 20), col(t, 'approvedBy', 'text', 14), col(t, 'before', 'money'), col(t, 'discount', 'money'), col(t, 'paid', 'money')],
      rows: r.meals.meals.map((m) => [m.at, m.shopName, t(`meal_${m.kind}`), m.employee, m.reason, m.approvedBy, m.before, m.discount, m.paid]),
      totals: [t('total'), null, null, null, null, null, sum(r.meals.meals.map((m) => m.before)), sum(r.meals.meals.map((m) => m.discount)),
        sum(r.meals.meals.map((m) => m.paid))],
    });
  }
  if (r.kiosks) {
    sheets.push(moneySheet(t('sheetKiosks'), t, [['till'], ['shop']], r.kiosks.byKiosk, (x) => [x.machineName, x.shopName]));
  }
  return sheets;
}
