/**
 * A voucher at the kiosk, scanned or typed — for the Windows kiosk (kiosk-desktop main process) and the browser
 * kiosk (lib/kioskWebService.ts), ONE copy of what they both do, as the Android kiosk's KioskPayMethodModel.redeem:
 *
 *  - "שובר אחד בעסקה / כמה שוברים בעסקה": refused before it is even looked up when the order holds a voucher that
 *    allows no other (`stackingBeforeScan`), then again with the new voucher's own terms (`stackingRefusal`, the
 *    shared rules — lib/kioskVouchers.ts);
 *  - `prepaid-vouchers/lookup`, telling the cloud what this kiosk can apply (`supportedKinds`: goods and both
 *    discount kinds — until now it said nothing, and the cloud refused every discount voucher as "לא ניתן לממש
 *    אותו בעמדה זו");
 *  - a discount voucher ("שובר הנחה", `order_discount` / `item_discount`): the rules here (what it takes off the
 *    basket, the uses it takes), then the cloud holds it for this order (`reserve`, checking the same rules again);
 *    it is a discount on the document — never a tender. It is given back (`release`) when removed or the order is
 *    left, and confirmed (`confirm`) when the sale is written;
 *  - goods ("שובר פריטים"): redeemed online against what the basket holds that earlier vouchers did not take
 *    (`redeem`, one client request id per attempt: a retry never redeems twice, `saleRef`: the order, so the cloud
 *    sees its other vouchers) — a leg of the payment: it pays the goods it covers, never the tip.
 *
 * Pure of any host: the calls go through `post` (each host's own reply type fits `VoucherReply`).
 */

import {
  SUPPORTED_VOUCHER_KINDS,
  VOUCHER_ALREADY_APPLIED,
  VOUCHER_MAX_PER_SALE,
  VOUCHER_NO_ELIGIBLE,
  VOUCHER_OTHER_NOT_STACKABLE,
  applyVoucherDiscounts,
  basketLineWire,
  discountFor,
  inSaleWire,
  isDiscountKind,
  stackingRefusal,
  stackingText,
  usesWanted,
  voucherBasketLines,
  voucherBenefitOf,
  voucherInSaleOf,
  voucherKindOf,
  voucherStackingOf,
  type AppliedDiscountVoucher,
  type StackingRefusal,
  type VoucherInSale,
  type VoucherLineIn,
  type VoucherOutcome,
} from './kioskVouchers';
import { voucherAmount, voucherForfeits, voucherTake, type VoucherItem, type VoucherLeg, type VoucherTaken, type WebOrderLine } from './kioskWebOrders';

/** What a call answered: its body, the cloud's refusal (a status and its `detail` code), or no answer at all. */
export type VoucherReply<T = unknown> =
  | { kind: 'ok'; body: T }
  | { kind: 'refused'; status: number; body: unknown; detail: string | null }
  | { kind: 'offline' };

export type VoucherPost = <T = Record<string, unknown>>(path: string, body: unknown, timeoutMs: number) => Promise<VoucherReply<T>>;

/** "יש להציג את השובר בקופה" — a staff test voucher is a till user's permission, never a kiosk's. */
export const VOUCHER_SHOW_AT_TILL = 'prepaid_kiosk_show_at_till';

/** "שובר הנחה ממומש רק בתשלום כאן בעמדה" — an order with a discount voucher is not handed to a till (the Android kiosk's kpay_voucher_discount_pay_here). */
export const DISCOUNT_PAY_HERE = 'שובר הנחה ממומש רק בתשלום כאן בעמדה. לתשלום בקופה — הסירו אותו והציגו אותו בקופה.';

/** What a voucher scanned or typed came to. */
export type VoucherResult =
  /** Goods: a leg of the payment. */
  | { kind: 'ok'; leg: VoucherLeg }
  /** A discount voucher, held in the cloud for this order. */
  | { kind: 'discount'; voucher: AppliedDiscountVoucher }
  | { kind: 'forfeit' }
  | { kind: 'no_match' }
  | { kind: 'offline' }
  /** [message]: the cloud's own Hebrew for the refusal (which till used it, when it expired), when it sent one. */
  | { kind: 'refused'; reason: string; message?: string };

export interface RedeemInput {
  code: string;
  /** The basket as priced now: each line's promotion and discount-voucher shares in (kioskWebOrders.ts WebOrderLine). */
  lines: readonly WebOrderLine[];
  /** The goods vouchers already taken for this order. */
  earlier: readonly VoucherLeg[];
  /** The discount vouchers already held for this order, in the order applied. */
  discounts: readonly AppliedDiscountVoucher[];
  forfeitRest?: boolean;
  /** One per attempt at a goods voucher: the same id returns the first answer. */
  clientRequestId: string;
  /** This order (its basket's id, one for the whole checkout): how the cloud sees the sale's other vouchers. */
  saleRef: string;
  operator: { id: string; name: string };
  newId: () => string;
  /** A goods voucher that paid nothing of the basket goes back on itself — the host keeps the reversal until the cloud answers. */
  reverse?: (redemptionId: string) => Promise<void>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The vouchers of this order as the stacking rules see them: its discount vouchers and its goods legs. */
export function vouchersInOrder(discounts: readonly AppliedDiscountVoucher[], legs: readonly Pick<VoucherLeg, 'inSale'>[]): VoucherInSale[] {
  return [...discounts.map(voucherInSaleOf), ...legs.flatMap((l) => (l.inSale ? [l.inSale] : []))];
}

/**
 * Before scanning another: the order holds a "one voucher" voucher, or as many as one of them allows
 * (VoucherSaleLimit.beforeScan) — refused without a lookup.
 */
export function stackingBeforeScan(existing: readonly VoucherInSale[]): StackingRefusal | null {
  const held = distinct(existing);
  if (held.length === 0) return null;
  if (held.some((v) => v.stacking === 'single')) return { code: VOUCHER_OTHER_NOT_STACKABLE, limit: null };
  const limits = held.map((v) => v.maxPerSale).filter((m): m is number => typeof m === 'number' && m > 0);
  const max = limits.length > 0 ? Math.min(...limits) : null;
  if (max !== null && held.length >= max) return { code: VOUCHER_MAX_PER_SALE, limit: max };
  return null;
}

function distinct(list: readonly VoucherInSale[]): VoucherInSale[] {
  const seen = new Set<string>();
  return list.filter((v) => (seen.has(v.voucherId) ? false : (seen.add(v.voucherId), true)));
}

/** A refusal the rules made, in the voucher result's shape (their own words where the cloud has them). */
const stackingRefused = (r: StackingRefusal): VoucherResult => {
  const message = stackingText(r.code, r.limit);
  return message ? { kind: 'refused', reason: r.code, message } : { kind: 'refused', reason: r.code };
};

/** A basket line as the voucher rules read it (kioskWebOrders.ts WebOrderLine → kioskVouchers.ts VoucherLineIn). */
export function voucherLineOf(l: WebOrderLine): VoucherLineIn {
  const gross = Math.round(l.qty * l.unitAgorot);
  return {
    id: l.key,
    productIds: [l.productId],
    categoryId: l.categoryId,
    qty: l.qty,
    grossAgorot: gross,
    // What the promotions took before any voucher: what is left on the line, and what gave way to one.
    promotionAgorot: Math.max(0, l.promotionAgorot ?? 0) + Math.max(0, l.promotionYieldedAgorot ?? 0),
    promotionId: l.promotionId ?? null,
    noDiscount: l.noDiscount === true,
  };
}

/** The lookup's refusal (a 404, an answer that says "not redeemable"), in the voucher result's shape. */
function lookupRefusal(dto: Record<string, unknown>): VoucherResult {
  const reason = typeof dto.reason === 'string' ? dto.reason : typeof dto.status === 'string' ? `prepaid_voucher_${dto.status}` : 'not_redeemable';
  // A voucher whose terms need a till that books them (a deduction, a fixed value, a forced discount —
  // pos-server production-vouchers contract §2 `features`): this kiosk books nothing itself, so the
  // customer is sent to the till; the cloud's words ("update the till") are the cashier's, not theirs.
  const message = reason !== 'prepaid_voucher_update_required' && typeof dto.message === 'string' && dto.message ? dto.message : undefined;
  return message ? { kind: 'refused', reason, message } : { kind: 'refused', reason };
}

/**
 * A voucher scanned or typed: looked up, then — by what it is — held as a discount on the order or redeemed online
 * as a leg of the payment.
 */
export async function redeemVoucherCode(post: VoucherPost, input: RedeemInput): Promise<VoucherResult> {
  const inOrder = vouchersInOrder(input.discounts, input.earlier);
  const early = stackingBeforeScan(inOrder);
  if (early) return stackingRefused(early);

  const looked = await post<Record<string, unknown>>('prepaid-vouchers/lookup', { code: input.code, supportedKinds: [...SUPPORTED_VOUCHER_KINDS] }, 12_000);
  if (looked.kind === 'offline') return { kind: 'offline' };
  if (looked.kind === 'refused') return { kind: 'refused', reason: looked.detail ?? (looked.status === 404 ? 'prepaid_voucher_not_found' : `http_${looked.status}`) };
  const dto = looked.body ?? {};
  const kind = voucherKindOf(dto.kind);
  const incoming: VoucherInSale = {
    voucherId: str(dto.voucherId) || str(dto.id),
    batchId: str(dto.batchId),
    kind,
    stacking: voucherStackingOf(dto.stacking),
    maxPerSale: num(dto.maxVouchersPerSale),
  };
  return isDiscountKind(kind) ? applyDiscount(post, input, dto, incoming, inOrder) : redeemGoods(post, input, dto, incoming, inOrder);
}

/* --------------------------------------------------------------- discount vouchers */

async function applyDiscount(post: VoucherPost, input: RedeemInput, dto: Record<string, unknown>, incoming: VoucherInSale, inOrder: VoucherInSale[]): Promise<VoucherResult> {
  // Scanned again: on this order already (held for it — not "in another sale").
  if (input.discounts.some((v) => v.voucherId === incoming.voucherId)) return { kind: 'refused', reason: VOUCHER_ALREADY_APPLIED };
  if (dto.redeemable === false) return lookupRefusal(dto);
  const benefit = voucherBenefitOf(dto.benefit, dto.kind);
  if (!benefit) return { kind: 'refused', reason: VOUCHER_NO_ELIGIBLE };
  const refusal = stackingRefusal(inOrder, incoming);
  if (refusal) return stackingRefused(refusal);
  // The basket the rules see: what the promotions took, and what the vouchers already on the order took.
  const lines = input.lines.map(voucherLineOf);
  const now = applyVoucherDiscounts(lines, input.discounts).lines;
  const basket = voucherBasketLines(lines, now);
  const allowed = [num(dto.maxUsesPerSale), num(dto.usesAvailable), num(dto.usesToday)].filter((n): n is number => n !== null).reduce<number | null>((m, n) => (m === null ? n : Math.min(m, n)), null) ?? 1;
  const uses = usesWanted(benefit, basket, allowed);
  const taken = discountFor(benefit, basket, uses);
  if (taken.refusal) return { kind: 'refused', reason: taken.refusal };
  const clientRequestId = input.newId();
  const r = await post<Record<string, unknown>>(
    'prepaid-vouchers/reserve',
    {
      code: input.code,
      clientRequestId,
      saleRef: input.saleRef,
      uses,
      supportedKinds: [...SUPPORTED_VOUCHER_KINDS],
      lines: basket.map(basketLineWire),
      otherVouchers: inOrder.map(inSaleWire),
      posUserId: input.operator.id,
      posUserName: input.operator.name,
    },
    15_000,
  );
  if (r.kind === 'offline') return { kind: 'offline' };
  if (r.kind === 'refused') return { kind: 'refused', reason: r.detail ?? (r.status === 404 ? 'prepaid_voucher_not_found' : `http_${r.status}`) };
  const body = r.body ?? {};
  const reservationId = str(body.reservationId);
  if (!reservationId) return { kind: 'refused', reason: 'bad_answer' };
  return {
    kind: 'discount',
    voucher: {
      reservationId,
      clientRequestId,
      voucherId: incoming.voucherId,
      code: input.code,
      serial: num(dto.serial) ?? 0,
      batchId: incoming.batchId,
      batchName: (str(dto.eventName).trim() ? str(dto.eventName) : str(dto.batchName)) || '',
      stacking: incoming.stacking,
      benefit,
      uses: Math.max(1, Math.trunc(num(body.uses) ?? uses)),
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    },
  };
}

/** Give a held discount voucher back — removed from the order, or the order left. Retried; idempotent in the cloud. */
export async function releaseDiscount(post: VoucherPost, voucher: Pick<AppliedDiscountVoucher, 'reservationId'>, sleep: Sleep = defaultSleep): Promise<boolean> {
  return retrying(() => post(`prepaid-vouchers/reservations/${encodeURIComponent(voucher.reservationId)}/release`, {}, 12_000), sleep);
}

/** The sale was written: this voucher's uses taken, with the document and what it took off. Retried; idempotent. */
export async function confirmDiscount(
  post: VoucherPost,
  voucher: Pick<AppliedDiscountVoucher, 'reservationId' | 'uses'>,
  sale: { transactionId: string; amountAgorot: number },
  sleep: Sleep = defaultSleep,
): Promise<boolean> {
  return retrying(
    () => post(`prepaid-vouchers/reservations/${encodeURIComponent(voucher.reservationId)}/confirm`, { transactionId: sale.transactionId, amountAgorot: sale.amountAgorot, uses: voucher.uses }, 12_000),
    sleep,
  );
}

/**
 * The sale [transactionId] was written with these vouchers (PrepaidVoucherRepository.settleSale): each one that took
 * something off is confirmed (its uses taken), each that took nothing is released. The document itself confirms them in
 * the cloud as well, through the outbox, if this never lands.
 */
export async function settleDiscounts(post: VoucherPost, outcomes: readonly VoucherOutcome[], transactionId: string, sleep: Sleep = defaultSleep): Promise<void> {
  for (const o of outcomes) {
    if (o.amountAgorot > 0) await confirmDiscount(post, o.voucher, { transactionId, amountAgorot: o.amountAgorot }, sleep);
    else await releaseDiscount(post, o.voucher, sleep);
  }
}

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Three tries, a second more between each; a refusal is the cloud's answer (released already, another document): nothing to retry. */
async function retrying(call: () => Promise<VoucherReply<unknown>>, sleep: Sleep): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await call();
    if (r.kind === 'ok') return true;
    if (r.kind === 'refused') return false;
    if (attempt < 2) await sleep(1_000 * (attempt + 1));
  }
  return false;
}

/* ---------------------------------------------------------------------- goods */

async function redeemGoods(post: VoucherPost, input: RedeemInput, dto: Record<string, unknown>, incoming: VoucherInSale, inOrder: VoucherInSale[]): Promise<VoucherResult> {
  if (dto.redeemable === false) return lookupRefusal(dto);
  // A staff test voucher ("שובר בדיקה"): a till user's permission, never a kiosk's.
  if (dto.isTest === true) return { kind: 'refused', reason: VOUCHER_SHOW_AT_TILL };
  // The order's other vouchers first: the batch's stacking (the cloud checks too).
  const refusal = stackingRefusal(inOrder, incoming);
  if (refusal) return stackingRefused(refusal);
  const items: VoucherItem[] = (Array.isArray(dto.items) ? (dto.items as Array<Record<string, unknown>>) : [])
    .filter((it) => typeof it.productId === 'string')
    .map((it) => ({
      productId: String(it.productId),
      tillProductId: typeof it.tillProductId === 'string' ? it.tillProductId : null,
      name: String(it.name ?? ''),
      quantity: Number(it.quantity) || 0,
      remaining: Number(it.remaining) || 0,
    }));
  const take = voucherTake(items, input.lines, input.earlier);
  if (take.size === 0) return { kind: 'no_match' };
  if (!input.forfeitRest && voucherForfeits(dto.splitAllowed === true, items, take)) return { kind: 'forfeit' };
  const r = await post<Record<string, unknown>>(
    'prepaid-vouchers/redeem',
    {
      code: input.code,
      items: [...take.entries()].map(([productId, quantity]) => ({ productId, quantity })),
      clientRequestId: input.clientRequestId,
      forfeitRest: input.forfeitRest === true,
      posUserId: input.operator.id,
      posUserName: input.operator.name,
      saleRef: input.saleRef,
    },
    15_000,
  );
  if (r.kind === 'offline') return { kind: 'offline' };
  if (r.kind === 'refused') return { kind: 'refused', reason: r.detail ?? `http_${r.status}` };
  const res = r.body ?? {};
  const redemptionId = typeof res.redemptionId === 'string' ? res.redemptionId : null;
  if (!redemptionId) return { kind: 'refused', reason: 'bad_answer' };
  const redeemed: VoucherTaken[] = (Array.isArray(res.redeemed) ? (res.redeemed as Array<Record<string, unknown>>) : [])
    .filter((x) => typeof x.productId === 'string')
    .map((x) => ({ productId: String(x.productId), tillProductId: typeof x.tillProductId === 'string' ? x.tillProductId : null, name: typeof x.name === 'string' ? x.name : null, quantity: Number(x.quantity) || 0 }));
  const voucher = (res.voucher ?? dto) as { serial?: unknown; eventName?: unknown; includeExtras?: unknown; stacking?: unknown; maxVouchersPerSale?: unknown };
  const includeExtras = voucher.includeExtras === true;
  const amount = voucherAmount([...input.lines], [...input.earlier], redeemed, includeExtras);
  if (amount <= 0) {
    // Nothing of the basket it could pay: never kept for nothing.
    await (input.reverse ? input.reverse(redemptionId) : post(`prepaid-vouchers/redemptions/${encodeURIComponent(redemptionId)}/reverse`, {}, 12_000).then(() => undefined));
    return { kind: 'no_match' };
  }
  return {
    kind: 'ok',
    leg: {
      redemptionId,
      serial: typeof voucher.serial === 'number' ? voucher.serial : 0,
      amountAgorot: amount,
      eventName: typeof voucher.eventName === 'string' ? voucher.eventName : null,
      redeemed,
      includeExtras,
      inSale: { ...incoming, stacking: voucherStackingOf(voucher.stacking ?? dto.stacking), maxPerSale: num(voucher.maxVouchersPerSale) ?? incoming.maxPerSale ?? null },
    },
  };
}

/* ---------------------------------------------------- the vouchers of a payment */

/**
 * The vouchers of an order as a payment takes them ("לתשלום"): the goods ones as legs (what each paid is worked out
 * again from the basket the service prices — the Android payment's own recount), the discount ones as held for it.
 * Read field by field (the browser kiosk's bridge sends them over HTTP): anything that is not one is no voucher.
 */
export interface StartVouchers {
  legs: VoucherLeg[];
  discounts: AppliedDiscountVoucher[];
  /** The order's id (one for the whole checkout). */
  saleRef: string;
}

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max ? v : null;
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v : null);
const textList = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    const t = text(x, 100);
    if (t === null) return null;
    out.push(t);
  }
  return out;
};

export function startVouchersOf(raw: unknown): StartVouchers | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const saleRef = text(o.saleRef, 100);
  if (!saleRef || !Array.isArray(o.legs) || !Array.isArray(o.discounts) || o.legs.length > 20 || o.discounts.length > 20) return null;
  const legs: VoucherLeg[] = [];
  for (const x of o.legs as Array<Record<string, unknown>>) {
    const redemptionId = text(x?.redemptionId, 100);
    const serial = int(x?.serial, 0, 1e9);
    const amount = int(x?.amountAgorot, 0, 1e9);
    if (!redemptionId || serial === null || amount === null || !Array.isArray(x.redeemed) || x.redeemed.length > 100) return null;
    const redeemed: VoucherTaken[] = [];
    for (const r of x.redeemed as Array<Record<string, unknown>>) {
      const productId = text(r?.productId, 100);
      const quantity = typeof r?.quantity === 'number' && Number.isFinite(r.quantity) && r.quantity > 0 && r.quantity <= 1e6 ? r.quantity : null;
      if (!productId || quantity === null) return null;
      redeemed.push({ productId, tillProductId: text(r.tillProductId, 100), name: text(r.name, 255), quantity });
    }
    const inSale = x.inSale && typeof x.inSale === 'object' ? (x.inSale as Record<string, unknown>) : null;
    legs.push({
      redemptionId,
      serial,
      amountAgorot: amount,
      eventName: text(x.eventName, 255),
      redeemed,
      includeExtras: x.includeExtras === true,
      ...(inSale && text(inSale.voucherId, 100)
        ? { inSale: { voucherId: String(inSale.voucherId), batchId: text(inSale.batchId, 100) ?? '', kind: voucherKindOf(inSale.kind), stacking: voucherStackingOf(inSale.stacking), maxPerSale: int(inSale.maxPerSale, 1, 1000) } }
        : {}),
    });
  }
  const discounts: AppliedDiscountVoucher[] = [];
  for (const x of o.discounts as Array<Record<string, unknown>>) {
    const reservationId = text(x?.reservationId, 100);
    const voucherId = text(x?.voucherId, 100);
    const uses = int(x?.uses, 1, 1000);
    const serial = int(x?.serial, 0, 1e9);
    // The benefit as this kiosk holds it (`minPurchase`, `maxDiscount`), as the cloud's wire names it (`…Agorot`): either is read, so a
    // voucher's minimum and cap survive the trip from the page to the kiosk's main process.
    const held = x?.benefit && typeof x.benefit === 'object' ? (x.benefit as Record<string, unknown>) : null;
    const benefit = held ? voucherBenefitOf({ ...held, minPurchaseAgorot: held.minPurchase ?? held.minPurchaseAgorot, maxDiscountAgorot: held.maxDiscount ?? held.maxDiscountAgorot }) : null;
    if (!reservationId || !voucherId || uses === null || serial === null || !benefit) return null;
    const productIds = textList((x.benefit as Record<string, unknown>).productIds ?? [], 500);
    const categoryIds = textList((x.benefit as Record<string, unknown>).categoryIds ?? [], 500);
    if (productIds === null || categoryIds === null) return null;
    discounts.push({
      reservationId,
      clientRequestId: text(x.clientRequestId, 100) ?? reservationId,
      voucherId,
      code: text(x.code, 100) ?? '',
      serial,
      batchId: text(x.batchId, 100) ?? '',
      batchName: text(x.batchName, 255) ?? '',
      stacking: voucherStackingOf(x.stacking),
      benefit: { ...benefit, productIds, categoryIds },
      uses,
      expiresAt: text(x.expiresAt, 64),
    });
  }
  return { legs, discounts, saleRef };
}
