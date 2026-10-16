/**
 * "שוברים בלי אינטרנט" through the shop's LAN host — the till's side (pos-android data/repo/ProductionVoucherService.kt
 * `open` / `openOffline` / `redeemAt` HOST, `settle`, `giveBack`; data/repo/VoucherLanHost.kt `VoucherLanPaths`;
 * domain/OfflineVouchers.kt `offlineUsedText`; P:/specs/production-vouchers-api.md §7):
 *
 *  - a voucher batch the cloud assigned to the shop's main till (`lan_host`) is redeemed only there while assigned — the cloud
 *    refuses it everywhere else (`prepaid_voucher_assigned_offline`), and offline the cloud is not there at all; the other
 *    tills ask the host on the shop's LAN (`POST /vouchers/lookup`, `/redeem`, `/attach`, `/reverse`, the shop's print secret);
 *  - the host is the only ledger of that batch: it says whether the voucher may be taken now (used, cancelled, expired, the
 *    batch paused or its quota reached), and takes it once (`id` — the till's request id, sent again when the answer was lost);
 *  - the till prices it itself from the batch's terms as downloaded (the snapshot), as it books it — the host checks the same;
 *  - a voucher of groups only (a plain list's items are not in the host's snapshot), never a discount voucher.
 *
 * Pure.
 */

import { coverPriced, countsAsPayment, shareByWeight, type AppliedUnit, type TillVoucherUnit, type VoucherTerms } from './vouchers';

export const VOUCHER_LAN = { LOOKUP: '/vouchers/lookup', REDEEM: '/vouchers/redeem', ATTACH: '/vouchers/attach', REVERSE: '/vouchers/reverse' } as const;
/** The cloud's refusal of a voucher assigned to work without internet on another device. */
export const ASSIGNED_OFFLINE = 'prepaid_voucher_assigned_offline';

/** Android's words. */
export const VOUCHER_LAN_TEXT = {
  /** OFFLINE_NOT_ASSIGNED_TEXT: no cloud, and no host holds it. */
  notAssigned: 'אין חיבור לענן, והשובר אינו משויך לעבודה ללא אינטרנט בקופה זו — לא ניתן לממש אותו כעת. נסו שוב כשיש חיבור.',
  /** R.string.prepaid_offline: the host did not answer the redeem (twice). */
  noAnswer: 'אין חיבור לענן — השובר לא נבדק ולא מומש, כי מימוש נבדק בענן בלבד. בדקו את החיבור ונסו שוב.',
  pauseDefault: 'מימוש השוברים מושהה',
  quotaDefault: 'הגעת למכסת המימושים של ההפקה — לא ניתן לממש שוברים נוספים מסדרה זו. לבירור פנו למנהל',
} as const;

/** "השובר כבר מומש במלואו בקופה 3 בשעה 22:14 — אין יתרה" (offlineUsedText). */
export function offlineUsedText(by: string | null | undefined, hhmm: string | null | undefined): string {
  return `השובר כבר מומש במלואו${by && by.trim() ? ` ב${by.trim()}` : ''}${hhmm && hhmm.trim() ? ` בשעה ${hhmm.trim()}` : ''} — אין יתרה`;
}

const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The host's `lookup` answer: the voucher and its batch's terms (the snapshot), or why not. Null — not one. */
export interface HostLookup {
  ok: boolean;
  reason: string | null;
  voucherId: string | null;
  batchId: string | null;
  serial: number | null;
  eventName: string | null;
  snapshot: Record<string, unknown> | null;
  refusal: string | null;
  refusalText: string | null;
}

export function hostLookupOf(body: unknown): HostLookup | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.ok !== 'boolean') return null;
  return {
    ok: b.ok,
    reason: s(b.reason),
    voucherId: s(b.voucherId),
    batchId: s(b.batchId),
    serial: n(b.serial),
    eventName: s(b.eventName),
    snapshot: b.snapshot && typeof b.snapshot === 'object' ? (b.snapshot as Record<string, unknown>) : null,
    refusal: s(b.refusal),
    refusalText: s(b.refusalText),
  };
}

/**
 * The snapshot as the voucher flow reads a cloud lookup (core/till/vouchers.ts `termsOf`): its groups (`frozenIds` — the
 * products as frozen — else `productIds`; `excludeProductIds` / `excludedIds`), its pricing and accounting, its limits.
 */
export function dtoOfSnapshot(l: HostLookup): Record<string, unknown> {
  const sn = l.snapshot ?? {};
  const groups = (Array.isArray(sn.groups) ? (sn.groups as Array<Record<string, unknown>>) : []).map((g) => ({
    key: g.key,
    name: g.name,
    minQty: g.minQty,
    maxQty: g.maxQty,
    remaining: g.remaining,
    productIds: Array.isArray(g.frozenIds) ? g.frozenIds : g.productIds,
    excludedIds: Array.isArray(g.excludeProductIds) ? g.excludeProductIds : g.excludedIds,
    allowRepeat: g.allowRepeat,
  }));
  return {
    voucherId: l.voucherId,
    batchId: l.batchId,
    serial: l.serial,
    eventName: l.eventName ?? sn.eventName,
    batchName: sn.batchName,
    productionName: sn.productionName,
    typeName: sn.typeName,
    selection: 'groups',
    groups,
    pricing: sn.pricing,
    tillValueAgorot: sn.tillValueAgorot,
    redemptionAccounting: sn.redemptionAccounting,
    countsAsPayment: sn.countsAsPayment,
    totalMax: sn.totalMax,
    totalRemaining: sn.totalRemaining,
    wholeAtOnce: sn.wholeAtOnce,
    splitAllowed: sn.splitAllowed,
    includeExtras: sn.includeExtras,
    stacking: sn.stacking,
    maxVouchersPerSale: sn.maxVouchersPerSale,
    testMode: sn.isTest === true,
    validFrom: sn.validFrom,
    validUntil: sn.validUntil,
  };
}

/** A voucher the host can take: of groups (a list's items are not in its snapshot). */
export const hostTakes = (l: HostLookup): boolean => Array.isArray(l.snapshot?.groups) && (l.snapshot!.groups as unknown[]).length > 0;

/**
 * The till's own pricing of what the host takes (VoucherPricing over the snapshot): zero — ₪0; cover — each unit at its
 * price; a fixed value — the value shared by the units' prices (no more than they come to).
 */
export function localPriced(terms: Pick<VoucherTerms, 'accounting' | 'pricing' | 'tillValue' | 'groups'>, mine: readonly TillVoucherUnit[], assigned: Readonly<Record<string, string>>): AppliedUnit[] {
  const groupOf = (u: TillVoucherUnit) => {
    const key = assigned[u.id] ?? null;
    return { key, name: key ? (terms.groups.find((g) => g.key === key)?.name ?? null) : null };
  };
  if (terms.pricing !== 'fixed' || terms.tillValue === null || !countsAsPayment(terms.accounting)) return coverPriced(terms.accounting, mine, groupOf);
  const total = mine.reduce((sum, u) => sum + u.price, 0);
  const shares = shareByWeight(Math.min(terms.tillValue, total), mine.map((u) => u.price));
  return mine.map((u, i) => {
    const g = groupOf(u);
    return { unitId: u.id, lineKey: u.lineKey, groupKey: g.key, groupName: g.name, productId: u.productId, name: u.name, price: u.price, salePrice: shares[i], covered: shares[i], listValue: u.listValue, forced: false, reduction: 0 };
  });
}

/** `POST /vouchers/redeem`'s body (ProductionVoucherService.redeemAt HOST). */
export function hostRedeemBody(o: {
  code: string;
  id: string;
  saleRef: string;
  units: readonly TillVoucherUnit[];
  assigned: Readonly<Record<string, string>>;
  user: { id: string; name: string } | null;
  machineId: string | null;
  by: string | null;
}): Record<string, unknown> {
  const ids = new Set(o.units.map((u) => u.id));
  return {
    code: o.code,
    id: o.id,
    saleRef: o.saleRef,
    units: o.units.map((u) => ({
      id: u.id,
      lineId: u.lineKey,
      productIds: [u.productId],
      categoryId: u.categoryId ?? null,
      parentCategoryIds: [],
      price: u.price,
      discountable: u.discountable,
      name: u.name,
      listValue: u.listValue,
      quantity: 1,
    })),
    assigned: Object.fromEntries(Object.entries(o.assigned).filter(([k]) => ids.has(k))),
    approval: null,
    ...(o.user?.id ? { posUserId: o.user.id } : {}),
    ...(o.user?.name ? { posUserName: o.user.name } : {}),
    ...(o.machineId ? { machineId: o.machineId } : {}),
    ...(o.by ? { by: o.by } : {}),
  };
}
