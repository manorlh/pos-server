/**
 * OTH ("על חשבון הבית") and club discounts ("הנחת מועדון") — `GET /reports/discounts`.
 *
 * Both are switched on per till by till parameters (`othEnabled`, `clubButtonEnabled`)
 * and reach the cloud on the sale documents: an OTH line is a sale line given free (a
 * 100% line discount with its reason, giver and approver), counted at its list price;
 * a club discount is a sale's basket discount marked `club`. Credit notes are left out.
 */
import { api, type ReportWindowParams } from './api';
import type { ReportWindowOut } from './types';

export interface OthFigures {
  /** OTH lines. */
  count: number;
  /** Units given. */
  quantity: number;
  /** At list price (unit price × quantity). */
  value: number;
  /** Sales they were on. */
  documents: number;
}

export interface ClubFigures {
  /** Sales with the discount. */
  count: number;
  amount: number;
}

export interface TillLabel {
  machineId: string | null;
  name: string | null;
  posNumber: string | null;
  shopName: string | null;
}

export interface DiscountsReport {
  window: ReportWindowOut;
  generatedAt: string;
  oth: {
    totals: OthFigures;
    byItem: (OthFigures & { productId: string | null; name: string | null })[];
    byEmployee: (OthFigures & { posUserId: string | null; name: string | null })[];
    byReason: (OthFigures & { reason: string | null })[];
    byTill: (OthFigures & TillLabel)[];
    byDay: (OthFigures & { date: string })[];
  };
  club: {
    totals: ClubFigures;
    byTill: (ClubFigures & TillLabel)[];
    byDay: (ClubFigures & { date: string })[];
  };
  /** The basket discounts by kind: the club's and the cashiers' own. */
  basketByKind: (ClubFigures & { kind: 'club' | 'manual' })[];
  /**
   * Discount vouchers ("שוברי הנחה", docs/SPEC_VOUCHER_PRODUCTION.md §7): a discount on the
   * document, never a tender. Absent from a server that predates them.
   */
  vouchers?: {
    totals: VoucherFigures;
    byBatch: (VoucherFigures & { batchId: string | null; name: string | null })[];
    byTill: (VoucherFigures & TillLabel)[];
    byDay: (VoucherFigures & { date: string })[];
  };
}

export interface VoucherFigures extends ClubFigures {
  /** Uses taken (a voucher may give several in one sale). */
  uses: number;
  /** Sales they were on. */
  documents: number;
}

export async function fetchDiscountsReport(params: ReportWindowParams): Promise<DiscountsReport> {
  return (await api.get<DiscountsReport>('/reports/discounts', { params })).data;
}
