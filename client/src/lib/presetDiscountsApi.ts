/**
 * "מעקב הנחות קבועות" — every use of a preset discount (P:/specs/preset-discounts.md §6):
 * `GET /reports/preset-discounts` (server app/services/preset_discounts_report.py).
 *
 * One row per sale whose basket discount was a preset's (credit notes left out), newest first, at
 * most 5000 (`truncated`); the totals and the groupings always count everything.
 */
import { api, type ReportWindowParams } from './api';
import type { ReportWindowOut } from './types';

export interface PresetUseFigures {
  /** Sales with the preset. */
  count: number;
  /** What it took off (₪). */
  amount: number;
}

export interface PresetDiscountRow {
  transactionId: string;
  documentNumber: string | null;
  documentType: number | string | null;
  /** In the report's zone, ISO. */
  createdAt: string | null;
  machineId: string | null;
  tillName: string | null;
  posNumber: string | null;
  shopName: string | null;
  cashierId: string | null;
  cashierName: string | null;
  approverName: string | null;
  presetId: string | null;
  presetName: string | null;
  kind: 'percent' | 'amount';
  percent: number | null;
  amount: number;
  /** The document's total, after the discount. */
  total: number;
  /** "עבור מי": the name, and how it was given. */
  for: string | null;
  forKind: 'employee' | 'customer' | 'typed' | null;
}

export interface PresetDiscountsReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: PresetUseFigures;
  byPreset: (PresetUseFigures & { presetId: string | null; name: string | null })[];
  byPerson: (PresetUseFigures & { for: string | null })[];
  byCashier: (PresetUseFigures & { cashierId: string | null; cashierName: string | null })[];
  rows: PresetDiscountRow[];
  truncated: boolean;
}

export type PresetDiscountsParams = ReportWindowParams & {
  presetId?: string;
  cashierId?: string;
  /** A part of the "for whom" name, case-insensitive. */
  person?: string;
};

export async function fetchPresetDiscountsReport(params: PresetDiscountsParams): Promise<PresetDiscountsReport> {
  return (await api.get<PresetDiscountsReport>('/reports/preset-discounts', { params })).data;
}
