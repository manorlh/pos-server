/**
 * The kiosk's money — what a basket costs — ONE TypeScript port of the Android till's rules,
 * shared by the Windows kiosk (kiosk-desktop, through `@dash-lib/kioskMoney`) and the browser
 * kiosk (`/k`) and their shared screens:
 *
 *  - the menu's choices (pos-android domain/LineDetails.kt `ModifierMath`, domain/MenuOrdering.kt
 *    `DishDraft`; pos-server app/services/menu.py `validate_picks` / `price_picks`): free choices
 *    (`freeCount` — the cheapest units are free, ties to the earlier pick), a quantity per option
 *    (`allowQuantity`, the option's `maxQty`), "מעט / הרבה / בצד" (`allowPre`; "הרבה" doubles a unit);
 *  - meals (domain/MenuOrdering.kt `MealDraft`): the meal's price, each component's upcharge and
 *    its paid choices;
 *  - promotions (domain/Promotions.kt `PromotionEngine`, domain/PromotionMapper.kt): the seven
 *    kinds, item promotions first by priority (the best order within one), spend thresholds after,
 *    each application spread over its units by price (largest remainder, to the agora);
 *  - the basket's total after promotions (domain/Cart.kt `totals`), the VAT once (domain/Vat.kt).
 *
 * Pinned by the shared golden fixture server/tests/fixtures/kiosk_money_golden.json (whose header
 * names the Kotlin each case pins); the client's and the Windows kiosk's tests both run it.
 *
 * Money is integer agorot throughout. Pure; no imports (the node tests compile it alone).
 */

/* ------------------------------------------------------------------- money */

/**
 * Shekels (the cloud's float) → agorot, as the till's `Agorot.ofShekels`: the double's shortest
 * decimal form (BigDecimal.valueOf), HALF_UP — `Math.round(x * 100)` gets 0.145 wrong.
 */
export function agorotOfShekels(shekels: number): number {
  if (!Number.isFinite(shekels) || shekels === 0) return 0;
  const neg = shekels < 0;
  let s = String(Math.abs(shekels));
  let exp = 0;
  const e = s.indexOf('e');
  if (e >= 0) {
    exp = Number(s.slice(e + 1));
    s = s.slice(0, e);
  }
  const dot = s.indexOf('.');
  let int = dot >= 0 ? s.slice(0, dot) : s;
  let frac = dot >= 0 ? s.slice(dot + 1) : '';
  let shift = 2 + exp;
  if (shift >= 0) {
    frac = frac.padEnd(shift, '0');
    int += frac.slice(0, shift);
    frac = frac.slice(shift);
  } else {
    shift = -shift;
    const padded = int.padStart(shift + 1, '0');
    frac = padded.slice(padded.length - shift) + frac;
    int = padded.slice(0, padded.length - shift);
  }
  let n = Number(int || '0');
  if (frac.length > 0 && frac.charCodeAt(0) >= 53 /* '5' */) n += 1;
  return neg ? -n : n;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
/** Code-unit order, as Kotlin's String.compareTo (never the locale's). */
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The VAT inside a total (domain/Vat.kt): net = Math.round(total / (1 + rate)) once, VAT the rest. */
export function vatSplit(totalAgorot: number, rate: number): { netAgorot: number; vatAgorot: number } {
  const net = rate <= 0 ? totalAgorot : Math.floor(totalAgorot / (1 + rate) + 0.5);
  return { netAgorot: net, vatAgorot: totalAgorot - net };
}

/* -------------------------------------------------------------------- menu */

export type GroupKind = 'choice' | 'addon' | 'removal';
/** "מעט" / "הרבה" (twice the price) / "בצד" (domain/Menu.kt PreModifier). */
export type PreModifier = 'lite' | 'extra' | 'side';

export const PRE_HE: Record<PreModifier, string> = { lite: 'מעט', extra: 'הרבה', side: 'בצד' };

export function preFactor(pre: PreModifier | null | undefined): number {
  return pre === 'extra' ? 2 : 1;
}

export interface MenuOption {
  id: string;
  name: string;
  priceAgorot: number;
  isDefault: boolean;
  /** The most of this option in one dish; null: only the group's max. */
  maxQty: number | null;
}

export interface MenuGroup {
  id: string;
  name: string;
  kind: GroupKind;
  minSelect: number;
  /** Null: no upper limit. */
  maxSelect: number | null;
  /** This many units of choice are free — the cheapest ones. */
  freeCount: number;
  allowQuantity: boolean;
  allowPre: boolean;
  options: MenuOption[];
}

/** One choice in a group, in the order it was picked. */
export interface OptionPick {
  optionId: string;
  qty: number;
  pre: PreModifier | null;
}

/**
 * A group of the cloud's `menu` block (MenuCodec.parse). The kiosks' one rule of their own: a
 * "choice" group with no maximum takes one ("מידת עשייה").
 */
export function menuGroupOf(g: Record<string, unknown>): MenuGroup | null {
  if (typeof g.id !== 'string') return null;
  const kind: GroupKind = g.kind === 'choice' || g.kind === 'removal' ? g.kind : 'addon';
  const max = num(g.maxSelect);
  const options = (Array.isArray(g.options) ? (g.options as Array<Record<string, unknown>>) : [])
    .filter((o) => typeof o.id === 'string' && o.isActive !== false)
    .map((o) => {
      const maxQty = num(o.maxQty);
      return {
        id: String(o.id),
        name: String(o.name ?? ''),
        priceAgorot: agorotOfShekels(num(o.price) ?? 0),
        isDefault: o.isDefault === true,
        maxQty: maxQty !== null && maxQty > 0 ? Math.trunc(maxQty) : null,
      };
    });
  return {
    id: g.id,
    name: String(g.name ?? ''),
    kind,
    minSelect: Math.max(0, Math.trunc(num(g.minSelect) ?? 0)),
    maxSelect: max === null ? (kind === 'choice' ? 1 : null) : Math.max(1, Math.trunc(max)),
    freeCount: Math.max(0, Math.trunc(num(g.freeCount) ?? 0)),
    allowQuantity: g.allowQuantity === true,
    allowPre: g.allowPre === true,
    options,
  };
}

/** Why a group's choices do not answer it (ModifierMath.validate). */
export type PickProblem = 'below_min' | 'above_max' | 'unknown_option' | 'quantity_not_allowed' | 'duplicate' | 'pre_not_allowed' | 'option_above_max';

const optionOf = (g: MenuGroup, id: string) => g.options.find((o) => o.id === id) ?? null;

export function pickUnits(picks: readonly OptionPick[]): number {
  return picks.reduce((s, p) => s + Math.max(0, p.qty), 0);
}

/** How many of `optionId` are chosen. */
export function pickCount(picks: readonly OptionPick[], optionId: string): number {
  return picks.filter((p) => p.optionId === optionId).reduce((s, p) => s + Math.max(0, p.qty), 0);
}

/** One more of `optionId` still fits: the option's own limit and the group's. */
export function canAddOne(g: MenuGroup, picks: readonly OptionPick[], optionId: string): boolean {
  const option = optionOf(g, optionId);
  if (!option) return false;
  if (g.maxSelect !== null && pickUnits(picks) >= g.maxSelect) return false;
  const limit = option.maxQty ?? (g.allowQuantity ? null : 1);
  return limit === null || pickCount(picks, optionId) < limit;
}

export function validatePicks(g: MenuGroup, picks: readonly OptionPick[]): PickProblem[] {
  const problems: PickProblem[] = [];
  for (const id of [...new Set(picks.map((p) => p.optionId))]) {
    const limit = optionOf(g, id)?.maxQty ?? null;
    if (limit !== null && pickCount(picks, id) > limit) problems.push('option_above_max');
  }
  const seen = new Set<string>();
  for (const p of picks) {
    if (!optionOf(g, p.optionId)) {
      problems.push('unknown_option');
      continue;
    }
    if (p.qty > 1 && !g.allowQuantity) problems.push('quantity_not_allowed');
    if (seen.has(p.optionId) && !g.allowQuantity) problems.push('duplicate');
    seen.add(p.optionId);
    if (p.pre !== null && !g.allowPre) problems.push('pre_not_allowed');
  }
  const units = pickUnits(picks.filter((p) => optionOf(g, p.optionId)));
  if (units < g.minSelect) problems.push('below_min');
  if (g.maxSelect !== null && units > g.maxSelect) problems.push('above_max');
  return problems;
}

/**
 * What each pick costs per unit of the dish (ModifierMath.charges): "הרבה" doubles a unit; the
 * group's free units are the cheapest ones, whatever order they were picked in (ties: the earlier
 * pick), so editing a line never changes its price.
 */
export function pickCharges(g: MenuGroup, picks: readonly OptionPick[]): number[] {
  const units: Array<{ price: number; pick: number; n: number }> = [];
  picks.forEach((p, i) => {
    const price = (optionOf(g, p.optionId)?.priceAgorot ?? 0) * preFactor(p.pre);
    for (let n = 0; n < Math.max(0, p.qty); n++) units.push({ price, pick: i, n });
  });
  const free = new Set(
    [...units].sort((a, b) => a.price - b.price || a.pick - b.pick || a.n - b.n).slice(0, Math.max(0, g.freeCount)),
  );
  const charged = picks.map(() => 0);
  for (const u of units) if (!free.has(u)) charged[u.pick] += u.price;
  return charged;
}

/** The defaults a fresh sheet starts with: the options marked default, up to the group's max. */
export function defaultPicks(g: MenuGroup): OptionPick[] {
  const d = g.options.filter((o) => o.isDefault).map((o) => ({ optionId: o.id, qty: 1, pre: null }));
  return g.maxSelect !== null ? d.slice(0, g.maxSelect) : d;
}

/** Tap on an option (DishDraft.toggle): a single-choice group swaps to it; a multi-choice one toggles it. */
export function togglePick(g: MenuGroup, picks: readonly OptionPick[], optionId: string): OptionPick[] {
  if (picks.some((p) => p.optionId === optionId)) return picks.filter((p) => p.optionId !== optionId);
  if (g.maxSelect === 1) return [{ optionId, qty: 1, pre: null }];
  if (!canAddOne(g, picks, optionId)) return [...picks];
  return [...picks, { optionId, qty: 1, pre: null }];
}

/** "+" / "−" on an option of a group that takes quantities (DishDraft.changeQty). */
export function changePickQty(g: MenuGroup, picks: readonly OptionPick[], optionId: string, delta: number): OptionPick[] {
  const existing = picks.find((p) => p.optionId === optionId);
  if (delta > 0 && !canAddOne(g, picks, optionId)) return [...picks];
  if (!existing) return delta > 0 ? [...picks, { optionId, qty: delta, pre: null }] : [...picks];
  if (existing.qty + delta <= 0) return picks.filter((p) => p.optionId !== optionId);
  return picks.map((p) => (p.optionId === optionId ? { ...p, qty: p.qty + delta } : p));
}

/** The pre-modifier pill (DishDraft.cyclePre): רגיל → מעט → הרבה → בצד → רגיל. */
export function cyclePre(g: MenuGroup, picks: readonly OptionPick[], optionId: string): OptionPick[] {
  if (!g.allowPre) return [...picks];
  const order: Array<PreModifier | null> = [null, 'lite', 'extra', 'side'];
  return picks.map((p) => (p.optionId === optionId ? { ...p, pre: order[(order.indexOf(p.pre) + 1) % order.length] } : p));
}

/** A choice as the line keeps it (LineModifier): its price, and what it was charged per unit of the dish. */
export interface ChosenOption {
  groupId: string;
  groupName: string;
  kind: GroupKind;
  optionId: string;
  name: string;
  priceAgorot: number;
  qty: number;
  pre: PreModifier | null;
  chargedAgorot: number;
}

/** The picks of every group, priced (ModifierMath.lineModifiers over the dish's groups). */
export function chosenOptions(groups: readonly MenuGroup[], picks: Readonly<Record<string, readonly OptionPick[]>>): ChosenOption[] {
  return groups.flatMap((g) => {
    const list = picks[g.id] ?? [];
    const charges = pickCharges(g, list);
    return list.flatMap((p, i) => {
      const o = optionOf(g, p.optionId);
      return o
        ? [{ groupId: g.id, groupName: g.name, kind: g.kind, optionId: o.id, name: o.name, priceAgorot: o.priceAgorot, qty: p.qty, pre: p.pre, chargedAgorot: charges[i] }]
        : [];
    });
  });
}

/** Every group answered (DishDraft.isValid). */
export function picksValid(groups: readonly MenuGroup[], picks: Readonly<Record<string, readonly OptionPick[]>>): boolean {
  return groups.every((g) => validatePicks(g, picks[g.id] ?? []).length === 0);
}

/** One unit of the dish (DishDraft.unitPrice): its own price and what its choices were charged. */
export function dishUnitAgorot(baseAgorot: number, chosen: readonly Pick<ChosenOption, 'chargedAgorot'>[]): number {
  return baseAgorot + chosen.reduce((s, o) => s + o.chargedAgorot, 0);
}

/** "+ גבינה", "בלי בצל", "הרבה גבינה ×2" — the cart's wording (LineModifier.displayText). */
export function optionText(o: Pick<ChosenOption, 'kind' | 'name' | 'pre' | 'qty'>): string {
  const withPre = o.pre === null ? o.name : o.pre === 'side' ? `${o.name} ${PRE_HE.side}` : `${PRE_HE[o.pre]} ${o.name}`;
  const text = o.kind === 'removal' ? `בלי ${withPre}` : withPre;
  return o.qty > 1 ? `${text} ×${o.qty}` : text;
}

/* ------------------------------------------------------------------- meals */

export interface MealSlotChoice {
  productId: string;
  upchargeAgorot: number;
  isDefault: boolean;
}

/** A meal's slot ("מנה עיקרית", "שתייה") — domain/Menu.kt MealSlotDef. */
export interface MealSlot {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  /** Items of this slot one meal includes. */
  quantity: number;
  /** The same product may fill more than one of the slot's items. */
  allowRepeat: boolean;
  choices: MealSlotChoice[];
}

/** The meals of the cloud's `menu` block, by meal product id (MenuCodec.parse `meals`); a slot with no choice is left out. */
export function mealsOf(menu: Record<string, unknown> | null | undefined): Record<string, MealSlot[]> {
  const raw = menu && typeof menu.meals === 'object' && menu.meals ? (menu.meals as Record<string, unknown>) : {};
  const out: Record<string, MealSlot[]> = {};
  for (const [pid, list] of Object.entries(raw)) {
    const slots = (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [])
      .map((s) => {
        const max = Math.max(1, Math.trunc(num(s.maxSelect) ?? 1));
        return {
          id: String(s.id ?? ''),
          name: String(s.name ?? ''),
          minSelect: Math.max(0, Math.trunc(num(s.minSelect) ?? 1)),
          maxSelect: max,
          quantity: Math.max(max, Math.trunc(num(s.quantity) ?? max)),
          allowRepeat: s.allowRepeat === true,
          choices: (Array.isArray(s.options) ? (s.options as Array<Record<string, unknown>>) : [])
            .filter((o) => !!str(o.productId))
            .map((o) => ({ productId: String(o.productId), upchargeAgorot: agorotOfShekels(num(o.upcharge) ?? 0), isDefault: o.isDefault === true })),
        };
      })
      .filter((s) => s.choices.length > 0);
    if (slots.length > 0) out[pid] = slots;
  }
  return out;
}

/** The products chosen in a slot so far, in order; a fresh meal starts with the slot's defaults. */
export function defaultMealChoices(slot: MealSlot): string[] {
  return slot.choices.filter((c) => c.isDefault).slice(0, slot.maxSelect).map((c) => c.productId);
}

/**
 * Tap on a component in a slot (MealDraft.pick): a one-pick slot swaps to it; otherwise it is added
 * (a second time only where the slot allows repeats) up to what may be chosen, and a tap on one
 * already chosen — when no more can be added — takes its last one off.
 */
export function mealPick(slot: MealSlot, chosen: readonly string[], productId: string): string[] {
  const already = chosen.includes(productId);
  if (slot.maxSelect === 1) return already ? [] : [productId];
  if (already && (!slot.allowRepeat || chosen.length >= slot.maxSelect)) {
    const last = chosen.lastIndexOf(productId);
    return chosen.filter((_, i) => i !== last);
  }
  if (chosen.length >= slot.maxSelect) return [...chosen];
  return [...chosen, productId];
}

/** "−" on a repeated component: one fewer of it (MealDraft.unpickOne). */
export function mealUnpickOne(chosen: readonly string[], productId: string): string[] {
  const last = chosen.lastIndexOf(productId);
  return last < 0 ? [...chosen] : chosen.filter((_, i) => i !== last);
}

/** A slot that still needs a choice, or holds too many (MealDraft.slotProblem, components on their defaults). */
export function mealSlotProblem(slot: MealSlot, chosen: readonly string[]): boolean {
  return chosen.length < slot.minSelect || chosen.length > slot.maxSelect;
}

/** One component of a meal line (MealComponent): its upcharge and its own choices (the kiosk: their defaults). */
export interface MealComponentPrice {
  upchargeAgorot: number;
  options: readonly Pick<ChosenOption, 'chargedAgorot'>[];
}

/** What a component adds to one meal (MealComponent.extras, qty 1). */
export function componentExtrasAgorot(c: MealComponentPrice): number {
  return c.upchargeAgorot + c.options.reduce((s, o) => s + o.chargedAgorot, 0);
}

/** One meal (MealDraft.unitPrice): the meal's price, each component's upcharge and paid choices. */
export function mealUnitAgorot(mealAgorot: number, components: readonly MealComponentPrice[]): number {
  return mealAgorot + components.reduce((s, c) => s + componentExtrasAgorot(c), 0);
}

/* -------------------------------------------------------------- promotions */

/** Which units a promotion speaks of ("קבוצת מבצע"). Category ids arrive expanded. */
export interface PromoGroup {
  all: boolean;
  productIds: string[];
  categoryIds: string[];
  excludeProductIds: string[];
  excludeCategoryIds: string[];
}

const PROMO_ALL: PromoGroup = { all: true, productIds: [], categoryIds: [], excludeProductIds: [], excludeCategoryIds: [] };

export function promoGroupMatches(g: PromoGroup, ids: readonly string[], categoryId: string | null): boolean {
  if (ids.some((id) => g.excludeProductIds.includes(id))) return false;
  if (categoryId !== null && g.excludeCategoryIds.includes(categoryId)) return false;
  if (g.all) return true;
  return ids.some((id) => g.productIds.includes(id)) || (categoryId !== null && g.categoryIds.includes(categoryId));
}

/** A percent in basis points (1250 = 12.5%) or an amount. */
export type PromoDiscount = { kind: 'percent'; basisPoints: number } | { kind: 'amount'; agorot: number };

export type PromotionRule =
  | { type: 'buy_x_get_y'; target: PromoGroup; buy: number; get: number; getPercentBp: number }
  | { type: 'bundle_price'; target: PromoGroup; quantity: number; price: number }
  | { type: 'discount'; target: PromoGroup; discount: PromoDiscount }
  | { type: 'threshold_gift'; threshold: number; counted: PromoGroup; giftProductId: string; giftQuantity: number }
  | { type: 'threshold_item_price'; threshold: number; counted: PromoGroup; reward: PromoGroup; specialPrice: number }
  | { type: 'threshold_basket_discount'; threshold: number; counted: PromoGroup; discount: PromoDiscount }
  | { type: 'combo'; components: Array<{ group: PromoGroup; quantity: number }>; price: number };

export interface Promotion {
  id: string;
  name: string;
  /** The cloud's type name, carried onto the document as it came. */
  type: string;
  rule: PromotionRule;
  priority: number;
  /** yyyy-MM-dd, local dates. */
  validFrom: string | null;
  validTo: string | null;
  /** 0 = Sunday … 6 = Saturday; null: every day. */
  weekdays: number[] | null;
  /** Minutes of the day; both or neither; end before start crosses midnight. */
  startMinute: number | null;
  endMinute: number | null;
  /** Null: no limit. */
  maxApplications: number | null;
}

const isThreshold = (p: Promotion) => p.rule.type === 'threshold_gift' || p.rule.type === 'threshold_item_price' || p.rule.type === 'threshold_basket_discount';

/** "HH:MM" → minutes of the day, or null (PromotionMapper.minuteOf). */
export function minuteOf(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 2) return null;
  const h = /^-?\d+$/.test(parts[0]) ? Number(parts[0]) : NaN;
  const m = /^-?\d+$/.test(parts[1].slice(0, 2)) ? Number(parts[1].slice(0, 2)) : NaN;
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function moneyOf(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : agorotOfShekels(n);
}

function intOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function basisPointsOf(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.floor(n * 100 + 0.5);
}

function idsOf(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x) => x !== null && x !== undefined).map(String).filter((s) => s.trim()))] : [];
}

/** A promotion group of the cloud's config, or null when it names nothing (PromotionMapper.group). */
export function promoGroupOf(v: unknown): PromoGroup | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const g: PromoGroup = {
    all: m.all === true,
    productIds: idsOf(m.productIds),
    categoryIds: idsOf(m.categoryIds),
    excludeProductIds: idsOf(m.excludeProductIds),
    excludeCategoryIds: idsOf(m.excludeCategoryIds),
  };
  return g.all || g.productIds.length > 0 || g.categoryIds.length > 0 ? g : null;
}

function discountOf(config: Record<string, unknown>): PromoDiscount | null {
  if (config.discountKind === 'percent') {
    const bp = basisPointsOf(config.discountValue);
    return bp !== null && bp >= 1 && bp <= 10_000 ? { kind: 'percent', basisPoints: bp } : null;
  }
  if (config.discountKind === 'amount') {
    const a = moneyOf(config.discountValue);
    return a !== null && a > 0 ? { kind: 'amount', agorot: a } : null;
  }
  return null;
}

/** The rule of a cloud promotion, or null when this build cannot read it (PromotionMapper.ruleOf). */
export function promotionRuleOf(type: string, config: Record<string, unknown>): PromotionRule | null {
  switch (type) {
    case 'buy_x_get_y': {
      const target = promoGroupOf(config.target);
      const buy = intOf(config.buyQuantity);
      const get = intOf(config.getQuantity);
      const percent = basisPointsOf(config.getDiscountPercent) ?? 10_000;
      if (!target || buy === null || get === null || buy < 1 || get < 1) return null;
      return { type, target, buy, get, getPercentBp: Math.min(10_000, Math.max(1, percent)) };
    }
    case 'bundle_price': {
      const target = promoGroupOf(config.target);
      const quantity = intOf(config.quantity);
      const price = moneyOf(config.price);
      if (!target || quantity === null || quantity < 1 || price === null) return null;
      return { type, target, quantity, price };
    }
    case 'discount': {
      const target = promoGroupOf(config.target);
      const discount = discountOf(config);
      return target && discount ? { type, target, discount } : null;
    }
    case 'threshold_gift': {
      const threshold = moneyOf(config.threshold);
      const gift = config.giftProductId === null || config.giftProductId === undefined || !String(config.giftProductId).trim() ? null : String(config.giftProductId);
      if (threshold === null || threshold <= 0 || gift === null) return null;
      return { type, threshold, counted: promoGroupOf(config.counted) ?? PROMO_ALL, giftProductId: gift, giftQuantity: Math.max(1, intOf(config.giftQuantity) ?? 1) };
    }
    case 'threshold_item_price': {
      const threshold = moneyOf(config.threshold);
      const reward = promoGroupOf(config.reward);
      const price = moneyOf(config.specialPrice);
      if (threshold === null || threshold <= 0 || !reward || price === null) return null;
      return { type, threshold, counted: promoGroupOf(config.counted) ?? PROMO_ALL, reward, specialPrice: price };
    }
    case 'threshold_basket_discount': {
      const threshold = moneyOf(config.threshold);
      const discount = discountOf(config);
      if (threshold === null || threshold <= 0 || !discount) return null;
      return { type, threshold, counted: promoGroupOf(config.counted) ?? PROMO_ALL, discount };
    }
    case 'combo': {
      const raw = Array.isArray(config.components) ? (config.components as unknown[]) : null;
      const parts = raw?.map((p) => {
        if (!p || typeof p !== 'object') return null;
        const g = promoGroupOf((p as Record<string, unknown>).group);
        return g ? { group: g, quantity: Math.max(1, intOf((p as Record<string, unknown>).quantity) ?? 1) } : null;
      });
      const price = moneyOf(config.price);
      if (!parts || parts.length === 0 || parts.some((p) => p === null) || price === null) return null;
      return { type, components: parts as Array<{ group: PromoGroup; quantity: number }>, price };
    }
    default:
      return null;
  }
}

/** A promotion of `GET /sync/{m}/promotions`, or null when it cannot be read — never guessed at (PromotionMapper.fromDto). */
export function promotionOf(dto: Record<string, unknown>): Promotion | null {
  try {
    const config = dto.config && typeof dto.config === 'object' ? (dto.config as Record<string, unknown>) : {};
    const rule = promotionRuleOf(String(dto.type ?? ''), config);
    if (!rule || typeof dto.id !== 'string') return null;
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
    const days = Array.isArray(dto.weekdays) ? [...new Set((dto.weekdays as unknown[]).map((d) => intOf(d)).filter((d): d is number => d !== null))] : null;
    const max = intOf(dto.maxApplications);
    return {
      id: dto.id,
      name: String(dto.name ?? ''),
      type: String(dto.type),
      rule,
      priority: intOf(dto.priority) ?? 0,
      validFrom: date(dto.validFrom),
      validTo: date(dto.validTo),
      weekdays: days && days.length > 0 && days.length < 7 ? days : null,
      startMinute: typeof dto.startTime === 'string' ? minuteOf(dto.startTime) : null,
      endMinute: typeof dto.endTime === 'string' ? minuteOf(dto.endTime) : null,
      maxApplications: max !== null && max > 0 ? max : null,
    };
  } catch {
    return null;
  }
}

export function promotionsOf(dtos: unknown): Promotion[] {
  return (Array.isArray(dtos) ? dtos : []).flatMap((d) => (d && typeof d === 'object' ? [promotionOf(d as Record<string, unknown>)] : [])).filter((p): p is Promotion => p !== null);
}

/** The device's local date and time — the clock promotions run by. */
export interface LocalDateTime {
  /** yyyy-MM-dd */
  date: string;
  hour: number;
  minute: number;
}

export function localDateTimeOf(d: Date): LocalDateTime {
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hour: d.getHours(), minute: d.getMinutes() };
}

function dayBefore(date: string): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 0 = Sunday (א׳) … 6 = Saturday (ש׳). */
export function weekdayOf(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
}

/**
 * Whether it runs at `now` on this device's clock (Promotion.isActiveAt). The hours after midnight
 * of a window that crosses it (22:00–02:00) belong to the day the window began.
 */
export function promotionActiveAt(p: Promotion, now: LocalDateTime): boolean {
  let day = now.date;
  const start = p.startMinute;
  const end = p.endMinute;
  if (start !== null && end !== null && start !== end) {
    const minute = now.hour * 60 + now.minute;
    if (start < end) {
      if (minute < start || minute >= end) return false;
    } else if (minute >= start) {
      // tonight's window
    } else if (minute < end) {
      day = dayBefore(day);
    } else {
      return false;
    }
  }
  if (p.validFrom !== null && day < p.validFrom) return false;
  if (p.validTo !== null && day > p.validTo) return false;
  if (p.weekdays !== null && !p.weekdays.includes(weekdayOf(day))) return false;
  return true;
}

/** One basket line as promotions read it: its unit price with its choices, whole units. */
export interface PromoLine {
  id: string;
  /** Every id the product is known by. */
  productIds: string[];
  categoryId: string | null;
  unitAgorot: number;
  qty: number;
  /** "לא מקבל הנחות": counted towards a threshold, never discounted. */
  noDiscount?: boolean;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  type: string;
  applications: number;
  discountAgorot: number;
}

export interface LinePromotionShare {
  discountAgorot: number;
  promotionId: string;
  promotionName: string;
}

export interface GiftOffer {
  promotionId: string;
  name: string;
  productId: string;
  quantity: number;
}

export interface PromotionHint {
  promotionId: string;
  name: string;
  kind: 'gift' | 'item_price' | 'basket_discount';
  missingAgorot: number;
}

export interface PromotionOutcome {
  applied: AppliedPromotion[];
  /** By line id; a line with no entry has no promotion. */
  lineShares: Record<string, LinePromotionShare>;
  giftOffers: GiftOffer[];
  near: PromotionHint[];
  rewardsAvailable: PromotionHint[];
}

export const NO_PROMOTIONS: PromotionOutcome = { applied: [], lineShares: {}, giftOffers: [], near: [], rewardsAvailable: [] };

/** Above this many competing promotions of one priority, orders are chosen greedily. */
const MAX_PERMUTED = 6;
/** Units of one line considered one by one; the rest of a huge line is one portion. */
const MAX_UNITS_PER_LINE = 500;
/** "Close to a threshold": at most this fraction of it still to spend (basis points). */
const NEAR_BASIS_POINTS = 2_000;

interface Slot {
  line: number;
  price: number;
  quantity: number;
  whole: boolean;
  eligible: boolean;
}

interface BLine {
  id: string;
  ids: string[];
  categoryId: string | null;
  value: number;
}

interface Application {
  promotion: Promotion;
  /** Slot → agorot taken off it (insertion order kept). */
  shares: Map<number, number>;
  count: number;
}

const discountOfApp = (a: Application) => [...a.shares.values()].reduce((s, v) => s + v, 0);

interface Basket {
  lines: BLine[];
  slots: Slot[];
}

const slotMatches = (b: Basket, s: Slot, g: PromoGroup) => promoGroupMatches(g, b.lines[s.line].ids, b.lines[s.line].categoryId);
const lineMatches = (b: Basket, l: number, g: PromoGroup) => promoGroupMatches(g, b.lines[l].ids, b.lines[l].categoryId);

/** Amount × quantity, HALF_UP (Agorot.times(Double)). */
const timesQty = (agorot: number, q: number) => (Number.isInteger(q) ? agorot * q : Math.floor(agorot * q + 0.5));

function basketOf(lines: readonly PromoLine[]): Basket {
  const out: Basket = { lines: [], slots: [] };
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const index = out.lines.length;
    const eligible = !l.noDiscount;
    const gross = timesQty(l.unitAgorot, l.qty);
    out.lines.push({ id: l.id, ids: [...new Set(l.productIds)], categoryId: l.categoryId, value: gross });
    const whole = Math.abs(l.qty - Math.round(l.qty)) < 1e-9;
    if (whole) {
      const count = Math.round(l.qty);
      const units = Math.min(count, MAX_UNITS_PER_LINE);
      for (let i = 0; i < units; i++) out.slots.push({ line: index, price: l.unitAgorot, quantity: 1, whole: true, eligible });
      const rest = count - units;
      if (rest > 0) out.slots.push({ line: index, price: timesQty(l.unitAgorot, rest), quantity: rest, whole: false, eligible });
    } else {
      out.slots.push({ line: index, price: gross, quantity: l.qty, whole: false, eligible });
    }
  }
  return out;
}

function byPriority(promotions: readonly Promotion[]): Promotion[][] {
  const groups = new Map<number, Promotion[]>();
  for (const p of promotions) groups.set(p.priority, [...(groups.get(p.priority) ?? []), p]);
  return [...groups.keys()]
    .sort((a, b) => b - a)
    .map((k) => [...groups.get(k)!].sort((a, b) => textOrder(a.name, b.name) || textOrder(a.id, b.id)));
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

type Apply = (p: Promotion, consumed: boolean[]) => Application[];
const total = (apps: Application[]) => apps.reduce((s, a) => s + discountOfApp(a), 0);

/** The order to apply one priority's promotions in: the one that takes the most off. */
function bestOrder(group: Promotion[], consumed: boolean[], apply: Apply): Promotion[] {
  if (group.length <= 1) return group;
  const live = group.filter((p) => total(apply(p, [...consumed])) > 0);
  const idle = group.filter((p) => !live.includes(p));
  if (live.length <= 1) return [...live, ...idle];
  let best: Promotion[];
  if (live.length <= MAX_PERMUTED) {
    best = live;
    let most = -1;
    for (const order of permutations(live)) {
      const c = [...consumed];
      const sum = order.reduce((s, p) => s + total(apply(p, c)), 0);
      if (sum > most) {
        most = sum;
        best = order;
      }
    }
  } else {
    const left = [...live];
    const c = [...consumed];
    best = [];
    while (left.length > 0) {
      let pick = left[0];
      let pickValue = -Infinity;
      for (const p of left) {
        const v = total(apply(p, [...c]));
        if (v > pickValue) {
          pickValue = v;
          pick = p;
        }
      }
      best.push(pick);
      left.splice(left.indexOf(pick), 1);
      apply(pick, c);
    }
  }
  return [...best, ...idle];
}

/** Free, whole or not, matching, most expensive first. */
function free(b: Basket, consumed: boolean[], g: PromoGroup, wholeOnly: boolean): number[] {
  return b.slots
    .map((_, i) => i)
    .filter((i) => {
      const s = b.slots[i];
      return !consumed[i] && s.eligible && (!wholeOnly || s.whole) && slotMatches(b, s, g);
    })
    .sort((x, y) => b.slots[y].price - b.slots[x].price || x - y);
}

/** BigDecimal(amount × bp / 10000) HALF_UP — amounts here are never negative. */
const percentOf = (amount: number, bp: number) => Math.floor((amount * bp + 5_000) / 10_000);

/** `total` over `slots` in proportion to their price, to the agora: floors, then the largest remainders. */
function spread(b: Basket, amount: number, slots: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (amount <= 0 || slots.length === 0) return out;
  const weight = slots.reduce((s, i) => s + b.slots[i].price, 0);
  if (weight <= 0) return out;
  const capped = Math.min(amount, weight);
  const exact = new Map(slots.map((i) => [i, (capped * b.slots[i].price) / weight] as const));
  const floors = new Map(slots.map((i) => [i, Math.floor(exact.get(i)!)] as const));
  let left = capped - [...floors.values()].reduce((s, v) => s + v, 0);
  const byRemainder = [...slots].sort((x, y) => exact.get(y)! - floors.get(y)! - (exact.get(x)! - floors.get(x)!) || x - y);
  for (const i of byRemainder) {
    if (left <= 0) break;
    if (floors.get(i)! < b.slots[i].price) {
      floors.set(i, floors.get(i)! + 1);
      left--;
    }
  }
  for (const i of slots) if (floors.get(i)! > 0) out.set(i, floors.get(i)!);
  return out;
}

const limitOf = (p: Promotion) => (p.maxApplications !== null && p.maxApplications > 0 ? p.maxApplications : Number.MAX_SAFE_INTEGER);

function applyItem(b: Basket, p: Promotion, consumed: boolean[]): Application[] {
  const r = p.rule;
  const out: Application[] = [];
  switch (r.type) {
    case 'buy_x_get_y': {
      const size = r.buy + r.get;
      if (r.buy < 1 || r.get < 1 || r.getPercentBp <= 0) return out;
      const units = free(b, consumed, r.target, true);
      for (let k = 0; (k + 1) * size <= units.length && out.length < limitOf(p); k++) {
        const chunk = units.slice(k * size, (k + 1) * size);
        // Most expensive first: the last `get` of each chunk are its cheapest.
        const discount = chunk.slice(chunk.length - r.get).reduce((s, i) => s + percentOf(b.slots[i].price, r.getPercentBp), 0);
        if (discount <= 0) break;
        for (const i of chunk) consumed[i] = true;
        out.push({ promotion: p, shares: spread(b, discount, chunk), count: 1 });
      }
      return out;
    }
    case 'bundle_price': {
      if (r.quantity < 1) return out;
      const units = free(b, consumed, r.target, true);
      for (let k = 0; (k + 1) * r.quantity <= units.length && out.length < limitOf(p); k++) {
        const chunk = units.slice(k * r.quantity, (k + 1) * r.quantity);
        const discount = chunk.reduce((s, i) => s + b.slots[i].price, 0) - r.price;
        // Most expensive first: once a bundle saves nothing, no later one will.
        if (discount <= 0) break;
        for (const i of chunk) consumed[i] = true;
        out.push({ promotion: p, shares: spread(b, discount, chunk), count: 1 });
      }
      return out;
    }
    case 'discount': {
      const units = free(b, consumed, r.target, false)
        .map((i) => {
          const s = b.slots[i];
          const off = r.discount.kind === 'percent' ? percentOf(s.price, r.discount.basisPoints) : timesQty(r.discount.agorot, s.quantity);
          return [i, Math.min(s.price, Math.max(0, off))] as const;
        })
        .filter(([, off]) => off > 0)
        .sort((x, y) => y[1] - x[1] || x[0] - y[0])
        .slice(0, limitOf(p));
      for (const [i, off] of units) {
        consumed[i] = true;
        out.push({ promotion: p, shares: new Map([[i, off]]), count: 1 });
      }
      return out;
    }
    case 'combo': {
      if (r.components.length === 0) return out;
      while (out.length < limitOf(p)) {
        const taken: number[] = [];
        const trial = [...consumed];
        // The scarcest part first, so a broad part ("any drink") does not take the unit a narrow one needs.
        const parts = r.components
          .map((part, idx) => ({ part, idx, n: free(b, trial, part.group, true).length }))
          .sort((x, y) => x.n - y.n || x.idx - y.idx)
          .map((x) => x.part);
        let complete = true;
        for (const part of parts) {
          const units = free(b, trial, part.group, true).slice(0, part.quantity);
          if (units.length < part.quantity) {
            complete = false;
            break;
          }
          for (const i of units) trial[i] = true;
          taken.push(...units);
        }
        if (!complete) break;
        const discount = taken.reduce((s, i) => s + b.slots[i].price, 0) - r.price;
        if (discount <= 0) break;
        for (const i of taken) consumed[i] = true;
        out.push({ promotion: p, shares: spread(b, discount, taken), count: 1 });
      }
      return out;
    }
    default:
      return out;
  }
}

interface Notes {
  offers: GiftOffer[];
  near: PromotionHint[];
  rewards: PromotionHint[];
}

function countedTotal(b: Basket, after: number[], g: PromoGroup, leaveOut: (line: number) => boolean = () => false): number {
  return b.lines.reduce((s, _, i) => (lineMatches(b, i, g) && !leaveOut(i) ? s + Math.max(0, after[i]) : s), 0);
}

function isNear(threshold: number, sum: number): boolean {
  const missing = threshold - sum;
  return missing > 0 && missing * 10_000 <= threshold * NEAR_BASIS_POINTS;
}

/** What one unit adds to a counted total: its price, if its line is counted at all. */
function countedPart(b: Basket, counted: PromoGroup, slot: number): number {
  const s = b.slots[slot];
  return lineMatches(b, s.line, counted) ? s.price : 0;
}

function applyThreshold(b: Basket, p: Promotion, consumed: boolean[], after: number[], notes: Notes | null): Application[] {
  const r = p.rule;
  switch (r.type) {
    case 'threshold_gift': {
      const isGift = (line: number) => b.lines[line].ids.includes(r.giftProductId);
      // The gift never counts towards its own threshold.
      const sum = countedTotal(b, after, r.counted, isGift);
      if (r.threshold <= 0) return [];
      const earned = Math.min(Math.floor(sum / r.threshold), limitOf(p));
      if (earned <= 0) {
        if (notes && isNear(r.threshold, sum)) notes.near.push({ promotionId: p.id, name: p.name, kind: 'gift', missingAgorot: r.threshold - sum });
        return [];
      }
      const wanted = earned * r.giftQuantity;
      const inBasket = b.slots.map((_, i) => i).filter((i) => b.slots[i].whole && isGift(b.slots[i].line));
      const units = inBasket
        .filter((i) => !consumed[i] && b.slots[i].eligible)
        .sort((x, y) => b.slots[y].price - b.slots[x].price || x - y)
        .slice(0, wanted);
      // Units a promotion may not touch are not missing either.
      const blocked = inBasket.some((i) => !b.slots[i].eligible);
      const missing = wanted - units.length;
      if (notes && missing > 0 && !blocked) notes.offers.push({ promotionId: p.id, name: p.name, productId: r.giftProductId, quantity: missing });
      if (units.length === 0) return [];
      for (const i of units) consumed[i] = true;
      const count = Math.max(1, Math.floor((units.length + r.giftQuantity - 1) / r.giftQuantity));
      return [{ promotion: p, shares: new Map(units.map((i) => [i, b.slots[i].price] as const)), count }];
    }
    case 'threshold_item_price': {
      if (r.threshold <= 0) return [];
      const sum = countedTotal(b, after, r.counted);
      const candidates = free(b, consumed, r.reward, true)
        .filter((i) => b.slots[i].price > r.specialPrice)
        .sort((x, y) => b.slots[y].price - r.specialPrice - (b.slots[x].price - r.specialPrice) || x - y);
      const out: Application[] = [];
      let taken = 0;
      const used = new Set<number>();
      while (out.length < limitOf(p)) {
        const need = (out.length + 1) * r.threshold;
        // The reward unit is not counted towards the threshold it unlocks.
        const pick = candidates.find((c) => !used.has(c) && sum - taken - countedPart(b, r.counted, c) >= need);
        if (pick === undefined) break;
        used.add(pick);
        taken += countedPart(b, r.counted, pick);
        consumed[pick] = true;
        out.push({ promotion: p, shares: new Map([[pick, b.slots[pick].price - r.specialPrice]]), count: 1 });
      }
      if (notes && out.length === 0) {
        if (candidates.length === 0) {
          if (sum >= r.threshold) notes.rewards.push({ promotionId: p.id, name: p.name, kind: 'item_price', missingAgorot: 0 });
          else if (isNear(r.threshold, sum)) notes.near.push({ promotionId: p.id, name: p.name, kind: 'item_price', missingAgorot: r.threshold - sum });
        } else {
          const counted = sum - countedPart(b, r.counted, candidates[0]);
          if (isNear(r.threshold, counted)) notes.near.push({ promotionId: p.id, name: p.name, kind: 'item_price', missingAgorot: r.threshold - counted });
        }
      }
      return out;
    }
    case 'threshold_basket_discount': {
      if (r.threshold <= 0) return [];
      const sum = countedTotal(b, after, r.counted);
      if (sum < r.threshold) {
        if (notes && isNear(r.threshold, sum)) notes.near.push({ promotionId: p.id, name: p.name, kind: 'basket_discount', missingAgorot: r.threshold - sum });
        return [];
      }
      const units = free(b, consumed, r.counted, false);
      const base = units.reduce((s, i) => s + b.slots[i].price, 0);
      if (base <= 0) return [];
      let discount: number;
      let count: number;
      if (r.discount.kind === 'percent') {
        discount = percentOf(base, r.discount.basisPoints);
        count = 1;
      } else {
        const times = Math.max(1, Math.min(Math.floor(sum / r.threshold), limitOf(p)));
        discount = Math.min(r.discount.agorot * times, base);
        count = times;
      }
      if (discount <= 0) return [];
      for (const i of units) consumed[i] = true;
      return [{ promotion: p, shares: spread(b, discount, units), count }];
    }
    default:
      return [];
  }
}

/** The promotions on a basket at `now` (PromotionEngine.evaluate); the lines as rung up, with no promotion on them. */
export function evaluatePromotions(lines: readonly PromoLine[], promotions: readonly Promotion[], now: LocalDateTime): PromotionOutcome {
  const active = promotions.filter((p) => promotionActiveAt(p, now));
  if (active.length === 0) return NO_PROMOTIONS;
  const b = basketOf(lines);
  if (b.lines.length === 0) return NO_PROMOTIONS;
  const consumed = b.slots.map(() => false);
  const applications: Application[] = [];
  for (const group of byPriority(active.filter((p) => !isThreshold(p)))) {
    for (const p of bestOrder(group, consumed, (q, c) => applyItem(b, q, c))) applications.push(...applyItem(b, p, consumed));
  }
  // What each line costs now: what spend thresholds count.
  const after = b.lines.map((l) => l.value);
  for (const a of applications) for (const [slot, amount] of a.shares) after[b.slots[slot].line] -= amount;
  const notes: Notes = { offers: [], near: [], rewards: [] };
  for (const group of byPriority(active.filter(isThreshold))) {
    for (const p of bestOrder(group, consumed, (q, c) => applyThreshold(b, q, c, after, null))) applications.push(...applyThreshold(b, p, consumed, after, notes));
  }
  return outcomeOf(b, applications.filter((a) => discountOfApp(a) > 0), notes);
}

function outcomeOf(b: Basket, applications: Application[], notes: Notes): PromotionOutcome {
  const applied = new Map<string, AppliedPromotion>();
  const perLine = new Map<number, Map<string, number>>();
  const names = new Map<string, string>();
  for (const a of applications) {
    const p = a.promotion;
    names.set(p.id, p.name);
    const prev = applied.get(p.id);
    applied.set(p.id, {
      promotionId: p.id,
      name: p.name,
      type: p.type,
      applications: (prev?.applications ?? 0) + a.count,
      discountAgorot: (prev?.discountAgorot ?? 0) + discountOfApp(a),
    });
    for (const [slot, amount] of a.shares) {
      const line = b.slots[slot].line;
      const byPromo = perLine.get(line) ?? new Map<string, number>();
      byPromo.set(p.id, (byPromo.get(p.id) ?? 0) + amount);
      perLine.set(line, byPromo);
    }
  }
  const lineShares: Record<string, LinePromotionShare> = {};
  for (const [line, byPromo] of perLine) {
    let top: [string, number] | null = null;
    for (const entry of byPromo) if (top === null || entry[1] > top[1]) top = entry;
    lineShares[b.lines[line].id] = {
      discountAgorot: [...byPromo.values()].reduce((s, v) => s + v, 0),
      promotionId: top![0],
      promotionName: names.get(top![0])!,
    };
  }
  return { applied: [...applied.values()], lineShares, giftOffers: notes.offers, near: notes.near, rewardsAvailable: notes.rewards };
}

/* ------------------------------------------------------------------ basket */

export interface PricedLine {
  id: string;
  unitAgorot: number;
  qty: number;
  /** unit × qty, before promotions. */
  grossAgorot: number;
  promotionAgorot: number;
  promotionId: string | null;
  promotionName: string | null;
  /** What the line costs: gross less its promotions' share. */
  totalAgorot: number;
}

export interface PricedBasket {
  lines: PricedLine[];
  grossAgorot: number;
  promotionAgorot: number;
  /** What the goods cost — what the customer pays before any tip. */
  totalAgorot: number;
  applied: AppliedPromotion[];
  itemCount: number;
}

/** The basket priced as it will be paid and documented (KioskViewModel.price → Cart.totals): promotions applied. */
export function priceKioskBasket(lines: readonly PromoLine[], promotions: readonly Promotion[], now: LocalDateTime): PricedBasket {
  const outcome = lines.length === 0 || promotions.length === 0 ? NO_PROMOTIONS : evaluatePromotions(lines, promotions, now);
  const priced = lines.map((l) => {
    const share = outcome.lineShares[l.id];
    const gross = timesQty(l.unitAgorot, l.qty);
    const promo = share?.discountAgorot ?? 0;
    return {
      id: l.id,
      unitAgorot: l.unitAgorot,
      qty: l.qty,
      grossAgorot: gross,
      promotionAgorot: promo,
      promotionId: share?.promotionId ?? null,
      promotionName: share?.promotionName ?? null,
      totalAgorot: gross - promo,
    };
  });
  const gross = priced.reduce((s, l) => s + l.grossAgorot, 0);
  const promo = priced.reduce((s, l) => s + l.promotionAgorot, 0);
  return {
    lines: priced,
    grossAgorot: gross,
    promotionAgorot: promo,
    totalAgorot: gross - promo,
    applied: outcome.applied,
    itemCount: Math.ceil(lines.reduce((s, l) => s + l.qty, 0)),
  };
}
