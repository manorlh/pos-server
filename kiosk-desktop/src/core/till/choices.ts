/**
 * "תוספות, ארוחות והערות" in the Windows till's cart — the Android till's menu layer on the sell screen (pos-android
 * domain/Menu.kt `needsSheet` / `opensSheet`, domain/MenuOrdering.kt DishDraft / MealDraft, ui/sell/MenuSheets.kt
 * DishSheet / MealBuilderSheet, ui/sell/MenuSheetState.kt; pos-server docs/SPEC_MENU_MODIFIERS.md §11):
 *
 *  - a tap on a meal, or on a dish with a group that must be answered, opens its sheet; with "תוספות — חלון קופץ
 *    אוטומטי" (`modifiersAutoOpen`) any dish with groups does, with "הערות — חלון קופץ אוטומטי" (`notesAutoOpen`) a dish
 *    with note chips of its own (or its category's) does — the shop's notes for every dish never do;
 *  - any other tap adds the dish on its options' defaults (DishDraft.start);
 *  - the sheet: each group in order with "חובה" / "בחירה אחת" / "עד N" / "N חינם", the picks (a quantity, "מעט / הרבה /
 *    בצד" where the group allows them), the note chips, "! חשוב", free text, the diner's allergies with "שימו לב: המנה
 *    מכילה …", the quantity, and one primary action "הוסף ₪xx" / "עדכן ₪xx"; a meal: a step per slot, then "סיכום".
 *
 * The money is the kiosk's own shared rules (client lib/kioskMoney.ts — the Android pricing corpus pins them): the engine
 * prices the line from the catalog, never from these figures; the sheet only shows them. Pure (test/tillChoices.test.ts).
 */

import {
  PRE_HE,
  canAddOne,
  changePickQty,
  chosenOptions,
  cyclePre,
  defaultMealChoices,
  defaultPicks,
  dishUnitAgorot,
  mealPick,
  mealSlotProblem,
  mealUnitAgorot,
  mealUnpickOne,
  optionText,
  picksValid,
  togglePick,
  validatePicks,
  type ChosenOption,
  type MenuGroup,
  type OptionPick,
  type PreModifier,
} from '@dash-lib/kioskMoney';

/** The Android strings (res/values/strings.xml, `menu_*`), word for word. */
export const CHOICES_TEXT = {
  required: 'חובה',
  single: 'בחירה אחת',
  upTo: (n: number) => `עד ${n}`,
  free: (n: number) => `${n} חינם`,
  without: (name: string) => `בלי ${name}`,
  preNone: 'רגיל',
  add: (total: string) => `הוסף ${total}`,
  update: (total: string) => `עדכן ${total}`,
  notes: 'הערות למטבח',
  noteHint: 'הערה חופשית (בלי מלח, לילד…)',
  important: 'חשוב',
  allergy: 'אלרגיה ל…',
  contains: (list: string) => `מכיל: ${list}`,
  allergyConflict: (list: string) => `שימו לב: המנה מכילה ${list}`,
  allergyDeclared: (list: string) => `אלרגיה: ${list}`,
  next: 'הבא',
  back: 'הקודם',
  summary: 'סיכום',
  slotChoose: (n: number) => `בחרו ${n}`,
  slotIncluded: (n: number) => `כלולים ${n}`,
  removeOne: 'הסר אחד',
  included: 'כלול',
  maxReached: 'הגעתם למקסימום בקבוצה — אפשר להסיר בחירה ולבחור אחרת',
  customize: 'התאמה אישית',
  edit: 'עריכת המנה',
  close: 'סגור',
  /** The engine's refusals of a line whose choices do not answer its groups. */
  groupMissing: (group: string) => `יש לבחור ב«${group}»`,
  mealMissing: (slot: string) => `יש לבחור ב«${slot}»`,
} as const;

/** The allergens the sheet offers (domain/Menu.kt `Allergen`, in its fixed order): the cloud's code, the Hebrew. */
export const ALLERGENS: ReadonlyArray<{ code: string; he: string; main: boolean }> = [
  { code: 'gluten', he: 'גלוטן', main: true },
  { code: 'milk', he: 'חלב', main: true },
  { code: 'nuts', he: 'אגוזים', main: true },
  { code: 'eggs', he: 'ביצים', main: true },
  { code: 'peanuts', he: 'בוטנים', main: true },
  { code: 'fish', he: 'דגים', main: true },
  { code: 'soy', he: 'סויה', main: true },
  { code: 'sesame', he: 'שומשום', main: true },
  { code: 'celery', he: 'סלרי', main: false },
  { code: 'mustard', he: 'חרדל', main: false },
  { code: 'sulphites', he: 'סולפיטים', main: false },
  { code: 'lupin', he: 'תורמוס', main: false },
  { code: 'molluscs', he: 'רכיכות', main: false },
  { code: 'crustaceans', he: 'סרטנים', main: false },
];

/** The till parameters (MenuSheetState.kt): each off unless "true". */
export const PARAM_MODIFIERS_AUTO_OPEN = 'modifiersAutoOpen';
export const PARAM_NOTES_AUTO_OPEN = 'notesAutoOpen';

/** A free note's longest (TableExtras.NOTE_MAX). */
export const NOTE_MAX = 120;
/** A configured line's quantity in the sheet (DishSheet's stepper). */
export const SHEET_QTY_MAX = 99;

/* ------------------------------------------------------------------ the wire */

/** A choice as the till's line keeps it (OrderLineIn's): the group, the option, how many, "מעט / הרבה / בצד". */
export interface LineOption {
  groupId: string;
  optionId: string;
  qty?: number;
  pre?: PreModifier | null;
}

/** A meal's component: the slot it fills, the product, its own choices (absent: its defaults). */
export interface LineComponent {
  slotId: string;
  productId: string;
  options?: LineOption[];
}

/** What a configured line carries besides its product and quantity. */
export interface LineChoices {
  options: LineOption[];
  notes: string[];
  meal: { components: LineComponent[] } | null;
  important: boolean;
  /** The diner's allergies, in Hebrew (the kitchen ticket's words), in the fixed order. */
  allergies: string[];
}

export const NO_CHOICES: LineChoices = { options: [], notes: [], meal: null, important: false, allergies: [] };

/* ------------------------------------------------------------- the catalog's */

/** A group as the till's catalog sends it (the kiosk's KGroup, minus the pictures). */
export interface ChoiceGroupView {
  id: string;
  name: string;
  kind: 'choice' | 'addon' | 'removal';
  min: number;
  max: number | null;
  freeCount: number;
  allowQuantity: boolean;
  allowPre: boolean;
  options: Array<{ id: string; name: string; priceAgorot: number; isDefault: boolean; maxQty: number | null }>;
}

/** A meal's slot as the till's catalog sends it, each choice with its name and its own groups. */
export interface MealSlotView {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  quantity: number;
  allowRepeat: boolean;
  choices: Array<{ productId: string; name: string; upchargeAgorot: number; isDefault: boolean; groupIds: string[] }>;
}

/** What may be chosen with a product (absent on the catalog's product: nothing). */
export interface ProductChoices {
  groupIds: string[];
  meal?: MealSlotView[];
  /** Its note chips (its own or its category's first, then the shop's for every dish). */
  notes: string[];
  /** It has note chips of its own or its category's (not only the shop's for every dish). */
  ownNotes: boolean;
  /** A meal, or a group that must be answered: a tap always opens the sheet (Menu.needsSheet). */
  needsSheet: boolean;
}

export function moneyGroup(g: ChoiceGroupView): MenuGroup {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    minSelect: g.min,
    maxSelect: g.max,
    freeCount: g.freeCount,
    allowQuantity: g.allowQuantity,
    allowPre: g.allowPre,
    options: g.options.map((o) => ({ id: o.id, name: o.name, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty })),
  };
}

/** A group must be answered ("חובה"). */
export const groupRequired = (g: Pick<ChoiceGroupView, 'min'>) => g.min > 0;

/** Menu.needsSheet: a meal, or a dish with a required group. */
export function needsSheet(groups: readonly Pick<ChoiceGroupView, 'min'>[], meal: readonly unknown[] | null | undefined): boolean {
  return (meal?.length ?? 0) > 0 || groups.some(groupRequired);
}

/** Menu.opensSheet: [needsSheet], or any group with `modifiersAutoOpen`, or note chips of its own with `notesAutoOpen`. */
export function opensSheet(c: ProductChoices | null | undefined, auto: { addOns: boolean; notes: boolean }): boolean {
  if (!c) return false;
  return c.needsSheet || (auto.addOns && c.groupIds.length > 0) || (auto.notes && c.ownNotes);
}

/** "true" (any case, trimmed) turns a parameter on. */
export function paramOn(v: unknown): boolean {
  return String(v ?? '').trim().toLowerCase() === 'true';
}

/* ------------------------------------------------------------- the engine's */

/** The picks of a line's options, per group (options of groups it does not have are dropped). */
export function picksOf(groups: readonly MenuGroup[], options: readonly LineOption[]): Record<string, OptionPick[]> {
  const out: Record<string, OptionPick[]> = {};
  for (const o of options) {
    const g = groups.find((x) => x.id === o.groupId);
    if (!g) continue;
    (out[g.id] ??= []).push({ optionId: o.optionId, qty: Math.max(1, Math.trunc(o.qty ?? 1)), pre: o.pre ?? null });
  }
  return out;
}

/** The defaults a dish goes in with on a plain tap (DishDraft.start). */
export function defaultOptions(groups: readonly MenuGroup[]): LineOption[] {
  return groups.flatMap((g) => defaultPicks(g).map((p) => ({ groupId: g.id, optionId: p.optionId, qty: p.qty, pre: p.pre })));
}

/** Why a dish's options do not answer its groups (the first group's words), or null. */
export function optionsRefusal(groups: readonly MenuGroup[], options: readonly LineOption[]): string | null {
  if (options.some((o) => !groups.some((g) => g.id === o.groupId && g.options.some((x) => x.id === o.optionId)))) return 'בחירה לא מוכרת';
  const picks = picksOf(groups, options);
  for (const g of groups) if (validatePicks(g, picks[g.id] ?? []).length > 0) return CHOICES_TEXT.groupMissing(g.name);
  return null;
}

/** Why a meal's components do not answer its slots (and each component its groups), or null. */
export function mealRefusal(slots: readonly MealSlotView[], meal: LineChoices['meal'], groupsOf: (productId: string) => MenuGroup[]): string | null {
  const components = meal?.components ?? [];
  for (const c of components) {
    const slot = slots.find((s) => s.id === c.slotId);
    if (!slot || !slot.choices.some((x) => x.productId === c.productId)) return 'בחירה לא מוכרת';
  }
  for (const slot of slots) {
    const chosen = components.filter((c) => c.slotId === slot.id);
    const valid = (productId: string) => {
      const groups = groupsOf(productId);
      const own = chosen.find((c) => c.productId === productId)?.options;
      const picks = own && own.length > 0 ? picksOf(groups, own) : Object.fromEntries(groups.map((g) => [g.id, defaultPicks(g)]));
      return picksValid(groups, picks) && (!own || optionsRefusal(groups, own) === null);
    };
    if (mealSlotProblem({ ...slot, choices: slot.choices }, chosen.map((c) => c.productId), valid)) return CHOICES_TEXT.mealMissing(slot.name);
  }
  return null;
}

/** Two lines may be one: the same product with the same choices, no notes and no meal. */
export function sameChoices(a: LineChoices, b: LineChoices): boolean {
  if (a.notes.length > 0 || b.notes.length > 0 || a.meal || b.meal || a.important || b.important || a.allergies.length > 0 || b.allergies.length > 0) return false;
  const key = (l: LineChoices) =>
    JSON.stringify(
      [...l.options].map((o) => [o.groupId, o.optionId, o.qty ?? 1, o.pre ?? null]).sort((x, y) => String(x).localeCompare(String(y))),
    );
  return key(a) === key(b);
}

/** The notes as the line carries them: the chips picked, then the free text — trimmed, no blanks, each once. */
export function cleanNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n !== 'string') continue;
    const t = n.trim().slice(0, NOTE_MAX);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 20);
}

/** The diner's allergies: known Hebrew names only (codes accepted too), in the fixed order. */
export function cleanAllergies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()));
  return ALLERGENS.filter((a) => wanted.has(a.he) || wanted.has(a.code)).map((a) => a.he);
}

const PRES = new Set(['lite', 'extra', 'side']);

/** A line's options as a screen sent them (shape only; the groups decide the rest). */
export function cleanOptions(raw: unknown): LineOption[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 60) return null;
  const out: LineOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    if (typeof r.groupId !== 'string' || typeof r.optionId !== 'string') return null;
    const qty = r.qty === undefined ? 1 : r.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 99) return null;
    const pre = r.pre === undefined || r.pre === null ? null : PRES.has(String(r.pre)) ? (r.pre as PreModifier) : undefined;
    if (pre === undefined) return null;
    out.push({ groupId: r.groupId, optionId: r.optionId, qty, pre });
  }
  return out;
}

/** A meal as a screen sent it (shape only). */
export function cleanMeal(raw: unknown): LineChoices['meal'] | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const list = (raw as { components?: unknown }).components;
  if (!Array.isArray(list) || list.length > 40) return undefined;
  const components: LineComponent[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') return undefined;
    const r = c as Record<string, unknown>;
    if (typeof r.slotId !== 'string' || typeof r.productId !== 'string') return undefined;
    const options = cleanOptions(r.options);
    if (options === null) return undefined;
    components.push({ slotId: r.slotId, productId: r.productId, ...(options.length > 0 ? { options } : {}) });
  }
  return { components };
}

/* --------------------------------------------------------------- the sheets */

/** A dish being chosen (DishDraft): its groups' picks, the notes, the allergies, how many. */
export interface DishDraft {
  productId: string;
  name: string;
  baseAgorot: number;
  groups: MenuGroup[];
  picks: Record<string, OptionPick[]>;
  /** The chips picked (in the order tapped). */
  chips: string[];
  noteText: string;
  important: boolean;
  allergies: string[];
  qty: number;
  /** "עדכן": the cart line being changed; null — a new line. */
  editing: string | null;
  showErrors: boolean;
}

export function startDish(p: { id: string; name: string; priceAgorot: number }, groups: readonly MenuGroup[], chipsOffered: readonly string[], line?: { lineId: string; qty: number; choices: LineChoices } | null): DishDraft {
  const fromLine = line?.choices ?? null;
  const picks = fromLine ? picksOf(groups, fromLine.options) : Object.fromEntries(groups.map((g) => [g.id, defaultPicks(g)]));
  const chips = fromLine ? fromLine.notes.filter((n) => chipsOffered.includes(n)) : [];
  const free = fromLine ? fromLine.notes.filter((n) => !chipsOffered.includes(n)).join(' · ') : '';
  return {
    productId: p.id,
    name: p.name,
    baseAgorot: p.priceAgorot,
    groups: [...groups],
    picks,
    chips,
    noteText: free,
    important: fromLine?.important ?? false,
    allergies: fromLine?.allergies ?? [],
    qty: line?.qty ?? 1,
    editing: line?.lineId ?? null,
    showErrors: false,
  };
}

const groupOf = (d: { groups: readonly MenuGroup[] }, id: string) => d.groups.find((g) => g.id === id) ?? null;

export function dishToggle(d: DishDraft, groupId: string, optionId: string): DishDraft {
  const g = groupOf(d, groupId);
  return g ? { ...d, picks: { ...d.picks, [g.id]: togglePick(g, d.picks[g.id] ?? [], optionId) } } : d;
}

export function dishQty(d: DishDraft, groupId: string, optionId: string, delta: number): DishDraft {
  const g = groupOf(d, groupId);
  return g ? { ...d, picks: { ...d.picks, [g.id]: changePickQty(g, d.picks[g.id] ?? [], optionId, delta) } } : d;
}

export function dishPre(d: DishDraft, groupId: string, optionId: string): DishDraft {
  const g = groupOf(d, groupId);
  return g ? { ...d, picks: { ...d.picks, [g.id]: cyclePre(g, d.picks[g.id] ?? [], optionId) } } : d;
}

export const toggleIn = (list: readonly string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** The allergies in the fixed order after a tap. */
export function toggleAllergy(list: readonly string[], he: string): string[] {
  const next = new Set(toggleIn(list, he));
  return ALLERGENS.filter((a) => next.has(a.he)).map((a) => a.he);
}

export const dishValid = (d: DishDraft) => picksValid(d.groups, d.picks);

export function dishUnit(d: DishDraft): number {
  return dishUnitAgorot(d.baseAgorot, chosenOptions(d.groups, d.picks));
}

/** The group whose picks are wrong now (its id), when the errors are shown. */
export function dishProblems(d: DishDraft): Set<string> {
  return new Set(d.groups.filter((g) => validatePicks(g, d.picks[g.id] ?? []).length > 0).map((g) => g.id));
}

/** "הגעתם למקסימום בקבוצה": a group whose max is taken. */
export function groupFull(g: MenuGroup, picks: readonly OptionPick[]): boolean {
  return g.maxSelect !== null && picks.reduce((s, p) => s + p.qty, 0) >= g.maxSelect;
}

export { canAddOne };

/** The notes the line carries: the chips, then the free text. */
export function notesOfDraft(chips: readonly string[], noteText: string): string[] {
  return cleanNotes([...chips, noteText]);
}

/** The draft as the op's arguments (`sell.add` / `sell.configure`). */
export function dishArgs(d: DishDraft): LineChoices & { qty: number } {
  return {
    qty: d.qty,
    options: Object.entries(d.picks).flatMap(([groupId, list]) => list.map((p) => ({ groupId, optionId: p.optionId, qty: p.qty, pre: p.pre }))),
    notes: notesOfDraft(d.chips, d.noteText),
    meal: null,
    important: d.important,
    allergies: d.allergies,
  };
}

/** A pill's words on a group (GroupBlock): "חובה", "בחירה אחת" / "עד N", "N חינם". */
export function groupPills(g: MenuGroup): string[] {
  const out: string[] = [];
  if (g.minSelect > 0) out.push(CHOICES_TEXT.required);
  if (g.maxSelect === 1) out.push(CHOICES_TEXT.single);
  else if (g.maxSelect !== null) out.push(CHOICES_TEXT.upTo(g.maxSelect));
  if (g.freeCount > 0) out.push(CHOICES_TEXT.free(g.freeCount));
  return out;
}

/** An option's words in the sheet: "בלי בצל" for a removal; "מעט גבינה" / "רוטב בצד" with its pre-modifier. */
export function optionLabel(g: MenuGroup, name: string, pre: PreModifier | null): string {
  if (g.kind === 'removal') return CHOICES_TEXT.without(name);
  if (pre === 'side') return `${name} ${PRE_HE.side}`;
  if (pre) return `${PRE_HE[pre]} ${name}`;
  return name;
}

export const preLabel = (pre: PreModifier | null) => (pre ? PRE_HE[pre] : CHOICES_TEXT.preNone);

/** "שימו לב: המנה מכילה …": the declared allergies the dish contains (its allergens are Hebrew names). */
export function allergyConflicts(declared: readonly string[], contains: readonly string[]): string[] {
  return declared.filter((a) => contains.includes(a));
}

/* -------------------------------------------------------------------- meals */

/** A meal being built (MealDraft): the products chosen in each slot, each component's choices, the step on show. */
export interface MealDraft {
  productId: string;
  name: string;
  baseAgorot: number;
  slots: MealSlotView[];
  chosen: Record<string, string[]>;
  /** A component's choices, by `${slotId}:${productId}` (absent: its defaults). */
  componentPicks: Record<string, Record<string, OptionPick[]>>;
  chips: string[];
  noteText: string;
  important: boolean;
  allergies: string[];
  qty: number;
  /** The slot on show; `slots.length` — the summary. */
  step: number;
  editing: string | null;
  showErrors: boolean;
}

const compKey = (slotId: string, productId: string) => `${slotId}:${productId}`;

export function startMeal(
  p: { id: string; name: string; priceAgorot: number },
  slots: readonly MealSlotView[],
  groupsOf: (productId: string) => MenuGroup[],
  chipsOffered: readonly string[],
  line?: { lineId: string; qty: number; choices: LineChoices } | null,
): MealDraft {
  const chosen: Record<string, string[]> = {};
  const componentPicks: MealDraft['componentPicks'] = {};
  const fromLine = line?.choices ?? null;
  for (const s of slots) {
    const kiosk = { ...s, choices: s.choices.map((c) => ({ productId: c.productId, upchargeAgorot: c.upchargeAgorot, isDefault: c.isDefault })) };
    chosen[s.id] = fromLine?.meal ? fromLine.meal.components.filter((c) => c.slotId === s.id).map((c) => c.productId) : defaultMealChoices(kiosk);
  }
  for (const c of fromLine?.meal?.components ?? []) {
    if (c.options && c.options.length > 0) componentPicks[compKey(c.slotId, c.productId)] = picksOf(groupsOf(c.productId), c.options);
  }
  const draft: MealDraft = {
    productId: p.id,
    name: p.name,
    baseAgorot: p.priceAgorot,
    slots: [...slots],
    chosen,
    componentPicks,
    chips: fromLine ? fromLine.notes.filter((n) => chipsOffered.includes(n)) : [],
    noteText: fromLine ? fromLine.notes.filter((n) => !chipsOffered.includes(n)).join(' · ') : '',
    important: fromLine?.important ?? false,
    allergies: fromLine?.allergies ?? [],
    qty: line?.qty ?? 1,
    step: 0,
    editing: line?.lineId ?? null,
    showErrors: false,
  };
  // Opens on the first slot that still needs a choice — or straight on the summary (an edit, or nothing to choose).
  const first = draft.slots.findIndex((s) => mealSlotWrong(draft, s, groupsOf));
  return { ...draft, step: first >= 0 ? first : line ? draft.slots.length : 0 };
}

/** A component's picks: its own, else its groups' defaults. */
export function componentPicks(d: MealDraft, slotId: string, productId: string, groups: readonly MenuGroup[]): Record<string, OptionPick[]> {
  return d.componentPicks[compKey(slotId, productId)] ?? Object.fromEntries(groups.map((g) => [g.id, defaultPicks(g)]));
}

/** A slot that still needs a choice, holds too many, or holds a component whose choices do not answer its groups. */
export function mealSlotWrong(d: MealDraft, slot: MealSlotView, groupsOf: (productId: string) => MenuGroup[]): boolean {
  const chosen = d.chosen[slot.id] ?? [];
  return mealSlotProblem(
    { ...slot, choices: slot.choices.map((c) => ({ productId: c.productId, upchargeAgorot: c.upchargeAgorot, isDefault: c.isDefault })) },
    chosen,
    (pid) => {
      const groups = groupsOf(pid);
      return picksValid(groups, componentPicks(d, slot.id, pid, groups));
    },
  );
}

export function mealTap(d: MealDraft, slotId: string, productId: string): MealDraft {
  const slot = d.slots.find((s) => s.id === slotId);
  if (!slot) return d;
  const kiosk = { ...slot, choices: slot.choices.map((c) => ({ productId: c.productId, upchargeAgorot: c.upchargeAgorot, isDefault: c.isDefault })) };
  return { ...d, chosen: { ...d.chosen, [slotId]: mealPick(kiosk, d.chosen[slotId] ?? [], productId) } };
}

export function mealRemoveOne(d: MealDraft, slotId: string, productId: string): MealDraft {
  return { ...d, chosen: { ...d.chosen, [slotId]: mealUnpickOne(d.chosen[slotId] ?? [], productId) } };
}

/** A component's group changed (its own choices in the meal: a size, a sauce). */
export function mealComponentPick(d: MealDraft, slotId: string, productId: string, groups: readonly MenuGroup[], change: (g: MenuGroup, picks: OptionPick[]) => OptionPick[], groupId: string): MealDraft {
  const g = groups.find((x) => x.id === groupId);
  if (!g) return d;
  const current = componentPicks(d, slotId, productId, groups);
  return { ...d, componentPicks: { ...d.componentPicks, [compKey(slotId, productId)]: { ...current, [g.id]: change(g, current[g.id] ?? []) } } };
}

export { togglePick, changePickQty, cyclePre };

export function mealValid(d: MealDraft, groupsOf: (productId: string) => MenuGroup[]): boolean {
  return d.slots.every((s) => !mealSlotWrong(d, s, groupsOf));
}

/** One meal's price as the sheet shows it (MealDraft.unitPrice): the meal, each component's upcharge and paid choices. */
export function mealUnit(d: MealDraft, groupsOf: (productId: string) => MenuGroup[]): number {
  const components = d.slots.flatMap((s) =>
    (d.chosen[s.id] ?? []).map((pid) => {
      const groups = groupsOf(pid);
      const options: ChosenOption[] = chosenOptions(groups, componentPicks(d, s.id, pid, groups));
      return { upchargeAgorot: s.choices.find((c) => c.productId === pid)?.upchargeAgorot ?? 0, options };
    }),
  );
  return mealUnitAgorot(d.baseAgorot, components);
}

export function mealArgs(d: MealDraft): LineChoices & { qty: number } {
  const components: LineComponent[] = d.slots.flatMap((s) =>
    (d.chosen[s.id] ?? []).map((pid) => {
      const own = d.componentPicks[compKey(s.id, pid)];
      const options = own ? Object.entries(own).flatMap(([groupId, list]) => list.map((p) => ({ groupId, optionId: p.optionId, qty: p.qty, pre: p.pre }))) : [];
      return { slotId: s.id, productId: pid, ...(own ? { options } : {}) };
    }),
  );
  return { qty: d.qty, options: [], notes: notesOfDraft(d.chips, d.noteText), meal: { components }, important: d.important, allergies: d.allergies };
}

/** A slot's line under its name: "בחרו N" / "כלולים N". */
export function slotHint(slot: MealSlotView): string {
  return slot.minSelect > 0 ? CHOICES_TEXT.slotChoose(slot.maxSelect) : CHOICES_TEXT.slotIncluded(slot.quantity);
}

/* -------------------------------------------------------------- the cart */

/** The line's sub-lines in the cart (CartLineMenuInfo): the choices, a meal's components with theirs, the notes, the allergy. */
/** An option as a line's words read it (a document's SaleOption or the cart's). */
export interface WordOption {
  kind?: 'choice' | 'addon' | 'removal' | null;
  name: string;
  pre?: PreModifier | null;
  qty: number;
}

const wordOf = (o: WordOption) => optionText({ kind: o.kind ?? 'addon', name: o.name, pre: o.pre ?? null, qty: o.qty });

export function lineWords(l: {
  options: ReadonlyArray<WordOption>;
  meal?: { components: ReadonlyArray<{ name: string; options: ReadonlyArray<WordOption> }> } | null;
  notes: readonly string[];
  important?: boolean;
  allergies?: readonly string[];
}): string[] {
  const out: string[] = [];
  if (l.options.length > 0) out.push(l.options.map(wordOf).join(' · '));
  for (const c of l.meal?.components ?? []) {
    const mods = c.options.map(wordOf).join(' · ');
    out.push(mods ? `${c.name}: ${mods}` : c.name);
  }
  const notes = l.notes.join(' · ');
  if (notes) out.push(l.important ? `! ${notes}` : notes);
  else if (l.important) out.push(`! ${CHOICES_TEXT.important}`);
  if (l.allergies && l.allergies.length > 0) out.push(CHOICES_TEXT.allergyDeclared(l.allergies.join(', ')));
  return out;
}
