/**
 * Run with `npm test`. The setup's quick presets fill the form with what the owner could set by hand
 * (the punch card: ONE group "פריטים" of 1–N, the same item again, N in all, in parts); the item
 * groups are checked with the cloud's limits — the value, the reason and the limit in each message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GROUP_QTY,
  VOUCHER_PRESETS,
  draftGroupsOf,
  emptyGroup,
  groupProblems,
  groupWarnings,
  groupsBody,
  groupsCheckBody,
  isPerGroup,
  isPunchCard,
  perGroupNewGroup,
  presetValues,
  punchUsesProblem,
  totalQtyBody,
  withPerGroup,
  withPunchUses,
  type GroupsCheck,
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
    assert.deepEqual(groupProblems([over], '50').map((x) => x.text), ["סה״כ 50 פריטים גבוה מסכום ה'עד' של הקבוצות (10)"]);
    const minOver = { ...emptyGroup('פריטים'), minQty: '3', maxQty: '2', categories: [food] };
    assert.match(groupProblems([minOver], '').map((x) => x.text).join(), /לפחות 3 פריטים גבוה מ"עד 2 פריטים"/);
  });

  it('the spec\'s texts (§4.4): nothing chosen says "מחלקות", the total over the groups says both numbers', () => {
    assert.deepEqual(groupProblems([{ ...emptyGroup('מזון'), minQty: '0' }], '').map((x) => x.text),
      ["מזון: לא נבחרו פריטים. בחרו מוצרים, מחלקות או 'כל התפריט'."]);
    const two = [{ ...emptyGroup('מזון'), minQty: '0', categories: [food] }, { ...emptyGroup('שתייה'), minQty: '0', categories: [food] }];
    assert.deepEqual(groupProblems(two, '4').map((x) => x.text), ["סה״כ 4 פריטים גבוה מסכום ה'עד' של הקבוצות (2)"]);
    assert.ok(groupProblems(two, '4').every((x) => !/קטגורי/.test(x.text)));
  });

  it('punchUsesProblem', () => {
    assert.equal(punchUsesProblem('50'), null);
    assert.equal(punchUsesProblem('120'), 'לא ניתן לשמור "120": בכרטיסייה אפשר 1–100 פריטים (המכסה של קבוצת פריטים אחת).');
    assert.notEqual(punchUsesProblem('0'), null);
  });
});

describe('"פריט אחד מכל קבוצה" (P:/specs/voucher-one-per-group.md §4)', () => {
  it('the preset: goods by groups, "מזון" and "שתייה" each 0–1, two items in all, in one sale; next to the meal', () => {
    const p = presetValues('perGroup');
    assert.deepEqual([p.kind, p.selection, p.totalQty, p.splitAllowed], ['items', 'groups', '2', false]);
    assert.deepEqual(p.groups.map((g) => [g.name, g.minQty, g.maxQty]), [['מזון', '0', '1'], ['שתייה', '0', '1']]);
    assert.deepEqual([...VOUCHER_PRESETS], ['choice', 'meal', 'perGroup', 'punch', 'discount']);
    assert.ok(isPerGroup(p.groups, p.totalQty));
    assert.deepEqual(groupsBody(p.groups).map((g) => [g.minQty, g.maxQty]), [[0, 1], [0, 1]]);
  });

  it('the preset keeps what was already picked on its first group', () => {
    assert.deepEqual(presetValues('perGroup', 50, { ...emptyGroup('x'), categories: [food] }).groups[0].categories, [food]);
  });

  it('9.14: adding "קינוח" with the switch on makes the total 3; every "עד" is 1', () => {
    const p = presetValues('perGroup');
    const added = withPerGroup([...p.groups, perGroupNewGroup('קינוח')]);
    assert.equal(added.totalQty, '3');
    assert.deepEqual(added.groups.map((g) => [g.name, g.minQty, g.maxQty]), [['מזון', '0', '1'], ['שתייה', '0', '1'], ['קינוח', '0', '1']]);
    const removed = withPerGroup(added.groups.slice(0, 2));
    assert.equal(removed.totalQty, '2');
  });

  it('turned on: "עד" comes down to 1 (and a "לפחות" above it), the total is the number of groups', () => {
    const free = [{ ...emptyGroup('מזון'), minQty: '2', maxQty: '2' }, { ...emptyGroup('שתייה'), minQty: '0', maxQty: '3' }];
    const on = withPerGroup(free);
    assert.deepEqual(on.groups.map((g) => [g.minQty, g.maxQty]), [['1', '1'], ['0', '1']]);
    assert.equal(on.totalQty, '2');
  });

  it('turned off, the numbers are free: מזון עד 2, שתייה עד 1, סה״כ 3 — and it reads as off', () => {
    const p = presetValues('perGroup');
    const free = [{ ...p.groups[0], maxQty: '2' }, p.groups[1]];
    assert.equal(isPerGroup(free, '3'), false);
    assert.deepEqual(groupProblems(free.map((g) => ({ ...g, categories: [food] })), '3'), []);
  });

  it('an existing voucher: on when every group is "עד 1" and the total is their number', () => {
    const g = (max: number) => ({ maxQty: max });
    assert.equal(isPerGroup([g(1), g(1)], 2), true);
    assert.equal(isPerGroup([g(1), g(1), g(1)], '3'), true);
    assert.equal(isPerGroup([g(1), g(1)], 1), false); // one of several
    assert.equal(isPerGroup([g(1), g(2)], 2), false);
    assert.equal(isPerGroup([g(1), g(1), g(1)], null), false); // the meal: the total left to the groups
    assert.equal(isPerGroup([g(1)], 1), false); // "פריט לבחירה"
    assert.equal(isPerGroup(presetValues('meal').groups, presetValues('meal').totalQty), false);
    assert.equal(isPerGroup(presetValues('choice').groups, presetValues('choice').totalQty), false);
  });
});

describe('the catalog check: what is sent and the warnings', () => {
  const drinks = { id: 'c-drinks', name: 'משקאות' };
  const hotdog = { id: 'p-hotdog', name: 'נקניקייה' };

  it('only the groups the cloud would take, with their place in the form', () => {
    const groups = [
      { ...emptyGroup('מזון'), minQty: '0', products: [hotdog], value: '-5' },
      { ...emptyGroup('קינוח') }, // nothing chosen yet
      { ...emptyGroup(''), minQty: '0', categories: [drinks] },
      { ...emptyGroup('שתייה'), minQty: '3', maxQty: '1', categories: [drinks] }, // "לפחות" above "עד"
    ];
    const { groups: sent, indexes } = groupsCheckBody(groups);
    assert.deepEqual(indexes, [0, 2]);
    assert.deepEqual(sent.map((g) => [g.name, g.value, g.productIds, g.categoryIds]), [
      ['מזון', null, ['p-hotdog'], []],
      ['קבוצה 3', null, [], ['c-drinks']],
    ]);
  });

  it('a product in both groups is said under each; an empty department under its group', () => {
    const check: GroupsCheck = {
      overlaps: [{ productId: 'p-hotdog', name: 'נקניקייה', groups: ['מזון', 'שתייה'], groupIndexes: [0, 1] }],
      overlapCount: 1,
      emptyGroups: [{ group: 'שתייה', groupIndex: 1, reason: 'empty_department', categoryId: 'c-drinks', categoryName: 'משקאות' }],
    };
    const text = "נקניקייה נמצאת גם ב'מזון' וגם ב'שתייה' — בקופה הקופאי יישאל לאיזו קבוצה לשייך";
    assert.deepEqual(groupWarnings(check, [0, 2]), [
      { group: 0, text },
      { group: 2, text },
      { group: 2, text: "במחלקה 'משקאות' אין כרגע מוצרים פעילים" },
    ]);
  });

  it('three groups; past three overlaps "ועוד"; a group with nothing active; no check, no warnings', () => {
    const o = (id: string, idx: number[]) => ({ productId: id, name: id, groups: ['א', 'ב', 'ג'].filter((_, i) => idx.includes(i)), groupIndexes: idx });
    const check: GroupsCheck = {
      overlaps: [o('w', [0, 1, 2]), o('x', [0, 1]), o('y', [0, 1]), o('z', [0, 1])],
      overlapCount: 4,
      emptyGroups: [{ group: 'ג', groupIndex: 2, reason: 'empty_group' }],
    };
    const out = groupWarnings(check, [0, 1, 2]);
    assert.equal(out[0].text, "w נמצאת גם ב'א', גם ב'ב' וגם ב'ג' — בקופה הקופאי יישאל לאיזו קבוצה לשייך");
    assert.deepEqual(out.filter((w) => w.group === 0).map((w) => w.text).slice(3), ['ועוד מוצר אחד שנמצא גם בקבוצה אחרת']);
    assert.deepEqual(out.filter((w) => w.group === 2).map((w) => w.text).slice(1), ["בקבוצה 'ג' אין כרגע מוצרים פעילים"]);
    assert.equal(groupWarnings({ ...check, overlapCount: 400 }, [0, 1, 2]).filter((w) => w.group === 0).pop()?.text,
      'ועוד מוצרים שנמצאים גם בקבוצה אחרת');
    assert.deepEqual(groupWarnings(null, [0]), []);
  });
});
