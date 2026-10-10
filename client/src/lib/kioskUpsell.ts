/**
 * "הגדלת מכירה" on the kiosk screens (the dashboard's preview and the Windows kiosk) — the
 * till's engine (pos-android domain/UpsellPrompts.kt: UpsellMatch, UpsellPrompts.atStep,
 * UpsellEngine.offerFor) over the menu's rules as the cloud sends them (`upsells` and
 * `kioskUpsells`, docs/SPEC_KIOSK.md §21). One trigger test for an item ("פריט"), a category
 * ("כל פריטי מחלקה"), every order and a step ("מעבר בין מסכים"); the kiosk offers each rule
 * once in an order, at most its cap of windows, never what the basket already holds.
 * No React, no Next: shared as it is.
 */

export type UpsellPlace = 'quick' | 'tables' | 'kiosk';
export const UPSELL_PLACES: UpsellPlace[] = ['quick', 'tables', 'kiosk'];
export type UpsellTriggerType = 'product' | 'category' | 'order' | 'transition';

/** The steps each channel has (the cloud's UPSELL_STEPS); after payment there is none. */
export const UPSELL_STEPS: Record<UpsellPlace, string[]> = {
  quick: ['order_start', 'enter_category', 'to_pay'],
  tables: ['table_open', 'enter_category', 'before_send', 'bill_request', 'to_pay'],
  kiosk: ['order_start', 'to_catalog', 'enter_category', 'to_cart', 'to_pay'],
};

export const enterCategory = (categoryId: string) => `enter_category:${categoryId}`;

/** A rule as the menu sends it (and as `/menu/upsells` lists it — the fields both have). */
export interface UpsellRuleLite {
  id: string;
  name: string;
  triggerType: UpsellTriggerType;
  /** Product / category ids, or step codes for a "transition". */
  triggerIds: string[];
  action?: 'add' | 'upgrade';
  options: Array<{ type: 'product' | 'category'; id: string; categoryIds?: string[] }>;
  prompt?: string | null;
  message?: string | null;
  showPrice?: boolean;
  /** The channels; absent (an older cloud): from `where`. */
  places?: UpsellPlace[] | null;
  where?: 'quick' | 'tables' | 'both' | null;
  imageUrl?: string | null;
  priority?: number;
  isActive?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  /** 0 = Sunday. */
  weekdays?: number[] | null;
  skipIfPresent?: boolean;
}

/** Its channels: before the kiosk had a place, it offered the rules for quick orders and for both. */
export function rulePlaces(r: Pick<UpsellRuleLite, 'places' | 'where'>): UpsellPlace[] {
  if (r.places && r.places.length > 0) return r.places;
  if (r.where === 'tables') return ['tables'];
  if (r.where === 'quick') return ['quick', 'kiosk'];
  return ['quick', 'tables', 'kiosk'];
}

export function stepExists(code: string, place: UpsellPlace): boolean {
  return UPSELL_STEPS[place].includes(code.split(':')[0]);
}

/** Where "בכל הזמנה" is asked: on the way to payment; a table at send and bill. */
export function orderSteps(place: UpsellPlace): string[] {
  return place === 'tables' ? ['before_send', 'bill_request'] : ['to_pay'];
}

export type UpsellMoment =
  | { kind: 'added'; productId: string; categoryIds: string[] }
  | { kind: 'step'; code: string };

/** The one trigger test (the till's UpsellMatch.triggers). Not its hours, nor once per order. */
export function upsellTriggers(rule: UpsellRuleLite, moment: UpsellMoment, place: UpsellPlace): boolean {
  if (!rulePlaces(rule).includes(place)) return false;
  if (moment.kind === 'added') {
    if (rule.triggerType === 'product') return rule.triggerIds.includes(moment.productId);
    if (rule.triggerType === 'category') return moment.categoryIds.some((c) => rule.triggerIds.includes(c));
    return false;
  }
  if (rule.triggerType === 'transition') return stepExists(moment.code, place) && rule.triggerIds.includes(moment.code);
  if (rule.triggerType === 'order') return orderSteps(place).includes(moment.code);
  return false;
}

const minutes = (hhmm: string | null | undefined): number | null => {
  const m = /^(\d\d):(\d\d)$/.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Within its days and hours at [now] (the hours after midnight belong to the day it began). */
export function upsellActiveAt(rule: Pick<UpsellRuleLite, 'startTime' | 'endTime' | 'weekdays' | 'isActive'>, now: Date): boolean {
  if (rule.isActive === false) return false;
  let day = now.getDay();
  const start = minutes(rule.startTime);
  const end = minutes(rule.endTime);
  if (start !== null && end !== null) {
    const t = now.getHours() * 60 + now.getMinutes();
    const inside = start <= end ? t >= start && t < end : t >= start || t < end;
    if (!inside) return false;
    if (start > end && t < end) day = (day + 6) % 7;
  }
  return !rule.weekdays || rule.weekdays.length === 0 || rule.weekdays.includes(day);
}

export interface UpsellPick {
  rule: UpsellRuleLite;
  /** The product ids offered, in the rule's order, up to six, none the basket holds. */
  items: string[];
}

/** At most this many items in one window (the till's KIOSK_UPSELL_MAX_ITEMS). */
export const KIOSK_UPSELL_MAX_ITEMS = 6;

/**
 * The window for [moment] on the kiosk, if any: the highest-priority rule it triggers, active
 * now, not yet asked in this order ([asked]), under the [cap] of windows, with something left
 * to offer once what the basket holds ([inCart]) is hidden. A rule for every order is never
 * asked of an empty basket. [productsOf]: a category's products, sellable, in the menu's order.
 */
export function pickKioskUpsell(
  rules: UpsellRuleLite[],
  moment: UpsellMoment,
  opts: {
    asked: string[];
    inCart: string[];
    cap: number;
    now: Date;
    sellable: (productId: string) => boolean;
    productsOf: (categoryIds: string[]) => string[];
  },
): UpsellPick | null {
  if (opts.cap > 0 && opts.asked.length >= opts.cap) return null;
  const candidates = rules
    .filter((r) => (r.action ?? 'add') === 'add' || moment.kind === 'added')
    .filter((r) => upsellTriggers(r, moment, 'kiosk'))
    .filter((r) => !opts.asked.includes(r.id) && upsellActiveAt(r, opts.now))
    .filter((r) => r.triggerType !== 'order' || opts.inCart.length > 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const exclude = new Set(opts.inCart);
  if (moment.kind === 'added') exclude.add(moment.productId);
  for (const rule of candidates) {
    const items: string[] = [];
    for (const o of rule.options) {
      const ids = o.type === 'product' ? [o.id] : opts.productsOf(o.categoryIds ?? [o.id]);
      for (const id of ids) if (!exclude.has(id) && opts.sellable(id) && !items.includes(id)) items.push(id);
    }
    if (items.length > 0) return { rule, items: items.slice(0, KIOSK_UPSELL_MAX_ITEMS) };
  }
  return null;
}
