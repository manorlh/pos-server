import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciliationSheets, statusFill, transactionsSheet, zTableSheets } from './reportSheets';
import type { Reconciliation, TransactionExportRow, ZTable } from './reportCenterTypes';

const t = (k: string) => k;

const link = {
  batchCount: 1, successfulBatches: 1, failedBatches: 0, batchNumbers: ['777'], batchesAmount: '40.00',
  cardLegs: 1, transmittedLegs: 1, untransmittedLegs: 0, untransmittedAmount: '0.00',
};

const table: ZTable = {
  window: { from: '2026-10-01', to: '2026-10-07', dateBasis: 'business', timezone: 'Asia/Jerusalem' },
  total: 2,
  paymentMethods: ['cash', 'card'],
  zs: [
    {
      id: 'a', zNumber: 7, zType: 'shop', zTypeLabel: 'Z סניפי', origin: 'cloud', shopName: 'הרצליה', machineName: null,
      posNumber: null, tills: 'קופה 1, קופה 2', businessDate: '2026-10-06', productionDate: null, openedAt: null,
      periodEnd: null, closedAt: '2026-10-06T21:00:00Z', invoiceRange: 'קופה 1: 10000001–10000009', creditNoteRange: null,
      receiptRange: null, invoiceCount: 9, creditNoteDocuments: 0, receiptCount: 0, transactionsCount: 9, salesCount: 9,
      creditNotesCount: 0, nonSaleDocumentsCount: 0, shiftCount: 2, machineCount: 2, grossSales: '100.00', discountsTotal: '0.00',
      lineDiscountsTotal: null, promotionDiscountsTotal: null, totalSales: '100.00', totalRefunds: '0.00', netSales: '100.00',
      vatTotal: '14.53', netOfVat: '85.47', cashSales: '60.00', cardSales: '40.00', payments: { cash: '60.00', card: '40.00' },
      totalTips: '0.00', cashTips: '0.00', cardTips: '0.00', expectedCash: null, actualCash: null, discrepancy: null,
      lateDocuments: 0, amendedDocuments: 0, totalsMismatch: false, builtOffline: false, transmission: link,
    },
    {
      id: 'b', zNumber: 3, zType: 'independent', zTypeLabel: 'Z עצמאי', origin: 'till', shopName: 'הרצליה', machineName: 'קופה 5',
      posNumber: '5', tills: 'קופה 5', businessDate: '2026-10-06', productionDate: null, openedAt: null, periodEnd: null,
      closedAt: null, invoiceRange: null, creditNoteRange: null, receiptRange: null, invoiceCount: 0, creditNoteDocuments: 0,
      receiptCount: 0, transactionsCount: 1, salesCount: 1, creditNotesCount: 0, nonSaleDocumentsCount: 0, shiftCount: 1,
      machineCount: 1, grossSales: '10.00', discountsTotal: '0.00', lineDiscountsTotal: null, promotionDiscountsTotal: null,
      totalSales: '10.00', totalRefunds: '0.00', netSales: '10.00', vatTotal: '1.45', netOfVat: '8.55', cashSales: '10.00',
      cardSales: '0.00', payments: { cash: '10.00' }, totalTips: '0.00', cashTips: '0.00', cardTips: '0.00', expectedCash: null,
      actualCash: null, discrepancy: null, lateDocuments: 0, amendedDocuments: 0, totalsMismatch: true, builtOffline: false,
      transmission: { ...link, batchNumbers: [], successfulBatches: 0 },
    },
  ],
  tills: [],
};

test('the Z sheet has a column per payment method and totals the money', () => {
  const [zs, tills] = zTableSheets(table, t, (m) => `pm:${m}`);
  const headers = zs.columns.map((c) => c.header);
  assert.ok(headers.includes('pm:cash') && headers.includes('pm:card'));
  const cardIdx = headers.indexOf('pm:card');
  assert.equal(zs.rows[0][cardIdx], '40.00');
  assert.equal(zs.rows[1][cardIdx], null);
  const netIdx = headers.indexOf('netSales');
  assert.equal(zs.totals?.[netIdx], 110);
  assert.equal(zs.rows[1][headers.indexOf('notes')], 'noteMismatch');
  assert.equal(tills.name, 'sheetZTills');
});

const rec: Reconciliation = {
  window: { from: '2026-10-06', to: '2026-10-06', timezone: 'Asia/Jerusalem' },
  generatedAt: '2026-10-07T00:00:00Z',
  checks: [{ key: 'document_numbers', label: 'רציפות' }, { key: 'card_legs', label: 'אשראי' }],
  statuses: [{ key: 'match', label: 'תואם' }, { key: 'difference', label: 'הפרש' }, { key: 'missing', label: 'חסר' }, { key: 'pending', label: 'ממתין' }],
  summary: {
    documents_z: { match: 0, difference: 0, missing: 0, pending: 0 },
    z_totals: { match: 0, difference: 0, missing: 0, pending: 0 },
    document_numbers: { match: 0, difference: 0, missing: 1, pending: 0 },
    z_numbers: { match: 0, difference: 0, missing: 0, pending: 0 },
    card_legs: { match: 1, difference: 0, missing: 0, pending: 0 },
    transmissions: { match: 0, difference: 0, missing: 0, pending: 0 },
    refused_documents: { match: 0, difference: 0, missing: 0, pending: 0 },
    repaired_tills: { match: 0, difference: 0, missing: 0, pending: 0 },
    numbering_conflicts: { match: 0, difference: 0, missing: 0, pending: 0 },
    z_completeness: { match: 0, difference: 0, missing: 0, pending: 0 },
    ingest_notes: { match: 0, difference: 0, missing: 0, pending: 0 },
    cloud_card_refunds: { match: 0, difference: 0, missing: 0, pending: 0 },
  },
  totals: { match: 1, difference: 0, missing: 1, pending: 0 },
  rows: [
    {
      check: 'document_numbers', checkLabel: 'רציפות', status: 'missing', statusLabel: 'חסר', shopName: 'הרצליה', machineId: 'm',
      machineName: 'קופה 2', posNumber: '2', terminal: null, day: null, zReportId: null, zNumber: null, zType: null,
      subject: '320', expected: 18, actual: 16, difference: -2, count: 16, reason: 'חסרים 2 מספרים: 80, 82',
      container: 'משמרת של הקופה ← Z סניפי', action: { label: 'חברו את הקופה לרשת', href: '/dashboard/machines/m' },
    },
    {
      check: 'card_legs', checkLabel: 'אשראי', status: 'match', statusLabel: 'תואם', shopName: 'הרצליה', machineId: 'm',
      machineName: 'קופה 2', posNumber: '2', terminal: 'Agamento', day: '2026-10-06', zReportId: null, zNumber: null, zType: null,
      subject: 'אשראי', expected: 140000, actual: 140000, difference: 0, count: 1, reason: 'כל העסקאות שודרו',
    },
  ],
};

test('reconciliation: a summary, all rows, and a sheet per check, coloured by status', () => {
  const sheets = reconciliationSheets(rec, t);
  assert.deepEqual(sheets.map((s) => s.name), ['sheetSummary', 'sheetAllRows', 'רציפות', 'אשראי']);
  assert.deepEqual(sheets[0].rows[0], ['רציפות', 0, 0, 1, 0]);
  assert.deepEqual(sheets[1].rowFills, [statusFill('missing'), null]);
  // A numbering row's expected/actual are counts of numbers, not money.
  assert.equal(sheets[2].rows[0][10], null);
  assert.equal(sheets[3].rows[0][10], 140000);
  // Where the documents belong, and what the owner does (the link's label; none: empty).
  assert.deepEqual(sheets[2].rows[0].slice(-2), ['משמרת של הקופה ← Z סניפי', 'חברו את הקופה לרשת']);
  assert.deepEqual(sheets[3].rows[0].slice(-2), [null, null]);
});

test('status fills: missing red, difference orange, match none', () => {
  assert.equal(statusFill('match'), null);
  assert.notEqual(statusFill('missing'), statusFill('difference'));
});

const exportRow = (over: Partial<TransactionExportRow>): TransactionExportRow => ({
  id: 'a', createdAt: '2026-10-06T10:00:00Z', documentNumber: '20000057', documentType: 320, status: 'completed',
  shopName: 'הרצליה', machineId: 'm', machineName: 'קופה 1', posNumber: '1', cashierId: 'c', cashierName: 'דנה',
  paymentMethod: 'cash', totalAmount: '117.00', documentDiscount: '0.00', collected: '117.00', signedAmount: '117.00',
  vatAmount: '17.85', netOfVat: '99.15', vatRate: '18.00', tipAmount: '0.00', tipPaymentMethod: null, cash: '112.00',
  card: '0.00', other: '0.00', exchange: '0.00', productionVoucher: '5.00', legs: 2, cardBrands: [], cardLast4: [],
  approvalNumbers: [], refundOf: null, shiftNumber: 1, zNumber: null, customerName: 'אקמי בע״מ', mealKind: null, ...over,
});

test('the transactions sheet: a cell under every header, the voucher money in its own column', () => {
  const sheet = transactionsSheet([exportRow({}), exportRow({ productionVoucher: undefined, customerName: null })], t, 'x', {
    documentType: (n) => `type:${n}`, status: (s) => s, method: (m) => m,
  });
  const headers = sheet.columns.map((c) => c.header);
  // Every row and the totals line are as wide as the header row (a missing cell shifts every column after it).
  assert.ok(sheet.rows.every((r) => r.length === headers.length));
  assert.equal(sheet.totals?.length, headers.length);
  const at = (h: string) => headers.indexOf(h);
  assert.equal(sheet.rows[0][at('productionVoucher')], '5.00');
  assert.equal(sheet.rows[0][at('other')], '0.00');
  assert.equal(sheet.rows[0][at('customer')], 'אקמי בע״מ');
  assert.equal(sheet.rows[1][at('productionVoucher')], null);
});
