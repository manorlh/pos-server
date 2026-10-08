/**
 * The dish's and the meal's choices on the kiosk's shared screens (ProductSheet, the steps view,
 * the meal window), priced by the one port of the Android till's rules (lib/kioskMoney.ts): free
 * choices, a quantity per option, "מעט / הרבה / בצד", a meal's components. The screens show what the
 * kiosk will charge; the Windows kiosk prices it again from its own catalog before the card.
 */

import { useState } from 'react';
import {
  canAddOne,
  changePickQty,
  chosenOptions,
  cyclePre,
  defaultPicks,
  dishOnDefaults,
  dishUnitAgorot,
  optionText,
  pickCharges,
  preFactor,
  picksValid,
  togglePick,
  priceKioskBasket,
  validatePicks,
  type ChosenOption,
  type LocalDateTime,
  type MenuGroup,
  type OptionPick,
  type PreModifier,
  type PricedBasket,
  type Promotion,
} from '@/lib/kioskMoney';
import type { CartPricing, PGroup, PLine, PProduct } from './preview-screens';

/** A screen group as the money rules read it (agorot from the option's exact price when the kiosk gave it). */
export function menuGroupOfP(g: PGroup): MenuGroup {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind ?? 'addon',
    minSelect: g.min,
    maxSelect: g.max,
    freeCount: g.freeCount ?? 0,
    allowQuantity: g.allowQuantity === true,
    allowPre: g.allowPre === true,
    options: g.options.map((o) => ({
      id: o.id,
      name: o.name,
      priceAgorot: o.priceAgorot ?? Math.round(o.price * 100),
      isDefault: o.isDefault === true,
      maxQty: o.maxQty ?? null,
    })),
  };
}

/**
 * What a fresh sheet starts with: the options marked default (the real kiosk's catalog says, as
 * DishDraft.start); a preview group that says nothing of defaults keeps its first option on a
 * required group.
 */
export function initialPicks(groups: readonly PGroup[]): Record<string, OptionPick[]> {
  return Object.fromEntries(
    groups.map((g) => {
      const known = g.options.some((o) => o.isDefault !== undefined);
      if (known) return [g.id, defaultPicks(menuGroupOfP(g))];
      return [g.id, g.min > 0 && g.options[0] ? [{ optionId: g.options[0].id, qty: 1, pre: null }] : []];
    }),
  );
}

/**
 * A dish's line on its options' defaults (quickAdd "always" — the wall of buttons, one tap): one
 * unit's price, the choices as the document names them and the cart's words; null when a group it
 * requires has no default (its window opens instead). The real kiosks only (their options say
 * which is the default).
 */
export function defaultsLine(product: Pick<PProduct, 'price' | 'priceAgorot'>, groups: readonly PGroup[]): { unitAgorot: number; options: NonNullable<PLine['options']>; texts: string[] } | null {
  const d = dishOnDefaults(product.priceAgorot ?? Math.round(product.price * 100), groups.map(menuGroupOfP));
  return d ? { unitAgorot: d.unitAgorot, options: lineOptionsOf(d.chosen), texts: d.chosen.map(optionText) } : null;
}

/** One unit of a basket line, in agorot (the sheet's exact figure when it set one). */
export function lineUnitAgorot(l: Pick<PLine, 'unit' | 'unitAgorot'>): number {
  return l.unitAgorot ?? Math.round(l.unit * 100);
}

/** The line's choices as the cart and the document name them ("הרבה טחינה", "בלי בצל ×2"). */
export function lineOptionsOf(chosen: readonly ChosenOption[]): NonNullable<PLine['options']> {
  return chosen.map((o) => ({
    groupId: o.groupId,
    optionId: o.optionId,
    name: o.name,
    price: o.priceAgorot / 100,
    qty: o.qty,
    pre: o.pre,
    chargedAgorot: o.chargedAgorot,
    kind: o.kind,
    groupName: o.groupName,
  }));
}

export interface DishSheet {
  groups: MenuGroup[];
  picks: Record<string, OptionPick[]>;
  chosen: ChosenOption[];
  unitAgorot: number;
  valid: boolean;
  /** The group still lacks its minimum. */
  lacking: (groupId: string) => boolean;
  isOn: (groupId: string, optionId: string) => boolean;
  qtyOf: (groupId: string, optionId: string) => number;
  preOf: (groupId: string, optionId: string) => PreModifier | null;
  /** A chosen unit the group's free count made free ("חינם"). */
  freeOf: (groupId: string, optionId: string) => boolean;
  canAdd: (groupId: string, optionId: string) => boolean;
  toggle: (groupId: string, optionId: string) => void;
  changeQty: (groupId: string, optionId: string, delta: number) => void;
  cyclePre: (groupId: string, optionId: string) => void;
  /** The cart's wording of the choices. */
  texts: string[];
}

/** The dish's sheet state (DishDraft): picks per group, priced on every change. */
export function useDishSheet(product: PProduct, groups: readonly PGroup[]): DishSheet {
  const [picks, setPicks] = useState<Record<string, OptionPick[]>>(() => initialPicks(groups));
  const money = groups.map(menuGroupOfP);
  const byId = new Map(money.map((g) => [g.id, g]));
  const chosen = chosenOptions(money, picks);
  const base = product.priceAgorot ?? Math.round(product.price * 100);
  const list = (gid: string) => picks[gid] ?? [];
  const update = (gid: string, next: (g: MenuGroup, cur: OptionPick[]) => OptionPick[]) => {
    const g = byId.get(gid);
    if (!g) return;
    setPicks((prev) => ({ ...prev, [gid]: next(g, prev[gid] ?? []) }));
  };
  return {
    groups: money,
    picks,
    chosen,
    unitAgorot: dishUnitAgorot(base, chosen),
    valid: picksValid(money, picks),
    lacking: (gid) => {
      const g = byId.get(gid);
      return !!g && validatePicks(g, list(gid)).includes('below_min');
    },
    isOn: (gid, oid) => list(gid).some((p) => p.optionId === oid),
    qtyOf: (gid, oid) => list(gid).filter((p) => p.optionId === oid).reduce((s, p) => s + p.qty, 0),
    preOf: (gid, oid) => list(gid).find((p) => p.optionId === oid)?.pre ?? null,
    freeOf: (gid, oid) => {
      const g = byId.get(gid);
      if (!g || g.freeCount <= 0) return false;
      const cur = list(gid);
      const charges = pickCharges(g, cur);
      const i = cur.findIndex((p) => p.optionId === oid);
      const price = g.options.find((o) => o.id === oid)?.priceAgorot ?? 0;
      return i >= 0 && price > 0 && charges[i] < price * cur[i].qty * preFactor(cur[i].pre);
    },
    canAdd: (gid, oid) => {
      const g = byId.get(gid);
      return !!g && canAddOne(g, list(gid), oid);
    },
    toggle: (gid, oid) => update(gid, (g, cur) => togglePick(g, cur, oid)),
    changeQty: (gid, oid, delta) => update(gid, (g, cur) => changePickQty(g, cur, oid, delta)),
    cyclePre: (gid, oid) => update(gid, (g, cur) => cyclePre(g, cur, oid)),
    texts: chosen.map(optionText),
  };
}

/**
 * The basket priced as the kiosk will charge it (lib/kioskMoney.ts priceKioskBasket — the till's
 * promotions): what the screens show (CartPricing) and every line's share.
 */
export function basketPricing(
  cart: readonly PLine[],
  promotions: readonly Promotion[],
  now: LocalDateTime,
  noDiscount: (productId: string) => boolean = () => false,
): { pricing: CartPricing; priced: PricedBasket } {
  const priced = priceKioskBasket(
    cart.map((l) => ({ id: l.key, productIds: [l.product.id], categoryId: l.product.categoryId, unitAgorot: lineUnitAgorot(l), qty: l.qty, noDiscount: noDiscount(l.product.id) })),
    promotions,
    now,
  );
  return {
    priced,
    pricing: {
      totalAgorot: priced.totalAgorot,
      promotionAgorot: priced.promotionAgorot,
      lines: Object.fromEntries(priced.lines.map((x) => [x.id, { promotionAgorot: x.promotionAgorot, promotionName: x.promotionName }])),
      applied: priced.applied.map((a) => ({ name: a.name, discountAgorot: a.discountAgorot })),
    },
  };
}

/** A basket line's choices as an order sends them: in the order picked, with their quantity and "מעט / הרבה / בצד". */
export function orderOptionsOf(l: Pick<PLine, 'options'>): Array<{ groupId: string; optionId: string; qty: number; pre: PreModifier | null }> {
  return (l.options ?? []).map((o) => ({ groupId: o.groupId, optionId: o.optionId, qty: o.qty ?? 1, pre: o.pre ?? null }));
}

/** A meal line's components as an order sends them (each slot's product; its choices are its defaults). */
export function orderMealOf(l: Pick<PLine, 'meal'>): { components: Array<{ slotId: string; productId: string }> } | null {
  return l.meal && l.meal.components.length > 0 ? { components: l.meal.components.map((c) => ({ slotId: c.slotId, productId: c.productId })) } : null;
}
