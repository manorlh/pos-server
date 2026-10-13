/**
 * How a till enters the redemption of a production voucher ("שובר הפקה") — the owner's spec of
 * 11.10.2026 §2 and §8. Two till settings, set at a company, shop, point of sale or till and
 * inherited down (the deepest level wins), with the same keys, values and defaults as
 * server/app/services/voucher_redeem_settings.py:
 *
 * - `voucherRedeemFlow` — "דרך מימוש שובר": `items_first`, `voucher_first` or `both` (unset: `both`,
 *   the owner, 13.10.2026 — a voucher scanned on an empty order opens its item picker at once, one
 *   scanned with items in the order goes to the payment; `items_first` was the default until then);
 * - `voucherShowUnavailable` — "פריטים זכאים שאינם זמינים": shown blocked (unset: true) or hidden.
 *
 * A layer's own value wins; else what it inherits (the server sends `effective` resolved);
 * else the default. `null` in a PATCH = this layer inherits again. A level that sets
 * `items_first` keeps it: only the unset default moved.
 */
import type { VoucherRedeemFlow } from './types';

export const VOUCHER_REDEEM_FLOW_KEY = 'voucherRedeemFlow' as const;
export const VOUCHER_SHOW_UNAVAILABLE_KEY = 'voucherShowUnavailable' as const;

export const VOUCHER_REDEEM_FLOWS: readonly VoucherRedeemFlow[] = ['items_first', 'voucher_first', 'both'];

/** Unset everywhere: both ways in, and unavailable items shown blocked. */
export const VOUCHER_REDEEM_FLOW_DEFAULT: VoucherRedeemFlow = 'both';
export const VOUCHER_SHOW_UNAVAILABLE_DEFAULT = true;

export function isVoucherRedeemFlow(value: unknown): value is VoucherRedeemFlow {
  return typeof value === 'string' && (VOUCHER_REDEEM_FLOWS as readonly string[]).includes(value);
}

/** The flow in force at a layer: its own, else the inherited one, else both ways in. */
export function resolveVoucherRedeemFlow(own: unknown, inherited: unknown): VoucherRedeemFlow {
  if (isVoucherRedeemFlow(own)) return own;
  if (isVoucherRedeemFlow(inherited)) return inherited;
  return VOUCHER_REDEEM_FLOW_DEFAULT;
}

/** Whether eligible items not for sale show (blocked) at a layer: its own, else inherited, else true. */
export function resolveVoucherShowUnavailable(own: unknown, inherited: unknown): boolean {
  if (typeof own === 'boolean') return own;
  if (typeof inherited === 'boolean') return inherited;
  return VOUCHER_SHOW_UNAVAILABLE_DEFAULT;
}
