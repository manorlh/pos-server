/**
 * The customer's details at the kiosk, as the Android kiosk checks them (pos-android
 * domain/KioskOrders.kt `KioskCustomer`) — ONE copy for the Windows kiosk (kiosk-desktop, through
 * `@dash-lib/kioskCustomer`) and the browser kiosk:
 *
 *  - a phone: an Israeli number as typed — 9–10 digits starting with 0, or +972 and 11–12 digits
 *    (spaces, dashes and brackets are ignored);
 *  - a name: 1–30 characters once trimmed.
 *
 * Pure; no imports (the node tests compile it alone).
 */

/** The longest name a kiosk takes (KioskCustomer.NAME_MAX). */
export const NAME_MAX = 30;

/** An Israeli mobile or landline as typed: 9–10 digits starting with 0, or +972… (KioskCustomer.phoneValid). */
export function phoneValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) return digits.startsWith('972') && digits.length >= 11 && digits.length <= 12;
  return digits.startsWith('0') && digits.length >= 9 && digits.length <= 10;
}

/** A name: 1–30 characters once trimmed (KioskCustomer.nameValid). */
export function nameValid(raw: string): boolean {
  const n = raw.trim().length;
  return n >= 1 && n <= NAME_MAX;
}
