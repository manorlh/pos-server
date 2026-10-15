/**
 * "התשלום אינו זמין כרגע" — the kiosk's no-payment screen says WHY in its default line (16.10: a kiosk set "ללא אשראי"
 * whose cash device was down still said "נחזור לפעול ברגע שהמסופון יחזור" — there is no terminal on it). The reason is
 * read from what the kiosk is set to take (`pay.methods`) and what it can take now (`pay.usable`): the card's terminal,
 * the cash device, both, or nothing set up. A business's own text for `noPaymentBody` always wins (the screen asks
 * this only when there is none), and only the Hebrew default is worded here — another language keeps the registry's.
 *
 * Pure.
 */

export type NoPaymentCause = 'terminal' | 'cash_device' | 'both' | 'none';

/** Why the kiosk cannot take money now. */
export function noPaymentCause(pay: { methods: readonly string[]; usable: readonly string[] }): NoPaymentCause {
  const cardDown = pay.methods.includes('card') && !pay.usable.includes('card');
  const cashDown = pay.methods.includes('cash_device') && !pay.usable.includes('cash_device');
  if (cardDown && cashDown) return 'both';
  if (cashDown) return 'cash_device';
  if (cardDown) return 'terminal';
  return 'none';
}

/** The registry's own default (lib/kioskTextRegistryData.ts `noPaymentBody`): the terminal's. */
export const NO_PAYMENT_BODY_TERMINAL = 'אפשר להזמין בקופה. נחזור לפעול ברגע שהמסופון יחזור.';

/** The Hebrew default line of the no-payment screen for its cause. */
export function noPaymentBodyHe(cause: NoPaymentCause): string {
  switch (cause) {
    case 'terminal':
      return NO_PAYMENT_BODY_TERMINAL;
    case 'cash_device':
      return 'אפשר להזמין בקופה. נחזור לפעול ברגע שמכשיר המזומן יחזור.';
    case 'both':
      return 'אפשר להזמין בקופה. נחזור לפעול ברגע שהמסופון ומכשיר המזומן יחזרו.';
    case 'none':
      return 'אפשר להזמין בקופה. לא הוגדר בקיוסק אמצעי תשלום.';
  }
}
