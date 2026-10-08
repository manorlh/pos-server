/**
 * Production vouchers ("שוברי הפקה") after redemption — the server's helper section
 * (pos-server app/routers/prepaid_voucher_extras.py; the contract: P:\specs\production-vouchers-api.md,
 * section H): settlement agreements and their external invoices, deliveries to the production,
 * replacement vouchers, the §15 reports, pause / quota / test batches and the simulator.
 *
 * Money is in agorot (`…Agorot`) and null without the `prepaid_voucher_prices` section. The pure
 * rules (refusal codes, ranges, quotas) are lib/prepaidVoucherExtras.ts.
 */
import { api } from './api';
import { downloadBlob } from './excelExport';
import type {
  PrepaidPricing,
  PrepaidRedemptionAccounting,
  PrepaidVoucher,
  PrepaidVoucherKind,
} from './prepaidVouchersApi';
import type { ControlScope, QuotaPeriod, ReplacementReason } from './prepaidVoucherExtras';

function withQuery(path: string, query?: URLSearchParams): string {
  const s = query ? query.toString() : '';
  return s ? `${path}?${s}` : path;
}

// ── Settlement (§14) ──────────────────────────────────────────────────────────

export type BillingBasis = 'redemption' | 'delivery';
export type CancelledPolicy = 'exclude' | 'charge';
export type ReplacementPolicy = 'free' | 'charge';
export type AgreementStatus = 'active' | 'closed';

/** Vouchers (never units) and their money — a batch's, a type's or the agreement's. */
export interface SettlementCounts {
  issued: number;
  replacements: number;
  delivered: number;
  deliveredFree: number;
  redeemed: number;
  cancelled: number;
  cancelledCharged: number;
  replacementsCharged: number;
  chargeable: number;
  redemptions: number;
  units: number;
  /** The redemptions' value at the till — shown beside the amount, never added to it. */
  tillValueAgorot: number | null;
  amountAgorot: number | null;
  invoiced: number;
  invoicedAmountAgorot: number | null;
  uninvoiced: number;
  uninvoicedAmountAgorot: number | null;
  overInvoiced: number;
}

export interface SettlementTotals extends SettlementCounts {
  /** Σ the live invoices' own amounts. */
  invoicesAmountAgorot: number | null;
  /** Invoices − the report's amount (+: invoiced more). */
  gapAgorot: number | null;
  /** Live invoices. */
  invoices: number;
}

export interface SettlementBatchRow extends SettlementCounts {
  batchId: string;
  batchName: string;
  typeId: string | null;
  typeName: string | null;
  eventName: string | null;
  productionName: string | null;
  kind: PrepaidVoucherKind | string;
  status: string;
  productionPriceAgorot: number | null;
  missingPrice: boolean;
}

export interface SettlementTypeRow extends SettlementCounts {
  typeId: string | null;
  typeName: string | null;
  batches: number;
  /** One price when every batch of the type has the same; else null. */
  productionPriceAgorot: number | null;
}

export interface SettlementInvoiceLine {
  batchId: string;
  batchName: string | null;
  quantity: number;
  unitPriceAgorot: number | null;
  amountAgorot: number | null;
}

export interface SettlementInvoice {
  id: string;
  agreementId: string;
  number: string;
  invoiceDate: string | null;
  system: string | null;
  amountAgorot: number | null;
  currency: string;
  note: string | null;
  gapNote: string | null;
  file: { name: string; type: string | null; size: number | null } | null;
  lines: SettlementInvoiceLine[];
  quantity: number;
  linesAmountAgorot: number | null;
  /** The invoice's amount − what its lines come to. */
  gapAgorot: number | null;
  voided: boolean;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

export type SettlementCorrection =
  | { kind: 'over_invoiced'; batchId: string; batchName: string; quantity: number }
  | { kind: 'cancelled_after_invoice'; batchId: string; batchName: string; voucherId: string; serial: number; cancelledAt: string | null }
  | { kind: 'invoice_voided'; invoiceId: string; number: string; voidedAt: string | null; reason: string | null };

export type SettlementWarning =
  | { kind: 'overlap'; agreementId: string; name: string; batchIds: string[] }
  | { kind: 'missing_price'; batchId: string; batchName: string };

export interface SettlementAgreementSummary {
  id: string;
  name: string;
  companyId: string;
  productionName: string | null;
  productionId?: string | null;
  eventName: string | null;
  reportEventId: string | null;
  batchIds: string[] | null;
  billingBasis: BillingBasis;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  cancelledPolicy: CancelledPolicy;
  replacementPolicy: ReplacementPolicy;
  status: AgreementStatus;
  notes: string | null;
  gapNote: string | null;
  createdAt: string | null;
  createdBy: string | null;
  pricesVisible: boolean;
  editable: boolean;
  /** The terms in words ("לפי מימוש: …"). */
  rules: string[];
  totals: SettlementTotals;
}

export interface SettlementAgreement extends SettlementAgreementSummary {
  batches: SettlementBatchRow[];
  types: SettlementTypeRow[];
  invoices: SettlementInvoice[];
  corrections: SettlementCorrection[];
  warnings: SettlementWarning[];
}

export interface AgreementBody {
  name?: string;
  companyId?: string;
  productionName?: string | null;
  eventName?: string | null;
  batchIds?: string[] | null;
  billingBasis?: BillingBasis;
  periodFrom?: string | null;
  periodTo?: string | null;
  currency?: 'ILS';
  cancelledPolicy?: CancelledPolicy;
  replacementPolicy?: ReplacementPolicy;
  notes?: string | null;
  /** PATCH only. */
  status?: AgreementStatus;
  gapNote?: string | null;
}

export interface SettlementCandidate {
  batchId: string;
  name: string;
  typeName: string | null;
  eventName: string | null;
  productionName: string | null;
  status: string;
  issued: number;
  productionPriceAgorot: number | null;
}

export async function fetchAgreements(
  opts: { companyId?: string; status?: AgreementStatus } = {},
): Promise<{ items: SettlementAgreementSummary[]; pricesVisible: boolean; editable: boolean }> {
  const { data } = await api.get<{ items: SettlementAgreementSummary[]; pricesVisible: boolean; editable: boolean }>(
    '/prepaid-vouchers/settlement/agreements',
    { params: opts },
  );
  return { items: data.items ?? [], pricesVisible: !!data.pricesVisible, editable: !!data.editable };
}

export async function fetchAgreement(id: string): Promise<SettlementAgreement> {
  const { data } = await api.get<SettlementAgreement>(`/prepaid-vouchers/settlement/agreements/${id}`);
  return data;
}

export async function createAgreement(body: AgreementBody): Promise<SettlementAgreement> {
  const { data } = await api.post<SettlementAgreement>('/prepaid-vouchers/settlement/agreements', { currency: 'ILS', ...body });
  return data;
}

export async function updateAgreement(id: string, body: AgreementBody): Promise<SettlementAgreement> {
  const { data } = await api.patch<SettlementAgreement>(`/prepaid-vouchers/settlement/agreements/${id}`, body);
  return data;
}

/** The batches an agreement with these terms would cover (the form's preview). */
export async function fetchSettlementCandidates(opts: {
  companyId: string;
  productionName?: string;
  eventName?: string;
  batchIds?: string[];
}): Promise<SettlementCandidate[]> {
  const p = new URLSearchParams({ companyId: opts.companyId });
  if (opts.productionName?.trim()) p.set('productionName', opts.productionName.trim());
  if (opts.eventName?.trim()) p.set('eventName', opts.eventName.trim());
  for (const id of opts.batchIds ?? []) p.append('batchId', id);
  const { data } = await api.get<{ items: SettlementCandidate[] }>(withQuery('/prepaid-vouchers/settlement/candidates', p));
  return data.items ?? [];
}

export interface InvoiceBody {
  number: string;
  invoiceDate: string;
  system?: string | null;
  /** ₪, as the invoice says. */
  amount: number;
  currency?: 'ILS';
  note?: string | null;
  gapNote?: string | null;
  lines: { batchId: string; quantity: number }[];
}

/** 409 `prepaid_settlement_over_invoiced:<batchId>:<left>` when a line is more than is left. Answer: the agreement. */
export async function addInvoice(agreementId: string, body: InvoiceBody): Promise<SettlementAgreement> {
  const { data } = await api.post<SettlementAgreement>(
    `/prepaid-vouchers/settlement/agreements/${agreementId}/invoices`,
    { currency: 'ILS', ...body },
  );
  return data;
}

/** Only the notes; numbers and quantities are voided and linked again, never edited. */
export async function updateInvoice(id: string, body: { note?: string | null; gapNote?: string | null }): Promise<SettlementAgreement> {
  const { data } = await api.patch<SettlementAgreement>(`/prepaid-vouchers/settlement/invoices/${id}`, body);
  return data;
}

export async function voidInvoice(id: string, reason: string): Promise<SettlementAgreement> {
  const { data } = await api.post<SettlementAgreement>(`/prepaid-vouchers/settlement/invoices/${id}/void`, { reason });
  return data;
}

/** PDF / PNG / JPEG / WEBP, ≤ 10 MB. */
export async function uploadInvoiceFile(id: string, file: File): Promise<{ ok: boolean; file: SettlementInvoice['file'] }> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.put<{ ok: boolean; file: SettlementInvoice['file'] }>(
    `/prepaid-vouchers/settlement/invoices/${id}/file`,
    form,
    // Let the browser set multipart/form-data with its own boundary.
    { headers: { 'Content-Type': undefined } },
  );
  return data;
}

export async function downloadInvoiceFile(id: string, fileName: string): Promise<void> {
  const { data } = await api.get<Blob>(`/prepaid-vouchers/settlement/invoices/${id}/file`, { responseType: 'blob' });
  downloadBlob(data, fileName || 'invoice', data.type || 'application/octet-stream');
}

// ── Deliveries ("מסירה להפקה") ────────────────────────────────────────────────

export interface Delivery {
  id: string;
  batchId: string;
  serialFrom: number;
  serialTo: number;
  count: number;
  chargeable: boolean;
  deliveredAt: string | null;
  recipient: string | null;
  note: string | null;
  userName: string | null;
  createdAt: string | null;
  voided: boolean;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface BatchDeliveries {
  batchId: string;
  lastSerial: number;
  delivered: number;
  deliveredFree: number;
  undelivered: { from: number; to: number }[];
  replacementSerials: number[];
  items: Delivery[];
}

export async function fetchDeliveries(batchId: string): Promise<BatchDeliveries> {
  const { data } = await api.get<BatchDeliveries>(`/prepaid-vouchers/batches/${batchId}/deliveries`);
  return data;
}

export async function addDelivery(
  batchId: string,
  body: { serialFrom: number; serialTo: number; deliveredAt?: string | null; recipient?: string | null; note?: string | null; chargeable: boolean },
): Promise<BatchDeliveries> {
  const { data } = await api.post<BatchDeliveries>(`/prepaid-vouchers/batches/${batchId}/deliveries`, body);
  return data;
}

export async function voidDelivery(id: string, reason: string): Promise<BatchDeliveries> {
  const { data } = await api.post<BatchDeliveries>(`/prepaid-vouchers/deliveries/${id}/void`, { reason });
  return data;
}

// ── Replacement (§16) ─────────────────────────────────────────────────────────

export interface Replacement {
  id: string;
  batchId: string;
  batchName?: string | null;
  originalId: string;
  originalSerial: number | null;
  replacementId: string;
  replacementSerial: number | null;
  replacementStatus?: string | null;
  reasonKind: ReplacementReason | string;
  reasonText: string | null;
  reason: string | null;
  originalStatus: string | null;
  userName: string | null;
  createdAt: string | null;
}

export interface ReplaceResult {
  replacement: Replacement;
  original: PrepaidVoucher;
  /** The new voucher, with its code. */
  voucher: PrepaidVoucher;
}

export async function replaceVoucher(
  voucherId: string,
  body: { reasonKind: ReplacementReason; reason: string; force?: boolean },
): Promise<ReplaceResult> {
  const { data } = await api.post<ReplaceResult>(`/prepaid-vouchers/vouchers/${voucherId}/replace`, body);
  return data;
}

export async function fetchReplacements(query?: URLSearchParams): Promise<{ items: Replacement[]; editable: boolean }> {
  const { data } = await api.get<{ items: Replacement[]; editable: boolean }>(withQuery('/prepaid-vouchers/replacements', query));
  return { items: data.items ?? [], editable: !!data.editable };
}

// ── Reports (§15), on the vouchers' filter model ─────────────────────────────

export interface SettlementReport {
  pricesVisible: boolean;
  items: SettlementAgreementSummary[];
  totals: {
    chargeable: number;
    amountAgorot: number | null;
    invoicesAmountAgorot: number | null;
    uninvoiced: number;
    uninvoicedAmountAgorot: number | null;
  };
  /** Batches under the filters no active agreement covers. */
  unassigned: {
    batchId: string;
    name: string;
    typeName: string | null;
    productionName: string | null;
    eventName: string | null;
    issued: number;
    used: number;
    productionPriceAgorot: number | null;
  }[];
}

export interface ExceptionRow {
  at: string | null;
  kind: string;
  kindText: string;
  batchId: string;
  batchName: string | null;
  typeName: string | null;
  voucherId: string | null;
  serial: number | null;
  machineId?: string | null;
  machineName?: string | null;
  employeeName?: string | null;
  transactionId?: string | null;
  redemptionId?: string | null;
  test: boolean;
  reason?: string | null;
  userName?: string | null;
  count?: number | null;
  groupNo?: number | null;
  replacementSerial?: number | null;
  productName?: string | null;
  reductionAgorot?: number | null;
  approvedBy?: string | null;
}

export interface ExceptionsReport {
  items: ExceptionRow[];
  counts: Record<string, number>;
  total: number;
  kinds: Record<string, string>;
  overridesRecorded?: boolean;
}

export interface OverrideRow {
  at: string | null;
  batchId: string;
  batchName: string | null;
  typeName: string | null;
  typeVersion: number | null;
  voucherId: string | null;
  productId: string | null;
  productName: string | null;
  categoryName: string | null;
  listPriceAgorot: number | null;
  valueAgorot: number | null;
  reductionAgorot: number | null;
  reductionBp: number | null;
  policy: string | null;
  preset: boolean;
  approvedBy: string | null;
  employeeName: string | null;
  machineId: string | null;
  machineName?: string | null;
  transactionId: string | null;
}

export interface OverridesReport {
  recorded: boolean;
  items: OverrideRow[];
  totals: { units?: number; reductionAgorot?: number; preset?: number; approved?: number };
}

export interface CatalogRow {
  batchId: string;
  batchName: string;
  typeName: string | null;
  kind: string;
  catalogMode: 'live' | 'frozen' | string;
  policyMode: string | null;
  role: 'item' | 'target_product' | 'target_category' | string;
  productId?: string;
  productName?: string | null;
  nameNow?: string | null;
  categoryId?: string;
  categoryName?: string | null;
  quantity?: number | null;
  /** ₪ — the product's price now. */
  priceNow?: number | null;
  noDiscount?: boolean | null;
  usable: boolean;
  blockReason: string | null;
  notes: string[];
  overrideApplies?: boolean;
}

export interface CatalogReport {
  batches: {
    batchId: string;
    batchName: string;
    typeName: string | null;
    kind: string;
    status: string;
    pricing: string | null;
    test: boolean;
    catalogMode: string;
  }[];
  rows: CatalogRow[];
  totals: { batches: number; entries: number; blocked: number; noDiscount: number };
}

export async function fetchSettlementReport(query: URLSearchParams): Promise<SettlementReport> {
  const { data } = await api.get<SettlementReport>(withQuery('/prepaid-vouchers/reports/settlement', query));
  return { ...data, items: data.items ?? [], unassigned: data.unassigned ?? [] };
}

export async function fetchExceptionsReport(query: URLSearchParams): Promise<ExceptionsReport> {
  const { data } = await api.get<ExceptionsReport>(withQuery('/prepaid-vouchers/reports/exceptions', query));
  return { ...data, items: data.items ?? [], counts: data.counts ?? {}, kinds: data.kinds ?? {} };
}

export async function fetchOverridesReport(query: URLSearchParams): Promise<OverridesReport> {
  const { data } = await api.get<OverridesReport>(withQuery('/prepaid-vouchers/reports/overrides', query));
  return { ...data, items: data.items ?? [], totals: data.totals ?? {} };
}

export async function fetchCatalogReport(query: URLSearchParams): Promise<CatalogReport> {
  const { data } = await api.get<CatalogReport>(withQuery('/prepaid-vouchers/reports/catalog', query));
  return { ...data, batches: data.batches ?? [], rows: data.rows ?? [] };
}

// ── Controls (§18) ────────────────────────────────────────────────────────────

export interface Pause {
  id: string;
  scopeKind: ControlScope;
  scopeValue: string;
  scopeLabel: string;
  companyId: string | null;
  reason: string;
  until: string | null;
  active: boolean;
  /** As the till says it ("מימוש השוברים מושהה עד …"). */
  text: string;
  createdAt: string | null;
  createdBy: string | null;
  resumedAt: string | null;
  resumedBy: string | null;
  resumeNote: string | null;
  /** May this user resume it (the server's rules: what they could have made). */
  editable?: boolean;
}

export interface Quota {
  id: string;
  scopeKind: ControlScope;
  scopeValue: string;
  scopeLabel: string;
  companyId: string | null;
  maxRedemptions: number;
  period: QuotaPeriod;
  periodFrom: string | null;
  periodTo: string | null;
  warnPercent: number;
  active: boolean;
  note: string | null;
  /** Null while inactive. */
  used: number | null;
  percent: number | null;
  reached: boolean;
  warning: boolean;
  text: string;
  createdAt: string | null;
  createdBy: string | null;
  /** May this user change it (the server's rules). */
  editable?: boolean;
}

export interface TestBatch {
  batchId: string;
  name: string;
  typeName: string | null;
  status: string;
  issued: number;
  used: number;
  note: string | null;
  createdAt: string | null;
  createdBy: string | null;
  /** Something real happened to it (a redemption, delivery or invoice): it cannot be unmarked. */
  redeemed: boolean;
}

export interface ControlEvent {
  id: string;
  action: string;
  refId: string | null;
  batchId: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  userName: string | null;
  at: string | null;
}

export async function fetchPauses(active = false): Promise<{ items: Pause[]; editable: boolean }> {
  const { data } = await api.get<{ items: Pause[]; editable: boolean }>('/prepaid-vouchers/controls/pauses', {
    params: active ? { active: true } : undefined,
  });
  return { items: data.items ?? [], editable: !!data.editable };
}

export async function createPause(body: {
  scopeKind: ControlScope;
  scopeValue: string;
  companyId?: string | null;
  reason: string;
  until?: string | null;
}): Promise<Pause> {
  const { data } = await api.post<Pause>('/prepaid-vouchers/controls/pauses', body);
  return data;
}

export async function resumePause(id: string, note?: string | null): Promise<Pause> {
  const { data } = await api.post<Pause>(`/prepaid-vouchers/controls/pauses/${id}/resume`, { note: note?.trim() || null });
  return data;
}

export async function fetchQuotas(): Promise<{ items: Quota[]; editable: boolean }> {
  const { data } = await api.get<{ items: Quota[]; editable: boolean }>('/prepaid-vouchers/controls/quotas');
  return { items: data.items ?? [], editable: !!data.editable };
}

export async function createQuota(body: {
  scopeKind: ControlScope;
  scopeValue: string;
  companyId?: string | null;
  maxRedemptions: number;
  period: QuotaPeriod;
  periodFrom?: string | null;
  periodTo?: string | null;
  warnPercent: number;
  note?: string | null;
}): Promise<Quota> {
  const { data } = await api.post<Quota>('/prepaid-vouchers/controls/quotas', body);
  return data;
}

export async function updateQuota(
  id: string,
  body: { maxRedemptions?: number; warnPercent?: number; periodFrom?: string | null; periodTo?: string | null; active?: boolean; note?: string | null; reason?: string | null },
): Promise<Quota> {
  const { data } = await api.patch<Quota>(`/prepaid-vouchers/controls/quotas/${id}`, body);
  return data;
}

export async function fetchTestBatches(): Promise<{ items: TestBatch[]; editable: boolean; label: string }> {
  const { data } = await api.get<{ items: TestBatch[]; editable: boolean; label: string }>('/prepaid-vouchers/controls/test-batches');
  return { items: data.items ?? [], editable: !!data.editable, label: data.label };
}

/** 409 `prepaid_voucher_test_has_history` / `prepaid_voucher_already_test`. */
export async function markTestBatch(batchId: string, note?: string | null): Promise<{ items: TestBatch[]; editable: boolean }> {
  const { data } = await api.post<{ items: TestBatch[]; editable: boolean }>(
    `/prepaid-vouchers/controls/test-batches/${batchId}`,
    { note: note?.trim() || null },
  );
  return data;
}

export async function unmarkTestBatch(batchId: string): Promise<{ items: TestBatch[]; editable: boolean }> {
  const { data } = await api.delete<{ items: TestBatch[]; editable: boolean }>(`/prepaid-vouchers/controls/test-batches/${batchId}`);
  return data;
}

export async function fetchControlEvents(opts: { batchId?: string; limit?: number } = {}): Promise<ControlEvent[]> {
  const { data } = await api.get<{ items: ControlEvent[] }>('/prepaid-vouchers/controls/events', { params: opts });
  return data.items ?? [];
}

// ── Simulator (§18.1) — read-only ─────────────────────────────────────────────

export interface SimulateBody {
  typeId?: string | null;
  batchId?: string | null;
  shopId?: string | null;
  machineId?: string | null;
  approved: boolean;
  lines: { productId: string; quantity: number; price: number | null; promotion?: number | null }[];
}

export type SimUnitStatus = 'assigned' | 'not_eligible' | 'group_full' | 'total_full' | 'ambiguous' | 'unusable' | 'skipped' | 'none' | string;

export interface SimUnit {
  ref: string;
  productId: string;
  productName: string;
  quantity: number;
  listPriceAgorot: number;
  noDiscount?: boolean;
  status: SimUnitStatus;
  statusText?: string | null;
  groupKey?: string | null;
  groupName?: string | null;
  reason?: string | null;
  valueAgorot?: number | null;
  coveredAgorot?: number | null;
  reductionAgorot?: number | null;
  forced?: boolean;
  /** A discount kind: what the line takes off. */
  deductionAgorot?: number | null;
}

export interface SimulateResult {
  source: 'type' | 'batch';
  id: string;
  name: string;
  kind: PrepaidVoucherKind | string;
  pricing: PrepaidPricing | string;
  tillValueAgorot: number | null;
  allowTopUp: boolean;
  redemptionAccounting: PrepaidRedemptionAccounting | string;
  bookingText: string | null;
  policy: string | null;
  wholeAtOnce: boolean;
  controls: { test: boolean; paused: string | null; quota: string | null } | null;
  shopId: string | null;
  ok: boolean;
  refusal: { code: string; text: string | null; groupKey?: string | null } | null;
  needsApproval?: boolean;
  note?: string | null;
  groups: { key: string; name: string | null; minQty: number; maxQty: number; taken: number }[];
  totalMax?: number | null;
  units: SimUnit[];
  totals: { listValueAgorot: number; valueAgorot?: number; coveredAgorot: number; topUpAgorot: number; reductionAgorot: number };
  document: { coveredAgorot: number; tender: string | null; deduction: string | null };
}

export async function simulateVoucher(body: SimulateBody): Promise<SimulateResult> {
  const { data } = await api.post<SimulateResult>('/prepaid-vouchers/simulate', body);
  return { ...data, units: data.units ?? [], groups: data.groups ?? [] };
}
