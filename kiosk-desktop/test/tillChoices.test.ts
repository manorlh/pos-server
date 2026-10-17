/**
 * "תוספות, ארוחות והערות" in the Windows till's cart (core/till/choices.ts, engine `sell.add` / `sell.configure`,
 * parts/ChoicesSheet.tsx): the Android till's menu layer — which taps open a sheet (Menu.needsSheet / opensSheet), a plain
 * tap on a dish with groups on its defaults, the choices checked against the catalog and priced by the kiosk's own rules,
 * a meal line for line, notes / "חשוב" / allergies to the kitchen ticket, held sales keeping them, the sheet's markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ALLERGENS,
  CHOICES_TEXT,
  allergyConflicts,
  cleanAllergies,
  cleanMeal,
  cleanOptions,
  dishArgs,
  dishToggle,
  dishUnit,
  dishValid,
  groupPills,
  lineWords,
  mealArgs,
  mealTap,
  mealUnit,
  mealValid,
  moneyGroup,
  needsSheet,
  opensSheet,
  optionLabel,
  optionsRefusal,
  sameChoices,
  startDish,
  startMeal,
  NO_CHOICES,
  type ChoiceGroupView,
  type MealSlotView,
} from '../src/core/till/choices';
import { kitchenLinesOfSale } from '../src/core/kitchen/tickets';
import { ChoicesSheet } from '../src/renderer/roles/till/parts/ChoicesSheet';
import type { Catalog, CartLine } from '../src/shared/till/protocol';
import { readyTill } from './tillEngineHarness';

const size: ChoiceGroupView = {
  id: 'g-size',
  name: 'גודל',
  kind: 'choice',
  min: 1,
  max: 1,
  freeCount: 0,
  allowQuantity: false,
  allowPre: false,
  options: [
    { id: 'o-s', name: 'רגיל', priceAgorot: 0, isDefault: false, maxQty: null },
    { id: 'o-l', name: 'גדול', priceAgorot: 500, isDefault: false, maxQty: null },
  ],
};
const extras: ChoiceGroupView = {
  id: 'g-extra',
  name: 'תוספות',
  kind: 'addon',
  min: 0,
  max: 3,
  freeCount: 1,
  allowQuantity: true,
  allowPre: true,
  options: [
    { id: 'o-cheese', name: 'גבינה', priceAgorot: 400, isDefault: true, maxQty: 2 },
    { id: 'o-egg', name: 'ביצה', priceAgorot: 300, isDefault: false, maxQty: null },
  ],
};
const removal: ChoiceGroupView = { id: 'g-rm', name: 'הסרות', kind: 'removal', min: 0, max: null, freeCount: 0, allowQuantity: false, allowPre: false, options: [{ id: 'o-onion', name: 'בצל', priceAgorot: 0, isDefault: false, maxQty: null }] };

describe('the sheet opens as on the Android till (Menu.needsSheet / opensSheet)', () => {
  it('a meal or a required group always; add-ons / own notes only with their parameters', () => {
    expect(needsSheet([size], null)).toBe(true);
    expect(needsSheet([extras], null)).toBe(false);
    expect(needsSheet([], [{}])).toBe(true);
    const addOns = { groupIds: ['g-extra'], notes: [], ownNotes: false, needsSheet: false };
    expect(opensSheet(addOns, { addOns: false, notes: false })).toBe(false);
    expect(opensSheet(addOns, { addOns: true, notes: false })).toBe(true);
    const notes = { groupIds: [], notes: ['בלי מלח'], ownNotes: true, needsSheet: false };
    expect(opensSheet(notes, { addOns: true, notes: false })).toBe(false);
    expect(opensSheet(notes, { addOns: false, notes: true })).toBe(true);
    // The shop's notes for every dish never open a sheet.
    expect(opensSheet({ ...notes, ownNotes: false }, { addOns: false, notes: true })).toBe(false);
  });

  it('pills, removal words and the pre-modifier in Android words', () => {
    expect(groupPills(moneyGroup(size))).toEqual(['חובה', 'בחירה אחת']);
    expect(groupPills(moneyGroup(extras))).toEqual(['עד 3', '1 חינם']);
    expect(optionLabel(moneyGroup(removal), 'בצל', null)).toBe('בלי בצל');
    expect(optionLabel(moneyGroup(extras), 'רוטב', 'side')).toBe('רוטב בצד');
    expect(optionLabel(moneyGroup(extras), 'גבינה', 'extra')).toBe('הרבה גבינה');
    expect(CHOICES_TEXT.add('₪12.00')).toBe('הוסף ₪12.00');
  });
});

describe('the dish draft', () => {
  const groups = [moneyGroup(size), moneyGroup(extras)];
  it('starts on the defaults, needs the required group, prices the free unit as the cheapest', () => {
    let d = startDish({ id: 'p', name: 'פיצה', priceAgorot: 4000 }, groups, ['בלי מלח']);
    expect(dishValid(d)).toBe(false);
    expect(d.picks['g-extra'].map((p) => p.optionId)).toEqual(['o-cheese']);
    // The one cheese is free (freeCount 1).
    expect(dishUnit(d)).toBe(4000);
    d = dishToggle(d, 'g-size', 'o-l');
    d = dishToggle(d, 'g-extra', 'o-egg');
    expect(dishValid(d)).toBe(true);
    // 40 + 5 (large) + the dearer of cheese / egg paid (the egg 3 is the cheapest: free) → 40 + 5 + 4.
    expect(dishUnit(d)).toBe(4900);
    const args = dishArgs({ ...d, chips: ['בלי מלח'], noteText: 'לילד', important: true, allergies: ['שומשום'] });
    expect(args.notes).toEqual(['בלי מלח', 'לילד']);
    expect(args.options).toEqual([
      { groupId: 'g-size', optionId: 'o-l', qty: 1, pre: null },
      { groupId: 'g-extra', optionId: 'o-cheese', qty: 1, pre: null },
      { groupId: 'g-extra', optionId: 'o-egg', qty: 1, pre: null },
    ]);
  });

  it('refuses options the groups do not answer, in words', () => {
    expect(optionsRefusal(groups, [])).toBe('יש לבחור ב«גודל»');
    expect(optionsRefusal(groups, [{ groupId: 'g-size', optionId: 'nope' }])).toBe('בחירה לא מוכרת');
    expect(optionsRefusal(groups, [{ groupId: 'g-size', optionId: 'o-s' }])).toBeNull();
  });

  it('cleans what a screen sends; allergies by name or code, in the fixed order', () => {
    expect(cleanOptions([{ groupId: 'g', optionId: 'o', qty: 0 }])).toBeNull();
    expect(cleanOptions([{ groupId: 'g', optionId: 'o', pre: 'bad' }])).toBeNull();
    expect(cleanOptions(undefined)).toEqual([]);
    expect(cleanMeal({ components: [{ slotId: 's', productId: 'p' }] })).toEqual({ components: [{ slotId: 's', productId: 'p' }] });
    expect(cleanMeal('x')).toBeUndefined();
    expect(cleanAllergies(['sesame', 'גלוטן', 'unknown'])).toEqual(['גלוטן', 'שומשום']);
    expect(ALLERGENS).toHaveLength(14);
    expect(allergyConflicts(['גלוטן', 'חלב'], ['חלב', 'ביצים'])).toEqual(['חלב']);
  });

  it('lines merge only on the same choices with nothing written', () => {
    const a = { ...NO_CHOICES, options: [{ groupId: 'g', optionId: 'o' }] };
    expect(sameChoices(a, { ...a })).toBe(true);
    expect(sameChoices(a, { ...a, notes: ['x'] })).toBe(false);
    expect(sameChoices(a, { ...a, important: true })).toBe(false);
  });

  it('the cart words: choices, components, the note (with "!"), the allergy', () => {
    expect(
      lineWords({
        options: [{ kind: 'addon', name: 'גבינה', pre: 'extra', qty: 2 }, { kind: 'removal', name: 'בצל', pre: null, qty: 1 }],
        meal: { components: [{ name: 'קולה', options: [] }] },
        notes: ['בלי מלח'],
        important: true,
        allergies: ['גלוטן'],
      }),
    ).toEqual(['הרבה גבינה ×2 · בלי בצל', 'קולה', '! בלי מלח', 'אלרגיה: גלוטן']);
  });
});

describe('the meal draft', () => {
  const slots: MealSlotView[] = [
    { id: 's-main', name: 'מנה עיקרית', minSelect: 1, maxSelect: 1, quantity: 1, allowRepeat: false, choices: [{ productId: 'p-burger', name: 'המבורגר', upchargeAgorot: 0, isDefault: true, groupIds: ['g-size'] }] },
    { id: 's-drink', name: 'שתייה', minSelect: 1, maxSelect: 1, quantity: 1, allowRepeat: false, choices: [{ productId: 'p-cola', name: 'קולה', upchargeAgorot: 200, isDefault: false, groupIds: [] }] },
  ];
  const groupsOf = (pid: string) => (pid === 'p-burger' ? [moneyGroup(size)] : []);
  it('opens on the first slot that needs a choice; a component must answer its own groups', () => {
    let d = startMeal({ id: 'p-meal', name: 'ארוחה', priceAgorot: 6000 }, slots, groupsOf, []);
    // The burger's size has no default → the main slot is wrong already.
    expect(d.step).toBe(0);
    expect(mealValid(d, groupsOf)).toBe(false);
    d = mealTap(d, 's-drink', 'p-cola');
    d = { ...d, componentPicks: { 's-main:p-burger': { 'g-size': [{ optionId: 'o-l', qty: 1, pre: null }] } } };
    expect(mealValid(d, groupsOf)).toBe(true);
    expect(mealUnit(d, groupsOf)).toBe(6000 + 200 + 500);
    expect(mealArgs(d).meal).toEqual({
      components: [
        { slotId: 's-main', productId: 'p-burger', options: [{ groupId: 'g-size', optionId: 'o-l', qty: 1, pre: null }] },
        { slotId: 's-drink', productId: 'p-cola' },
      ],
    });
  });
});

/** A catalog with a dish of a required size, a dish of free add-ons, and a meal (burger + a drink). */
const MENU = {
  groups: [
    { id: 'g-size', name: 'גודל', kind: 'choice', minSelect: 1, maxSelect: 1, options: [{ id: 'o-s', name: 'רגיל', price: 0 }, { id: 'o-l', name: 'גדול', price: 5 }] },
    { id: 'g-extra', name: 'תוספות', kind: 'addon', minSelect: 0, maxSelect: 3, options: [{ id: 'o-cheese', name: 'גבינה', price: 4, isDefault: true }, { id: 'o-egg', name: 'ביצה', price: 3 }] },
  ],
  links: { products: { 'p-pizza': ['g-size'], 'p-burger': ['g-extra'] } },
  notes: { all: [], categories: {}, products: { 'p-burger': [{ text: 'בלי בצל', important: false }] } },
  meals: {
    'p-meal': [
      { id: 's-main', name: 'מנה עיקרית', minSelect: 1, maxSelect: 1, options: [{ productId: 'p-burger', upcharge: 0, isDefault: true }] },
      { id: 's-drink', name: 'שתייה', minSelect: 1, maxSelect: 1, options: [{ productId: 'p-cola', upcharge: 2 }] },
    ],
  },
};
const PRODUCTS = [
  { id: 'p-pizza', name: 'פיצה', price: 40, categoryId: 'c-main', inStock: true, isAvailable: true, salesChannel: 'all' },
  { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, salesChannel: 'all' },
  { id: 'p-cola', name: 'קולה', price: 12, categoryId: 'c-drink', inStock: true, isAvailable: true, salesChannel: 'all' },
  { id: 'p-meal', name: 'ארוחת המבורגר', price: 55, categoryId: 'c-main', inStock: true, isAvailable: true, salesChannel: 'all' },
];
const CATALOG = {
  products: PRODUCTS,
  categories: [
    { id: 'c-main', name: 'מנות', isActive: true },
    { id: 'c-drink', name: 'שתייה', isActive: true },
  ],
  menu: MENU,
};

describe('the engine: sell.add with choices, sell.configure, the kitchen and the held sale', () => {
  it('the catalog sends the groups once and each product its choices', async () => {
    const h = await readyTill({ catalog: CATALOG });
    const cat = await h.ok<Catalog>('catalog.snapshot');
    expect(Object.keys(cat.choiceGroups ?? {}).sort()).toEqual(['g-extra', 'g-size']);
    const pizza = cat.products.find((p) => p.id === 'p-pizza')!;
    expect(pizza.choices).toMatchObject({ groupIds: ['g-size'], needsSheet: true });
    const burger = cat.products.find((p) => p.id === 'p-burger')!;
    expect(burger.choices).toMatchObject({ groupIds: ['g-extra'], notes: ['בלי בצל'], ownNotes: true, needsSheet: false });
    const meal = cat.products.find((p) => p.id === 'p-meal')!;
    expect(meal.choices?.meal?.map((s) => s.name)).toEqual(['מנה עיקרית', 'שתייה']);
    expect(meal.choices?.meal?.[0].choices[0]).toMatchObject({ productId: 'p-burger', name: 'המבורגר', groupIds: ['g-extra'] });
    expect(cat.products.find((p) => p.id === 'p-cola')!.choices).toBeUndefined();
    h.stop();
  });

  it('a tap on a dish that must be answered adds nothing and asks for its sheet; from the sheet it goes in priced', async () => {
    const h = await readyTill({ catalog: CATALOG });
    expect(await h.ok('sell.add', { productId: 'p-pizza' })).toEqual({ choices: true });
    expect(h.state().sell.lines).toHaveLength(0);
    const bad = await h.fail('sell.add', { productId: 'p-pizza', configured: true, options: [], notes: [], meal: null, important: false, allergies: [] });
    expect(bad.message).toBe('יש לבחור ב«גודל»');
    await h.ok('sell.add', { productId: 'p-pizza', configured: true, options: [{ groupId: 'g-size', optionId: 'o-l' }], notes: ['דחוף'], meal: null, important: true, allergies: ['milk'] });
    const line = h.state().sell.lines[0] as CartLine;
    expect(line.totalAgorot).toBe(4500);
    expect(line.subLines).toEqual(['גדול', '! דחוף', 'אלרגיה: חלב']);
    expect(line.choices?.options).toEqual([{ groupId: 'g-size', optionId: 'o-l', qty: 1, pre: null }]);
    h.stop();
  });

  it('a plain tap on a dish with add-ons goes in on its defaults and merges with the same', async () => {
    const h = await readyTill({ catalog: CATALOG });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-burger' });
    const lines = h.state().sell.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(2);
    // The default cheese at ₪4.
    expect(lines[0].totalAgorot).toBe(2 * 4600);
    expect(lines[0].subLines).toEqual(['גבינה']);
    // With a note it is a line of its own.
    await h.ok('sell.add', { productId: 'p-burger', configured: true, options: [], notes: ['בלי בצל'], meal: null, important: false, allergies: [] });
    expect(h.state().sell.lines).toHaveLength(2);
    h.stop();
  });

  it('"עדכן" changes a line\'s choices and quantity; a malformed one is refused', async () => {
    const h = await readyTill({ catalog: CATALOG });
    await h.ok('sell.add', { productId: 'p-pizza', configured: true, options: [{ groupId: 'g-size', optionId: 'o-s' }], notes: [], meal: null, important: false, allergies: [] });
    const id = h.state().sell.lines[0].lineId;
    await h.ok('sell.configure', { lineId: id, qty: 3, options: [{ groupId: 'g-size', optionId: 'o-l' }], notes: [], meal: null, important: false, allergies: [] });
    const l = h.state().sell.lines[0];
    expect([l.qty, l.totalAgorot]).toEqual([3, 3 * 4500]);
    expect((await h.fail('sell.configure', { lineId: id, qty: 1, options: [{ groupId: 'g-size' }] })).code).toBe('invalid_args');
    h.stop();
  });

  it('a meal line for line: its components priced, sold, and on the kitchen ticket with the allergy and "חשוב"', async () => {
    const h = await readyTill({ catalog: CATALOG });
    expect(await h.ok('sell.add', { productId: 'p-meal' })).toEqual({ choices: true });
    const missing = await h.fail('sell.add', { productId: 'p-meal', configured: true, options: [], notes: [], meal: { components: [{ slotId: 's-main', productId: 'p-burger' }] }, important: false, allergies: [] });
    expect(missing.message).toBe('יש לבחור ב«שתייה»');
    await h.ok('sell.add', {
      productId: 'p-meal',
      configured: true,
      options: [],
      notes: ['בלי בצל'],
      meal: { components: [{ slotId: 's-main', productId: 'p-burger', options: [{ groupId: 'g-extra', optionId: 'o-egg' }] }, { slotId: 's-drink', productId: 'p-cola' }] },
      important: true,
      allergies: ['גלוטן'],
    });
    const l = h.state().sell.lines[0];
    // 55 + 2 (the drink's upcharge) + 3 (the egg instead of the default cheese).
    expect(l.totalAgorot).toBe(6000);
    expect(l.subLines).toEqual(['המבורגר: ביצה', 'קולה', '! בלי בצל', 'אלרגיה: גלוטן']);
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 6000 });
    const docId = h.state().checkout.documentId!;
    const doc = h.svc.ledger.doc(docId)!;
    expect(doc.lines[0].meal?.components.map((c) => c.name)).toEqual(['המבורגר', 'קולה']);
    const kitchen = kitchenLinesOfSale(doc.lines);
    expect(kitchen.map((k) => [k.name, k.important === true, k.allergies ?? []])).toEqual([
      ['המבורגר', true, ['גלוטן']],
      ['קולה', true, ['גלוטן']],
    ]);
    h.stop();
  });

  it('a held sale keeps the choices and their price', async () => {
    const h = await readyTill({ catalog: CATALOG });
    await h.ok('sell.add', { productId: 'p-pizza', configured: true, options: [{ groupId: 'g-size', optionId: 'o-l' }], notes: ['דחוף'], meal: null, important: false, allergies: [] });
    const { id } = await h.ok<{ id: string }>('held.hold', {});
    expect(h.state().sell.lines).toHaveLength(0);
    await h.ok('held.resume', { id });
    const l = h.state().sell.lines[0];
    expect([l.totalAgorot, l.subLines]).toEqual([4500, ['גדול', 'דחוף']]);
    h.stop();
  });
});

describe('the sheet', () => {
  const catalog: Catalog = {
    version: 1,
    departments: [{ id: 'c', name: 'מנות', color: '#000000' }],
    choiceGroups: { 'g-size': size, 'g-extra': extras },
    products: [
      { id: 'p-pizza', departmentId: 'c', name: 'פיצה', priceAgorot: 4000, allergens: ['חלב'], choices: { groupIds: ['g-size', 'g-extra'], notes: ['בלי מלח'], ownNotes: true, needsSheet: true } },
      {
        id: 'p-meal',
        departmentId: 'c',
        name: 'ארוחה',
        priceAgorot: 6000,
        choices: {
          groupIds: [],
          notes: [],
          ownNotes: false,
          needsSheet: true,
          meal: [{ id: 's', name: 'שתייה', minSelect: 1, maxSelect: 1, quantity: 1, allowRepeat: false, choices: [{ productId: 'p-cola', name: 'קולה', upchargeAgorot: 0, isDefault: true, groupIds: [] }] }],
        },
      },
    ],
  };
  const noop = () => undefined;
  it('a dish: its groups with their pills, the notes, the allergies and "הוסף"', () => {
    const html = renderToStaticMarkup(createElement(ChoicesSheet, { catalog, target: { productId: 'p-pizza' }, onConfirm: noop, onClose: noop }));
    for (const w of ['גודל', 'חובה', 'בחירה אחת', 'תוספות', '1 חינם', 'הערות למטבח', 'בלי מלח', '! חשוב', 'אלרגיה ל…', 'מכיל: חלב', 'הוסף']) expect(html).toContain(w);
  });
  it('a line opened again says "עדכן"; a meal shows its steps and "סיכום"', () => {
    const edit = renderToStaticMarkup(
      createElement(ChoicesSheet, { catalog, target: { productId: 'p-pizza', line: { lineId: 'l1', qty: 2, choices: { options: [{ groupId: 'g-size', optionId: 'o-l' }], notes: [], meal: null, important: false, allergies: [] } } }, onConfirm: noop, onClose: noop }),
    );
    expect(edit).toContain('עדכן');
    const meal = renderToStaticMarkup(createElement(ChoicesSheet, { catalog, target: { productId: 'p-meal' }, onConfirm: noop, onClose: noop }));
    for (const w of ['שתייה', 'סיכום', 'קולה', 'הבא']) expect(meal).toContain(w);
  });
});
