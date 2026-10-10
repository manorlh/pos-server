/**
 * What a customer reads about the vouchers of the order, in Hebrew (the Android kiosk's KioskPayMethodUi
 * DiscountVouchers): "שובר #12 — פסטיבל הקיץ  −₪30.00" with its terms under it, why it does not apply now, and the
 * lines it left out and why. Pure; both TypeScript kiosks draw the same rows (kiosk-shared/pay-method.tsx).
 */

import { VOUCHER_REASON_TEXT, VOUCHER_SKIP_TEXT, voucherLabel, type VoucherOutcome } from './kioskVouchers';
import type { VoucherLeg } from './kioskWebOrders';

/** One voucher on the order as the payment step lists it (kiosk-shared KioskPayVoucher). */
export interface PayVoucherRow {
  id: string;
  serial: number;
  amountAgorot: number;
  label?: string | null;
  /** Its own words, in place of "שובר #N · label". */
  title?: string | null;
  /** What it covered / why it did not apply, under it. */
  lines?: string[];
}

/** "לא חל כרגע: <הסיבה>" — a voucher that takes nothing off the order as it stands (the basket under its minimum …). */
export const notAppliedText = (refusal: string): string => `לא חל כרגע: ${VOUCHER_REASON_TEXT[refusal] ?? 'לא ניתן לממש את השובר.'}`;

/** The discount vouchers of the order: each with what it took off, its terms, and the lines it left out. [nameOf]: a basket line's name. */
export function discountVoucherRows(outcomes: readonly VoucherOutcome[], nameOf: (lineId: string) => string): PayVoucherRow[] {
  return outcomes.map((o) => ({
    id: o.voucher.reservationId,
    serial: o.voucher.serial,
    amountAgorot: o.amountAgorot,
    title: voucherLabel(o.voucher.serial, o.voucher.batchName),
    lines: [
      ...(o.voucher.benefit.text ? [o.voucher.benefit.text] : []),
      ...(o.refusal ? [notAppliedText(o.refusal)] : []),
      ...o.skipped.map(([lineId, why]) => `${nameOf(lineId)} — ${VOUCHER_SKIP_TEXT[why]}`),
    ],
  }));
}

/** The goods vouchers of the order (legs of the payment): "שובר #12", what each pays. */
export function goodsVoucherRows(legs: readonly Pick<VoucherLeg, 'redemptionId' | 'serial' | 'amountAgorot' | 'eventName'>[]): PayVoucherRow[] {
  return legs.map((v) => ({ id: v.redemptionId, serial: v.serial, amountAgorot: v.amountAgorot, label: v.eventName }));
}
