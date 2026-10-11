/**
 * Which settings a production voucher shows — only what applies to the voucher being edited
 * (the type editor, the new batch, "ערוך סדרה", "שינוי הגדרות לסדרות שנבחרו").
 *
 * * goods (`items`): the contents (a list, or groups with their total), "מימוש בחלקים", the pricing
 *   and its till value, "כולל תוספות", the accounting and the discount-block policy — never a
 *   discount's terms nor the three "שימושים" (a goods voucher is used by what it holds).
 * * `order_discount`: its type and value, a minimum purchase, a cap (a percent only), the promotion
 *   policy and the three uses — never goods, split, pricing, extras, targets or units.
 * * `item_discount`: as the order discount, with its targets and units per use instead of the
 *   minimum and the cap.
 * * every kind: the stacking (its maximum only when more than one voucher may go in a sale),
 *   validity, shops, offline and the print flags.
 *
 * The cloud says the same: "ערוך סדרה" drops a discount's rules on a goods batch
 * (`_DISCOUNT_ONLY`, server/app/services/prepaid_voucher_edit.py — pinned by the test).
 */

export type VoucherField =
  // Goods
  | 'items' | 'groups' | 'totalQty' | 'splitAllowed' | 'pricing' | 'tillValue' | 'allowTopUp' | 'includeExtras'
  | 'redemptionAccounting' | 'discountBlockPolicy' | 'printTillValue'
  // A discount
  | 'discountType' | 'discountValue' | 'minPurchase' | 'maxDiscount' | 'maxUnits' | 'targets' | 'promotionPolicy'
  | 'usesPerVoucher' | 'maxUsesPerSale' | 'maxUsesPerDay'
  // Every kind
  | 'stacking' | 'maxVouchersPerSale' | 'validFrom' | 'validUntil' | 'shopIds' | 'offlineAllowed'
  | 'showCode' | 'showItems' | 'showValidity' | 'showCredit' | 'barcodeType';

export interface VoucherFieldContext {
  kind?: string | null;
  /** Goods: "items" (a fixed list) or "groups". */
  selection?: string | null;
  splitAllowed?: boolean | null;
  pricing?: string | null;
  stacking?: string | null;
  discountType?: string | null;
  /** "מספר שימושים בכל שובר" (as typed, or the number). */
  usesPerVoucher?: number | string | null;
}

export interface VoucherFields {
  /** Shown. */
  visible: ReadonlySet<VoucherField>;
  /** Shown but fixed (e.g. uses per sale while a voucher has one use: it is 1). */
  disabled: ReadonlySet<VoucherField>;
  /** Not this voucher's — neither shown nor sent. */
  hidden: ReadonlySet<VoucherField>;
}

export const ALL_VOUCHER_FIELDS: readonly VoucherField[] = [
  'items', 'groups', 'totalQty', 'splitAllowed', 'pricing', 'tillValue', 'allowTopUp', 'includeExtras',
  'redemptionAccounting', 'discountBlockPolicy', 'printTillValue',
  'discountType', 'discountValue', 'minPurchase', 'maxDiscount', 'maxUnits', 'targets', 'promotionPolicy',
  'usesPerVoucher', 'maxUsesPerSale', 'maxUsesPerDay',
  'stacking', 'maxVouchersPerSale', 'validFrom', 'validUntil', 'shopIds', 'offlineAllowed',
  'showCode', 'showItems', 'showValidity', 'showCredit', 'barcodeType',
];

/** The three "שימושים": a discount's only. */
export const USES_FIELDS: readonly VoucherField[] = ['usesPerVoucher', 'maxUsesPerSale', 'maxUsesPerDay'];

/**
 * The cloud's `_DISCOUNT_ONLY` (server/app/services/prepaid_voucher_edit.py) in wire names: what
 * "ערוך סדרה" never takes for a goods batch. The test reads the server file and compares.
 */
export const SERVER_DISCOUNT_ONLY: readonly VoucherField[] = ['promotionPolicy', 'maxUsesPerSale', 'maxUsesPerDay', 'usesPerVoucher'];

const COMMON: readonly VoucherField[] = [
  'stacking', 'maxVouchersPerSale', 'validFrom', 'validUntil', 'shopIds', 'offlineAllowed',
  'showCode', 'showItems', 'showValidity', 'showCredit', 'barcodeType',
];
const GOODS: readonly VoucherField[] = [
  'splitAllowed', 'pricing', 'tillValue', 'allowTopUp', 'includeExtras', 'redemptionAccounting', 'discountBlockPolicy', 'printTillValue',
];
const DISCOUNT: readonly VoucherField[] = ['discountType', 'discountValue', 'promotionPolicy', ...USES_FIELDS];

export function isDiscountVoucher(kind: string | null | undefined): boolean {
  return kind === 'order_discount' || kind === 'item_discount';
}

function usesOf(v: VoucherFieldContext['usesPerVoucher']): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '1'), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** What [ctx]'s voucher shows, shows fixed, and hides. */
export function voucherFieldsFor(ctx: VoucherFieldContext): VoucherFields {
  const kind = ctx.kind ?? 'items';
  const visible = new Set<VoucherField>(COMMON);
  const disabled = new Set<VoucherField>();
  if (!isDiscountVoucher(kind)) {
    GOODS.forEach((f) => visible.add(f));
    if (ctx.selection === 'groups') {
      visible.add('groups');
      visible.add('totalQty');
    } else {
      visible.add('items');
    }
    // A fixed value has no top-up (the till value is the voucher's whole value).
    if ((ctx.pricing ?? 'cover') === 'fixed') visible.delete('allowTopUp');
  } else {
    DISCOUNT.forEach((f) => visible.add(f));
    if (kind === 'order_discount') {
      visible.add('minPurchase');
      if (ctx.discountType === 'percent') visible.add('maxDiscount');
    } else {
      visible.add('targets');
      visible.add('maxUnits');
    }
    // One use per voucher: at most one in a sale — shown as 1, fixed.
    if (usesOf(ctx.usesPerVoucher) === 1) disabled.add('maxUsesPerSale');
  }
  if ((ctx.stacking ?? 'single') === 'single') visible.delete('maxVouchersPerSale');
  const hidden = new Set<VoucherField>(ALL_VOUCHER_FIELDS.filter((f) => !visible.has(f)));
  return { visible, disabled, hidden };
}

/**
 * The settings every one of [ctxs] has (the bulk dialog: only what applies to all the batches
 * picked) and whether they are of different kinds ("נבחרו סדרות מסוגים שונים").
 */
export function commonVoucherFields(ctxs: readonly VoucherFieldContext[]): { visible: Set<VoucherField>; mixed: boolean } {
  const kindKey = (c: VoucherFieldContext) => `${c.kind ?? 'items'}:${isDiscountVoucher(c.kind) ? '' : (c.selection === 'groups' ? 'groups' : 'items')}`;
  const mixed = new Set(ctxs.map(kindKey)).size > 1;
  // What a kind may have at all (the bulk dialog sets the dependent ones itself: stacking's maximum, top-up).
  const open = (c: VoucherFieldContext) => voucherFieldsFor({ ...c, stacking: 'unlimited', pricing: 'cover', discountType: 'percent' }).visible;
  if (!ctxs.length) return { visible: new Set(), mixed: false };
  const out = new Set<VoucherField>(open(ctxs[0]));
  for (const c of ctxs.slice(1)) {
    const v = open(c);
    for (const f of [...out]) if (!v.has(f)) out.delete(f);
  }
  return { visible: out, mixed };
}

// ── The checks the forms show, with the value, why and the limit ─────────────

export interface UsesPerSaleProblem {
  value: number;
  limit: number;
}

/**
 * "מקסימום שימושים בעסקה" above "מספר שימושים בכל שובר": the cloud refuses it
 * (`prepaid_voucher_max_uses_per_sale_over_uses`); the form says so first, with both numbers.
 */
export function usesPerSaleProblem(perSale: string | number, perVoucher: string | number): UsesPerSaleProblem | null {
  const sale = typeof perSale === 'number' ? perSale : parseInt(String(perSale).trim(), 10);
  const limit = usesOf(perVoucher);
  if (!Number.isFinite(sale)) return null;
  return sale > limit ? { value: sale, limit } : null;
}

/** "מספר שוברים מקסימלי בעסקה" as typed, out of 1–[max] (empty is fine: no maximum). */
export function maxVouchersProblem(typed: string, max: number): { value: string; max: number } | null {
  const s = typed.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= max ? null : { value: s, max };
}
