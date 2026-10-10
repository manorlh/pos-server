/**
 * "הגדלת מכירה" as the Android kiosk asks it — a WINDOW, one at a time (KioskViewModel afterAdd /
 * offerStep / takeUpsell / skipUpsell) — for both TypeScript kiosk hosts (the Windows kiosk's
 * renderer/kiosk/KioskApp.tsx and the browser kiosk's components/kiosk-web/web-kiosk-app.tsx), which
 * draw it with the shared `UpsellWindow`:
 *
 *  - right after a line goes in (`payment.stepModes.upsellItem`): the rule that line triggers — the
 *    flow's "added" waits for the window's answer, as on Android;
 *  - when the basket opens (`upsellSteps`, a rule naming the step `to_cart`) and on the way to payment
 *    (`upsellCheckout`, a rule naming `to_pay` or asked of every order) — once per order each; the
 *    payment waits for the answer;
 *  - each rule at most once in an order, no more rules than `upsell.maxShown`, nothing the order
 *    holds, nothing sold out (lib/kioskUpsellRules.ts); a line taken from a window never opens another;
 *  - "חובה": answered with "הוסף" / "לא תודה" only — no tap outside, no back.
 */

import { useState } from 'react';
import { stepMode, type KioskConfig } from '../lib/kioskConfig';
import { kioskUpsellOffer, upsellNowOf, type KioskUpsellRule, type UpsellMoment, type UpsellOfferOut } from '../lib/kioskUpsellRules';

/** What follows the window when it closes: the add it came after, the payment, or nothing (a step). */
export type UpsellThen = 'item_added' | 'checkout' | 'nothing';
export type UpsellMomentKey = 'item' | 'steps' | 'checkout';

export interface UpsellWindowState {
  offer: UpsellOfferOut;
  then: UpsellThen;
  moment: UpsellMomentKey;
  /** Taken from this window so far, per product id. */
  added: Record<string, number>;
  /** "חובה": no tap outside, no back. */
  required: boolean;
}

interface Offerable {
  id: string;
  categoryId: string | null;
  soldOut: boolean;
}

const MODE_KEY = { item: 'upsellItem', steps: 'upsellSteps', checkout: 'upsellCheckout' } as const;

export interface KioskUpsell {
  window: UpsellWindowState | null;
  /** A line went in (not from a window): true when a window opened — the flow's "added" waits for it. */
  afterAdd(productId: string, categoryId: string | null, inCart: readonly string[]): boolean;
  /** The order reached the basket or the way to payment: true when a window opened (the payment waits for it). */
  atStep(code: 'to_cart' | 'to_pay', inCart: readonly string[]): boolean;
  /** One more taken from the window (it stays for more). */
  taken(productId: string): void;
  /** The window closed: what follows it. */
  close(): UpsellThen | null;
  /** A new order. */
  reset(): void;
}

/** What a host notes about the windows (the Windows kiosk's funnel, "ביצועי קיוסקים"). */
export interface UpsellEvents {
  shown?(w: UpsellWindowState): void;
}

/**
 * `atRest`: the kiosk is at rest (no order) — the order's asked rules and steps are forgotten then, as a
 * new order starts afresh.
 */
export function useKioskUpsell(
  cfg: KioskConfig,
  rules: readonly KioskUpsellRule[] | undefined,
  products: readonly Offerable[],
  atRest: boolean,
  events?: UpsellEvents,
): KioskUpsell {
  const [win, setWin] = useState<UpsellWindowState | null>(null);
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const [steps, setSteps] = useState<ReadonlySet<string>>(() => new Set());
  // A new order starts afresh: when the kiosk comes to rest, what this order was asked is forgotten.
  const [rest, setRest] = useState(atRest);
  if (rest !== atRest) {
    setRest(atRest);
    if (atRest) {
      setWin(null);
      setAsked(new Set());
      setSteps(new Set());
    }
  }

  const offer = (moment: UpsellMomentKey, at: UpsellMoment, inCart: readonly string[], then: UpsellThen): boolean => {
    if (win) return false;
    const mode = stepMode(cfg, MODE_KEY[moment]);
    if (mode === 'off') return false;
    const o = kioskUpsellOffer({
      rules: rules ?? [],
      moment: at,
      now: upsellNowOf(new Date()),
      inCart: new Set(inCart),
      catalog: products.map((p) => ({ id: p.id, categoryId: p.categoryId, soldOut: p.soldOut })),
      asked,
      maxShown: cfg.upsell?.maxShown ?? 0,
    });
    if (!o) return false;
    setAsked(new Set([...asked, o.rule.id]));
    const next: UpsellWindowState = { offer: o, then, moment, added: {}, required: mode === 'required' };
    setWin(next);
    events?.shown?.(next);
    return true;
  };

  return {
    window: win,
    afterAdd: (productId, categoryId, inCart) => offer('item', { kind: 'line', productId, categoryId }, inCart, 'item_added'),
    atStep: (code, inCart) => {
      if (steps.has(code) || inCart.length === 0) return false;
      setSteps(new Set([...steps, code]));
      return offer(code === 'to_pay' ? 'checkout' : 'steps', { kind: 'step', code }, inCart, code === 'to_pay' ? 'checkout' : 'nothing');
    },
    taken: (productId) => setWin((w) => (w ? { ...w, added: { ...w.added, [productId]: (w.added[productId] ?? 0) + 1 } } : w)),
    close: () => {
      const then = win?.then ?? null;
      setWin(null);
      return then;
    },
    reset: () => {
      setWin(null);
      setAsked(new Set());
      setSteps(new Set());
    },
  };
}
