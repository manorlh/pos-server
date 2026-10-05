/**
 * The §4.3 reports (docs/ACCOUNTING_EXPORT_AND_REPORTS.md): server `app/routers/sales_reports.py`.
 * Kept out of `api.ts` so the types sit next to the calls that return them.
 */
import { api, type ReportWindowParams } from './api';
import type { ReportWindowOut } from './types';

type Params = ReportWindowParams & { cashierId?: string };

export interface PaymentMethodRow {
  day: string;
  shopId?: string | null;
  shopName?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  method: string;
  bucket: 'cash' | 'card' | 'exchange' | 'other';
  amount: number;
  documents: number;
}

export interface PaymentMethodTotal {
  method: string;
  bucket: PaymentMethodRow['bucket'];
  amount: number;
  documents: number;
  share: number;
}

export interface PaymentMethodsReport {
  window: ReportWindowOut;
  generatedAt: string;
  rows: PaymentMethodRow[];
  totals: PaymentMethodTotal[];
  total: number;
}

export interface HourlyCell {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  hour: number;
  net: number;
  documents: number;
}

export interface HourlyReport {
  window: ReportWindowOut;
  generatedAt: string;
  cells: HourlyCell[];
  byHour: { hour: number; net: number; documents: number; averageBasket: number }[];
  total: number;
  documents: number;
}

export interface DepartmentRow {
  categoryId?: string | null;
  categoryName?: string | null;
  units: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  share: number;
}

export interface DepartmentReport {
  window: ReportWindowOut;
  generatedAt: string;
  rows: DepartmentRow[];
  totals: DepartmentRow;
}

export interface SequenceRow {
  machineId: string;
  machineName?: string | null;
  shopName?: string | null;
  documentType?: number | null;
  firstNumber?: string | null;
  lastNumber?: string | null;
  documents: number;
  missing: number;
  duplicates: string[];
  nonNumeric: number;
  gaps: { fromNumber: number; toNumber: number; missing: number }[];
}

export interface DocumentSequenceReport {
  window: ReportWindowOut;
  generatedAt: string;
  rows: SequenceRow[];
  totalMissing: number;
}

export interface CashVarianceShift {
  shiftId: string;
  businessDate: string;
  shopName?: string | null;
  machineName?: string | null;
  sequenceNumber?: number | null;
  cashier?: string | null;
  openedAt: string;
  closedAt?: string | null;
  expectedCash?: number | null;
  countedCash?: number | null;
  variance?: number | null;
  unattended: boolean;
}

export interface CashVarianceCashier {
  cashier?: string | null;
  shifts: number;
  countedShifts: number;
  over: number;
  short: number;
  net: number;
}

export interface CashVarianceReport {
  window: ReportWindowOut;
  generatedAt: string;
  shifts: CashVarianceShift[];
  byCashier: CashVarianceCashier[];
  totalVariance: number;
  uncounted: number;
}

export async function fetchPaymentMethodsReport(params: Params): Promise<PaymentMethodsReport> {
  return (await api.get<PaymentMethodsReport>('/reports/payment-methods', { params })).data;
}

export async function fetchHourlyReport(params: Params): Promise<HourlyReport> {
  return (await api.get<HourlyReport>('/reports/hourly', { params })).data;
}

export async function fetchDepartmentReport(params: Params): Promise<DepartmentReport> {
  return (await api.get<DepartmentReport>('/reports/departments', { params })).data;
}

export async function fetchDocumentSequenceReport(params: Params): Promise<DocumentSequenceReport> {
  return (await api.get<DocumentSequenceReport>('/reports/document-sequence', { params })).data;
}

export async function fetchCashVarianceReport(params: Params): Promise<CashVarianceReport> {
  return (await api.get<CashVarianceReport>('/reports/cash-variance', { params })).data;
}

export interface CardBrandTotal {
  key: string;
  salesCount: number;
  salesAmount: number;
  refundsCount: number;
  refundsAmount: number;
  net: number;
  share: number;
}

/** One shop × brand (מותג) × acquirer (חברת סליקה); refunds positive. */
export interface CardBrandRow {
  shopId?: string | null;
  shopName?: string | null;
  brand: string;
  acquirer: string;
  salesCount: number;
  salesAmount: number;
  refundsCount: number;
  refundsAmount: number;
  net: number;
}

export interface CardBrandsReport {
  window: ReportWindowOut;
  generatedAt: string;
  rows: CardBrandRow[];
  byBrand: CardBrandTotal[];
  byAcquirer: CardBrandTotal[];
  salesCount: number;
  salesAmount: number;
  refundsCount: number;
  refundsAmount: number;
  net: number;
}

/** Card legs per brand (מותג) and acquirer (סולק) — `GET /reports/card-brands`. */
export async function fetchCardBrandsReport(params: Params): Promise<CardBrandsReport> {
  return (await api.get<CardBrandsReport>('/reports/card-brands', { params })).data;
}
