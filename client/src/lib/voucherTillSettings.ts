/**
 * Three more production-voucher till settings (the owner, 11.10.2026), set at a company, shop, point
 * of sale or till and inherited down (the deepest level wins) like `voucherRedeemFlow`
 * (lib/voucherRedeemFlow.ts), with the server's keys, values and defaults:
 *
 * - `voucherBalanceCheck` — "בירור יתרת שובר בתפריט הקופה": `auto` (unset: on while the till has an
 *   active production voucher batch it can redeem), `on` or `off`
 *   (server/app/services/voucher_balance_check.py). The settings preview carries
 *   `voucherBalanceCheckActiveVouchers`: whether "auto" is on at that level right now.
 * - `voucherAutoClose` — "סגירה אוטומטית כשהשובר מכסה הכל": `on` (unset: today) or `off`.
 * - `voucherStation` — "עמדת שובר (מסך סריקה בלבד)": `off` (unset) or `on`
 *   (server/app/services/voucher_station_settings.py).
 * - `voucherStationPaidItems` (12.10.2026, the spec's §5) — "רכישה נוספת בתשלום בעמדת שובר": `off`
 *   (unset: the station redeems vouchers only) or `on` (after the voucher, items paid for at the
 *   regular price can join the same sale). The till shows it only with a cash or card option on.
 * - `voucherShowEntitlement` (13.10.2026, P:/specs/voucher-one-per-group.md §5) — "הצג לקופאי מה מגיע
 *   ללקוח בסריקת שובר": `on` (unset: every voucher scan opens a small card with what the voucher gives
 *   and what is left, never stopping the redemption) or `off` (the till as before).
 * - `voucherAutoApply` (12.10.2026) — "מימוש אוטומטי בסריקת שובר": `on` (unset: a voucher scanned with
 *   items already in the cart is applied at once to the matching cart lines, with no redeem sheet and no
 *   "מימוש" press, when no choice is needed; the sheet opens only when one is) or `off` (the redeem
 *   sheet opens, as before).
 * - `voucherSuccessScreen` (12.10.2026) — "מסך הצלחה במימוש שובר": `always` (unset: a large green
 *   screen after every sale that redeemed a voucher), `auto_close` (only when the voucher closed the
 *   sale by itself) or `off` (the usual end-of-sale screen only).
 * - `voucherSuccessSeconds` (12.10.2026) — "משך מסך ההצלחה (שניות)": an integer 1–10 (unset: 3);
 *   anything else counts as unset.
 * - `voucherSoundApprove` / `voucherSoundReject` (12.10.2026) — "צליל אישור במימוש שובר" / "צליל סירוב
 *   במימוש שובר": `on` (unset: a strong sound once when a voucher is accepted / refused in red) or `off`.
 *
 * A layer's own value wins; else what it inherits (the server sends `effective` resolved); else the
 * default. `null` in a PATCH = this layer inherits again.
 */
import { PAYMENT_OPTIONS, resolvePaymentOptionKey } from './paymentOptions';
import type {
  PosSettingsPatch,
  PosSettingsV1,
  VoucherBalanceCheckMode,
  VoucherOnOff,
  VoucherRedeemFlow,
  VoucherSuccessScreen,
} from './types';

export const VOUCHER_BALANCE_CHECK_KEY = 'voucherBalanceCheck' as const;
export const VOUCHER_BALANCE_ACTIVE_KEY = 'voucherBalanceCheckActiveVouchers' as const;
export const VOUCHER_AUTO_CLOSE_KEY = 'voucherAutoClose' as const;
export const VOUCHER_STATION_KEY = 'voucherStation' as const;
export const VOUCHER_STATION_PAID_ITEMS_KEY = 'voucherStationPaidItems' as const;
export const VOUCHER_SHOW_ENTITLEMENT_KEY = 'voucherShowEntitlement' as const;
export const VOUCHER_AUTO_APPLY_KEY = 'voucherAutoApply' as const;
export const VOUCHER_SUCCESS_SCREEN_KEY = 'voucherSuccessScreen' as const;
export const VOUCHER_SUCCESS_SECONDS_KEY = 'voucherSuccessSeconds' as const;
export const VOUCHER_SOUND_APPROVE_KEY = 'voucherSoundApprove' as const;
export const VOUCHER_SOUND_REJECT_KEY = 'voucherSoundReject' as const;

export const VOUCHER_BALANCE_CHECK_MODES: readonly VoucherBalanceCheckMode[] = ['auto', 'on', 'off'];
export const VOUCHER_AUTO_CLOSE_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_STATION_VALUES: readonly VoucherOnOff[] = ['off', 'on'];
export const VOUCHER_STATION_PAID_ITEMS_VALUES: readonly VoucherOnOff[] = ['off', 'on'];
export const VOUCHER_SHOW_ENTITLEMENT_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_AUTO_APPLY_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_SUCCESS_SCREEN_VALUES: readonly VoucherSuccessScreen[] = ['always', 'auto_close', 'off'];
export const VOUCHER_SUCCESS_SECONDS_MIN = 1;
export const VOUCHER_SUCCESS_SECONDS_MAX = 10;
/** 1, 2, …, 10: every choice the dashboard offers. */
export const VOUCHER_SUCCESS_SECONDS_VALUES: readonly number[] = Array.from(
  { length: VOUCHER_SUCCESS_SECONDS_MAX - VOUCHER_SUCCESS_SECONDS_MIN + 1 },
  (_, i) => VOUCHER_SUCCESS_SECONDS_MIN + i,
);
export const VOUCHER_SOUND_VALUES: readonly VoucherOnOff[] = ['on', 'off'];

export const VOUCHER_BALANCE_CHECK_DEFAULT: VoucherBalanceCheckMode = 'auto';
export const VOUCHER_AUTO_CLOSE_DEFAULT: VoucherOnOff = 'on';
export const VOUCHER_STATION_DEFAULT: VoucherOnOff = 'off';
export const VOUCHER_STATION_PAID_ITEMS_DEFAULT: VoucherOnOff = 'off';
export const VOUCHER_SHOW_ENTITLEMENT_DEFAULT: VoucherOnOff = 'on';
export const VOUCHER_AUTO_APPLY_DEFAULT: VoucherOnOff = 'on';
export const VOUCHER_SUCCESS_SCREEN_DEFAULT: VoucherSuccessScreen = 'always';
export const VOUCHER_SUCCESS_SECONDS_DEFAULT = 3;
export const VOUCHER_SOUND_DEFAULT: VoucherOnOff = 'on';

export function isVoucherBalanceCheckMode(value: unknown): value is VoucherBalanceCheckMode {
  return typeof value === 'string' && (VOUCHER_BALANCE_CHECK_MODES as readonly string[]).includes(value);
}

export function isVoucherOnOff(value: unknown): value is VoucherOnOff {
  return value === 'on' || value === 'off';
}

/** The balance check's mode at a layer: its own, else the inherited one, else "auto". */
export function resolveVoucherBalanceCheck(own: unknown, inherited: unknown): VoucherBalanceCheckMode {
  if (isVoucherBalanceCheckMode(own)) return own;
  if (isVoucherBalanceCheckMode(inherited)) return inherited;
  return VOUCHER_BALANCE_CHECK_DEFAULT;
}

/** Whether the menu item shows: "on" / "off" as said; "auto" while there are active vouchers (unknown → null). */
export function voucherBalanceCheckEnabled(mode: VoucherBalanceCheckMode, activeVouchers: unknown): boolean | null {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return typeof activeVouchers === 'boolean' ? activeVouchers : null;
}

export function resolveVoucherAutoClose(own: unknown, inherited: unknown): VoucherOnOff {
  if (isVoucherOnOff(own)) return own;
  if (isVoucherOnOff(inherited)) return inherited;
  return VOUCHER_AUTO_CLOSE_DEFAULT;
}

export function resolveVoucherStation(own: unknown, inherited: unknown): VoucherOnOff {
  if (isVoucherOnOff(own)) return own;
  if (isVoucherOnOff(inherited)) return inherited;
  return VOUCHER_STATION_DEFAULT;
}

export function resolveVoucherStationPaidItems(own: unknown, inherited: unknown): VoucherOnOff {
  if (isVoucherOnOff(own)) return own;
  if (isVoucherOnOff(inherited)) return inherited;
  return VOUCHER_STATION_PAID_ITEMS_DEFAULT;
}

/** "הצג לקופאי מה מגיע ללקוח בסריקת שובר" at a layer: its own, else the inherited one, else "on". */
export function resolveVoucherShowEntitlement(own: unknown, inherited: unknown): VoucherOnOff {
  if (isVoucherOnOff(own)) return own;
  if (isVoucherOnOff(inherited)) return inherited;
  return VOUCHER_SHOW_ENTITLEMENT_DEFAULT;
}

/** "מימוש אוטומטי בסריקת שובר" at a layer: its own, else the inherited one, else "on". */
export function resolveVoucherAutoApply(own: unknown, inherited: unknown): VoucherOnOff {
  if (isVoucherOnOff(own)) return own;
  if (isVoucherOnOff(inherited)) return inherited;
  return VOUCHER_AUTO_APPLY_DEFAULT;
}

export function isVoucherSuccessScreen(value: unknown): value is VoucherSuccessScreen {
  return typeof value === 'string' && (VOUCHER_SUCCESS_SCREEN_VALUES as readonly string[]).includes(value);
}

/** An integer from 1 to 10 (a number, not a numeric string). */
export function isVoucherSuccessSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= VOUCHER_SUCCESS_SECONDS_MIN &&
    value <= VOUCHER_SUCCESS_SECONDS_MAX
  );
}

/** "מסך הצלחה במימוש שובר" at a layer: its own, else the inherited one, else "always". */
export function resolveVoucherSuccessScreen(own: unknown, inherited: unknown): VoucherSuccessScreen {
  if (isVoucherSuccessScreen(own)) return own;
  if (isVoucherSuccessScreen(inherited)) return inherited;
  return VOUCHER_SUCCESS_SCREEN_DEFAULT;
}

/** "משך מסך ההצלחה (שניות)" at a layer: its own, else the inherited one, else 3; outside 1–10 is unset. */
export function resolveVoucherSuccessSeconds(own: unknown, inherited: unknown): number {
  if (isVoucherSuccessSeconds(own)) return own;
  if (isVoucherSuccessSeconds(inherited)) return inherited;
  return VOUCHER_SUCCESS_SECONDS_DEFAULT;
}

/** "צליל אישור / סירוב במימוש שובר" at a layer: its own, else the inherited one, else "on". */
export function resolveVoucherSound(own: unknown, inherited: unknown): VoucherOnOff {
  if (isVoucherOnOff(own)) return own;
  if (isVoucherOnOff(inherited)) return inherited;
  return VOUCHER_SOUND_DEFAULT;
}

/**
 * "רכישה נוספת בתשלום בעמדת שובר" at a layer as drafted: the value in force (its own, else the
 * inherited one, else "off"), what it would inherit, and whether the dashboard warns that the till
 * will not show it — "on" while every cash and card option resolves blocked at that level (a
 * voucher-only till has nothing to take the money with). The voucher's own switches do not count:
 * they redeem, they do not pay for the extra items.
 */
export function voucherStationPaidItemsView(
  own: PosSettingsPatch,
  inherited: PosSettingsV1 | undefined,
): { value: VoucherOnOff; inheritedValue: VoucherOnOff; noPaymentWarning: boolean } {
  const value = resolveVoucherStationPaidItems(own[VOUCHER_STATION_PAID_ITEMS_KEY], inherited?.[VOUCHER_STATION_PAID_ITEMS_KEY]);
  const inheritedValue = resolveVoucherStationPaidItems(undefined, inherited?.[VOUCHER_STATION_PAID_ITEMS_KEY]);
  const anyPaymentOn = PAYMENT_OPTIONS.some((o) =>
    resolvePaymentOptionKey(o.enabledKey, own, inherited, o.enabledByDefault),
  );
  return { value, inheritedValue, noPaymentWarning: value === 'on' && !anyPaymentOn };
}

/**
 * The voucher station's recommended companions (spec §3): with the station on, a level whose
 * redemption flow is still "items first", or whose voucher can be neither scanned nor typed, gets a
 * (non-blocking) "מומלץ: דרך מימוש = סריקת שובר תחילה".
 */
export function voucherStationNeedsAdvice(
  station: VoucherOnOff,
  flow: VoucherRedeemFlow,
  voucherScanOn: boolean,
  voucherManualOn: boolean,
): boolean {
  if (station !== 'on') return false;
  return flow === 'items_first' || (!voucherScanOn && !voucherManualOn);
}
