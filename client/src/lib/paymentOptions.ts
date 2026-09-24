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
 *
 * Each option has two settings. `enabledKey` decides whether the till shows the
 * button at all; `tipsKey` whether that path asks for a tip. The keys are flat on
 * the settings object and resolve tenant → company → shop like every other key.
 * The server returns the inherited values already resolved (including the legacy
 * `tipsEnabled` / `cashTipsEnabled` fallback), so nothing here re-derives them.
 */
import type { PaymentOptionSettingKey, PosSettingsPatch, PosSettingsV1 } from './types';

export type PaymentOptionId = 'fastCash' | 'cash' | 'fastCard' | 'card';

export interface PaymentOption {
  id: PaymentOptionId;
  enabledKey: PaymentOptionSettingKey;
  tipsKey: PaymentOptionSettingKey;
  /** Message keys in the `posSettings` namespace. */
  labelKey: string;
  descriptionKey: string;
}

export const PAYMENT_OPTIONS = [
  {
    id: 'fastCash',
    enabledKey: 'payFastCashEnabled',
    tipsKey: 'payFastCashTips',
    labelKey: 'payFastCashLabel',
    descriptionKey: 'payFastCashDesc',
  },
  {
    id: 'cash',
    enabledKey: 'payCashEnabled',
    tipsKey: 'payCashTips',
    labelKey: 'payCashLabel',
    descriptionKey: 'payCashDesc',
  },
  {
    id: 'fastCard',
    enabledKey: 'payFastCardEnabled',
    tipsKey: 'payFastCardTips',
    labelKey: 'payFastCardLabel',
    descriptionKey: 'payFastCardDesc',
  },
  {
    id: 'card',
    enabledKey: 'payCardEnabled',
    tipsKey: 'payCardTips',
    labelKey: 'payCardLabel',
    descriptionKey: 'payCardDesc',
  },
] as const satisfies readonly PaymentOption[];

/**
 * Only for an older server whose inherited settings lack the keys: every option
 * offered, none asking for a tip — what the till did before these settings existed.
 */
export const PAYMENT_OPTION_FALLBACK = { enabled: true, tips: false } as const;

/** This layer's own value if it set one, else what it inherits, else `fallback`. */
export function resolvePaymentOptionKey(
  key: PaymentOptionSettingKey,
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
 */
export function noPaymentOptionAllowed(
  own: PosSettingsPatch,
  inherited: PosSettingsV1 | undefined,
): boolean {
  return PAYMENT_OPTIONS.every(
    (o) => !resolvePaymentOptionKey(o.enabledKey, own, inherited, PAYMENT_OPTION_FALLBACK.enabled),
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
