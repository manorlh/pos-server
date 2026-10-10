/**
 * The details and tip a kiosk host keeps between the basket and the payment — ONE copy for the
 * Windows kiosk (kiosk-desktop renderer/kiosk/Details.tsx) and the browser kiosk
 * (components/kiosk-web/web-details.tsx), which only draw it.
 *
 * The tip is the Android kiosk's (KioskViewModel.price, lib/kioskMoney.ts kioskTipAgorot): the
 * customer's own amount only when tips and "סכום אחר" are on and it is whole shekels, at most ₪999
 * and never more than the order; otherwise the preset's percent of the goods after promotions.
 */

import { kioskTipAgorot, type TipRules } from '../lib/kioskMoney';

export { phoneValid, nameValid } from '../lib/kioskCustomer';

export interface DetailsValue {
  name: string;
  phone: string;
  table: string;
  /** A preset's percent… */
  tipPct: number | null;
  /** …or "סכום אחר" in agorot (whole shekels): choosing one clears the other. */
  tipAgorot: number | null;
}

export const NO_DETAILS: DetailsValue = { name: '', phone: '', table: '', tipPct: null, tipAgorot: null };

/** The tip charged for what the customer chose, on `goodsAgorot` (the goods after promotions). */
export function tipOfDetails(v: Pick<DetailsValue, 'tipPct' | 'tipAgorot'>, goodsAgorot: number, rules: TipRules): number {
  return kioskTipAgorot(rules, goodsAgorot, v.tipPct, v.tipAgorot);
}
