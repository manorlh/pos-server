/**
 * Run with `npm test`. The setup's quick presets fill the form with what the owner could set by hand
 * (the punch card: ONE group "פריטים" of 1–N, the same item again, N in all, in parts); the item
 * groups are checked with the cloud's limits — the value, the reason and the limit in each message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GROUP_QTY,
  draftGroupsOf,
  emptyGroup,
  groupProblems,
  groupsBody,
  isPunchCard,
  presetValues,
  punchUsesProblem,
  totalQtyBody,
  withPunchUses,
} from './voucherPresets';

const food = { id: 'c-food', name: 'מזון' };

describe('presetValues', () => {
  it('the punch card: goods, one group "פריטים" min 1 max N, the same item again, N in all, in parts', () => {
    const p = presetValues('punch', 50);
    assert.equal(p.kind, 'items');
    assert.equal(p.selection, 'groups');
    assert.equal(p.splitAllowed, true);
    assert.equal(p.totalQty, '50');
    assert.equal(p.groups.length, 1);
    assert.deepEqual([p.groups[0].name, p.groups[0].minQty, p.groups[0].maxQty, p.groups[0].allowRepeat], ['פריטים', '1', '50', true]);
    assert.ok(isPunchCard(p.selection, p.groups, p.totalQty));
  });

  it('the punch card keeps the items already picked and is clamped to the group limit', () => {
    const picked = { ...emptyGroup('x'), categories: [food] };
    assert.deepEqual(presetValues('punch', 50, picked).groups[0].categories, [food]);
    assert.equal(presetValues('punch', 500).totalQty, String(MAX_GROUP_QTY));
  });

  it('one of several, a meal of three, a discount', () => {
    const choice = presetValues('choice');
    assert.deepEqual([choice.selection, choice.totalQty, choice.groups.length, choice.splitAllowed], ['groups', '1', 1, false]);
    const meal = presetValues('meal');
    assert.deepEqual(meal.groups.map((g) => [g.name, g.minQty, g.maxQty]), [['מנה', '1', '1'], ['תוספת', '1', '1'], ['משקה', '1', '1']]);
    assert.equal(meal.splitAllowed, false);
    const discount = presetValues('discount');
    assert.deepEqual([discount.kind, discount.selection, discount.discountType], ['order_discount', 'items', 'fixed']);
  });

  it('withPunchUses sets the group max and the total together', () => {
    const p = presetValues('punch', 50);
    const next = withPunchUses(p.groups, '30');
    assert.deepEqual([next.groups[0].maxQty, next.totalQty], ['30', '30']);
  });
});

describe('groupsBody / draftGroupsOf', () => {
  it('as the API takes them; "כל התפריט" sends no picks; the order is kept', () => {
    const g = { ...emptyGroup('פריטים'), maxQty: '50', categories: [food], excludeProducts: [{ id: 'p-beer', name: 'בירה' }] };
    const [body] = groupsBody([g]);
    assert.deepEqual(body, {
      name: 'פריטים', minQty: 1, maxQty: 50, value: null, allowRepeat: true, allItems: false, productIds: [], categoryIds: ['c-food'],
      includeSubcategories: true, excludeProductIds: ['p-beer'], excludeCategoryIds: [], sortOrder: 0,
    });
    assert.deepEqual(groupsBody([{ ...g, allItems: true }])[0].categoryIds, []);
    assert.equal(totalQtyBody('50'), 50);
    assert.equal(totalQtyBody(''), null);
  });

  it('back from the cloud with its names; an unnamed id stays an id', () => {
    const [d] = draftGroupsOf([{ key: 'k1', name: 'פריטים', minQty: 1, maxQty: 50, allowRepeat: true, categoryIds: ['C-FOOD'], productIds: ['p1'] }],
      { products: {}, categories: { 'c-food': 'מזון' } });
    assert.deepEqual([d.key, d.maxQty, d.categories[0].name, d.products[0].name], ['k1', '50', 'מזון', 'p1']);
  });
});

describe('groupProblems', () => {
  it('nothing wrong with the punch card', () => {
    const p = presetValues('punch', 50, { ...emptyGroup(), categories: [food] });
    assert.deepEqual(groupProblems(p.groups, p.totalQty), []);
  });

  it('the value, the reason and the limit', () => {
    const g = { ...emptyGroup('פריטים'), maxQty: '120', categories: [food] };
    assert.deepEqual(groupProblems([g], '').map((x) => x.text), ['פריטים: לא ניתן לשמור "120" פריטים לכל היותר — מספר שלם בין 1 ל-100.']);
    const nothing = { ...emptyGroup('מנה') };
    assert.match(groupProblems([nothing], '')[0].text, /^מנה: לא נבחרו פריטים/);
    const over = { ...emptyGroup('פריטים'), maxQty: '10', categories: [food] };
    assert.deepEqual(groupProblems([over], '50').map((x) => x.text),
      ['לא ניתן לשמור 50 פריטים בשובר: הקבוצות נותנות יחד עד 10 פריטים. הגדילו את "עד" בקבוצה או הקטינו את הסה״כ.']);
    const minOver = { ...emptyGroup('פריטים'), minQty: '3', maxQty: '2', categories: [food] };
    assert.match(groupProblems([minOver], '').map((x) => x.text).join(), /לפחות 3 פריטים גבוה מ"עד 2 פריטים"/);
  });

  it('punchUsesProblem', () => {
    assert.equal(punchUsesProblem('50'), null);
    assert.equal(punchUsesProblem('120'), 'לא ניתן לשמור "120": בכרטיסייה אפשר 1–100 פריטים (המכסה של קבוצת פריטים אחת).');
    assert.notEqual(punchUsesProblem('0'), null);
  });
});
