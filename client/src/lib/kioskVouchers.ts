/**
 * Discount vouchers ("שוברי הנחה", docs/SPEC_VOUCHER_PRODUCTION.md §7) on the Windows and browser kiosks:
 * the rules, ported once from the Android kiosk and till (pos-android domain/VoucherDiscount.kt) and the
 * cloud (app/services/prepaid_voucher_rules.py), the same three that share
 * `tests/fixtures/prepaid_voucher_rules.json` — this port is the third reader of that fixture
 * (lib/kioskVouchers.test.ts), and `kiosk_pricing_parity.json`'s `vouchers` section pins what applying
 * them does to a priced basket, line by line, as the Android kiosk's `Cart.withVoucherDiscounts` did.
 *
 *  - which vouchers may share an order (`stackingRefusal`): the batch's stacking, "שובר אחד בעסקה", the
 *    count a sale may hold;
 *  - what a voucher takes off a basket (`discountFor`): the sale lines after the cashier's discount, the
 *    promotions and the vouchers applied before, a fixed sum or a percent, a minimum, a cap, the dearest
 *    units first; "לא מקבל הנחות" never; a promoted line by the voucher's policy (`exclude` / `best` /
 *    `combine`); how many uses (`usesWanted`);
 *  - the order priced with its vouchers (`applyVoucherDiscounts`): each line's share, a promotion that
 *    gave way ("ההטבה הטובה מבין השתיים"), and what each voucher took and why it left a line out.
 *
 * A discount voucher is a discount on the document (it lowers the sale and its VAT base), never a tender:
 * the Windows kiosk writes it as `items[].voucherDiscount` + `voucherDiscounts[]` and confirms the cloud's
 * hold (`reserve` → `confirm`) when the sale is written; the browser kiosk hands nothing to a till with
 * one on the order (as the Android kiosk: "שובר הנחה ממומש רק בתשלום כאן בעמדה").
 *
 * Money in agorot, a percent in basis points (2000 = 20%). Whole numbers all the way: no float
 * arithmetic on money; quantities (kg) are counted in thousandths. Pure; no imports.
 */

/* ------------------------------------------------------------------ kinds */

export type VoucherKind = 'items' | 'order_discount' | 'item_discount';

/** What this kiosk can apply — told to the cloud on every lookup (`supportedKinds`). */
export const SUPPORTED_VOUCHER_KINDS: readonly VoucherKind[] = ['items', 'order_discount', 'item_discount'];

/** Anything unknown (an older cloud sends none) is goods, as every voucher used to be. */
export function voucherKindOf(wire: unknown): VoucherKind {
  return wire === 'order_discount' || wire === 'item_discount' ? wire : 'items';
}

export const isDiscountKind = (kind: VoucherKind): boolean => kind !== 'items';

/** Other vouchers in the same sale ("שילוב עם שוברים נוספים באותה עסקה"). */
export type VoucherStacking = 'single' | 'distinct_batches' | 'unlimited';

export function voucherStackingOf(wire: unknown): VoucherStacking {
  return wire === 'distinct_batches' || wire === 'unlimited' ? wire : 'single';
}

/** A discount voucher on a line that has a promotion ("שילוב עם מבצעים"): `exclude` is the default. */
export type VoucherPromotionPolicy = 'exclude' | 'best' | 'combine';

export function voucherPolicyOf(wire: unknown): VoucherPromotionPolicy {
  return wire === 'best' || wire === 'combine' ? wire : 'exclude';
}

export type VoucherDiscountType = 'fixed' | 'percent';

/** Why a line was left out of a discount voucher — said under the voucher. */
export type VoucherSkip = 'promoted' | 'no_discount' | 'promotion_better' | 'max_units';

export function voucherSkipOf(wire: unknown): VoucherSkip | null {
  return wire === 'promoted' || wire === 'no_discount' || wire === 'promotion_better' || wire === 'max_units' ? wire : null;
}

/** A voucher in (or coming into) one sale, as the stacking rules see it. */
export interface VoucherInSale {
  voucherId: string;
  batchId: string;
  kind: VoucherKind;
  stacking: VoucherStacking;
  /** "כמה שוברים בעסקה": the most vouchers a sale may hold with this one (`max_vouchers_per_sale`); null: no count. */
  maxPerSale?: number | null;
}

/** A discount batch's terms (what the cloud's lookup sends as `benefit`). */
export interface VoucherBenefit {
  kind: VoucherKind;
  discountType: VoucherDiscountType;
  /** Agorot (fixed) or basis points (percent). */
  value: number;
  minPurchase: number | null;
  maxDiscount: number | null;
  maxUnits: number | null;
  /** Global and till ids of the products an item discount is on. */
  productIds: string[];
  /** The categories (their sub-categories already in) an item discount is on. */
  categoryIds: string[];
  promotionPolicy: VoucherPromotionPolicy;
  /** "₪30 הנחה על כל ההזמנה" as the cloud words it (the paper's words). */
  text: string | null;
}

/** One sale line as the discount rules see it. */
export interface VoucherBasketLine {
  id: string;
  productIds: string[];
  categoryIds: string[];
  quantity: number;
  /** Unit price × quantity, before anything was taken off. */
  gross: number;
  /** The cashier's own line discount (a kiosk has none). */
  lineDiscount: number;
  /** What promotions took off the line. */
  promotion: number;
  /** What vouchers applied before this one took off the line. */
  voucher: number;
  /** False: "לא מקבל הנחות" (or a line given free). */
  discountable: boolean;
  /** Sold by weight: [quantity] is a decimal (kg), an item discount takes it per kg, pro rata (a kiosk sells none). */
  weighed: boolean;
  /** The general item ("פריט כללי"): never an item discount's; an order discount's like any line (a kiosk sells none). */
  general: boolean;
}

export interface VoucherDiscountResult {
  amount: number;
  /** By line id; sums to [amount]. */
  shares: Record<string, number>;
  /** "The better of the two": the lines whose promotion gives way to the voucher. */
  dropPromotion: string[];
  /** (line id, why), in line order. */
  skipped: Array<[string, VoucherSkip]>;
  /** Why nothing was taken off (a refusal code below), or null. */
  refusal: string | null;
}

/* ---------------------------------------------------------------- refusals */

export const VOUCHER_ALREADY_APPLIED = 'prepaid_voucher_already_applied';
export const VOUCHER_NOT_STACKABLE = 'prepaid_voucher_not_stackable';
export const VOUCHER_OTHER_NOT_STACKABLE = 'prepaid_voucher_other_not_stackable';
export const VOUCHER_SAME_BATCH = 'prepaid_voucher_same_batch';
/** "הגעת למספר השוברים המקסימלי בעסקה (N)" — `max_vouchers_per_sale`. */
export const VOUCHER_MAX_PER_SALE = 'prepaid_voucher_max_per_sale';
export const VOUCHER_MIN_PURCHASE = 'prepaid_voucher_min_purchase';
export const VOUCHER_NO_ELIGIBLE = 'prepaid_voucher_no_eligible_items';
export const VOUCHER_PROMOTION_BETTER = 'prepaid_voucher_promotion_better';

const BASIS = 10_000;
/** A unit in thousandths: a weighed line's quantity (kg) is counted in grams. */
const MILLI = 1000;

export interface StackingRefusal {
  code: string;
  limit: number | null;
}

/**
 * Why [incoming] may not join a sale that holds [existing], or null. The same voucher again is not
 * "another voucher": goods may be redeemed again (the rest of them), a discount voucher is refused (its
 * uses in a sale are taken in one go). Two discount vouchers of one batch never share a sale, whatever the
 * stacking. Then the count: the smallest `max_vouchers_per_sale` of the sale's vouchers and the new one,
 * every kind counted.
 */
export function stackingRefusal(existing: readonly VoucherInSale[], incoming: VoucherInSale): StackingRefusal | null {
  const discount = isDiscountKind(incoming.kind);
  if (discount && existing.some((v) => v.voucherId === incoming.voucherId)) return { code: VOUCHER_ALREADY_APPLIED, limit: null };
  const others = existing.filter((v) => v.voucherId !== incoming.voucherId);
  if (others.length === 0) return null;
  if (incoming.stacking === 'single') return { code: VOUCHER_NOT_STACKABLE, limit: null };
  if (others.some((v) => v.stacking === 'single')) return { code: VOUCHER_OTHER_NOT_STACKABLE, limit: null };
  const same = others.filter((v) => v.batchId === incoming.batchId);
  if (same.length > 0 && (discount || same.some((v) => isDiscountKind(v.kind)) || incoming.stacking === 'distinct_batches' || same.some((v) => v.stacking === 'distinct_batches'))) {
    return { code: VOUCHER_SAME_BATCH, limit: null };
  }
  const held = distinctBy(others, (v) => v.voucherId);
  const limits = [...held, incoming].map((v) => v.maxPerSale).filter((m): m is number => typeof m === 'number' && m > 0);
  const limit = limits.length > 0 ? Math.min(...limits) : null;
  if (limit !== null && held.length + 1 > limit) return { code: VOUCHER_MAX_PER_SALE, limit };
  return null;
}

/** "ניתן לממש שובר אחד בלבד בעסקה" / "הגעת למספר השוברים המקסימלי בעסקה (2)"; null — the kiosk's own words for the code. */
export function stackingText(code: string, limit: number | null): string | null {
  switch (code) {
    case VOUCHER_NOT_STACKABLE:
    case VOUCHER_OTHER_NOT_STACKABLE:
      return 'ניתן לממש שובר אחד בלבד בעסקה';
    case VOUCHER_MAX_PER_SALE:
      return limit === null ? null : `הגעת למספר השוברים המקסימלי בעסקה (${limit})`;
    default:
      return null;
  }
}

function distinctBy<T>(list: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of list) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/* ----------------------------------------------------------------- the rules */

const targets = (b: VoucherBenefit, line: VoucherBasketLine): boolean =>
  b.kind === 'order_discount' ||
  // The general item has no identity: never an item discount's, not even by its category.
  (!line.general && (line.productIds.some((id) => b.productIds.includes(id)) || line.categoryIds.some((id) => b.categoryIds.includes(id))));

/** The line's whole units; 0 for a fraction of a product sold by the piece (an item discount is per unit). */
function wholeUnits(quantity: number): number {
  const q = Math.round(quantity);
  return q >= 1 && Math.abs(quantity - q) < 1e-9 ? q : 0;
}

/** [quantity] in thousandths of a unit (0.734 kg → 734) — the cloud's `_milli`. */
const milli = (quantity: number): number => Math.round(quantity * MILLI);

/** What the discount takes off one whole unit whose net price is [unit]. */
const unitOff = (b: VoucherBenefit, unit: number): number => (b.discountType === 'fixed' ? Math.min(b.value, unit) : Math.floor((unit * b.value) / BASIS));

/** Something an item discount can count: a whole unit, or any weight of a weighed product. */
const hasUnits = (line: VoucherBasketLine): boolean => (line.weighed ? milli(line.quantity) >= 1 : wholeUnits(line.quantity) >= 1);

type Active = Array<[VoucherBasketLine, number]>;

function orderShares(b: VoucherBenefit, active: Active, uses: number, base: number): Record<string, number> {
  let raw = b.discountType === 'fixed' ? b.value * uses : Math.floor((base * b.value) / BASIS);
  if (b.maxDiscount !== null) raw = Math.min(raw, b.maxDiscount);
  const amount = Math.max(0, Math.min(raw, base));
  if (amount === 0 || base <= 0) return {};
  const floors = active.map(([, net]) => Math.floor((amount * net) / base));
  const left = amount - floors.reduce((s, f) => s + f, 0);
  // The largest remainders first, a tie by the basket's order (the cloud's largest-remainder split).
  const order = active.map((_, i) => i).sort((a, b2) => (amount * active[b2][1]) % base - ((amount * active[a][1]) % base) || a - b2);
  for (const i of order.slice(0, left)) floors[i] += 1;
  const out: Record<string, number> = {};
  active.forEach(([line], i) => {
    if (floors[i] > 0) out[line.id] = floors[i];
  });
  return out;
}

interface Slot {
  take: number;
  pos: number;
  size: number;
  perUnit: number;
}

/**
 * Per unit, the most valuable first, at most `maxUnits` × uses units — the cloud's `_item_shares`. Units are
 * counted in thousandths so a weighed line's kg are units too: its whole kg, then what is left of a kg (its
 * discount pro rata, half up). A unit sold by the piece needs a whole unit of room; a weighed slot takes what
 * room is left, pro rata.
 */
function itemShares(b: VoucherBenefit, active: Active, uses: number): Record<string, number> {
  const slots: Slot[] = [];
  active.forEach(([line, net], pos) => {
    if (line.weighed) {
      const mq = milli(line.quantity);
      if (mq < 1) return;
      const unit = Math.floor((2 * net * MILLI + mq) / (2 * mq)); // the net price of one kg, half up
      const off = unitOff(b, unit);
      if (off <= 0) return;
      for (let i = 0; i < Math.floor(mq / MILLI); i++) slots.push({ take: off, pos, size: MILLI, perUnit: off });
      const rest = mq % MILLI;
      if (rest > 0) slots.push({ take: Math.floor((off * rest + MILLI / 2) / MILLI), pos, size: rest, perUnit: off });
    } else {
      const q = wholeUnits(line.quantity);
      if (q < 1) return;
      const unit = Math.floor((2 * net + q) / (2 * q)); // the unit's net price, half up
      const off = unitOff(b, unit);
      if (off > 0) for (let i = 0; i < q; i++) slots.push({ take: off, pos, size: MILLI, perUnit: off });
    }
  });
  // Stable: within one discount, the basket's order (a line's whole kg before its fraction).
  const sorted = slots.map((slot, i) => ({ slot, i })).sort((x, y) => y.slot.take - x.slot.take || x.slot.pos - y.slot.pos || x.i - y.i).map((x) => x.slot);
  let room: number | null = b.maxUnits === null ? null : Math.max(0, b.maxUnits * uses) * MILLI;
  const shares: Record<string, number> = {};
  for (const slot of sorted) {
    const line = active[slot.pos][0];
    let take = slot.take;
    if (room !== null) {
      if (room <= 0) break;
      let size = slot.size;
      if (size > room) {
        if (!line.weighed) continue; // a whole unit needs a whole unit of room
        take = Math.floor((slot.perUnit * room + MILLI / 2) / MILLI);
        size = room;
      }
      room -= size;
    }
    if (take > 0) shares[line.id] = (shares[line.id] ?? 0) + take;
  }
  for (const [line, net] of active) {
    const s = shares[line.id];
    if (s !== undefined && s > net) shares[line.id] = net;
  }
  return shares;
}

const sum = (shares: Record<string, number>): number => Object.values(shares).reduce((s, v) => s + v, 0);

/** What [benefit] takes off [lines] for [uses] uses (the rules in the file comment). */
export function discountFor(benefit: VoucherBenefit, lines: readonly VoucherBasketLine[], uses = 1): VoucherDiscountResult {
  const n = Math.max(1, uses);
  const policy = benefit.promotionPolicy;
  const order = new Map(lines.map((l, i) => [l.id, i] as const));
  const skipped = new Map<string, VoucherSkip>();
  const candidates: Active = [];
  for (const line of lines) {
    if (!targets(benefit, line)) continue;
    if (!line.discountable) {
      skipped.set(line.id, 'no_discount');
      continue;
    }
    const promoted = line.promotion > 0;
    if (promoted && policy === 'exclude') {
      skipped.set(line.id, 'promoted');
      continue;
    }
    // A fraction of a product sold by the piece has no unit; a weighed line is taken per kg.
    if (benefit.kind === 'item_discount' && !hasUnits(line)) continue;
    const promotion = promoted && policy === 'best' ? 0 : line.promotion;
    const net = line.gross - line.lineDiscount - promotion - line.voucher;
    if (net > 0) candidates.push([line, net]);
  }

  const done = (amount = 0, shares: Record<string, number> = {}, drop: string[] = [], refusal: string | null = null): VoucherDiscountResult => ({
    amount,
    shares,
    dropPromotion: drop,
    skipped: [...skipped.entries()].sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0)),
    refusal,
  });
  const nothing = (): VoucherDiscountResult => done(0, {}, [], [...skipped.values()].includes('promotion_better') ? VOUCHER_PROMOTION_BETTER : VOUCHER_NO_ELIGIBLE);

  if (candidates.length === 0) return done(0, {}, [], VOUCHER_NO_ELIGIBLE);
  const excluded = new Set<string>();
  let active: Active;
  let shares: Record<string, number>;
  for (;;) {
    active = candidates.filter(([line]) => !excluded.has(line.id));
    if (active.length === 0) return nothing();
    if (benefit.kind === 'order_discount') {
      const base = active.reduce((s, [, net]) => s + net, 0);
      const min = benefit.minPurchase;
      if (min !== null && min > 0 && base < min) return done(0, {}, [], VOUCHER_MIN_PURCHASE);
      shares = orderShares(benefit, active, n, base);
    } else {
      shares = itemShares(benefit, active, n);
    }
    if (policy !== 'best') break;
    const losers = active.map(([line]) => line).filter((l) => l.promotion > 0 && (shares[l.id] ?? 0) >= 1 && (shares[l.id] ?? 0) <= l.promotion).map((l) => l.id);
    if (losers.length === 0) break;
    for (const id of losers) {
      excluded.add(id);
      skipped.set(id, 'promotion_better');
    }
  }
  if (benefit.kind === 'item_discount') {
    for (const [line] of active) if ((shares[line.id] ?? 0) === 0 && !skipped.has(line.id)) skipped.set(line.id, 'max_units');
  }
  const amount = sum(shares);
  if (amount <= 0) return nothing();
  const drop = policy === 'best' ? active.map(([line]) => line).filter((l) => l.promotion > 0 && (shares[l.id] ?? 0) > 0).map((l) => l.id) : [];
  return done(amount, shares, drop);
}

/**
 * How many uses one sale takes, at most [allowed] (the per-sale limit, the uses left, the day's): as long as
 * one more adds to the discount. A percent off the whole sale is one.
 */
export function usesWanted(benefit: VoucherBenefit, lines: readonly VoucherBasketLine[], allowed: number): number {
  const max = Math.max(1, allowed);
  if (max === 1) return 1;
  if (benefit.kind === 'order_discount' && benefit.discountType === 'percent') return 1;
  let best = discountFor(benefit, lines, 1);
  let uses = 1;
  while (uses < max) {
    const more = discountFor(benefit, lines, uses + 1);
    if (more.amount <= best.amount) break;
    best = more;
    uses += 1;
  }
  return uses;
}

/* ------------------------------------------------------ vouchers on a basket */

/** A discount voucher applied to the order: held in the cloud for this sale ([reservationId]) until it is paid, or removed. */
export interface AppliedDiscountVoucher {
  reservationId: string;
  /** The same id renews the hold. */
  clientRequestId: string;
  voucherId: string;
  code: string;
  serial: number;
  batchId: string;
  batchName: string;
  stacking: VoucherStacking;
  benefit: VoucherBenefit;
  /** Uses the cloud granted for this sale. */
  uses: number;
  expiresAt: string | null;
}

export const voucherInSaleOf = (v: Pick<AppliedDiscountVoucher, 'voucherId' | 'batchId' | 'benefit' | 'stacking'>): VoucherInSale => ({
  voucherId: v.voucherId,
  batchId: v.batchId,
  kind: v.benefit.kind,
  stacking: v.stacking,
});

/** The receipt's line: "שובר #12 — פסטיבל הקיץ". */
export function voucherLabel(serial: number | null | undefined, batchName: string | null | undefined): string {
  return (serial && serial > 0 ? `שובר #${serial}` : 'שובר') + (batchName && batchName.trim() ? ` — ${batchName}` : '');
}

/** What one applied voucher takes off the basket as it stands now. */
export interface VoucherOutcome {
  voucher: AppliedDiscountVoucher;
  amountAgorot: number;
  /** By basket line id. */
  shares: Record<string, number>;
  skipped: Array<[string, VoucherSkip]>;
  /** Why it takes nothing now (the basket under the minimum …): shown, and released at payment. */
  refusal: string | null;
}

/** A line as it comes out of the promotions, for the vouchers to be taken off it. */
export interface VoucherLineIn {
  id: string;
  /** Every id the product is known by. */
  productIds: readonly string[];
  categoryId: string | null;
  qty: number;
  /** unit × qty, before any discount. */
  grossAgorot: number;
  /** What promotions took off it, and the promotion that took most. */
  promotionAgorot: number;
  promotionId: string | null;
  /** "לא מקבל הנחות". */
  noDiscount: boolean;
}

export interface VoucherLineOut {
  /** What the vouchers took off the line. */
  voucherAgorot: number;
  /** The promotion's share left on the line (a voucher that beat it took it off). */
  promotionAgorot: number;
  /** The promotion's share that gave way to a voucher on this line ("ההטבה הטובה מבין השתיים"). */
  promotionYieldedAgorot: number;
}

export interface VouchersApplied {
  lines: Record<string, VoucherLineOut>;
  outcomes: VoucherOutcome[];
  /** By promotion id: what a voucher took from it (to take off the promotions' own totals). */
  yielded: Record<string, number>;
}

/** The sale lines as the rules see them, net of what came before ([voucherAgorot]: the vouchers applied so far, by line id). */
export function voucherBasketLines(lines: readonly VoucherLineIn[], now: Readonly<Record<string, VoucherLineOut>> = {}): VoucherBasketLine[] {
  return lines
    .filter((l) => l.qty > 0)
    .map((l) => ({
      id: l.id,
      productIds: [...l.productIds],
      categoryIds: l.categoryId ? [l.categoryId] : [],
      quantity: l.qty,
      gross: l.grossAgorot,
      lineDiscount: 0,
      promotion: now[l.id] ? now[l.id].promotionAgorot : l.promotionAgorot,
      voucher: now[l.id]?.voucherAgorot ?? 0,
      // A product that takes no discount takes none; a kiosk sells nothing weighed or general.
      discountable: !l.noDiscount,
      weighed: false,
      general: false,
    }));
}

/**
 * The basket with its discount vouchers taken off, in the order they were applied (Cart.withVoucherDiscounts):
 * each line's share, a promotion that gave way to a voucher moved off its line, and each voucher's outcome.
 * Built from the basket as priced by its promotions, so applying it twice is applying it once.
 */
export function applyVoucherDiscounts(lines: readonly VoucherLineIn[], vouchers: readonly AppliedDiscountVoucher[]): VouchersApplied {
  const state: Record<string, VoucherLineOut> = Object.fromEntries(lines.map((l) => [l.id, { voucherAgorot: 0, promotionAgorot: l.promotionAgorot, promotionYieldedAgorot: 0 }]));
  const outcomes: VoucherOutcome[] = [];
  const yielded: Record<string, number> = {};
  for (const v of vouchers) {
    const r = discountFor(v.benefit, voucherBasketLines(lines, state), v.uses);
    outcomes.push({ voucher: v, amountAgorot: r.amount, shares: r.shares, skipped: r.skipped, refusal: r.refusal });
    if (r.amount <= 0) continue;
    const drop = new Set(r.dropPromotion);
    for (const l of lines) {
      const cur = state[l.id];
      const share = r.shares[l.id] ?? 0;
      if (drop.has(l.id)) {
        if (l.promotionId) yielded[l.promotionId] = (yielded[l.promotionId] ?? 0) + cur.promotionAgorot;
        state[l.id] = { voucherAgorot: cur.voucherAgorot + share, promotionYieldedAgorot: cur.promotionYieldedAgorot + cur.promotionAgorot, promotionAgorot: 0 };
      } else if (share > 0) {
        state[l.id] = { ...cur, voucherAgorot: cur.voucherAgorot + share };
      }
    }
  }
  return { lines: state, outcomes, yielded };
}

/** Under a voucher: "קפה — במבצע — השובר לא חל" (the skipped lines, in the customer's Hebrew). */
export const VOUCHER_SKIP_TEXT: Record<VoucherSkip, string> = {
  promoted: 'במבצע — השובר לא חל',
  no_discount: 'לא מקבל הנחות',
  promotion_better: 'המבצע משתלם יותר',
  max_units: 'מעבר למספר היחידות בשובר',
};

/** The cloud's refusal codes for a discount voucher, in the customer's Hebrew (the Android kiosk's prepaid_reason_*). */
export const VOUCHER_REASON_TEXT: Record<string, string> = {
  prepaid_voucher_in_use: 'השובר בשימוש בעסקה פתוחה אחרת כרגע. נסו שוב בעוד כמה דקות.',
  prepaid_voucher_daily_limit: 'השובר הגיע למגבלת השימושים היומית.',
  prepaid_voucher_kind_unsupported: 'זהו שובר הנחה — לא ניתן לממש אותו כאן.',
  [VOUCHER_ALREADY_APPLIED]: 'השובר כבר הוחל בעסקה זו.',
  [VOUCHER_NOT_STACKABLE]: 'השובר לא ניתן לשילוב עם שובר נוסף באותה עסקה.',
  [VOUCHER_OTHER_NOT_STACKABLE]: 'בעסקה כבר יש שובר שלא ניתן לשלב עם שוברים נוספים.',
  [VOUCHER_MAX_PER_SALE]: 'הגעת למספר השוברים המקסימלי בעסקה',
  [VOUCHER_SAME_BATCH]: 'בעסקה כבר יש שובר מאותה סדרה.',
  [VOUCHER_MIN_PURCHASE]: 'סכום הקנייה (בלי פריטים שהשובר לא חל עליהם) נמוך ממינימום הקנייה של השובר.',
  [VOUCHER_NO_ELIGIBLE]: 'אין בסל פריטים שהשובר חל עליהם.',
  [VOUCHER_PROMOTION_BETTER]: 'המבצע בסל משתלם יותר — השובר לא הוחל.',
  prepaid_voucher_reservation_released: 'השובר הוסר מהעסקה. סרקו אותו שוב.',
};

/* --------------------------------------------------------------- on the wire */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);

/** A lookup's discount terms (`benefit`) as the rules take them; null when the cloud sent none (nothing to apply). */
export function voucherBenefitOf(raw: unknown, fallbackKind: unknown = null): VoucherBenefit | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const kind = voucherKindOf(b.kind ?? fallbackKind);
  if (kind === 'items') return null;
  const value = num(b.value);
  if (value === null) return null;
  return {
    kind,
    discountType: b.discountType === 'percent' ? 'percent' : 'fixed',
    value: Math.trunc(value),
    minPurchase: num(b.minPurchaseAgorot),
    maxDiscount: num(b.maxDiscountAgorot),
    maxUnits: num(b.maxUnits),
    productIds: strList(b.productIds),
    categoryIds: strList(b.categoryIds),
    promotionPolicy: voucherPolicyOf(b.promotionPolicy),
    text: typeof b.text === 'string' && b.text.trim() ? b.text : null,
  };
}

/** One basket line as the cloud's `reserve` takes it (PrepaidBasketLineDto), money in agorot. */
export function basketLineWire(l: VoucherBasketLine): Record<string, unknown> {
  return {
    id: l.id,
    productIds: l.productIds,
    categoryIds: l.categoryIds,
    quantity: l.quantity,
    grossAgorot: l.gross,
    lineDiscountAgorot: l.lineDiscount,
    promotionAgorot: l.promotion,
    voucherAgorot: l.voucher,
    discountable: l.discountable,
    weighed: l.weighed,
    general: l.general,
  };
}

/** The vouchers already in the sale as `reserve` takes them (`otherVouchers`). */
export function inSaleWire(v: VoucherInSale): Record<string, unknown> {
  return { voucherId: v.voucherId, batchId: v.batchId, kind: v.kind, stacking: v.stacking, maxVouchersPerSale: v.maxPerSale ?? null };
}

/**
 * The document's discount vouchers (`voucherDiscounts[]`, VoucherDiscountJson.encode): what each voucher that took
 * something off the sale took, its lines named by the document's item ids ([itemIdOf]: the basket line's), the
 * reservation the document confirms in the cloud. Money in shekels, as the document carries it.
 */
export function voucherDiscountsWire(outcomes: readonly VoucherOutcome[], itemIdOf: (lineId: string) => string | null | undefined, shekels: (agorot: number) => number): Array<Record<string, unknown>> {
  return outcomes
    .filter((o) => o.amountAgorot > 0)
    .map((o) => ({
      reservationId: o.voucher.reservationId,
      voucherId: o.voucher.voucherId,
      batchId: o.voucher.batchId,
      serial: o.voucher.serial,
      batchName: o.voucher.batchName,
      kind: o.voucher.benefit.kind,
      uses: o.voucher.uses,
      amount: shekels(o.amountAgorot),
      lines: Object.entries(o.shares).flatMap(([lineId, share]) => {
        const itemId = itemIdOf(lineId);
        return itemId && share > 0 ? [{ itemId, amount: shekels(share) }] : [];
      }),
    }));
}
