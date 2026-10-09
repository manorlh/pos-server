/**
 * Run with `npm test`. The kiosk's money (lib/kioskMoney.ts — the Windows and the browser kiosk's
 * one port of the Android till's rules) against the shared golden fixture
 * server/tests/fixtures/kiosk_money_golden.json: choices, meals, promotions, totals, to the agora.
 * The fixture's SHA-256 is pinned (the same constant in kiosk-desktop's test and, to come, the
 * Android kiosk's): a change to it is a change to every platform's test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  agorotOfShekels,
  canAddOne,
  changePickQty,
  chosenOptions,
  componentExtrasAgorot,
  cyclePre,
  defaultMealChoices,
  defaultPicks,
  dishOnDefaults,
  dishUnitAgorot,
  evaluatePromotions,
  mealPick,
  mealSlotProblem,
  mealsOf,
  mealUnitAgorot,
  menuGroupOf,
  optionText,
  pickCharges,
  priceKioskBasket,
  promotionOf,
  promotionsOf,
  togglePick,
  validatePicks,
  vatSplit,
  type LocalDateTime,
  type MenuGroup,
  type OptionPick,
  type PromoLine,
} from './kioskMoney';

/** The fixture's SHA-256, its line endings read as LF. */
const KIOSK_MONEY_GOLDEN_SHA256 = '69424fcab136e5f783c2d3ce472c77a81ba703b5f1dc0ce6a1314245df888c0e';

function fixtureText(): string {
  const name = 'kiosk_money_golden.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `${name} not found`);
  return readFileSync(found, 'utf8').replace(/\r\n/g, '\n');
}

type Row = Record<string, unknown>;
const text = fixtureText();
const golden = JSON.parse(text) as {
  modifiers: Array<{ name: string; baseAgorot: number; group: Row; picks: OptionPick[] | null; expected: { charges: number[]; problems: string[]; unitAgorot: number; canAddOne?: Record<string, boolean>; defaults?: string[] } }>;
  mealPicks: Array<{ name: string; slot: Row; taps: string[]; start?: string[]; expected: string[][] }>;
  meals: Array<{
    name: string;
    mealPriceAgorot: number;
    slots: Row[];
    componentGroups: Record<string, Row[]>;
    chosen: Record<string, string[]>;
    expected: { defaults: Record<string, string[]>; components: number[]; unitAgorot: number; valid: boolean };
  }>;
  products: Record<string, { categoryId: string; noDiscount?: boolean }>;
  baskets: Array<{
    name: string;
    now: string;
    promotions: Row[];
    lines: Array<{ id: string; productId: string; unitAgorot: number; qty: number }>;
    vatRate: number;
    tipPct: number | null;
    expected: {
      lines: Array<{ id: string; promotionAgorot: number; promotionId: string | null; totalAgorot: number }>;
      applied: Array<{ promotionId: string; applications: number; discountAgorot: number }>;
      grossAgorot: number;
      promotionAgorot: number;
      totalAgorot: number;
      itemCount: number;
      netAgorot: number;
      vatAgorot: number;
      giftOffers?: Array<{ promotionId: string; productId: string; quantity: number }>;
      near?: Array<{ promotionId: string; kind: string; missingAgorot: number }>;
    };
  }>;
};

const nowOf = (s: string): LocalDateTime => ({ date: s.slice(0, 10), hour: Number(s.slice(11, 13)), minute: Number(s.slice(14, 16)) });
const groupOf = (row: Row): MenuGroup => {
  const g = menuGroupOf(row);
  assert.ok(g);
  return g;
};

describe('the shared golden fixture', () => {
  it('is the pinned one', () => {
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), KIOSK_MONEY_GOLDEN_SHA256);
  });
});

describe('choices (ModifierMath)', () => {
  for (const c of golden.modifiers) {
    it(c.name, () => {
      const g = groupOf(c.group);
      const picks = c.picks ?? defaultPicks(g);
      if (c.expected.defaults) assert.deepEqual(defaultPicks(g).map((p) => p.optionId), c.expected.defaults);
      assert.deepEqual(pickCharges(g, picks), c.expected.charges);
      assert.deepEqual(validatePicks(g, picks), c.expected.problems);
      assert.equal(dishUnitAgorot(c.baseAgorot, chosenOptions([g], { [g.id]: picks })), c.expected.unitAgorot);
      for (const [id, can] of Object.entries(c.expected.canAddOne ?? {})) assert.equal(canAddOne(g, picks, id), can, id);
    });
  }

  it('the sheet’s taps: a single choice swaps, a quantity stops at the option’s maximum, the pill cycles', () => {
    const pita = groupOf(golden.modifiers[1].group);
    let picks: OptionPick[] = [];
    for (let i = 0; i < 5; i++) picks = changePickQty(pita, picks, 'falafel', 1);
    assert.deepEqual(picks, [{ optionId: 'falafel', qty: 3, pre: null }]);
    picks = changePickQty(pita, picks, 'falafel', -3);
    assert.deepEqual(picks, []);
    const one = { ...pita, maxSelect: 1 };
    assert.deepEqual(togglePick(one, togglePick(one, [], 'egg'), 'pickles'), [{ optionId: 'pickles', qty: 1, pre: null }]);
    const sauce = groupOf(golden.modifiers[2].group);
    let s: OptionPick[] = togglePick(sauce, [], 'tahini');
    const seen = [];
    for (let i = 0; i < 4; i++) {
      s = cyclePre(sauce, s, 'tahini');
      seen.push(s[0].pre);
    }
    assert.deepEqual(seen, ['lite', 'extra', 'side', null]);
    assert.equal(optionText({ kind: 'addon', name: 'טחינה', pre: 'extra', qty: 2 }), 'הרבה טחינה ×2');
    assert.equal(optionText({ kind: 'removal', name: 'בצל', pre: null, qty: 1 }), 'בלי בצל');
  });
});

describe('meals (MealDraft)', () => {
  for (const c of golden.mealPicks) {
    it(c.name, () => {
      const slot = mealsOf({ meals: { m: [c.slot] } }).m[0];
      let chosen = c.start ?? [];
      const steps = c.taps.map((tap) => (chosen = mealPick(slot, chosen, tap)));
      assert.deepEqual(steps, c.expected);
    });
  }

  for (const c of golden.meals) {
    it(c.name, () => {
      const slots = mealsOf({ meals: { meal: c.slots } }).meal;
      assert.deepEqual(Object.fromEntries(slots.map((s) => [s.id, defaultMealChoices(s)])), c.expected.defaults);
      const components = slots.flatMap((s) =>
        (c.chosen[s.id] ?? []).map((pid) => {
          const groups = (c.componentGroups[pid] ?? []).map(groupOf);
          const choice = s.choices.find((x) => x.productId === pid)!;
          return { upchargeAgorot: choice.upchargeAgorot, options: chosenOptions(groups, Object.fromEntries(groups.map((g) => [g.id, defaultPicks(g)]))) };
        }),
      );
      assert.deepEqual(components.map(componentExtrasAgorot), c.expected.components);
      assert.equal(mealUnitAgorot(c.mealPriceAgorot, components), c.expected.unitAgorot);
      assert.equal(slots.every((s) => !mealSlotProblem(s, c.chosen[s.id] ?? [])), c.expected.valid);
    });
  }
});

describe('baskets (PromotionEngine, Cart.totals, Vat.net)', () => {
  for (const c of golden.baskets) {
    it(c.name, () => {
      const promotions = promotionsOf(c.promotions);
      assert.equal(promotions.length, c.promotions.length, 'every promotion read');
      const lines: PromoLine[] = c.lines.map((l) => ({
        id: l.id,
        productIds: [l.productId],
        categoryId: golden.products[l.productId].categoryId,
        unitAgorot: l.unitAgorot,
        qty: l.qty,
        noDiscount: golden.products[l.productId].noDiscount === true,
      }));
      const now = nowOf(c.now);
      const priced = priceKioskBasket(lines, promotions, now);
      assert.deepEqual(
        priced.lines.map((l) => ({ id: l.id, promotionAgorot: l.promotionAgorot, promotionId: l.promotionId, totalAgorot: l.totalAgorot })),
        c.expected.lines,
      );
      assert.deepEqual(
        priced.applied.map((a) => ({ promotionId: a.promotionId, applications: a.applications, discountAgorot: a.discountAgorot })),
        c.expected.applied,
      );
      assert.equal(priced.grossAgorot, c.expected.grossAgorot);
      assert.equal(priced.promotionAgorot, c.expected.promotionAgorot);
      assert.equal(priced.totalAgorot, c.expected.totalAgorot);
      assert.equal(priced.itemCount, c.expected.itemCount);
      assert.deepEqual(vatSplit(priced.totalAgorot, c.vatRate), { netAgorot: c.expected.netAgorot, vatAgorot: c.expected.vatAgorot });
      const outcome = evaluatePromotions(lines, promotions, now);
      if (c.expected.giftOffers) assert.deepEqual(outcome.giftOffers.map((o) => ({ promotionId: o.promotionId, productId: o.productId, quantity: o.quantity })), c.expected.giftOffers);
      if (c.expected.near) assert.deepEqual(outcome.near.map((h) => ({ promotionId: h.promotionId, kind: h.kind, missingAgorot: h.missingAgorot })), c.expected.near);
    });
  }
});

describe('money and reading the cloud', () => {
  it('shekels to agorot as the till’s Agorot.ofShekels (HALF_UP on the decimal form)', () => {
    assert.deepEqual([0.145, 12.3, 2.675, -0.005, 1e-7, 59].map(agorotOfShekels), [15, 1230, 268, -1, 0, 5900]);
  });

  it('a promotion it cannot read is dropped, never guessed at', () => {
    assert.equal(promotionOf({ id: 'x', name: 'x', type: 'mystery', config: {} }), null);
    assert.equal(promotionOf({ id: 'x', name: 'x', type: 'discount', config: { target: { categoryIds: [] }, discountKind: 'percent', discountValue: 10 } }), null);
    assert.equal(promotionOf({ id: 'x', name: 'x', type: 'discount', config: { target: { all: true }, discountKind: 'percent', discountValue: 0 } }), null);
    const p = promotionOf({ id: 'x', name: 'x', type: 'discount', weekdays: [0, 1, 2, 3, 4, 5, 6], maxApplications: 0, config: { target: { all: true }, discountKind: 'amount', discountValue: '2.5' } });
    assert.ok(p);
    assert.equal(p.weekdays, null);
    assert.equal(p.maxApplications, null);
    assert.deepEqual(p.rule, { type: 'discount', target: { all: true, productIds: [], categoryIds: [], excludeProductIds: [], excludeCategoryIds: [] }, discount: { kind: 'amount', agorot: 250 } });
  });
});

describe('quickAdd "always" (the wall): a dish on its defaults', () => {
  // As the till's pull sends a group (server menu_block: every option says whether it is the default).
  const doneness = menuGroupOf({
    id: 'g-done', name: 'מידת עשייה', kind: 'choice', minSelect: 1, maxSelect: 1,
    options: [{ id: 'o-rare', name: 'Rare', price: 0, isDefault: false }, { id: 'o-medium', name: 'Medium', price: 2, isDefault: true }],
  })!;
  const extras = menuGroupOf({
    id: 'g-extra', name: 'תוספות', kind: 'addon', minSelect: 0, maxSelect: 3, freeCount: 1,
    options: [{ id: 'o-cheese', name: 'גבינה', price: 5, isDefault: true }, { id: 'o-egg', name: 'ביצה', price: 4, isDefault: false }],
  })!;
  const sauce = menuGroupOf({
    id: 'g-sauce', name: 'רוטב', kind: 'choice', minSelect: 1, maxSelect: 1,
    options: [{ id: 'o-bbq', name: 'ברביקיו', price: 0 }, { id: 'o-garlic', name: 'שום', price: 0 }],
  })!;

  it('goes in on its defaults, priced as the window prices them (a free choice free)', () => {
    const d = dishOnDefaults(5200, [doneness, extras]);
    assert.ok(d);
    assert.deepEqual(d.chosen.map((o) => [o.optionId, o.chargedAgorot]), [['o-medium', 200], ['o-cheese', 0]]);
    assert.equal(d.unitAgorot, 5400);
    assert.equal(d.unitAgorot, dishUnitAgorot(5200, chosenOptions([doneness, extras], { 'g-done': defaultPicks(doneness), 'g-extra': defaultPicks(extras) })));
  });

  it('a required choice with no default leaves it to its window; nothing required — plain', () => {
    assert.equal(dishOnDefaults(5200, [doneness, sauce]), null);
    assert.deepEqual(dishOnDefaults(1200, []), { chosen: [], unitAgorot: 1200 });
    const none = menuGroupOf({ id: 'g-none', name: 'x', kind: 'addon', minSelect: 0, maxSelect: 2, options: [{ id: 'a', name: 'a', price: 1 }] })!;
    assert.deepEqual(dishOnDefaults(1000, [none]), { chosen: [], unitAgorot: 1000 });
  });
});
