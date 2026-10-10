/**
 * The vouchers of ONE order at a TypeScript kiosk, from the first scan to the payment — the part of the Android kiosk's
 * KioskPayMethodModel the screens own: the goods vouchers (legs of the payment), the discount vouchers (held in the
 * cloud for the order, "שוברי הנחה"), what is left to pay, what to tell the customer, and giving them back.
 *
 * Both hosts of the shared screens (the Windows kiosk's renderer, the browser kiosk) drive the same session
 * (kiosk-shared/use-vouchers.ts), so a voucher behaves identically on both — and the tests drive it without a screen:
 *
 *  - a code is looked up and applied by what it is (lib/kioskVoucherClient.ts); the order is priced again with the
 *    discount vouchers on it, so every screen's total, tip and "נותר לתשלום" already have them;
 *  - the goods vouchers' amounts are recounted from the basket as it stands (a discount voucher added after one moves
 *    what it is worth — recountLegs, the Android payment's own recount), so what is shown is what the payment charges;
 *  - a voucher is removable until the payment starts (`remove`), and every one is given back when the order is left
 *    (`giveBack`): a discount voucher's hold released, a goods voucher reversed;
 *  - when the vouchers pay it all and no tip is left, the host goes on by itself (`onCovered`), once.
 *
 * Pure of React and of the DOM; the host's calls come in through `deps`.
 */

import type { PricedBasket } from './kioskMoney';
import { discountVoucherRows, goodsVoucherRows, type PayVoucherRow } from './kioskVoucherView';
import type { VoucherResult } from './kioskVoucherClient';
import type { AppliedDiscountVoucher, VoucherOutcome } from './kioskVouchers';
import { dueAgorot, newId, recountLegs, type CoverLine, type VoucherLeg } from './kioskWebOrders';

/** The words of the session, in the customer's language (the kiosk's texts, kiosk-shared / each host's i18n). */
export interface VoucherWords {
  /** "בודקים את השובר…". */
  checking: string;
  /** "השובר נקלט · ₪12.00". */
  appliedLeg: (amountAgorot: number) => string;
  /** "שובר #12: הנחה של ₪30.00". */
  appliedDiscount: (serial: number, amountAgorot: number) => string;
  /** "אין חיבור" (no answer). */
  offline: string;
  /** "השובר אינו כולל אף פריט מההזמנה". */
  noMatch: string;
  /** A refusal in words ("השובר כבר מומש"): the cloud's own where it sent them. */
  reason: (reason: string, message?: string) => string;
  /** The code as the voucher is looked up by, or null when it cannot be one. */
  codeOf: (raw: string) => string | null;
}

/** What the host knows of a basket line besides what the pricing says. */
export interface VoucherLineInfo {
  productId: string;
  /** The dish's own price (agorot): a goods voucher covers it, the paid extras are paid. */
  baseAgorot: number;
  name: string;
}

export interface VoucherSessionDeps<T extends { priced: PricedBasket }> {
  /** The basket priced as the screens price it, with these discount vouchers on the order. */
  price: (discounts: readonly AppliedDiscountVoucher[]) => T;
  /** A basket line (by its key) as the goods vouchers read it; null: not in the basket. */
  lineInfo: (key: string) => VoucherLineInfo | null;
  /** The tip the order carries on [goodsAgorot] (the goods after promotions and vouchers). */
  tipOf: (goodsAgorot: number) => number;
  /** A voucher scanned or typed, for this order, through the host's service (it prices the basket itself). */
  call: (input: { code: string; forfeitRest: boolean; clientRequestId: string; saleRef: string; earlier: VoucherLeg[]; discounts: AppliedDiscountVoucher[] }) => Promise<VoucherResult>;
  /** A goods voucher back on itself (the host keeps it until the cloud answers). */
  reverse: (redemptionId: string) => void;
  /** Discount vouchers' holds given back. */
  release: (vouchers: Array<{ reservationId: string }>) => void;
  words: VoucherWords;
  /** The vouchers pay everything (no tip left): the host takes the order on by itself, once. */
  onCovered: () => void;
}

export interface VoucherSessionState {
  legs: VoucherLeg[];
  discounts: AppliedDiscountVoucher[];
  /** A voucher being checked. */
  busy: boolean;
  /** "השובר נקלט · …". */
  note: string | null;
  error: string | null;
  /** A one-time voucher only partly taken: the customer is asked (its code). */
  forfeit: string | null;
  /** This order, one id for the whole checkout: how the cloud sees the sale's other vouchers. */
  saleRef: string;
}

export const initialVoucherState = (saleRef: string = newId()): VoucherSessionState => ({ legs: [], discounts: [], busy: false, note: null, error: null, forfeit: null, saleRef });

/** What the screens read of the session now. */
export interface VoucherView<T extends { priced: PricedBasket }> {
  state: VoucherSessionState;
  /** The basket priced with the discount vouchers (the host's own shape). */
  price: T;
  /** The goods vouchers as the basket pays them now. */
  legs: VoucherLeg[];
  /** What the discount vouchers took, voucher by voucher. */
  outcomes: VoucherOutcome[];
  /** The goods after promotions and discount vouchers; the tip on it; what is left to pay. */
  goodsAgorot: number;
  tipAgorot: number;
  dueAgorot: number;
  /** Everything on the order, as the payment step lists it. */
  rows: PayVoucherRow[];
  /** Any voucher on the order. */
  any: boolean;
}

/** The basket's lines as the goods vouchers read them. */
export function coverLinesOf(priced: PricedBasket, info: (key: string) => VoucherLineInfo | null): CoverLine[] {
  return priced.lines.flatMap((l) => {
    const i = info(l.id);
    return i ? [{ key: l.id, productId: i.productId, qty: l.qty, unitAgorot: l.unitAgorot, baseAgorot: i.baseAgorot, promotionAgorot: l.promotionAgorot, voucherAgorot: l.voucherAgorot }] : [];
  });
}

/** The session's state as the screens read it: the order priced with its discount vouchers, the legs recounted, what is due. */
export function voucherViewOf<T extends { priced: PricedBasket }>(state: VoucherSessionState, deps: Pick<VoucherSessionDeps<T>, 'price' | 'lineInfo' | 'tipOf'>): VoucherView<T> {
  const price = deps.price(state.discounts);
  const legs = recountLegs(coverLinesOf(price.priced, deps.lineInfo), state.legs);
  const goodsAgorot = price.priced.totalAgorot;
  const tipAgorot = deps.tipOf(goodsAgorot);
  const names = new Map(price.priced.lines.map((l) => [l.id, deps.lineInfo(l.id)?.name ?? ''] as const));
  return {
    state,
    price,
    legs,
    outcomes: price.priced.voucherOutcomes,
    goodsAgorot,
    tipAgorot,
    dueAgorot: dueAgorot(goodsAgorot, tipAgorot, legs),
    rows: [...goodsVoucherRows(legs), ...discountVoucherRows(price.priced.voucherOutcomes, (id) => names.get(id) ?? '')],
    any: state.legs.length + state.discounts.length > 0,
  };
}

export class KioskVoucherSession<T extends { priced: PricedBasket }> {
  private current: VoucherSessionState;
  private readonly listeners = new Set<() => void>();
  /** One attempt per code: a retry of the same code redeems nothing twice. */
  private attempt: { code: string; id: string } | null = null;

  constructor(
    private deps: VoucherSessionDeps<T>,
    saleRef?: string,
  ) {
    this.current = initialVoucherState(saleRef);
  }

  /** The host's calls (they change with its render); the state stays. */
  use(deps: VoucherSessionDeps<T>): void {
    this.deps = deps;
  }

  get state(): VoucherSessionState {
    return this.current;
  }

  view(): VoucherView<T> {
    return voucherViewOf(this.current, this.deps);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<VoucherSessionState>): void {
    this.current = { ...this.current, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  /** A "voucher not taken" message cleared (the customer typed again, closed the window). */
  clearMessages(): void {
    if (this.current.error !== null || this.current.note !== null) this.set({ error: null, note: null });
  }

  /** A message for the customer on the payment step (a refusal the host makes itself: an order with a discount voucher is not taken to a till). */
  setError(error: string | null): void {
    this.set({ error, note: null });
  }

  /** The customer declined to give up the rest of a one-time voucher. */
  dismissForfeit(): void {
    this.set({ forfeit: null });
  }

  /** A voucher scanned or typed (or the same, its forfeit confirmed): applied to this order. */
  async redeem(raw: string, forfeitRest = false): Promise<void> {
    const code = this.deps.words.codeOf(raw);
    if (!code || this.current.busy) return;
    if (!this.attempt || this.attempt.code !== code) this.attempt = { code, id: newId() };
    const attemptId = this.attempt.id;
    this.set({ busy: true, error: null, note: this.deps.words.checking, forfeit: null });
    // The goods vouchers already taken as the basket pays them now (a discount voucher added since may have moved them).
    const earlier = this.view().legs;
    const r = await this.deps.call({ code, forfeitRest, clientRequestId: attemptId, saleRef: this.current.saleRef, earlier, discounts: this.current.discounts }).catch(
      (): VoucherResult => ({ kind: 'offline' }),
    );
    const words = this.deps.words;
    if (r.kind === 'ok') {
      this.attempt = null;
      this.set({ busy: false, error: null, legs: [...this.current.legs, r.leg] });
      const leg = this.view().legs.find((l) => l.redemptionId === r.leg.redemptionId) ?? r.leg;
      this.set({ note: words.appliedLeg(leg.amountAgorot) });
      this.coveredCheck();
      return;
    }
    if (r.kind === 'discount') {
      this.attempt = null;
      this.set({ busy: false, error: null, discounts: [...this.current.discounts, r.voucher] });
      const took = this.view().outcomes.find((o) => o.voucher.reservationId === r.voucher.reservationId)?.amountAgorot ?? 0;
      this.set({ note: words.appliedDiscount(r.voucher.serial, took) });
      this.coveredCheck();
      return;
    }
    // Nothing taken: why, in words. An unanswered attempt is retried with the same id (an answer lost on the way never redeems twice).
    if (r.kind !== 'offline' && r.kind !== 'forfeit') this.attempt = null;
    if (r.kind === 'forfeit') {
      this.set({ busy: false, note: null, error: null, forfeit: code });
      return;
    }
    const error = r.kind === 'offline' ? words.offline : r.kind === 'no_match' ? words.noMatch : words.reason(r.reason, r.message);
    this.set({ busy: false, note: null, error });
  }

  /** The vouchers pay all and no tip is left: the host goes on, once, on this answer. */
  private coveredCheck(): void {
    const v = this.view();
    if (v.any && v.dueAgorot === 0) this.deps.onCovered();
  }

  /** A voucher off the order ("הסרה"), until the payment starts: a discount voucher's hold released, a goods voucher reversed. */
  remove(id: string): void {
    if (this.current.busy) return;
    const discount = this.current.discounts.find((v) => v.reservationId === id);
    if (discount) {
      this.set({ discounts: this.current.discounts.filter((v) => v.reservationId !== id), note: null, error: null });
      this.deps.release([{ reservationId: id }]);
      return;
    }
    if (this.current.legs.some((v) => v.redemptionId === id)) {
      this.set({ legs: this.current.legs.filter((v) => v.redemptionId !== id), note: null, error: null });
      this.deps.reverse(id);
    }
  }

  /** The order left the checkout before it was paid: every voucher back on itself, and a new order starts. */
  giveBack(): void {
    const { legs, discounts } = this.current;
    for (const v of legs) this.deps.reverse(v.redemptionId);
    if (discounts.length > 0) this.deps.release(discounts.map((v) => ({ reservationId: v.reservationId })));
    this.attempt = null;
    this.current = initialVoucherState();
    for (const fn of [...this.listeners]) fn();
  }

  /** The order went on to its payment (or to the tills) with its vouchers: they stay with it; a new order starts clean. */
  reset(): void {
    this.attempt = null;
    this.current = initialVoucherState();
    for (const fn of [...this.listeners]) fn();
  }
}
