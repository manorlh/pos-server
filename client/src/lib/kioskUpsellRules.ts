/**
 * "הגדלת מכירה" on the kiosk — ONE TypeScript port of the Android kiosk's upsell rules, for the
 * Windows kiosk (kiosk-desktop, `@dash-lib/kioskUpsellRules`) and the browser kiosk (`/k`):
 *
 *  - the rules (pos-android domain/Menu.kt MenuCodec `upsells` + `kioskUpsells`, domain/UpsellPrompts.kt
 *    UpsellCodec): a kiosk-only rule is offered on the kiosk alone; another one where its `places`
 *    (else its older `where`) say — a till-only rule is never offered on a kiosk;
 *  - when (UpsellRule.isActiveAt): its days and hours, the hours after midnight belonging to the day
 *    a window that crosses it began;
 *  - what triggers it (UpsellMatch.triggers): a line of a product ("פריט") or of a category ("כל פריטי
 *    מחלקה", sub-categories expanded by the cloud), a step it names ("מעבר בין מסכים"), or every order
 *    (asked on the way to payment);
 *  - what it offers (UpsellChoices.expand): its products and its categories' products in the catalog's
 *    order, sold and in stock, never what the order already holds (the kiosk's `hideInCart`), at most 12;
 *  - which first: the highest priority, then the name, then the id; each rule once in an order, and no
 *    more rules in an order than `upsell.maxShown` (UpsellCaps.mayOffer; 0: no cap).
 *
 * Pure; no imports (the node tests compile it alone).
 */

export type UpsellPlace = 'quick' | 'tables' | 'kiosk';

/** One thing a rule offers: a product, or a category (with its sub-categories, as the cloud expanded them). */
export type UpsellChoiceRef = { type: 'product'; id: string } | { type: 'category'; id: string; categoryIds: string[] };

export interface KioskUpsellRule {
  id: string;
  name: string;
  /** "product" | "category" | "order" | "transition". */
  triggerType: string;
  triggerIds: string[];
  action: 'add' | 'upgrade';
  choices: UpsellChoiceRef[];
  prompt: string | null;
  message: string | null;
  showPrice: boolean;
  /** "HH:MM", both or neither. */
  startTime: string | null;
  endTime: string | null;
  /** 0 = Sunday … 6 = Saturday; empty: every day. */
  weekdays: number[];
  priority: number;
  display: 'card' | 'popup';
  /** The channels it is offered on. */
  places: UpsellPlace[];
  imageUrl: string | null;
  skipIfPresent: boolean;
  oncePerOrder: boolean;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const ints = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map((x) => Math.trunc(Number(x))) : [];

/** Its channels from the older `where` (UpsellWhere.places): before the kiosk had a place, quick orders' rules were the kiosk's too. */
function placesOfWhere(where: unknown): UpsellPlace[] {
  if (where === 'quick') return ['quick', 'kiosk'];
  if (where === 'tables') return ['tables'];
  return ['quick', 'tables', 'kiosk'];
}

function ruleOf(u: Row, kioskOnly: boolean): KioskUpsellRule | null {
  const id = str(u.id);
  if (id === null) return null;
  const choices: UpsellChoiceRef[] = (Array.isArray(u.options) ? (u.options as Row[]) : []).flatMap((o): UpsellChoiceRef[] => {
    const oid = str(o?.id);
    if (oid === null) return [];
    if (o.type === 'product') return [{ type: 'product', id: oid }];
    if (o.type === 'category') return [{ type: 'category', id: oid, categoryIds: [...new Set([...strings(o.categoryIds), oid])] }];
    return [];
  });
  const product = str(u.productId);
  // A rule from before options names one product; one with them may name none.
  if (product === null && choices.length === 0) return null;
  const listed = (Array.isArray(u.places) ? (u.places as unknown[]) : []).filter((p): p is UpsellPlace => p === 'quick' || p === 'tables' || p === 'kiosk');
  return {
    id,
    name: typeof u.name === 'string' ? u.name : '',
    triggerType: typeof u.triggerType === 'string' ? u.triggerType : '',
    triggerIds: strings(u.triggerIds),
    action: u.action === 'upgrade' ? 'upgrade' : 'add',
    choices: choices.length > 0 ? choices : [{ type: 'product', id: product! }],
    prompt: str(u.prompt),
    message: str(u.message),
    showPrice: u.showPrice !== false,
    startTime: str(u.startTime),
    endTime: str(u.endTime),
    weekdays: ints(u.weekdays),
    priority: Number.isFinite(Number(u.priority)) ? Math.trunc(Number(u.priority)) : 0,
    display: u.display === 'popup' ? 'popup' : 'card',
    places: kioskOnly ? ['kiosk'] : listed.length > 0 ? [...new Set(listed)] : placesOfWhere(u.where),
    imageUrl: str(u.imageUrl),
    skipIfPresent: u.skipIfPresent === null || u.skipIfPresent === undefined ? true : u.skipIfPresent !== false,
    oncePerOrder: u.oncePerOrder === true,
  };
}

/** The rules of the cloud's `menu` block (`upsells`, then `kioskUpsells` — the kiosk's alone), as MenuCodec reads them. */
export function upsellRulesOf(menu: Row | null | undefined): KioskUpsellRule[] {
  const rows = (k: string) => (menu && Array.isArray(menu[k]) ? (menu[k] as Row[]) : []);
  return [...rows('upsells').map((u) => ruleOf(u, false)), ...rows('kioskUpsells').map((u) => ruleOf(u, true))].filter((r): r is KioskUpsellRule => r !== null);
}

/** "HH:MM[:SS]" → minutes of the day, or null (LocalTime.parse). */
function minutesOf(text: string | null): number | null {
  if (text === null) return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** The device's local moment: its weekday (0 = Sunday) and the minute of the day. */
export interface UpsellNow {
  weekday: number;
  minute: number;
}

export function upsellNowOf(d: Date): UpsellNow {
  return { weekday: d.getDay(), minute: d.getHours() * 60 + d.getMinutes() };
}

/** Within its days and hours (UpsellRule.isActiveAt); the hours after midnight belong to the day the window began. */
export function upsellActiveAt(r: Pick<KioskUpsellRule, 'startTime' | 'endTime' | 'weekdays'>, now: UpsellNow): boolean {
  const start = minutesOf(r.startTime);
  const end = minutesOf(r.endTime);
  let day = now.weekday;
  if (start !== null && end !== null) {
    const inWindow = start <= end ? now.minute >= start && now.minute < end : now.minute >= start || now.minute < end;
    if (!inWindow) return false;
    if (start > end && now.minute < end) day = (day + 6) % 7;
  }
  return r.weekdays.length === 0 || r.weekdays.includes(day);
}

export const upsellAllows = (r: Pick<KioskUpsellRule, 'places'>, place: UpsellPlace) => r.places.includes(place);

/** The steps a kiosk has (UpsellSteps.BY_PLACE[KIOSK]); "every order" is asked at `to_pay`. */
export const KIOSK_UPSELL_STEPS = ['order_start', 'to_catalog', 'enter_category', 'to_cart', 'to_pay'] as const;

/** A line that just went in, or a step the order reached. */
export type UpsellMoment = { kind: 'line'; productId: string; categoryId: string | null } | { kind: 'step'; code: string };

/** The one trigger test (UpsellMatch.triggers), on the kiosk. */
export function upsellTriggers(r: KioskUpsellRule, moment: UpsellMoment): boolean {
  if (!upsellAllows(r, 'kiosk')) return false;
  const everyOrder = r.triggerType === 'order';
  const transition = r.triggerType === 'transition';
  if (moment.kind === 'line') {
    if (everyOrder || transition) return false;
    if (r.triggerType === 'category') return moment.categoryId !== null && r.triggerIds.includes(moment.categoryId);
    return r.triggerIds.includes(moment.productId);
  }
  if (transition) return (KIOSK_UPSELL_STEPS as readonly string[]).includes(moment.code.split(':')[0]) && r.triggerIds.includes(moment.code);
  if (everyOrder) return moment.code === 'to_pay';
  return false;
}

/** A catalog product as the offer reads it. */
export interface UpsellProduct {
  id: string;
  categoryId: string | null;
  /** Sold out / not sellable now. */
  soldOut: boolean;
}

/** The most tiles one offer holds (UpsellChoices.MAX). */
export const UPSELL_MAX_CHOICES = 12;

/** What a rule offers here (UpsellChoices.expand): its products, a category's in the catalog's order; never one of `exclude`. */
export function upsellChoices(r: KioskUpsellRule, catalog: readonly UpsellProduct[], exclude: ReadonlySet<string>): string[] {
  const byId = new Map(catalog.map((p) => [p.id, p] as const));
  const out: string[] = [];
  const take = (p: UpsellProduct | undefined) => {
    if (!p || p.soldOut || exclude.has(p.id) || out.includes(p.id)) return;
    out.push(p.id);
  };
  for (const ref of r.choices) {
    if (ref.type === 'product') take(byId.get(ref.id));
    else for (const p of catalog) if (p.categoryId !== null && ref.categoryIds.includes(p.categoryId)) take(p);
    if (out.length >= UPSELL_MAX_CHOICES) break;
  }
  return out.slice(0, UPSELL_MAX_CHOICES);
}

/** The order of the rules tried: the highest priority first, then the name, then the id (code-unit order, as Kotlin). */
const ruleOrder = (a: KioskUpsellRule, b: KioskUpsellRule) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** "עד כמה הצעות בהזמנה" (UpsellCaps.mayOffer): another rule may be asked in this order. */
export function upsellMayOffer(askedInOrder: number, maxShown: number): boolean {
  return maxShown <= 0 || askedInOrder < maxShown;
}

export interface UpsellOfferOut {
  rule: KioskUpsellRule;
  /** The products offered, in order (the first is the card's). */
  productIds: string[];
}

/**
 * The offer for a `moment` (a line added: UpsellEngine.offerFor with the kiosk's hideInCart; a step:
 * UpsellPrompts.atStep), or null: the highest-ordered rule it triggers, active now, not yet asked in
 * this order, under the cap, with something to offer that the order does not hold. Only "add" rules:
 * an upgrade goes through the meal window ("רוצים להפוך לארוחה?").
 */
export function kioskUpsellOffer(input: {
  rules: readonly KioskUpsellRule[];
  moment: UpsellMoment;
  now: UpsellNow;
  /** Every product id the order holds. */
  inCart: ReadonlySet<string>;
  catalog: readonly UpsellProduct[];
  asked: ReadonlySet<string>;
  maxShown: number;
}): UpsellOfferOut | null {
  if (!upsellMayOffer(input.asked.size, input.maxShown)) return null;
  const candidates = input.rules
    .filter((r) => r.action === 'add' && upsellTriggers(r, input.moment) && upsellActiveAt(r, input.now) && !input.asked.has(r.id))
    // "Every order" is never asked of an empty order (UpsellPrompts.atStep `selling`).
    .filter((r) => !(input.moment.kind === 'step' && r.triggerType === 'order' && input.inCart.size === 0))
    .sort(ruleOrder);
  // A line's own product is never offered with it (UpsellEngine.offerFor's exclude), nor anything the order holds.
  const exclude = new Set(input.inCart);
  if (input.moment.kind === 'line') exclude.add(input.moment.productId);
  for (const rule of candidates) {
    const productIds = upsellChoices(rule, input.catalog, exclude);
    if (productIds.length > 0) return { rule, productIds };
  }
  return null;
}

/**
 * The basket's offers (the Windows and browser kiosks' strip on the cart): the rules the order's lines
 * trigger, in the order the lines went in, then the cart step's and — on the way to payment — every
 * order's; each rule once, no more rules than the cap, no product twice, at most `limit` products.
 */
export function kioskBasketUpsells(input: {
  rules: readonly KioskUpsellRule[];
  lines: ReadonlyArray<{ productId: string; categoryId: string | null }>;
  now: UpsellNow;
  catalog: readonly UpsellProduct[];
  maxShown: number;
  limit: number;
}): UpsellOfferOut[] {
  const inCart = new Set(input.lines.map((l) => l.productId));
  if (inCart.size === 0) return [];
  const asked = new Set<string>();
  const offers: UpsellOfferOut[] = [];
  const shown = new Set<string>();
  const moments: UpsellMoment[] = [
    ...input.lines.map((l): UpsellMoment => ({ kind: 'line', productId: l.productId, categoryId: l.categoryId })),
    { kind: 'step', code: 'to_cart' },
    { kind: 'step', code: 'to_pay' },
  ];
  for (const moment of moments) {
    const offer = kioskUpsellOffer({ rules: input.rules, moment, now: input.now, inCart: new Set([...inCart, ...shown]), catalog: input.catalog, asked, maxShown: input.maxShown });
    if (!offer) continue;
    asked.add(offer.rule.id);
    offers.push(offer);
    for (const id of offer.productIds) shown.add(id);
    if (shown.size >= input.limit) break;
  }
  return offers;
}
