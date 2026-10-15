/**
 * The till's tenders, as the Android checkout takes them (pos-android ui/checkout/CheckoutViewModel.kt: takePartialCash,
 * confirmCash, settleLegs, cashHandedOver; domain/Basket.kt BasketSaleFields):
 *
 *  - the goods' total is paid by legs; a cash leg is the GOODS it settled, never the note handed over — the legs add up to
 *    the total to the agora;
 *  - cash handed over below what is due is a PARTIAL cash leg ("קבל X במזומן — יישאר Y"); at or above what is due it
 *    closes the sale with a leg for exactly what was left, and the surplus is the CHANGE;
 *  - a card leg is always the LAST: it charges what is left (the terminal's amount is the whole rest, never a part),
 *    so a document is written only when it can be complete — `amountTendered` is all the cash handed over, `changeAmount`
 *    the change;
 *  - a document's `paymentMethod` is its last leg's.
 *
 * Pure: agorot in, agorot out.
 */

export interface TenderLeg {
  method: 'cash' | 'card';
  /** The goods it settled. */
  amountAgorot: number;
  /** Cash: what was handed over for it (the closing leg's is the whole note, the change inside it). */
  handedAgorot: number;
}

export function paidOf(legs: readonly TenderLeg[]): number {
  return legs.reduce((s, l) => s + l.amountAgorot, 0);
}

/** What is still due (never below zero). */
export function dueOf(totalAgorot: number, legs: readonly TenderLeg[]): number {
  return Math.max(0, totalAgorot - paidOf(legs));
}

/** A cash amount the screens may send: a whole number of agorot, at least 1, at most ₪1,000,000. */
export function validCashAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100_000_000;
}

export type CashStep =
  | { kind: 'partial'; leg: TenderLeg; dueAfterAgorot: number }
  | { kind: 'complete'; leg: TenderLeg; legs: TenderLeg[]; tenderedAgorot: number; changeAgorot: number };

/**
 * Cash handed over now, on top of the legs so far. Below the due: a partial leg (the due after it is what is left).
 * At or above: the sale is complete — the closing leg settles exactly what was left, the rest is change.
 */
export function takeCash(totalAgorot: number, legs: readonly TenderLeg[], handedAgorot: number): CashStep {
  const due = dueOf(totalAgorot, legs);
  if (handedAgorot < due) {
    const leg: TenderLeg = { method: 'cash', amountAgorot: handedAgorot, handedAgorot };
    return { kind: 'partial', leg, dueAfterAgorot: due - handedAgorot };
  }
  const leg: TenderLeg = { method: 'cash', amountAgorot: due, handedAgorot };
  const all = [...legs, leg];
  return { kind: 'complete', leg, legs: all, tenderedAgorot: handedTotal(all), changeAgorot: handedAgorot - due };
}

/** All the cash handed over (cashHandedOver). */
export function handedTotal(legs: readonly TenderLeg[]): number {
  return legs.filter((l) => l.method === 'cash').reduce((s, l) => s + l.handedAgorot, 0);
}

/** The legs of a card-last sale: the cash taken so far, then the card for everything that is left. */
export function cardLast(totalAgorot: number, legs: readonly TenderLeg[]): TenderLeg[] {
  return [...legs, { method: 'card', amountAgorot: dueOf(totalAgorot, legs), handedAgorot: 0 }];
}

/** Whether the legs settle the total exactly (legsSettleExactly). */
export function settlesExactly(totalAgorot: number, legs: readonly TenderLeg[]): boolean {
  return paidOf(legs) === totalAgorot;
}

/** Cash a customer is likely to hand over for `due` (the next round notes) — the quick buttons of the cash pad. */
export function quickNotes(dueAgorot: number): number[] {
  if (dueAgorot <= 0) return [];
  const out: number[] = [];
  for (const note of [2_000, 5_000, 10_000, 20_000]) {
    const v = Math.ceil(dueAgorot / note) * note;
    if (v > dueAgorot && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 3);
}
