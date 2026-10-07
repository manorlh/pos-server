/**
 * The report center's wire types (docs/SPEC_REPORTS.md) — apart from the fetchers
 * (`lib/reportCenterApi.ts`) so the pure sheet builders and their node tests can use them.
 */

// ── Transactions export ──────────────────────────────────────────────────────

export interface TransactionExportRow {
  id: string;
  createdAt: string;
  serverReceivedAt?: string | null;
  documentNumber: string;
  documentType: number | null;
  status: string;
  shopName: string | null;
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  cashierId: string | null;
  cashierName: string | null;
  paymentMethod: string | null;
  totalAmount: string;
  documentDiscount: string;
  collected: string;
  signedAmount: string;
  vatAmount: string | null;
  netOfVat: string | null;
  vatRate: string | null;
  tipAmount: string;
  tipPaymentMethod: string | null;
  cash: string;
  card: string;
  other: string;
  exchange: string;
  legs: number;
  cardBrands: string[];
  cardLast4: string[];
  approvalNumbers: string[];
  refundOf: string | null;
  shiftNumber: number | null;
  zNumber: number | null;
  customerName: string | null;
  mealKind: string | null;
}

// ── Z types and the Z table ──────────────────────────────────────────────────

export const Z_TYPES = ['shop', 'independent', 'till', 'kiosk', 'legacy'] as const;
export type ZType = (typeof Z_TYPES)[number];

export interface ZTransmissionLink {
  batchCount: number;
  successfulBatches: number;
  failedBatches: number;
  batchNumbers: string[];
  batchesAmount: string | null;
  cardLegs: number;
  transmittedLegs: number;
  untransmittedLegs: number;
  untransmittedAmount: string | null;
  zBatchOutcome?: string | null;
  zBatchNumber?: string | null;
  zBatchAmount?: string | null;
  zBatchCount?: number | null;
}

export interface ZTableRow {
  id: string;
  zNumber: number | null;
  zType: ZType;
  zTypeLabel: string;
  origin: string;
  shopName: string | null;
  shopNumber?: number | null;
  branchCode?: string | null;
  machineName: string | null;
  posNumber: string | null;
  tills: string | null;
  areaName?: string | null;
  businessDate: string | null;
  productionDate: string | null;
  openedAt: string | null;
  periodEnd: string | null;
  closedAt: string | null;
  invoiceRange: string | null;
  creditNoteRange: string | null;
  receiptRange: string | null;
  invoiceCount: number;
  creditNoteDocuments: number;
  receiptCount: number;
  transactionsCount: number | null;
  salesCount: number | null;
  creditNotesCount: number | null;
  nonSaleDocumentsCount: number | null;
  shiftCount: number | null;
  machineCount: number | null;
  grossSales: string | null;
  discountsTotal: string | null;
  lineDiscountsTotal: string | null;
  promotionDiscountsTotal: string | null;
  totalSales: string | null;
  totalRefunds: string | null;
  netSales: string | null;
  vatTotal: string | null;
  netOfVat: string | null;
  cashSales: string | null;
  cardSales: string | null;
  payments: Record<string, string>;
  totalTips: string | null;
  cashTips: string | null;
  cardTips: string | null;
  expectedCash: string | null;
  actualCash: string | null;
  discrepancy: string | null;
  lateDocuments: number;
  amendedDocuments: number;
  totalsMismatch: boolean;
  builtOffline: boolean;
  transmission: ZTransmissionLink;
}

export interface ZTableTillRow {
  zReportId: string;
  zNumber: number | null;
  zType: ZType;
  zTypeLabel: string;
  shopName: string | null;
  businessDate: string | null;
  closedAt: string | null;
  posNumber: string | null;
  machineName: string | null;
  shiftCount: number | null;
  firstShift: number | null;
  lastShift: number | null;
  invoiceFirst: string | null;
  invoiceLast: string | null;
  invoiceCount: number | null;
  creditNoteFirst: string | null;
  creditNoteLast: string | null;
  receiptFirst: string | null;
  receiptLast: string | null;
  transactionsCount: number | null;
  salesCount: number | null;
  creditNotesCount: number | null;
  grossSales: string | null;
  discountsTotal: string | null;
  totalSales: string | null;
  totalRefunds: string | null;
  netSales: string | null;
  vatTotal: string | null;
  netOfVat: string | null;
  payments: Record<string, string>;
  totalTips: string | null;
  expectedCash: string | null;
  countedCash: string | null;
  overShort: string | null;
  transmission: ZTransmissionLink;
}

export interface ZTable {
  window: { from: string | null; to: string | null; dateBasis: string; timezone: string };
  total: number;
  zs: ZTableRow[];
  tills: ZTableTillRow[];
  paymentMethods: string[];
}

// ── All in one ───────────────────────────────────────────────────────────────

export interface MoneyRow {
  documents: number;
  salesCount: number;
  refundsCount: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  averageBasket: number;
  cash: number;
  card: number;
  other: number;
  exchange: number;
  tips: number;
}

export interface AllInOneReport {
  window: { from: string; to: string; timezone: string; fromHour?: number | null; toHour?: number | null };
  generatedAt: string;
  empty: boolean;
  summary?: MoneyRow & {
    vat: number;
    netOfVat: number;
    cancelledDocuments: number;
    cancelledAmount: number;
    failedAttempts: number;
    zCount: number;
    transmissions: number;
  };
  byPaymentMethod?: { method: string; bucket: string; amount: number; documents: number; share: number }[];
  cardBrands?: { brand: string; salesCount: number; salesAmount: number; refundsCount: number; refundsAmount: number; net: number }[];
  byTill?: (MoneyRow & { machineId: string | null; machineName: string | null; posNumber: string | null; shopName: string | null; kiosk: boolean })[];
  byEmployee?: (MoneyRow & { cashierId: string | null; cashierName: string | null; workerNumber: string | null })[];
  byDay?: (MoneyRow & { day: string })[];
  byCategory?: { categoryId: string | null; categoryName: string | null; units: number; gross: number; discounts: number; refunds: number; net: number; share: number }[];
  byItem?: { productId: string | null; productName: string | null; sku: string | null; unitsSold: number; unitsRefunded: number; unitsNet: number; gross: number; discounts: number; refunds: number; net: number }[];
  itemsTruncated?: boolean;
  refunds?: {
    count: number;
    total: number;
    truncated: boolean;
    items: { id: string; createdAt: string; documentNumber: string; documentType: number | null; originalNumber: string | null; machineName: string | null; posNumber: string | null; cashierName: string | null; paymentMethod: string | null; amount: number }[];
  };
  discounts?: {
    documentDiscounts: number;
    lineDiscounts: number;
    promotionDiscounts: number;
    byKind: { kind: string; documents: number; amount: number }[];
    byTill: { machineName: string | null; posNumber: string | null; shopName: string | null; discounts: number }[];
    byEmployee: { cashierName: string | null; discounts: number }[];
  };
  tips?: {
    total: number;
    cash: number;
    card: number;
    documents: number;
    byTill: { machineName: string | null; posNumber: string | null; shopName: string | null; tips: number }[];
    byEmployee: { cashierName: string | null; tips: number }[];
  };
  vat?: {
    rows: { rate: number | null; documents: number; gross: number; vat: number; netOfVat: number; missingVat: number }[];
    totals: { documents: number; gross: number; vat: number; netOfVat: number; missingVat: number };
  };
  zs?: ZTable;
  transmissions?: {
    count: number;
    truncated: boolean;
    items: TransmissionItem[];
    byTill: TransmissionTill[];
  };
  failedPayments?: {
    summary: { count: number; totalAgorot: number; payoutCount: number; payoutTotalAgorot: number; paidLaterCount: number };
    truncated: boolean;
    items: { occurredAt: string; machineName: string | null; posNumber: string | null; employeeName: string | null; amount: number; method: string; kind: string; outcome: string; outcomeLabel: string; reason: string | null; cardBrand: string | null; cardLast4: string | null; paidLaterBy: string | null }[];
  };
  meals?: {
    staff: { count: number; before: number; discount: number; paid: number };
    managers: { count: number; before: number; discount: number; paid: number };
    byEmployee: { kind: string; employeeId: string | null; employee: string | null; count: number; before: number; discount: number; paid: number; shopName: string }[];
    meals: { transactionNumber: string; at: string; kind: string; employee: string | null; reason: string | null; approvedBy: string | null; before: number; discount: number; paid: number; shopName: string }[];
  };
  kiosks?: { byKiosk: (MoneyRow & { machineName: string | null; posNumber: string | null; shopName: string | null })[]; totals: MoneyRow };
}

export interface TransmissionItem {
  id: string;
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  receivedAt: string;
  status: string;
  statusCode: number | null;
  statusMessage: string | null;
  batchNumber: string | null;
  transactionCount: number | null;
  amount: string | null;
  error: string | null;
  terminalTransactionCount: number;
  legsMatched: number;
  assumedTransactionCount: number;
}

export interface TransmissionTill {
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  attempts: number;
  success: number;
  failed: number;
  unknown: number;
  amount: number;
  transactions: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export const RECONCILIATION_CHECKS = [
  'documents_z',
  'z_totals',
  'document_numbers',
  'z_numbers',
  'card_legs',
  'transmissions',
  'refused_documents',
  'repaired_tills',
  'numbering_conflicts',
  'z_completeness',
  'ingest_notes',
] as const;
export type ReconciliationCheck = (typeof RECONCILIATION_CHECKS)[number];
export type ReconciliationStatus = 'match' | 'difference' | 'missing' | 'pending';

export interface ReconciliationRow {
  check: ReconciliationCheck;
  checkLabel: string;
  status: ReconciliationStatus;
  statusLabel: string;
  shopName: string | null;
  machineId: string | null;
  machineName: string | null;
  posNumber: string | null;
  terminal: string | null;
  day: string | null;
  zReportId: string | null;
  zNumber: number | string | null;
  zType: string | null;
  subject: string | null;
  expected: number | null;
  actual: number | null;
  difference: number | null;
  count: number | null;
  reason: string | null;
  /** What the gap is (a stable code), e.g. `repaired_open_shift`, `waiting`, `numbering_conflict`. */
  gapType?: string | null;
  /** What the owner does about it, with a dashboard link when there is one. */
  action?: ReconciliationAction | null;
  /** Where the documents belong: the till's shift and the shop Z, or the till's own Z. */
  container?: string | null;
  transactionId?: string;
  transmissionId?: string;
  [extra: string]: unknown;
}

export interface ReconciliationAction {
  label: string;
  href: string | null;
}

export interface Reconciliation {
  window: { from: string; to: string; timezone: string };
  generatedAt: string;
  checks: { key: ReconciliationCheck; label: string }[];
  statuses: { key: ReconciliationStatus; label: string }[];
  summary: Record<ReconciliationCheck, Record<ReconciliationStatus, number>>;
  totals: Record<ReconciliationStatus, number>;
  rows: ReconciliationRow[];
}

// ── Transmissions across tills ───────────────────────────────────────────────

export interface TransmissionsReport {
  window: { from: string; to: string; timezone: string };
  count: number;
  truncated: boolean;
  items: TransmissionItem[];
  byTill: TransmissionTill[];
  tills: {
    machineId: string;
    machineName: string | null;
    posNumber: string | null;
    trackingStartedAt: string | null;
    lastTransmissionAt: string | null;
    lastError: string | null;
    tillPendingCount: number | null;
    tillReportedAt: string | null;
    untransmittedCardLegs: number;
    untransmittedCardAmount: string | null;
  }[];
  /** "מסמך שנדחה בענן": documents of these tills the cloud refused (open ones always). */
  refusedDocuments?: RefusedDocument[];
}

export interface RefusedDocument {
  id: string;
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  documentRef: string;
  documentId: string | null;
  documentNumber: string | null;
  documentType: number | null;
  issuedAt: string | null;
  totalAmount: string | null;
  reason: string;
  attempts: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  landedAt: string | null;
}
