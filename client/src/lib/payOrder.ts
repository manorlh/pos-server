/**
 * "סדר אמצעי התשלום" — the `payOrder` setting: the order a till lists its payment methods
 * in. Set per level (company → shop → point of sale → till) like the switches in
 * lib/paymentOptions.ts; the deepest level that sets it wins whole.
 *
 * The till draws two groups and the order sorts within each, never across them:
 *
 * * the big buttons at the top of the payment screen ("מהיר"): `fastCard`, `cash` (with
 *   change) and `fastCash` — also the tablet order panel's buttons and the handheld's
 *   one-tap pair on the sell screen;
 * * the rows in the list under them: `card` (instalments), `manualCard` and `voucher`.
 *
 * It only sorts: a method switched off is not shown because the order names it. The
 * server holds the same ids and the same completion rule (DEFAULT_PAY_ORDER /
 * complete_pay_order in server/app/services/payment_options.py). Kept free of imports so
 * `npm test` can compile it on its own.
 */

export type PayOrderId = 'fastCard' | 'cash' | 'fastCash' | 'card' | 'manualCard' | 'voucher';

/** Every id, in the order the till shows them when no level sets one. */
export const DEFAULT_PAY_ORDER: readonly PayOrderId[] = [
  'fastCard',
  'cash',
  'fastCash',
  'card',
  'manualCard',
  'voucher',
];

/** The big buttons at the top of the payment screen ("מהיר"); the rest are list rows. */
export const BIG_BUTTON_IDS: readonly PayOrderId[] = ['fastCard', 'cash', 'fastCash'];

export function isPayOrderId(value: unknown): value is PayOrderId {
  return typeof value === 'string' && (DEFAULT_PAY_ORDER as readonly string[]).includes(value);
}

export function isBigButton(id: PayOrderId): boolean {
  return BIG_BUTTON_IDS.includes(id);
}

/**
 * A stored or inherited `payOrder` as the till reads it: the known ids as listed, each
 * once, then every id it leaves out, in the default order. `null` when it is not a list
 * (nothing set).
 */
export function completePayOrder(value: unknown): PayOrderId[] | null {
  if (!Array.isArray(value)) return null;
  const out: PayOrderId[] = [];
  for (const id of value) {
    if (isPayOrderId(id) && !out.includes(id)) out.push(id);
  }
  return [...out, ...DEFAULT_PAY_ORDER.filter((id) => !out.includes(id))];
}

/** The order as the page shows it: the big buttons first, then the list, each in order. */
export function groupPayOrder(order: readonly PayOrderId[]): {
  big: PayOrderId[];
  list: PayOrderId[];
} {
  return {
    big: order.filter((id) => isBigButton(id)),
    list: order.filter((id) => !isBigButton(id)),
  };
}

/** Completed and grouped: what a layer's order means on the till, in one canonical list. */
export function normalizePayOrder(value: unknown): PayOrderId[] | null {
  const complete = completePayOrder(value);
  if (!complete) return null;
  const { big, list } = groupPayOrder(complete);
  return [...big, ...list];
}

/**
 * `order` with `id` moved one place up (-1) or down (+1) within its own group; at the
 * group's edge, unchanged. Returns a normalized list.
 */
export function movePayOrder(
  order: readonly PayOrderId[],
  id: PayOrderId,
  direction: -1 | 1,
): PayOrderId[] {
  const { big, list } = groupPayOrder(normalizePayOrder(order) ?? DEFAULT_PAY_ORDER);
  const group = isBigButton(id) ? big : list;
  const from = group.indexOf(id);
  const to = from + direction;
  if (from >= 0 && to >= 0 && to < group.length) {
    [group[from], group[to]] = [group[to], group[from]];
  }
  return [...big, ...list];
}

export function samePayOrder(
  a: readonly PayOrderId[] | null,
  b: readonly PayOrderId[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
