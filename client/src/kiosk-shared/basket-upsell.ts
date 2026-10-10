/**
 * The basket's offers ("הגדלת מכירה") for both TypeScript kiosk hosts — the Windows kiosk
 * (kiosk-desktop renderer/kiosk/KioskApp.tsx) and the browser kiosk (components/kiosk-web/
 * web-kiosk-app.tsx) call this, never a copy of their own. The rules are the Android kiosk's
 * (lib/kioskUpsellRules.ts): the menu's `upsells` + `kioskUpsells` on the kiosk's place, their days
 * and hours, priority, `upsell.maxShown`, category options with their sub-categories, nothing sold
 * out or already in the order.
 */

import { kioskBasketUpsells, upsellNowOf, type KioskUpsellRule } from '../lib/kioskUpsellRules';

/** The strip on the basket shows at most this many products. */
export const BASKET_UPSELL_LIMIT = 4;

interface Offerable {
  id: string;
  categoryId: string | null;
  soldOut: boolean;
}

/**
 * The products the basket offers, in order, and the rules they came from. `all`: the kiosk's
 * products in its catalog's order.
 */
export function basketUpsell<P extends Offerable>(
  rules: readonly KioskUpsellRule[] | undefined,
  maxShown: number | undefined,
  cart: ReadonlyArray<{ product: Offerable }>,
  all: readonly P[],
  now: Date = new Date(),
): { products: P[]; ruleIds: string[] } {
  if (!rules || rules.length === 0 || cart.length === 0) return { products: [], ruleIds: [] };
  const offers = kioskBasketUpsells({
    rules,
    lines: cart.map((l) => ({ productId: l.product.id, categoryId: l.product.categoryId })),
    now: upsellNowOf(now),
    catalog: all.map((p) => ({ id: p.id, categoryId: p.categoryId, soldOut: p.soldOut })),
    maxShown: maxShown ?? 0,
    limit: BASKET_UPSELL_LIMIT,
  });
  const byId = new Map(all.map((p) => [p.id, p] as const));
  const ids = [...new Set(offers.flatMap((o) => o.productIds))].slice(0, BASKET_UPSELL_LIMIT);
  return { products: ids.map((id) => byId.get(id)).filter((p): p is P => !!p), ruleIds: offers.map((o) => o.rule.id) };
}

/**
 * "רוצים להפוך לארוחה?" (KioskMealUpsell.optionsFor): the meals the menu's "upgrade" rules for the
 * kiosk offer for the dish (a product trigger), then the meals one of whose slots holds it — sellable
 * here, each with a slot that takes the dish, cheapest first (the meal's price with the dish's
 * upcharge in its slot), at most three. Never for a dish that is itself a meal.
 */
export function mealUpsellIds(
  rules: readonly KioskUpsellRule[] | undefined,
  productId: string,
  meals: Readonly<Record<string, ReadonlyArray<{ id: string; choices: ReadonlyArray<{ productId: string; upchargeAgorot: number }> }>>>,
  priceOf: (mealId: string) => number | null,
): string[] {
  if (meals[productId]?.length) return [];
  const fromRules = (rules ?? [])
    .filter((r) => r.action === 'upgrade' && r.places.includes('kiosk') && r.triggerType !== 'category' && r.triggerIds.includes(productId))
    .flatMap((r) => r.choices.flatMap((c) => (c.type === 'product' ? [c.id] : [])));
  const fromSlots = Object.entries(meals)
    .filter(([, slots]) => slots.some((s) => s.choices.some((c) => c.productId === productId)))
    .map(([id]) => id);
  const out: Array<{ id: string; price: number }> = [];
  for (const mealId of [...new Set([...fromRules, ...fromSlots])]) {
    const price = priceOf(mealId);
    const slots = meals[mealId];
    if (price === null || !slots?.length || out.some((o) => o.id === mealId)) continue;
    const home = slots.find((s) => s.choices.some((c) => c.productId === productId));
    if (!home) continue;
    out.push({ id: mealId, price: price + home.choices.find((c) => c.productId === productId)!.upchargeAgorot });
  }
  return out
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => a.price - b.price || a.i - b.i)
    .slice(0, 3)
    .map((o) => o.id);
}
