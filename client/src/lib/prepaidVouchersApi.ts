/**
 * Prepaid vouchers ("שוברי הפקה", `/prepaid-vouchers`): batches of vouchers worth goods,
 * handed to an event's production team and redeemed at the tills by QR.
 *
 * Unrelated to `/vouchers` (gift-voucher templates) and to item tickets.
 */
import { api } from './api';
import type { PrepaidBatchEditPlan } from './prepaidBatchEdit';
import type { PrepaidDuplicateRef } from './prepaidBatchSubmit';
import type { BatchSort, VoucherState } from './prepaidVoucherFilters';
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
  /** "מספר שוברים מקסימלי בעסקה" (with many); null: no maximum. */
  maxVouchersPerSale?: number | null;
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
  // ── Its type (the spec's §2) and the two prices (§5), as issued ──
  type?: PrepaidTypeRef | null;
  /** The type's name as printed above the title (a manual type's; null for a batch's own). */
  typeName?: string | null;
  /** ₪ — the whole voucher's value at the till; null: the goods, whatever they cost. */
  tillValue?: number | null;
  /** ₪ — only with the `prepaid_voucher_prices` section (else null, `pricesVisible` false). */
  productionPrice?: number | null;
  pricesVisible?: boolean;
  pricing?: PrepaidPricing;
  allowTopUp?: boolean;
  /** How the till books a redemption (editable after issue; each redemption records it). */
  redemptionAccounting?: PrepaidRedemptionAccounting;
  /** "הצג תוקף על השובר" (absent: shown). */
  showValidity?: boolean;
  discountBlockPolicy?: PrepaidOverridePolicy;
  /** "מימוש ללא אינטרנט". */
  offlineAllowed?: boolean;
  printTillValue?: boolean;
  /** Issued so far (the next serial less one): "ערוך סדרה" never goes below it. */
  issuedCount?: number;
  /** The production it was made for (§13); its name is `customerName`. */
  production?: { id: string; name: string; billingBasis: PrepaidBillingBasis } | null;
  /** The event (the existing report events); `eventName` is the printed text. */
  reportEvent?: PrepaidEventRef | null;
  /** "ערוך סדרה": the production price by serial once it was changed (prices section only). */
  productionPriceHistory?: { fromSerial: number; price: number | null; at?: string | null; by?: string | null }[] | null;
  /** "items" (a fixed list) or "groups" (a package / one of several, the production vouchers contract §1). */
  selection?: 'items' | 'groups';
  groups?: PrepaidBatchGroup[] | null;
  totalQty?: number | null;
  catalogMode?: 'frozen' | 'live';
  /** The list's figures (GET /prepaid-vouchers/batches): issued, redeemed, open, the rate. */
  figures?: PrepaidBatchFigures;
  /** Every status the list filters by, at once. */
  state?: PrepaidBatchState;
  /**
   * Only on the answer of POST /prepaid-vouchers/batches: an identical batch the same user made a
   * moment ago ("נראה שאצווה זהה נוצרה לפני רגע — לבטל את הכפולה?"). A warning, never a refusal.
   */
  possibleDuplicate?: PrepaidDuplicateRef | null;
}

// ── Productions ("הפקות") and the events a batch may name (§13) ──────────────

/** By what was redeemed (the default) or by what was handed over. */
export type PrepaidBillingBasis = 'redemption' | 'delivery';

export interface PrepaidProduction {
  id: string;
  companyId: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  billingBasis: PrepaidBillingBasis;
  notes: string | null;
  active: boolean;
  batchCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PrepaidProductionBody {
  companyId?: string;
  name?: string;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  billingBasis?: PrepaidBillingBasis;
  notes?: string | null;
  active?: boolean;
}

export interface PrepaidEventRef {
  id: string;
  name: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface PrepaidEventOption extends PrepaidEventRef {
  shopId: string;
  shopName: string | null;
  status: string;
}

export async function fetchPrepaidProductions(params: { companyId?: string; includeInactive?: boolean } = {}): Promise<PrepaidProduction[]> {
  const { data } = await api.get<{ items: PrepaidProduction[] }>('/prepaid-vouchers/productions', {
    params: { companyId: params.companyId || undefined, includeInactive: params.includeInactive || undefined },
  });
  return data.items;
}

export async function createPrepaidProduction(body: PrepaidProductionBody): Promise<PrepaidProduction> {
  const { data } = await api.post<PrepaidProduction>('/prepaid-vouchers/productions', body);
  return data;
}

export async function updatePrepaidProduction(id: string, body: PrepaidProductionBody): Promise<PrepaidProduction> {
  const { data } = await api.patch<PrepaidProduction>(`/prepaid-vouchers/productions/${id}`, body);
  return data;
}

/** The events a batch may name: the report events of the shops the user sees, newest first. */
export async function fetchPrepaidEventOptions(companyId?: string): Promise<PrepaidEventOption[]> {
  const { data } = await api.get<{ items: PrepaidEventOption[] }>('/prepaid-vouchers/events', {
    params: { companyId: companyId || undefined },
  });
  return data.items;
}

// ── "מימוש ללא אינטרנט" — the batch assigned to a device (§7) ────────────────────

export interface PrepaidOfflineAssignment {
  id: string;
  batchId: string;
  target: 'machine' | 'lan_host';
  machineId: string;
  machineName: string | null;
  shopId: string | null;
  /** `releasing`: the release asked; it completes once the device acknowledges (two steps). */
  status: 'active' | 'releasing' | 'released';
  version: number;
  assignedAt: string | null;
  lastDownloadAt: string | null;
  lastSyncAt: string | null;
  /** What the device said it still had to send at its last sync. */
  lastSyncPending: number | null;
  releasedAt: string | null;
  forced: boolean;
  releaseReason: string | null;
}

export interface PrepaidOfflineTargets {
  offlineAllowed: boolean;
  shops: {
    shopId: string;
    shopName: string;
    /** The shop's main till, which serves its LAN; null when it has none. */
    lanHost: { machineId: string; name: string } | null;
    machines: { machineId: string; name: string; posNumber: string | null }[];
  }[];
}

export async function fetchPrepaidOffline(batchId: string): Promise<{ assignment: PrepaidOfflineAssignment | null; history: PrepaidOfflineAssignment[] }> {
  const { data } = await api.get(`/prepaid-vouchers/batches/${batchId}/offline`);
  return data;
}

export async function fetchPrepaidOfflineTargets(batchId: string): Promise<PrepaidOfflineTargets> {
  const { data } = await api.get<PrepaidOfflineTargets>(`/prepaid-vouchers/batches/${batchId}/offline/targets`);
  return data;
}

export async function assignPrepaidOffline(
  batchId: string, body: { target: 'machine' | 'lan_host'; machineId?: string; shopId?: string },
): Promise<PrepaidOfflineAssignment> {
  const { data } = await api.post<PrepaidOfflineAssignment>(`/prepaid-vouchers/batches/${batchId}/offline/assign`, body);
  return data;
}

/** Released once the device synced everything; `force` (with a reason) before that — audited. */
export async function releasePrepaidOffline(batchId: string, body: { force?: boolean; reason?: string }): Promise<{ assignment: PrepaidOfflineAssignment | null }> {
  const { data } = await api.post(`/prepaid-vouchers/batches/${batchId}/offline/release`, body);
  return data;
}

/** One group of a batch of groups (₪ for its value). */
export interface PrepaidBatchGroup {
  key: string;
  name: string;
  minQty: number;
  maxQty: number;
  value?: number | null;
  allowRepeat?: boolean;
  allItems?: boolean;
  productIds?: string[];
  categoryIds?: string[];
  includeSubcategories?: boolean;
  excludeProductIds?: string[];
  excludeCategoryIds?: string[];
  sortOrder?: number;
}

export interface PrepaidBatchFigures {
  issued: number;
  /** Redeemed in full or in part. */
  redeemed: number;
  fullyRedeemed: number;
  open: number;
  cancelled: number;
  /** Redeemed of the vouchers not cancelled (0–1); null: none. */
  rate: number | null;
}

export interface PrepaidBatchState {
  active: boolean;
  not_started: boolean;
  expired: boolean;
  cancelled: boolean;
  fully_redeemed: boolean;
  has_open: boolean;
}

export type PrepaidPricing = 'fixed' | 'cover';
/**
 * discount — "קיזוז מהחשבונית (כמו הנחה)" (a document deduction, the default);
 * payment — "אמצעי תשלום (חייב במע״מ)" (the production_voucher tender);
 * zero — "₪0 עם הצגת שווי" (legacy batches).
 */
export type PrepaidRedemptionAccounting = 'discount' | 'payment' | 'zero';
export const PREPAID_REDEMPTION_ACCOUNTING: PrepaidRedemptionAccounting[] = ['discount', 'payment', 'zero'];
export type PrepaidOverrideMode = 'honour' | 'auto' | 'manager';

/** Products that take no discounts (§7): honour / force automatically / with a manager. ₪ and %. */
export interface PrepaidOverridePolicy {
  mode: PrepaidOverrideMode;
  maxAmount?: number | null;
  maxPercent?: number | null;
  maxTotal?: number | null;
  scope?: { productIds: string[]; categoryIds: string[] } | null;
}
export type PrepaidTypeOrigin = 'manual' | 'batch' | 'legacy';

export interface PrepaidTypeRef {
  id: string;
  code: string | null;
  name: string | null;
  /** The version the batch was issued with, and the type's current one. */
  version: number;
  currentVersion: number | null;
  origin: PrepaidTypeOrigin | null;
}

/** "סוג שובר" — the template batches are issued from. Money in ₪. */
export interface PrepaidVoucherType extends PrepaidBatchTerms {
  id: string;
  companyId: string;
  companyName: string | null;
  code: string | null;
  name: string;
  description: string | null;
  origin: PrepaidTypeOrigin;
  active: boolean;
  version: number;
  items: PrepaidBatchItem[];
  tillValue: number | null;
  productionPrice: number | null;
  pricesVisible: boolean;
  pricing: PrepaidPricing;
  allowTopUp: boolean;
  redemptionAccounting: PrepaidRedemptionAccounting;
  showValidity: boolean;
  discountBlockPolicy: PrepaidOverridePolicy;
  offlineAllowed: boolean;
  splitAllowed: boolean;
  includeExtras: boolean;
  printTillValue: boolean;
  batchCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PrepaidTypeBody {
  companyId?: string;
  name?: string;
  code?: string | null;
  description?: string | null;
  active?: boolean;
  kind?: PrepaidVoucherKind;
  items?: { productId: string; quantity: number }[];
  tillValue?: number | null;
  productionPrice?: number | null;
  pricing?: PrepaidPricing;
  allowTopUp?: boolean;
  redemptionAccounting?: PrepaidRedemptionAccounting;
  showValidity?: boolean;
  discountBlockPolicy?: PrepaidOverridePolicy;
  offlineAllowed?: boolean;
  splitAllowed?: boolean;
  includeExtras?: boolean;
  printTillValue?: boolean;
  discountType?: PrepaidDiscountType | null;
  discountValue?: number | null;
  minPurchase?: number | null;
  maxDiscount?: number | null;
  maxUnits?: number | null;
  targets?: { productIds: string[]; categoryIds: string[] } | null;
  stacking?: PrepaidStacking;
  /** "מספר שוברים מקסימלי בעסקה" (with many); null: no maximum. */
  maxVouchersPerSale?: number | null;
  promotionPolicy?: PrepaidPromotionPolicy;
  usesPerVoucher?: number;
  maxUsesPerSale?: number;
  maxUsesPerDay?: number | null;
}

export interface PrepaidTypeEvent {
  id: string;
  action: 'create' | 'update' | 'activate' | 'deactivate';
  userName: string | null;
  createdAt: string | null;
  details: { fields?: string[]; version?: number } | null;
}

/** The types, and whether this user sees (and sets) production prices at all. */
export async function fetchPrepaidTypes(
  opts: { companyId?: string; includeInactive?: boolean; includeOneOff?: boolean } = {},
): Promise<{ items: PrepaidVoucherType[]; pricesVisible: boolean; pricesEditable: boolean; overrideEditable: boolean }> {
  const { data } = await api.get<{ items: PrepaidVoucherType[]; pricesVisible: boolean; pricesEditable: boolean; overrideEditable: boolean }>(
    '/prepaid-vouchers/types', { params: opts },
  );
  return data;
}

export async function fetchPrepaidType(id: string): Promise<PrepaidVoucherType> {
  const { data } = await api.get<PrepaidVoucherType>(`/prepaid-vouchers/types/${id}`);
  return data;
}

export async function createPrepaidType(body: PrepaidTypeBody): Promise<PrepaidVoucherType> {
  const { data } = await api.post<PrepaidVoucherType>('/prepaid-vouchers/types', body);
  return data;
}

export async function updatePrepaidType(id: string, body: PrepaidTypeBody): Promise<PrepaidVoucherType> {
  const { data } = await api.patch<PrepaidVoucherType>(`/prepaid-vouchers/types/${id}`, body);
  return data;
}

export async function fetchPrepaidTypeEvents(id: string): Promise<PrepaidTypeEvent[]> {
  const { data } = await api.get<{ items: PrepaidTypeEvent[] }>(`/prepaid-vouchers/types/${id}/events`);
  return data.items;
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
  /** The type it is issued from: what it gives, its terms and prices are the type's. */
  typeId?: string | null;
  /** Without a type: its prices (₪) and how it is priced / recorded. */
  tillValue?: number | null;
  productionPrice?: number | null;
  pricing?: PrepaidPricing;
  redemptionAccounting?: PrepaidRedemptionAccounting;
  showValidity?: boolean;
  discountBlockPolicy?: PrepaidOverridePolicy;
  offlineAllowed?: boolean;
  printTillValue?: boolean;
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
  /** The production (§13): its name becomes the batch's `customerName`. */
  productionId?: string | null;
  /** The event (a report event): the printed `eventName` defaults to its name. */
  reportEventId?: string | null;
  kind?: PrepaidVoucherKind;
  discountType?: PrepaidDiscountType | null;
  discountValue?: number | null;
  minPurchase?: number | null;
  maxDiscount?: number | null;
  maxUnits?: number | null;
  targets?: { productIds: string[]; categoryIds: string[] } | null;
  stacking?: PrepaidStacking;
  /** "מספר שוברים מקסימלי בעסקה" (with many); null: no maximum. */
  maxVouchersPerSale?: number | null;
  promotionPolicy?: PrepaidPromotionPolicy;
  usesPerVoucher?: number;
  maxUsesPerSale?: number;
  maxUsesPerDay?: number | null;
}

/** The rules of use that may change after printing (what it gives and its uses never do). */
export interface PrepaidBatchRulesUpdate {
  stacking?: PrepaidStacking;
  /** "מספר שוברים מקסימלי בעסקה" (with many); null: no maximum. */
  maxVouchersPerSale?: number | null;
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

/**
 * A new batch. `idempotencyKey` (one per form submission, lib/prepaidBatchSubmit.ts): a retry with
 * the same key gets the same batch back (200), never a second one. `timeoutMs`: past it the answer
 * counts as lost — the caller asks again with the same key.
 */
export async function createPrepaidBatch(
  body: PrepaidBatchCreate,
  opts: { idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<PrepaidVoucherBatch> {
  const { data } = await api.post<PrepaidVoucherBatch>('/prepaid-vouchers/batches', body, {
    headers: opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined,
    timeout: opts.timeoutMs,
  });
  return data;
}

/**
 * "ערוך סדרה": any setting but the codes, serials, kind and company. Absent fields stay; a null
 * clears what may be empty. `count`: the vouchers in all (more is issued, never fewer).
 * `applyToPartial`: new contents reach the partly redeemed vouchers too.
 */
export type PrepaidBatchEditBody = Partial<Omit<PrepaidBatchCreate, 'companyId' | 'typeId' | 'groupSize' | 'targets'>> &
  PrepaidBatchRulesUpdate & {
    targets?: { productIds: string[]; categoryIds: string[] } | null;
    selection?: 'items' | 'groups';
    groups?: PrepaidBatchGroup[] | null;
    totalQty?: number | null;
    catalogMode?: 'frozen' | 'live';
    applyToPartial?: boolean;
  };

export async function updatePrepaidBatch(id: string, body: PrepaidBatchEditBody): Promise<PrepaidVoucherBatch> {
  const { data } = await api.patch<PrepaidVoucherBatch>(`/prepaid-vouchers/batches/${id}`, body);
  return data;
}

/** What an edit would change and touch (each change before → after, the effects); nothing is saved. */
export async function previewPrepaidBatchEdit(id: string, body: PrepaidBatchEditBody): Promise<PrepaidBatchEditPlan> {
  const { data } = await api.post<PrepaidBatchEditPlan>(`/prepaid-vouchers/batches/${id}/edit-preview`, body);
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
  | 'create' | 'add' | 'assign_groups' | 'update' | 'cancel_batch' | 'cancel_group' | 'cancel_voucher' | 'use_flagged'
  | 'offline_assign' | 'offline_release' | 'offline_force_release';

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
  /** A staff test batch ("שוברי בדיקה"): out of the settlements and the commercial reports. */
  isTest?: boolean;
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

// ── The filter model: lists, search and the till report (server: prepaid_voucher_analytics.py) ──

/** A batch as a voucher / redemption row names it. */
export interface PrepaidBatchRef {
  id: string;
  name: string;
  eventName: string | null;
  customerName: string | null;
  typeName: string | null;
  kind: PrepaidVoucherKind;
  validFrom: string | null;
  validUntil: string | null;
  status: 'active' | 'cancelled';
  redemptionAccounting: PrepaidRedemptionAccounting | null;
}

/** A voucher in "כל השוברים" (or a batch's table): its state and its batch. */
export interface PrepaidVoucherRow extends PrepaidVoucher {
  state: VoucherState;
  batch: PrepaidBatchRef;
}

export interface PrepaidFacets {
  customers: { value: string; batches: number }[];
  events: { value: string; batches: number }[];
  types: { id: string; name: string }[];
  batches: { id: string; name: string; customerName: string | null; eventName: string | null }[];
  shops: { id: string; name: string; companyId: string }[];
  tills: { id: string; name: string | null; shopName: string | null }[];
  employees: { id: string; name: string }[];
  creators: { id: string; name: string }[];
  pricesVisible: boolean;
}

export interface PrepaidSearchResult {
  batches: PrepaidBatchRef[];
  vouchers: { id: string; serial: number; displayCode: string; state: VoucherState; batch: PrepaidBatchRef }[];
  tills: { id: string; name: string | null; shopName: string | null; redemptions: number }[];
  employees: { id: string; name: string; redemptions: number }[];
}

/** Agorot per accounting mode: a deduction, a payment, memo value — never "a discount". */
export interface PrepaidValueByMode {
  discount: number;
  payment: number;
  zero: number;
  total: number;
}

export interface PrepaidSeriesPoint {
  /** The hour (0–23) or the day (yyyy-mm-dd). */
  key: number | string;
  redemptions: number;
  vouchers: number;
  items: number;
  /** Agorot. */
  value: number;
}

export interface PrepaidTillRow {
  machineId: string | null;
  name: string | null;
  shopId: string | null;
  shopName: string | null;
  redemptions: number;
  vouchers: number;
  items: number;
  value: PrepaidValueByMode;
  flagged: number;
  /** Not recorded yet (reserve → confirm, the override audit, offline sync): null, never 0. */
  topUp: number | null;
  refusals: number | null;
  overrides: number | null;
  offlinePending: number | null;
}

export interface PrepaidTillReport {
  items: PrepaidTillRow[];
  totals: { redemptions: number; vouchers: number; items: number; value: PrepaidValueByMode };
  series: PrepaidSeriesPoint[];
  bucket: 'hour' | 'day';
  /** How many of the scope's batches were left out as staff test batches. */
  testBatchesExcluded?: number;
}

export interface PrepaidRedemptionRow {
  id: string;
  redeemedAt: string | null;
  voucherId: string;
  serial: number | null;
  displayCode: string | null;
  batch: PrepaidBatchRef;
  items: { productId: string; name: string | null; quantity: number }[];
  units: number;
  uses: number | null;
  /** Agorot, and how it was valued: the voucher's fixed value, list prices, a discount's amount. */
  value: number;
  valueBasis: 'fixed' | 'list' | 'discount';
  accounting: PrepaidRedemptionAccounting;
  machineId: string | null;
  machineName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  transactionId: string | null;
  flags: string[];
}

function withQuery(path: string, query: URLSearchParams, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams(query);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** The batch list under the filters (the server filters; the figures come with each batch). */
export async function fetchFilteredPrepaidBatches(query: URLSearchParams, sort: BatchSort = 'newest'): Promise<{ items: PrepaidVoucherBatch[]; total: number }> {
  const { data } = await api.get<{ items: PrepaidVoucherBatch[]; total: number }>(
    withQuery('/prepaid-vouchers/batches', query, { sort: sort === 'newest' ? undefined : sort }),
  );
  return { items: data.items ?? [], total: data.total ?? (data.items ?? []).length };
}

/** "כל השוברים" (or one batch's, with `batchId` in [query]), a page at a time. */
export async function fetchPrepaidVoucherRows(
  query: URLSearchParams,
  limit: number,
  offset: number,
): Promise<{ total: number; items: PrepaidVoucherRow[] }> {
  const { data } = await api.get<{ total: number; items: PrepaidVoucherRow[] }>(
    withQuery('/prepaid-vouchers/vouchers', query, { limit, offset }),
  );
  return data;
}

export async function fetchPrepaidFacets(): Promise<PrepaidFacets> {
  const { data } = await api.get<PrepaidFacets>('/prepaid-vouchers/facets');
  return data;
}

export async function searchPrepaid(q: string): Promise<PrepaidSearchResult> {
  const { data } = await api.get<PrepaidSearchResult>(withQuery('/prepaid-vouchers/search', new URLSearchParams({ q })));
  return data;
}

export async function fetchPrepaidTillReport(query: URLSearchParams, bucket: 'hour' | 'day'): Promise<PrepaidTillReport> {
  const { data } = await api.get<PrepaidTillReport>(withQuery('/prepaid-vouchers/analytics/tills', query, { bucket }));
  return data;
}

export async function fetchPrepaidRedemptions(
  query: URLSearchParams,
  limit: number,
  offset: number,
): Promise<{ total: number; items: PrepaidRedemptionRow[] }> {
  const { data } = await api.get<{ total: number; items: PrepaidRedemptionRow[] }>(
    withQuery('/prepaid-vouchers/analytics/redemptions', query, { limit, offset }),
  );
  return data;
}

