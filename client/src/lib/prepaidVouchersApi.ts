/**
 * Prepaid vouchers ("שוברי הפקה", `/prepaid-vouchers`): batches of vouchers worth goods,
 * handed to an event's production team and redeemed at the tills by QR.
 *
 * Unrelated to `/vouchers` (gift-voucher templates) and to item tickets.
 */
import { api } from './api';
import type {
  PrepaidDiscountType,
  PrepaidPromotionPolicy,
  PrepaidStacking,
  PrepaidVoucherKind,
} from './prepaidVoucherBenefit';
import {
  prepaidProductOf,
  type PrepaidProductBlock,
  type PrepaidProductNote,
  type PrepaidProductOption,
  type PrepaidProductPurpose,
} from './prepaidVoucherProducts';

export type { PrepaidDiscountType, PrepaidPromotionPolicy, PrepaidStacking, PrepaidVoucherKind };

export type PrepaidVoucherStatus = 'active' | 'partially_used' | 'used' | 'cancelled';

/** An item discount's products and categories (global ids) and their names as printed. */
export interface PrepaidTargets {
  productIds: string[];
  categoryIds: string[];
  names?: string[];
}

/**
 * A batch's kind and terms (docs/SPEC_VOUCHER_PRODUCTION.md §7). Money in ₪, a percent as a
 * percent (20 = 20%). Absent from a server that predates kinds: read as goods.
 */
export interface PrepaidBatchTerms {
  kind?: PrepaidVoucherKind;
  discountType?: PrepaidDiscountType | null;
  discountValue?: number | null;
  minPurchase?: number | null;
  maxDiscount?: number | null;
  maxUnits?: number | null;
  targets?: PrepaidTargets | null;
  stacking?: PrepaidStacking;
  promotionPolicy?: PrepaidPromotionPolicy;
  usesPerVoucher?: number;
  maxUsesPerSale?: number;
  maxUsesPerDay?: number | null;
  /** "₪30 הנחה על כל ההזמנה" — what the paper says; null for goods. */
  benefitText?: string | null;
}

export interface PrepaidBatchItem {
  productId: string;
  name: string;
  /** Units; a product sold by weight in its unit ("0.5" ק״ג). */
  quantity: number;
  /** Sold by weight when the batch was made (docs/SPEC_VOUCHER_PRODUCTION.md §7.14). */
  weighed?: boolean;
  unitLabel?: string | null;
  /** "2× נקניקייה" / "0.5 ק״ג זיתים" — as printed. */
  text?: string;
}

export interface PrepaidBatchStats {
  total: number;
  active: number;
  partiallyUsed: number;
  used: number;
  cancelled: number;
}

export interface PrepaidVoucherBatch extends PrepaidBatchTerms {
  id: string;
  name: string;
  eventName: string | null;
  logoUrl: string | null;
  freeText: string | null;
  validFrom: string | null;
  validUntil: string | null;
  splitAllowed: boolean;
  status: 'active' | 'cancelled';
  companyId: string;
  companyName: string | null;
  shopIds: string[] | null;
  shops: { id: string; name: string | null }[];
  items: PrepaidBatchItem[];
  stats: PrepaidBatchStats;
  createdAt: string | null;
  cancelledAt: string | null;
  /** Production in groups (docs/SPEC_VOUCHER_PRODUCTION.md): the run's group size; null: not grouped. */
  groupSize?: number | null;
  /** The highest group number issued (0: no groups). */
  groupCount?: number;
  /** Print the voucher's code under its barcode. */
  showCode?: boolean;
  /** "הצגת הפריטים על השובר": print the goods (a discount: what it gives). Absent: true. */
  showItems?: boolean;
  /** "נוצר על ידי Runner Systems" at the bottom of the voucher. Absent: true. */
  showCredit?: boolean;
  barcodeType?: PrepaidBarcodeType;
  customerName?: string | null;
  orderRef?: string | null;
  /** Goods: "כולל תוספות" — paid options and a meal's upcharges are covered too (§7.14). */
  includeExtras?: boolean;
}

/** QR (any camera / 2D imager) or a Code 128 line barcode (1D laser scanners). */
export type PrepaidBarcodeType = 'qr' | 'code128';

export interface PrepaidVoucherItem extends PrepaidBatchItem {
  remaining: number;
}

export interface PrepaidRedemptionLine {
  productId: string;
  name: string | null;
  quantity: number;
}

export interface PrepaidRedemption {
  id: string;
  redeemedAt: string | null;
  machineId: string | null;
  machineName: string | null;
  shopId: string | null;
  posUserId: string | null;
  posUserName: string | null;
  transactionId: string | null;
  items: PrepaidRedemptionLine[];
  forfeited: PrepaidRedemptionLine[];
  /** Set when the till gave it back (its payment was abandoned): the goods returned to the voucher. */
  reversedAt?: string | null;
  /** A discount voucher's use: the uses it took and the ₪ it took off the sale. */
  uses?: number | null;
  discountAmount?: number | null;
  /** What the cloud's re-check found when the sale confirmed it (late, over_use, …). */
  flags?: string[];
}

export interface PrepaidVoucher {
  id: string;
  batchId: string;
  serial: number;
  /** Its group in a run made in groups; null otherwise. */
  groupNo?: number | null;
  code: string;
  displayCode: string;
  qrPayload: string;
  status: PrepaidVoucherStatus;
  /** Free text from the dashboard; the till's lookup shows it too. */
  note?: string | null;
  items: PrepaidVoucherItem[];
  /** A discount voucher: its uses left of the batch's per-voucher uses (null for goods). */
  usesLeft?: number | null;
  usesPerVoucher?: number | null;
  firstRedeemedAt: string | null;
  lastRedeemedAt: string | null;
  cancelledAt: string | null;
  redemptions?: PrepaidRedemption[];
}

export interface PrepaidBatchCreate {
  name: string;
  companyId: string;
  shopIds: string[] | null;
  eventName: string | null;
  logoUrl: string | null;
  freeText: string | null;
  validFrom: string | null;
  validUntil: string | null;
  splitAllowed: boolean;
  /** Goods; empty for a discount kind. A fraction only for a product sold by weight. */
  items: { productId: string; quantity: number }[];
  count: number;
  /** Goods: "כולל תוספות". */
  includeExtras?: boolean;
  groupSize?: number | null;
  showCode?: boolean;
  /** "הצגת הפריטים על השובר" (default true). */
  showItems?: boolean;
  /** "נוצר על ידי Runner Systems" (default true). */
  showCredit?: boolean;
  barcodeType?: PrepaidBarcodeType;
  customerName?: string | null;
  orderRef?: string | null;
  kind?: PrepaidVoucherKind;
  discountType?: PrepaidDiscountType | null;
  discountValue?: number | null;
  minPurchase?: number | null;
  maxDiscount?: number | null;
  maxUnits?: number | null;
  targets?: { productIds: string[]; categoryIds: string[] } | null;
  stacking?: PrepaidStacking;
  promotionPolicy?: PrepaidPromotionPolicy;
  usesPerVoucher?: number;
  maxUsesPerSale?: number;
  maxUsesPerDay?: number | null;
}

/** The rules of use that may change after printing (what it gives and its uses never do). */
export interface PrepaidBatchRulesUpdate {
  stacking?: PrepaidStacking;
  promotionPolicy?: PrepaidPromotionPolicy;
  maxUsesPerSale?: number;
  /** Null clears the daily limit. */
  maxUsesPerDay?: number | null;
}

// Every product type (docs/SPEC_VOUCHER_PRODUCTION.md §7.14): the pickers' rows, and why not.
export type { PrepaidProductBlock, PrepaidProductNote, PrepaidProductOption, PrepaidProductPurpose };

export async function fetchPrepaidBatches(): Promise<PrepaidVoucherBatch[]> {
  const { data } = await api.get<{ items: PrepaidVoucherBatch[] }>('/prepaid-vouchers/batches');
  return data.items ?? [];
}

export async function fetchPrepaidBatch(id: string): Promise<PrepaidVoucherBatch> {
  const { data } = await api.get<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}`);
  return data;
}

export async function createPrepaidBatch(body: PrepaidBatchCreate): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>('/prepaid-vouchers/batches', body);
  return data;
}

export async function updatePrepaidBatch(
  id: string,
  body: Partial<Pick<
    PrepaidBatchCreate,
    | 'name' | 'eventName' | 'logoUrl' | 'freeText' | 'validFrom' | 'validUntil' | 'showCode' | 'showItems' | 'showCredit' | 'barcodeType'
    | 'customerName' | 'orderRef'
  >> & PrepaidBatchRulesUpdate,
): Promise<PrepaidVoucherBatch> {
  const { data } = await api.patch<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}`, body);
  return data;
}

/** More vouchers; a grouped batch issues them in new groups (of [groupSize], else its own size). */
export async function addPrepaidVouchers(id: string, count: number, groupSize?: number | null): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}/vouchers`, {
    count,
    ...(groupSize ? { groupSize } : {}),
  });
  return data;
}

export async function cancelPrepaidBatch(id: string, reason?: string | null): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}/cancel`, reason ? { reason } : undefined);
  return data;
}

// ── Groups (`/prepaid-vouchers/batches/{id}/groups`) ─────────────────────────

export interface PrepaidGroupRow extends PrepaidBatchStats {
  /** Null: the vouchers issued before the batch was grouped. */
  group: number | null;
  fromSerial: number;
  toSerial: number;
  /** Used + partly used. */
  redeemed: number;
}

export async function fetchPrepaidGroups(batchId: string): Promise<{ groupSize: number | null; items: PrepaidGroupRow[] }> {
  const { data } = await api.get<{ groupSize: number | null; items: PrepaidGroupRow[] }>(
    `/prepaid-vouchers/batches/${batchId}/groups`,
  );
  return data;
}

/** Split the vouchers with no group yet into groups of [groupSize]. */
export async function assignPrepaidGroups(batchId: string, groupSize: number): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${batchId}/groups`, { groupSize });
  return data;
}

/** Cancel a whole group (a lost envelope); the reason goes into the audit trail. */
export async function cancelPrepaidGroup(
  batchId: string,
  group: number,
  reason?: string | null,
): Promise<{ group: number; cancelled: number; groupStats: PrepaidGroupRow | null }> {
  const { data } = await api.post<{ group: number; cancelled: number; groupStats: PrepaidGroupRow | null }>(
    `/prepaid-vouchers/batches/${batchId}/groups/${group}/cancel`,
    reason ? { reason } : undefined,
  );
  return data;
}

export type PrepaidEventAction =
  | 'create' | 'add' | 'assign_groups' | 'update' | 'cancel_batch' | 'cancel_group' | 'cancel_voucher' | 'use_flagged';

export interface PrepaidBatchEvent {
  id: string;
  action: PrepaidEventAction;
  group: number | null;
  voucherId: string | null;
  count: number | null;
  reason: string | null;
  userName: string | null;
  details: Record<string, unknown>;
  createdAt: string | null;
}

/** The batch's audit trail, newest first. */
export async function fetchPrepaidEvents(batchId: string): Promise<PrepaidBatchEvent[]> {
  const { data } = await api.get<{ items: PrepaidBatchEvent[] }>(`/prepaid-vouchers/batches/${batchId}/events`);
  return data.items ?? [];
}

export async function fetchPrepaidVouchers(
  batchId: string,
  params: {
    status?: PrepaidVoucherStatus;
    serial?: number;
    limit?: number;
    offset?: number;
    /** One group of a run made in groups. */
    group?: number;
    /** The code under the barcode, or 4+ characters of it. */
    code?: string;
  } = {},
): Promise<{ total: number; items: PrepaidVoucher[] }> {
  const { data } = await api.get<{ total: number; items: PrepaidVoucher[] }>(
    `/prepaid-vouchers/batches/${batchId}/vouchers`,
    { params },
  );
  return data;
}

/** Every voucher of a batch, for printing / PDF (the server answers up to 5000 per page). */
export async function fetchAllPrepaidVouchers(batchId: string): Promise<PrepaidVoucher[]> {
  const out: PrepaidVoucher[] = [];
  for (let offset = 0; offset < 100_000; offset += 5000) {
    const page = await fetchPrepaidVouchers(batchId, { limit: 5000, offset });
    out.push(...page.items);
    if (page.items.length < 5000) break;
  }
  return out;
}

export async function fetchPrepaidVoucher(id: string): Promise<PrepaidVoucher> {
  const { data } = await api.get<PrepaidVoucher>(`/prepaid-vouchers/vouchers/${id}`);
  return data;
}

export async function cancelPrepaidVoucher(id: string, reason?: string | null): Promise<PrepaidVoucher> {
  const { data } = await api.post<PrepaidVoucher>(`/prepaid-vouchers/vouchers/${id}/cancel`, reason ? { reason } : undefined);
  return data;
}

/** A voucher's free-text note; blank clears it. */
export async function setPrepaidVoucherNote(id: string, note: string | null): Promise<PrepaidVoucher> {
  const { data } = await api.put<PrepaidVoucher>(`/prepaid-vouchers/vouchers/${id}/note`, { note });
  return data;
}

// ── Report (`GET /prepaid-vouchers/batches/{id}/report`) ─────────────────────

export interface PrepaidReportCounts {
  redemptions: number;
  vouchers: number;
  /** Goods: units taken. A discount batch: uses taken. */
  units: number;
  /** A discount batch: the ₪ its uses took off. */
  amount?: number;
}

export interface PrepaidReportProduct {
  productId: string;
  name: string | null;
  /** Sold by weight: every figure of the row is in [unitLabel]. */
  weighed?: boolean;
  unitLabel?: string | null;
  perVoucher: number;
  /** perVoucher × vouchers issued; = taken + forfeited + outstanding + void. */
  issued: number;
  taken: number;
  /** Given up on one-time vouchers taken in part. */
  forfeited: number;
  /** Still on live vouchers. */
  outstanding: number;
  /** Left on cancelled vouchers. */
  void: number;
}

export interface PrepaidReportGroup extends PrepaidReportCounts {
  key: string | null;
  name: string | null;
  shopName?: string | null;
}

/**
 * A batch's usage: uses (a discount batch) or units (goods) issued, used, remaining on live
 * vouchers and void on cancelled ones; the ₪ a discount batch gave (null for goods).
 */
export interface PrepaidBatchUsage {
  unit: 'uses' | 'units';
  issued: number;
  used: number;
  remaining: number;
  void: number;
  benefit: number | null;
  /** Uses the cloud's re-check flagged when their sale confirmed them. */
  flagged: number;
  /** Uses held by open sales right now. */
  held: number;
}

export interface PrepaidBatchReport {
  batchId: string;
  timezone: string;
  generatedAt: string;
  kind?: PrepaidVoucherKind;
  usage?: PrepaidBatchUsage;
  vouchers: PrepaidBatchStats;
  products: PrepaidReportProduct[];
  totals: PrepaidReportCounts;
  byHour: (PrepaidReportCounts & { hour: number })[];
  byDay: (PrepaidReportCounts & {
    date: string;
    products: { productId: string; name: string | null; quantity: number }[];
  })[];
  byShop: PrepaidReportGroup[];
  byTill: PrepaidReportGroup[];
  byEmployee: PrepaidReportGroup[];
}

export async function fetchPrepaidBatchReport(batchId: string): Promise<PrepaidBatchReport> {
  const { data } = await api.get<PrepaidBatchReport>(`/prepaid-vouchers/batches/${batchId}/report`);
  return data;
}

export async function searchPrepaidProducts(
  search: string,
  companyId: string,
  opts: { purpose?: PrepaidProductPurpose; shopIds?: string[] } = {},
): Promise<PrepaidProductOption[]> {
  // The cloud's own rule for what a batch of this company may carry — the save checks the same.
  // Every product comes back, each with whether it can go on and why not (§7.14).
  const { data } = await api.get<{ items: Record<string, unknown>[] }>('/prepaid-vouchers/products', {
    params: {
      companyId,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      ...(opts.shopIds?.length ? { shopIds: opts.shopIds } : {}),
    },
    // `shopIds=a&shopIds=b`, as FastAPI reads a list.
    paramsSerializer: { indexes: null },
  });
  return (data.items ?? []).map(prepaidProductOf);
}

/** A category an item discount may name (`GET /prepaid-vouchers/categories`). */
export interface PrepaidCategoryOption {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * The categories an item discount of [companyId] may name — the cloud's own rule, the one
 * the save checks (as [searchPrepaidProducts] for the products).
 */
export async function fetchPrepaidCategories(companyId: string): Promise<PrepaidCategoryOption[]> {
  const { data } = await api.get<{ items: PrepaidCategoryOption[] }>('/prepaid-vouchers/categories', {
    params: { companyId },
  });
  return data.items ?? [];
}

/**
 * The vouchers as a file drawn on the server (`GET /prepaid-vouchers/batches/{id}/file`):
 * `pdf` — one PDF (`group` narrows it to one group, opened by its cover sheet); `zip` — a PDF
 * per voucher; `groups` — a PDF per group with cover sheets, and the CSV manifest, in a ZIP;
 * `csv` — the manifest of every code. Downloaded as `fileName`.
 * Used vouchers are left out, as in printing; `voucherId` narrows it to one.
 */
export async function downloadPrepaidVouchersFile(
  batchId: string,
  opts: {
    format: 'pdf' | 'zip' | 'groups' | 'csv';
    layout: string;
    width?: number;
    height?: number;
    voucherId?: string;
    group?: number;
    fileName: string;
  },
): Promise<void> {
  const { data } = await api.get<Blob>(`/prepaid-vouchers/batches/${batchId}/file`, {
    params: {
      format: opts.format,
      layout: opts.layout,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
      ...(opts.group ? { group: opts.group } : {}),
      ...(opts.voucherId ? { voucherId: opts.voucherId, includeUsed: true } : { includeUsed: false }),
    },
    responseType: 'blob',
    timeout: 300_000,
  });
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
