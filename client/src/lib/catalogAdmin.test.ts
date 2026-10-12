import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areasWithoutMenu,
  changedValues,
  fromText,
  levelOptions,
  ownKeys,
  parseLevelValue,
  shopOfLevel,
  toText,
  type AdminTarget,
} from './catalogAdmin';

const targets: AdminTarget[] = [
  { level: 'company', id: 'c1', name: 'רשת', parentId: null },
  { level: 'company', id: 'c2', name: 'בת', parentId: 'c1' },
  { level: 'shop', id: 's1', name: 'סניף א', parentId: 'c1' },
  { level: 'shop', id: 's2', name: 'סניף ב', parentId: 'c2' },
  { level: 'area', id: 'a1', name: 'בר', parentId: 's1' },
  { level: 'area', id: 'a2', name: 'מטבח', parentId: 's1' },
  { level: 'machine', id: 'm1', name: 'קופה', parentId: 'a1', posNumber: '3', shopId: 's1' },
  { level: 'machine', id: 'm2', name: 'קופה 2', parentId: 's1', posNumber: null, shopId: 's1' },
  { level: 'group', id: 'g1', name: 'קבוצה', parentId: 'c1' },
];

test('the level picker lists companies, shops, points of sale and tills in tree order, no groups', () => {
  const opts = levelOptions(targets, (n) => `קופה מס׳ ${n}`);
  assert.deepEqual(
    opts.map((o) => [o.value, o.depth, o.name]),
    [
      ['company:c1', 0, 'רשת'],
      ['shop:s1', 1, 'סניף א'],
      ['area:a1', 2, 'בר'],
      ['machine:m1', 3, 'קופה מס׳ 3 · קופה'],
      ['area:a2', 2, 'מטבח'],
      ['machine:m2', 2, 'קופה 2'],
      ['company:c2', 1, 'בת'],
      ['shop:s2', 2, 'סניף ב'],
    ],
  );
});

test('a point of sale with no menu (or only an inactive one) shows the shop catalog', () => {
  const assignments = [
    { level: 'area', targetId: 'a1', menuId: 'menu-bar' },
    { level: 'shop', targetId: 's1', menuId: 'menu-shop' },
  ];
  assert.deepEqual(areasWithoutMenu(targets, assignments).map((a) => a.id), ['a2']);
  assert.deepEqual(areasWithoutMenu(targets, assignments, 's2'), []);
  assert.deepEqual(
    areasWithoutMenu(targets, assignments, 's1', new Set(['menu-shop'])).map((a) => a.id),
    ['a1', 'a2'],
  );
});

test('the shop of a level', () => {
  assert.equal(shopOfLevel(targets, 'company', 'c1'), null);
  assert.equal(shopOfLevel(targets, 'shop', 's1'), 's1');
  assert.equal(shopOfLevel(targets, 'area', 'a1'), 's1');
  assert.equal(shopOfLevel(targets, 'machine', 'm1'), 's1');
  assert.equal(shopOfLevel(targets, 'machine', 'nope'), null);
});

test('level values parse back; anything else is refused', () => {
  assert.deepEqual(parseLevelValue('area:a1'), { level: 'area', id: 'a1' });
  assert.equal(parseLevelValue('group:g1'), null);
  assert.equal(parseLevelValue('nothing'), null);
});

test('own keys are what a reset clears', () => {
  assert.deepEqual(ownKeys({ catalogAdminScope: 'shop', catalogAdminEnabled: false, other: 1 }), [
    'catalogAdminEnabled',
    'catalogAdminScope',
  ]);
  assert.deepEqual(ownKeys({}), []);
});

test('only edits that differ are sent; blank clears, booleans are booleans', () => {
  assert.equal(toText(false), 'false');
  assert.equal(toText(undefined), '');
  assert.equal(fromText('boolean', 'true'), true);
  assert.equal(fromText('enum', ''), null);
  assert.deepEqual(
    changedValues(
      { catalogAdminEnabled: true, catalogAdminScope: 'area' },
      { catalogAdminEnabled: 'true', catalogAdminScope: '', catalogWithoutShift: 'never' },
      { catalogAdminEnabled: 'boolean', catalogAdminScope: 'enum', catalogWithoutShift: 'enum' },
    ),
    { catalogAdminScope: null, catalogWithoutShift: 'never' },
  );
});
