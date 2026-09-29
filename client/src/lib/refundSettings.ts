/**
 * How the till handles returns (זיכוי), in the order the settings form lists them.
 *
 * * `unlinkedCardCreditEnabled` — a card credit may be issued for a return with no
 *   original receipt (an item picked from the catalogue).
 * * `refundCustomerDetailsRequired` — the till asks for the buyer's name, phone and
 *   address before it issues a credit note.
 *
 * Both are on unless a layer switches them off. Flat keys, resolved tenant → company →
 * shop like every other key; the server returns the shop's inherited preview already
 * resolved to a real bool (server/app/services/refund_settings.py).
 */
import type { RefundSettingKey } from './types';

export interface RefundSetting {
  key: RefundSettingKey;
  /** Message keys in the `posSettings` namespace. */
  labelKey: string;
  descriptionKey: string;
}

export const REFUND_SETTINGS = [
  {
    key: 'unlinkedCardCreditEnabled',
    labelKey: 'unlinkedCardCreditLabel',
    descriptionKey: 'unlinkedCardCreditDesc',
  },
  {
    key: 'refundCustomerDetailsRequired',
    labelKey: 'refundCustomerDetailsLabel',
    descriptionKey: 'refundCustomerDetailsDesc',
  },
] as const satisfies readonly RefundSetting[];

/** What the till does when nothing sets one of these keys: on. */
export const REFUND_SETTING_DEFAULT = true;
