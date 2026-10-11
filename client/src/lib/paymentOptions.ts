/**
 * The payment options a till can offer, in the order the settings form lists them.
 *
 * These are entry paths on the till, not tender types: `fastCash` and `cash` both
 * end in a cash tender, `fastCard` and `card` both in a card tender. What differs is
 * the button the cashier presses and what the till asks before charging:
 *
 * * `fastCash` — one tap, cash at exactly the amount due.
 * * `cash`     — the cash keypad: the customer hands over another amount and the
 *                till computes the change.
 * * `fastCard` — one tap, card, a single payment.
 * * `card`     — card, with the instalments picker first.
 * * `manualCard` — the card number keyed on the payment terminal's own secure
 *                screen, for a card that is not present (a phone order). Off unless
 *                switched on: the acquirer has to enable keyed entry for the merchant,
 *                and a shop that never asked for it must not find it on its tills.
 *                The number never passes through this system or the till app.
 *
 * Each option has two settings. `enabledKey` decides whether the till shows the
 * button at all; `tipsKey` whether that path asks for a tip. The keys are flat on
 * the settings object and resolve tenant → company → shop like every other key.
 * The server returns the inherited values already resolved (including the legacy
 * `tipsEnabled` / `cashTipsEnabled` fallback), so nothing here re-derives them.
 */
import type {
  PaymentOptionSettingKey,
  PosSettingsPatch,
  PosSettingsV1,
  ResettableSwitchKey,
  VoucherSettingKey,
} from './types';

export type PaymentOptionId = 'fastCash' | 'cash' | 'fastCard' | 'card' | 'manualCard';

export interface PaymentOption {
  id: PaymentOptionId;
  enabledKey: PaymentOptionSettingKey;
  tipsKey: PaymentOptionSettingKey;
  /** Message keys in the `posSettings` namespace. */
  labelKey: string;
  descriptionKey: string;
  /**
   * What the till does when nothing sets `enabledKey`. The server sends it resolved,
   * so this matters only against an older server that does not.
   */
  enabledByDefault: boolean;
}

export const PAYMENT_OPTIONS = [
  {
    id: 'fastCash',
    enabledKey: 'payFastCashEnabled',
    tipsKey: 'payFastCashTips',
    labelKey: 'payFastCashLabel',
    descriptionKey: 'payFastCashDesc',
    enabledByDefault: true,
  },
  {
    id: 'cash',
    enabledKey: 'payCashEnabled',
    tipsKey: 'payCashTips',
    labelKey: 'payCashLabel',
    descriptionKey: 'payCashDesc',
    enabledByDefault: true,
  },
  {
    id: 'fastCard',
    enabledKey: 'payFastCardEnabled',
    tipsKey: 'payFastCardTips',
    labelKey: 'payFastCardLabel',
    descriptionKey: 'payFastCardDesc',
    enabledByDefault: true,
  },
  {
    id: 'card',
    enabledKey: 'payCardEnabled',
    tipsKey: 'payCardTips',
    labelKey: 'payCardLabel',
    descriptionKey: 'payCardDesc',
    enabledByDefault: true,
  },
  {
    id: 'manualCard',
    enabledKey: 'payManualCardEnabled',
    tipsKey: 'payManualCardTips',
    labelKey: 'payManualCardLabel',
    descriptionKey: 'payManualCardDesc',
    enabledByDefault: false,
  },
] as const satisfies readonly PaymentOption[];

/**
 * Only for an older server whose inherited settings lack the keys: no tip anywhere,
 * what the till did before these settings existed. Whether an option is offered
 * falls back to that option's own `enabledByDefault`.
 */
export const PAYMENT_OPTION_FALLBACK = { tips: false } as const;

export type VoucherSwitchId = 'voucher' | 'voucherManual';

export interface VoucherSwitch {
  id: VoucherSwitchId;
  key: VoucherSettingKey;
  /** Message keys in the `posSettings` namespace. */
  labelKey: string;
  descriptionKey: string;
}

/**
 * The production voucher ("שובר הפקה") on the till's payment screen: scanning it, and
 * "שובר ידני" — typing its code by hand. A rule of its own beside the five options above
 * (no tender of its own, no tip question): both on when nothing sets them, so a shop that
 * predates the switches keeps the voucher. With every cash and card option off and either
 * of these on, the till is a voucher-only till — allowed, unlike a till with nothing.
 * The same keys and default as server/app/services/payment_options.py.
 */
export const VOUCHER_SWITCHES = [
  {
    id: 'voucher',
    key: 'payVoucherEnabled',
    labelKey: 'payVoucherLabel',
    descriptionKey: 'payVoucherDesc',
  },
  {
    id: 'voucherManual',
    key: 'payVoucherManualEnabled',
    labelKey: 'payVoucherManualLabel',
    descriptionKey: 'payVoucherManualDesc',
  },
] as const satisfies readonly VoucherSwitch[];

/** What an unset voucher switch means: on. */
export const VOUCHER_SWITCH_DEFAULT = true;

/**
 * This layer's own value if it set one, else what it inherits, else `fallback`.
 * Also used by the sell-screen switches (lib/sellScreen.ts), which follow the same
 * set-or-inherit rule.
 */
export function resolvePaymentOptionKey(
  key: ResettableSwitchKey,
  own: PosSettingsPatch,
  inherited: PosSettingsV1 | undefined,
  fallback: boolean,
): boolean {
  const mine = own[key];
  if (typeof mine === 'boolean') return mine;
  const inh = inherited?.[key];
  if (typeof inh === 'boolean') return inh;
  return fallback;
}

/**
 * A till with every option hidden could not take a payment at all. The server
 * refuses such a save with a 422; the form checks first so the operator sees why.
 * Every cash and card option off is fine while the voucher (scanned or typed) is on:
 * that is a voucher-only till. Only nothing at all left is refused.
 */
export function noPaymentOptionAllowed(
  own: PosSettingsPatch,
  inherited: PosSettingsV1 | undefined,
): boolean {
  return (
    PAYMENT_OPTIONS.every(
      (o) => !resolvePaymentOptionKey(o.enabledKey, own, inherited, o.enabledByDefault),
    ) &&
    VOUCHER_SWITCHES.every(
      (v) => !resolvePaymentOptionKey(v.key, own, inherited, VOUCHER_SWITCH_DEFAULT),
    )
  );
}

/** Whether the layer as drafted takes payment only by voucher: every cash and card option off. */
export function voucherOnly(own: PosSettingsPatch, inherited: PosSettingsV1 | undefined): boolean {
  return (
    !noPaymentOptionAllowed(own, inherited) &&
    PAYMENT_OPTIONS.every(
      (o) => !resolvePaymentOptionKey(o.enabledKey, own, inherited, o.enabledByDefault),
    )
  );
}

/**
 * Whether a failed save is the server's "at least one option must stay allowed"
 * refusal. Matched on the stable code the server sends, never on its sentence —
 * the wording is the server's to change.
 */
export function isNoPaymentOptionAllowedError(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  if (res?.status !== 422) return false;
  const detail = res.data?.detail as { code?: unknown } | undefined;
  return detail?.code === 'no_payment_option_allowed';
}
