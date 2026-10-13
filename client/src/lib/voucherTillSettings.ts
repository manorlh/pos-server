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
 * - `voucherSuccessDismiss` (13.10.2026, P:/specs/voucher-fast-mode.md §0 item 11) — "סגירת מסך 'שובר
 *   מומש'": `auto` (unset: by itself after the seconds, or on a touch) or `confirm` (until the cashier
 *   presses "אישור"; a new scan counts as the press and goes on to the next voucher).
 * - `voucherSoundApprove` / `voucherSoundReject` (12.10.2026) — "צליל אישור במימוש שובר" / "צליל סירוב
 *   במימוש שובר": `on` (unset: a strong sound once when a voucher is accepted / refused in red) or `off`.
 * - The voucher fast mode (13.10.2026, P:/specs/voucher-fast-mode.md §0 — "המכשיר עובר להיות בקר
 *   סריקה"): eight choices (VOUCHER_FAST_CHOICES) and a title —
 *   `voucherFastMode` "מצב מהיר: מימוש בלי בחירה כשהשובר ברור": `off`, `station` (unset: at the voucher
 *   station only) or `all`; `voucherFastAutoClose` "סגירה לבד במצב מהיר": `on` (unset) or `off`;
 *   `voucherStationCamera` "מצלמה בעמדת שובר": `off`, `always` or `tap` (unset);
 *   `voucherStationCameraFacing` "איזו מצלמה בעמדת שובר": `back` (unset) or `front`;
 *   `voucherVibrate` "רטט במימוש שובר": `off`, `approve`, `reject` or `both` (unset);
 *   `voucherSoundBoost` "הגברת צליל שובר לעוצמה מקסימלית": `on` (unset) or `off`;
 *   `voucherStationCatalogSwitch` "מעבר מעמדת שובר לקטלוג רגיל": `off`, `manager` (unset) or `free`;
 *   `voucherStationHeader` "כותרת במסך עמדת שובר": `logo` (unset), `text`, `both` or `none`;
 *   `voucherStationTitle` "כיתוב בראש עמדת שובר": up to 40 characters as one trimmed line (unset, blank
 *   or longer: "עמדת מימוש שוברים"; the server refuses a longer one, in Hebrew).
 * - "בחר פריט לשובר" (13.10.2026, P:/specs/voucher-station-fast-flows.md §4 — a scanned voucher that needs
 *   items opens the order screen with the voucher on the sale):
 *   `voucherGuide` "הסבר לעובד מה לבחור": a boolean (unset: true — a guide strip with what the voucher
 *   allows and how many are left); `voucherPickFilter` "אחרי סריקת שובר שדורש פריטים": `eligible` (unset:
 *   only the eligible items) or `all` (the whole menu, the eligible items tagged);
 *   `voucherAutoPickSingle` "כשיש רק פריט מתאים אחד — בחר אותו אוטומטית": a boolean (unset: true).
 *
 * A layer's own value wins; else what it inherits (the server sends `effective` resolved); else the
 * default. `null` in a PATCH = this layer inherits again.
 */
import { PAYMENT_OPTIONS, resolvePaymentOptionKey } from './paymentOptions';
import type {
  PosSettingsPatch,
  PosSettingsV1,
  VoucherBalanceCheckMode,
  VoucherFastMode,
  VoucherOnOff,
  VoucherPickFilter,
  VoucherRedeemFlow,
  VoucherStationCamera,
  VoucherStationCameraFacing,
  VoucherStationCatalogSwitch,
  VoucherStationHeader,
  VoucherSuccessDismiss,
  VoucherSuccessScreen,
  VoucherVibrate,
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
export const VOUCHER_SUCCESS_DISMISS_KEY = 'voucherSuccessDismiss' as const;
export const VOUCHER_SOUND_APPROVE_KEY = 'voucherSoundApprove' as const;
export const VOUCHER_SOUND_REJECT_KEY = 'voucherSoundReject' as const;

export const VOUCHER_BALANCE_CHECK_MODES: readonly VoucherBalanceCheckMode[] = ['auto', 'on', 'off'];
export const VOUCHER_AUTO_CLOSE_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_STATION_VALUES: readonly VoucherOnOff[] = ['off', 'on'];
export const VOUCHER_STATION_PAID_ITEMS_VALUES: readonly VoucherOnOff[] = ['off', 'on'];
export const VOUCHER_SHOW_ENTITLEMENT_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_AUTO_APPLY_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_SUCCESS_SCREEN_VALUES: readonly VoucherSuccessScreen[] = ['always', 'auto_close', 'off'];
export const VOUCHER_SUCCESS_DISMISS_VALUES: readonly VoucherSuccessDismiss[] = ['auto', 'confirm'];
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
export const VOUCHER_SUCCESS_DISMISS_DEFAULT: VoucherSuccessDismiss = 'auto';
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

export function isVoucherSuccessDismiss(value: unknown): value is VoucherSuccessDismiss {
  return typeof value === 'string' && (VOUCHER_SUCCESS_DISMISS_VALUES as readonly string[]).includes(value);
}

/** "סגירת מסך 'שובר מומש'" at a layer: its own, else the inherited one, else "auto". */
export function resolveVoucherSuccessDismiss(own: unknown, inherited: unknown): VoucherSuccessDismiss {
  if (isVoucherSuccessDismiss(own)) return own;
  if (isVoucherSuccessDismiss(inherited)) return inherited;
  return VOUCHER_SUCCESS_DISMISS_DEFAULT;
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
 * redemption flow is "items first" (set at it or above — unset resolves to "both" since 13.10.2026),
 * or whose voucher can be neither scanned nor typed, gets a (non-blocking) "מומלץ: דרך מימוש = סריקת
 * שובר תחילה".
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

// ── The voucher fast mode (13.10.2026, P:/specs/voucher-fast-mode.md §0) ──

export const VOUCHER_FAST_MODE_KEY = 'voucherFastMode' as const;
export const VOUCHER_FAST_AUTO_CLOSE_KEY = 'voucherFastAutoClose' as const;
export const VOUCHER_STATION_CAMERA_KEY = 'voucherStationCamera' as const;
export const VOUCHER_STATION_CAMERA_FACING_KEY = 'voucherStationCameraFacing' as const;
export const VOUCHER_VIBRATE_KEY = 'voucherVibrate' as const;
export const VOUCHER_SOUND_BOOST_KEY = 'voucherSoundBoost' as const;
export const VOUCHER_STATION_CATALOG_SWITCH_KEY = 'voucherStationCatalogSwitch' as const;
export const VOUCHER_STATION_HEADER_KEY = 'voucherStationHeader' as const;
export const VOUCHER_STATION_TITLE_KEY = 'voucherStationTitle' as const;

export const VOUCHER_FAST_MODE_VALUES: readonly VoucherFastMode[] = ['off', 'station', 'all'];
export const VOUCHER_FAST_AUTO_CLOSE_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_STATION_CAMERA_VALUES: readonly VoucherStationCamera[] = ['off', 'always', 'tap'];
export const VOUCHER_STATION_CAMERA_FACING_VALUES: readonly VoucherStationCameraFacing[] = ['back', 'front'];
export const VOUCHER_VIBRATE_VALUES: readonly VoucherVibrate[] = ['off', 'approve', 'reject', 'both'];
export const VOUCHER_SOUND_BOOST_VALUES: readonly VoucherOnOff[] = ['on', 'off'];
export const VOUCHER_STATION_CATALOG_SWITCH_VALUES: readonly VoucherStationCatalogSwitch[] = ['off', 'manager', 'free'];
export const VOUCHER_STATION_HEADER_VALUES: readonly VoucherStationHeader[] = ['logo', 'text', 'both', 'none'];

/** Unset everywhere — the owner's defaults (§0). */
export const VOUCHER_FAST_MODE_DEFAULT: VoucherFastMode = 'station';
export const VOUCHER_FAST_AUTO_CLOSE_DEFAULT: VoucherOnOff = 'on';
export const VOUCHER_STATION_CAMERA_DEFAULT: VoucherStationCamera = 'tap';
export const VOUCHER_STATION_CAMERA_FACING_DEFAULT: VoucherStationCameraFacing = 'back';
export const VOUCHER_VIBRATE_DEFAULT: VoucherVibrate = 'both';
export const VOUCHER_SOUND_BOOST_DEFAULT: VoucherOnOff = 'on';
export const VOUCHER_STATION_CATALOG_SWITCH_DEFAULT: VoucherStationCatalogSwitch = 'manager';
export const VOUCHER_STATION_HEADER_DEFAULT: VoucherStationHeader = 'logo';

/** "כיתוב בראש עמדת שובר": "טקסט חופשי עד 40 תווים", "עמדת מימוש שוברים" by default. */
export const VOUCHER_STATION_TITLE_MAX = 40;
export const VOUCHER_STATION_TITLE_DEFAULT = 'עמדת מימוש שוברים';

/** The fast mode's eight choices, in the dashboard's order: the key, its values and its default. */
export const VOUCHER_FAST_CHOICES = [
  { key: VOUCHER_FAST_MODE_KEY, values: VOUCHER_FAST_MODE_VALUES, fallback: VOUCHER_FAST_MODE_DEFAULT },
  { key: VOUCHER_FAST_AUTO_CLOSE_KEY, values: VOUCHER_FAST_AUTO_CLOSE_VALUES, fallback: VOUCHER_FAST_AUTO_CLOSE_DEFAULT },
  { key: VOUCHER_STATION_CAMERA_KEY, values: VOUCHER_STATION_CAMERA_VALUES, fallback: VOUCHER_STATION_CAMERA_DEFAULT },
  {
    key: VOUCHER_STATION_CAMERA_FACING_KEY,
    values: VOUCHER_STATION_CAMERA_FACING_VALUES,
    fallback: VOUCHER_STATION_CAMERA_FACING_DEFAULT,
  },
  { key: VOUCHER_VIBRATE_KEY, values: VOUCHER_VIBRATE_VALUES, fallback: VOUCHER_VIBRATE_DEFAULT },
  { key: VOUCHER_SOUND_BOOST_KEY, values: VOUCHER_SOUND_BOOST_VALUES, fallback: VOUCHER_SOUND_BOOST_DEFAULT },
  {
    key: VOUCHER_STATION_CATALOG_SWITCH_KEY,
    values: VOUCHER_STATION_CATALOG_SWITCH_VALUES,
    fallback: VOUCHER_STATION_CATALOG_SWITCH_DEFAULT,
  },
  { key: VOUCHER_STATION_HEADER_KEY, values: VOUCHER_STATION_HEADER_VALUES, fallback: VOUCHER_STATION_HEADER_DEFAULT },
] as const;

export type VoucherFastChoiceKey = (typeof VOUCHER_FAST_CHOICES)[number]['key'];
/** The values one choice takes (`voucherVibrate` → 'off' | 'approve' | 'reject' | 'both'). */
export type VoucherFastChoiceValue<K extends VoucherFastChoiceKey> = NonNullable<PosSettingsV1[K]>;

export const VOUCHER_FAST_CHOICE_KEYS: readonly VoucherFastChoiceKey[] = VOUCHER_FAST_CHOICES.map((c) => c.key);

function fastChoice(key: VoucherFastChoiceKey) {
  return VOUCHER_FAST_CHOICES.find((c) => c.key === key)!;
}

export function isVoucherFastChoiceKey(key: unknown): key is VoucherFastChoiceKey {
  return typeof key === 'string' && (VOUCHER_FAST_CHOICE_KEYS as readonly string[]).includes(key);
}

/** The values [key] takes, in the dashboard's order. */
export function voucherFastChoiceValues<K extends VoucherFastChoiceKey>(key: K): readonly VoucherFastChoiceValue<K>[] {
  return fastChoice(key).values as readonly VoucherFastChoiceValue<K>[];
}

export function voucherFastChoiceDefault<K extends VoucherFastChoiceKey>(key: K): VoucherFastChoiceValue<K> {
  return fastChoice(key).fallback as VoucherFastChoiceValue<K>;
}

/** Whether [value] is one of [key]'s values — exactly: "ON" or " on" is not. */
export function isVoucherFastChoiceValue<K extends VoucherFastChoiceKey>(
  key: K,
  value: unknown,
): value is VoucherFastChoiceValue<K> {
  return typeof value === 'string' && (fastChoice(key).values as readonly string[]).includes(value);
}

/** One fast-mode choice at a layer: its own, else the inherited one, else the default; junk is unset. */
export function resolveVoucherFastChoice<K extends VoucherFastChoiceKey>(
  key: K,
  own: unknown,
  inherited: unknown,
): VoucherFastChoiceValue<K> {
  if (isVoucherFastChoiceValue(key, own)) return own;
  if (isVoucherFastChoiceValue(key, inherited)) return inherited;
  return voucherFastChoiceDefault(key);
}

/** A title as the server stores it: control characters as spaces, runs of whitespace as one, trimmed. */
export function normalizeVoucherStationTitle(value: string): string {
  return value
    // Exactly the control characters, as the server's "Cc".
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Its length as the server counts it once normalized — characters, not UTF-16 units. */
export function voucherStationTitleLength(value: string): number {
  return Array.from(normalizeVoucherStationTitle(value)).length;
}

/** Whether a typed title is over 40 characters (the server would refuse it). */
export function voucherStationTitleTooLong(value: unknown): boolean {
  return typeof value === 'string' && voucherStationTitleLength(value) > VOUCHER_STATION_TITLE_MAX;
}

/** A title the till would show: text, non-blank and at most 40 characters once normalized. */
export function isVoucherStationTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const n = voucherStationTitleLength(value);
  return n > 0 && n <= VOUCHER_STATION_TITLE_MAX;
}

/** "כיתוב בראש עמדת שובר" at a layer: its own, else the inherited one, else "עמדת מימוש שוברים". */
export function resolveVoucherStationTitle(own: unknown, inherited: unknown): string {
  if (isVoucherStationTitle(own)) return normalizeVoucherStationTitle(own);
  if (isVoucherStationTitle(inherited)) return normalizeVoucherStationTitle(inherited);
  return VOUCHER_STATION_TITLE_DEFAULT;
}

/** What a typed title sends: the normalized text, or `null` (inherit again) when blank. */
export function voucherStationTitlePatch(typed: unknown): string | null {
  const v = typeof typed === 'string' ? normalizeVoucherStationTitle(typed) : '';
  return v === '' ? null : v;
}

// ── "בחר פריט לשובר" (13.10.2026, P:/specs/voucher-station-fast-flows.md §4) ──

export const VOUCHER_GUIDE_KEY = 'voucherGuide' as const;
export const VOUCHER_PICK_FILTER_KEY = 'voucherPickFilter' as const;
export const VOUCHER_AUTO_PICK_SINGLE_KEY = 'voucherAutoPickSingle' as const;

export const VOUCHER_PICK_FILTER_VALUES: readonly VoucherPickFilter[] = ['eligible', 'all'];

/** Unset everywhere: the guide strip shown, only the eligible items, a lone eligible item picked by itself. */
export const VOUCHER_GUIDE_DEFAULT = true;
export const VOUCHER_PICK_FILTER_DEFAULT: VoucherPickFilter = 'eligible';
export const VOUCHER_AUTO_PICK_SINGLE_DEFAULT = true;

export function isVoucherPickFilter(value: unknown): value is VoucherPickFilter {
  return typeof value === 'string' && (VOUCHER_PICK_FILTER_VALUES as readonly string[]).includes(value);
}

/** "הסבר לעובד מה לבחור" at a layer: its own, else the inherited one, else true; only a real boolean counts. */
export function resolveVoucherGuide(own: unknown, inherited: unknown): boolean {
  if (typeof own === 'boolean') return own;
  if (typeof inherited === 'boolean') return inherited;
  return VOUCHER_GUIDE_DEFAULT;
}

/** "אחרי סריקת שובר שדורש פריטים" at a layer: its own, else the inherited one, else "eligible". */
export function resolveVoucherPickFilter(own: unknown, inherited: unknown): VoucherPickFilter {
  if (isVoucherPickFilter(own)) return own;
  if (isVoucherPickFilter(inherited)) return inherited;
  return VOUCHER_PICK_FILTER_DEFAULT;
}

/** "כשיש רק פריט מתאים אחד — בחר אותו אוטומטית" at a layer: its own, else the inherited one, else true. */
export function resolveVoucherAutoPickSingle(own: unknown, inherited: unknown): boolean {
  if (typeof own === 'boolean') return own;
  if (typeof inherited === 'boolean') return inherited;
  return VOUCHER_AUTO_PICK_SINGLE_DEFAULT;
}
