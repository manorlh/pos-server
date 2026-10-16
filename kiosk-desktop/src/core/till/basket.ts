/**
 * A mixed basket — sale lines and refund lines at one counter, one customer, one payment — the Android till's Basket.kt
 * (pos-android data/repo/Basket.kt), one to one, in agorot. It is written as several documents in one transaction, all
 * with the same basketId:
 *
 *  - a 320 (400 for an exempt dealer) for what was sold, if anything was;
 *  - a 330 (−400 for a receipt or an exempt dealer) per original document credited (linked, `refundOfTransactionId`);
 *  - one 330 without a link for what came back with no receipt.
 *
 * Amounts are positive; the document type carries the direction. What came back is set against what is bought with a
 * tender of its own, `exchange`, and only the net crosses the counter:
 *
 *  - net > 0: the 320 is paid by the real legs (cash / card) plus an exchange leg for everything credited; each credit
 *    note in exchange alone;
 *  - net = 0: everything exchange;
 *  - net < 0: the 320 in exchange; the credit notes in exchange plus ONE payout leg (cash or card) for the money that goes
 *    back — placed first on the one a linked card refund names, then on any that can hold it whole, never more than a
 *    note credits.
 *
 * The exchange legs of a basket net to zero: never cash, never card, never in the drawer. Pure.
 */

export const EXCHANGE = 'exchange';

export type TenderMethod = 'cash' | 'card' | 'exchange';

export interface Tender {
  method: TenderMethod;
  amountAgorot: number;
  /** A card leg's acquirer reply (on the card payout). */
  meta?: Record<string, unknown> | null;
}

/** A basket whose legs do not add up is a basket the cloud would refuse. */
export class BasketMismatch extends Error {}

/** The money going back on a basket that comes to less than nothing. */
export interface BasketPayout {
  method: 'cash' | 'card';
  /** The original whose credit note carries the payout — a linked card refund's own original. */
  onCreditOf?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface BasketTenderPlan {
  sale: Tender[];
  credits: Tender[][];
}

const sum = (legs: readonly Tender[]) => legs.reduce((s, t) => s + t.amountAgorot, 0);

/** The tender legs of every document of a basket (planBasketTenders). */
export function planBasketTenders(input: {
  saleTotalAgorot: number;
  creditTotals: readonly number[];
  creditOriginals?: ReadonlyArray<string | null>;
  realLegs?: readonly Tender[];
  payout?: BasketPayout | null;
}): BasketTenderPlan {
  const credits = input.creditTotals;
  const originals = input.creditOriginals ?? credits.map(() => null);
  const real = input.realLegs ?? [];
  const payout = input.payout ?? null;
  const credited = credits.reduce((s, c) => s + c, 0);
  const net = input.saleTotalAgorot - credited;
  const exchange = (a: number): Tender => ({ method: EXCHANGE, amountAgorot: a });
  if (net > 0) {
    if (payout) throw new BasketMismatch('a payout on a basket the customer pays for');
    const paid = sum(real);
    if (paid !== net) throw new BasketMismatch(`legs ${paid} for a net of ${net}`);
    if (real.some((t) => t.method === EXCHANGE)) throw new BasketMismatch('exchange is not a real tender');
    return {
      sale: [...real, ...(credited > 0 ? [exchange(credited)] : [])],
      credits: credits.map((c) => [exchange(c)]),
    };
  }
  if (net === 0) {
    if (real.length > 0 || payout) throw new BasketMismatch('money moved on a basket that nets to zero');
    return { sale: [exchange(input.saleTotalAgorot)], credits: credits.map((c) => [exchange(c)]) };
  }
  if (real.length > 0) throw new BasketMismatch('legs taken on a basket that pays out');
  if (!payout) throw new BasketMismatch('no payout for a basket that pays out');
  if ((payout.method as string) === EXCHANGE) throw new BasketMismatch('exchange is not a payout');
  const rank = (i: number) => (payout.onCreditOf != null && originals[i] === payout.onCreditOf ? 0 : credits[i] >= -net ? 1 : 2);
  const order = credits.map((_, i) => i).sort((a, b) => rank(a) - rank(b));
  let left = -net;
  const legs: Tender[][] = credits.map(() => []);
  for (const i of order) {
    const take = left > credits[i] ? credits[i] : left;
    left -= take;
    const kept = credits[i] - take;
    legs[i] = [
      ...(kept > 0 ? [exchange(kept)] : []),
      ...(take > 0 ? [{ method: payout.method, amountAgorot: take, ...(payout.meta ? { meta: payout.meta } : {}) } as Tender] : []),
    ];
  }
  return { sale: [exchange(input.saleTotalAgorot)], credits: legs };
}

/** What a card payout can be sent as. */
export type CardPayoutRoute = { kind: 'linked'; originalId: string; acquirerTransactionId: string } | { kind: 'unlinked' } | { kind: 'unavailable' };

/** An original a card payout could be linked to. */
export interface LinkCandidate {
  originalId: string;
  /** What this basket credits against it. */
  creditedAgorot: number;
  /** What the original took by card, net of card refunds already made against it. */
  cardAgorot: number;
  acquirerTransactionId: string | null;
}

/**
 * Linked when the money going back comes from one card original — the whole payout inside what this basket credits
 * against it, and inside what that card was charged; else an unlinked credit if the merchant allows those.
 */
export function cardPayoutRoute(payoutAgorot: number, candidates: readonly LinkCandidate[], unlinkedAllowed: boolean): CardPayoutRoute {
  let linked: LinkCandidate | null = null;
  for (const c of candidates) {
    if (c.acquirerTransactionId === null || payoutAgorot > c.creditedAgorot || payoutAgorot > c.cardAgorot) continue;
    if (!linked || c.creditedAgorot > linked.creditedAgorot) linked = c;
  }
  if (linked) return { kind: 'linked', originalId: linked.originalId, acquirerTransactionId: linked.acquirerTransactionId! };
  return unlinkedAllowed ? { kind: 'unlinked' } : { kind: 'unavailable' };
}

/** "זיכוי לכרטיס ללא קבלה" (`unlinkedCardCreditEnabled`): on unless the merchant switched it off. */
export const UNLINKED_CARD_CREDIT_PARAM = 'unlinkedCardCreditEnabled';
/** "פרטי לקוח בזיכוי" (`refundCustomerDetailsRequired`): on unless switched off. */
export const REFUND_CUSTOMER_DETAILS_PARAM = 'refundCustomerDetailsRequired';

/** On unless the value says "false" (the Android `onUnlessFalse`). */
export function onUnlessFalse(raw: unknown): boolean {
  if (raw === false) return false;
  return !(typeof raw === 'string' && raw.trim().toLowerCase() === 'false');
}

/** One refund line of the cart, as the credit notes are built from it. */
export interface BasketRefundLine {
  /** The cart line's id, carried to its credit line. */
  key?: string;
  productId: string;
  name: string;
  sku: string | null;
  qty: number;
  unitAgorot: number;
  /** What goes back for the line (a receipt line's credit, a catalog line's gross). */
  totalAgorot: number;
  /** Set on a line picked from a receipt. */
  refundOf: { transactionId: string; itemId: string } | null;
  details?: unknown;
}

/** One line of a basket's credit note, already priced. */
export interface BasketCreditLine {
  key?: string;
  productId: string;
  name: string;
  sku: string | null;
  qty: number;
  unitAgorot: number;
  discountShareAgorot: number;
  discountType: string | null;
  totalAgorot: number;
  /** The original line it credits; null for a return with no receipt. */
  sourceItemId: string | null;
  details?: unknown;
}

/** One credit note of a basket, before it is written. */
export interface BasketCredit {
  originalId: string | null;
  lines: BasketCreditLine[];
  fullyRefunded: boolean;
  /** The original's own type, once read: a receipt is credited by a receipt refund. */
  originalDocumentType: number | null;
}

export const creditTotal = (c: Pick<BasketCredit, 'lines'>) => c.lines.reduce((s, l) => s + l.totalAgorot, 0);

/**
 * The credit notes a cart's refund lines make (basketCreditsOf): one per original, in the order the lines were picked,
 * then one for the returns with no receipt. The writer re-prices each linked credit from the stored original and refuses
 * the basket if the two disagree.
 */
export function basketCreditsOf(lines: readonly BasketRefundLine[]): BasketCredit[] {
  const out: BasketCredit[] = [];
  const byOriginal = new Map<string, BasketRefundLine[]>();
  for (const l of lines) {
    if (!l.refundOf) continue;
    const list = byOriginal.get(l.refundOf.transactionId) ?? [];
    list.push(l);
    byOriginal.set(l.refundOf.transactionId, list);
  }
  for (const [originalId, ls] of byOriginal) {
    out.push({
      originalId,
      fullyRefunded: false,
      originalDocumentType: null,
      lines: ls.map((l) => {
        const gross = l.unitAgorot * l.qty;
        const share = gross - l.totalAgorot;
        return {
          ...(l.key !== undefined ? { key: l.key } : {}),
          productId: l.productId,
          name: l.name,
          sku: l.sku,
          qty: l.qty,
          unitAgorot: l.unitAgorot,
          discountShareAgorot: share > 0 ? share : 0,
          discountType: share > 0 ? 'fixed' : null,
          totalAgorot: l.totalAgorot,
          sourceItemId: l.refundOf!.itemId,
          ...(l.details !== undefined ? { details: l.details } : {}),
        };
      }),
    });
  }
  const loose = lines.filter((l) => !l.refundOf);
  if (loose.length > 0) {
    out.push({
      originalId: null,
      fullyRefunded: false,
      originalDocumentType: null,
      lines: loose.map((l) => ({ ...(l.key !== undefined ? { key: l.key } : {}), productId: l.productId, name: l.name, sku: l.sku, qty: l.qty, unitAgorot: l.unitAgorot, discountShareAgorot: 0, discountType: null, totalAgorot: l.totalAgorot, sourceItemId: null })),
    });
  }
  return out;
}

/** Enough of a returning customer for a credit note: a name, and a phone or an address. */
export function returnCustomerComplete(name: string, phone: string, address: string): boolean {
  return name.trim() !== '' && (phone.trim() !== '' || address.trim() !== '');
}

/** The details are required for returns with no receipt, unless the merchant relaxed the rule. */
export function returnCustomerRequired(hasUnlinked: boolean, settingRequired: boolean): boolean {
  return hasUnlinked && settingRequired;
}

/** Where a basket goes once its customer is taken down: tenders for a positive net, one confirmation for zero, the payout. */
export function basketNextStep(netAgorot: number): 'tender' | 'exchange' | 'payout' {
  return netAgorot > 0 ? 'tender' : netAgorot === 0 ? 'exchange' : 'payout';
}
