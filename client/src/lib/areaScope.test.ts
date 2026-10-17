import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areaOptionsFor,
  clampToAreaReach,
  mayPickWholeShop,
  savedScopeFor,
  scopePatch,
  workingOnLabel,
} from './areaScope';

const SHOP = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BAR = '33333333-3333-4333-8333-333333333333';
const KITCHEN = '44444444-4444-4444-8444-444444444444';
const T = '55555555-5555-4555-8555-555555555555';

const reach = { areaIds: [BAR], areas: [{ id: BAR, name: 'בר', shopId: SHOP }] };

test('a manager of points of sale is held to theirs', () => {
  assert.deepEqual(clampToAreaReach({ companyId: null, shopId: null, machineId: null }, reach), {
    companyId: null, shopId: SHOP, machineId: null, areaId: BAR,
  });
  assert.deepEqual(clampToAreaReach({ companyId: 'c', shopId: SHOP, machineId: null, areaId: KITCHEN }, reach), {
    companyId: 'c', shopId: SHOP, machineId: null, areaId: BAR,
  });
  assert.equal(clampToAreaReach({ companyId: 'c', shopId: SHOP, machineId: null, areaId: BAR }, reach), null);
  assert.deepEqual(clampToAreaReach({ companyId: 'c', shopId: OTHER, machineId: null }, reach)?.shopId, SHOP);
});

test('everyone else is not clamped and may pick the whole shop', () => {
  assert.equal(clampToAreaReach({ companyId: null, shopId: SHOP, machineId: null }, { areaIds: [] }), null);
  assert.equal(clampToAreaReach({ companyId: null, shopId: SHOP, machineId: null }, null), null);
  assert.equal(mayPickWholeShop(null), true);
  assert.equal(mayPickWholeShop(reach), false);
});

test('area options', () => {
  const areas = [{ id: BAR }, { id: KITCHEN }];
  assert.deepEqual(areaOptionsFor(areas, reach), [{ id: BAR }]);
  assert.deepEqual(areaOptionsFor(areas, null), areas);
});

test('saved scope is read defensively and written per organization', () => {
  assert.deepEqual(savedScopeFor({ [T]: { shopId: SHOP, areaId: BAR } }, T), {
    companyId: null, shopId: SHOP, machineId: null, areaId: BAR,
  });
  assert.equal(savedScopeFor({ [T]: { shopId: 'x' } }, T), null);
  assert.deepEqual(savedScopeFor({ [T]: { areaId: BAR } }, T), null);
  assert.equal(savedScopeFor(null, T), null);
  assert.deepEqual(scopePatch(T, { companyId: null, shopId: SHOP, machineId: null, areaId: BAR }), {
    dashboardScope: { [T]: { shopId: SHOP, areaId: BAR } },
  });
  assert.deepEqual(scopePatch(T, { companyId: null, shopId: null, machineId: null, areaId: BAR }), {
    dashboardScope: { [T]: null },
  });
});

test('the working-on label', () => {
  assert.equal(workingOnLabel(['רשת', 'היכל'], 'כל הנקודות', true, null), 'רשת › היכל › כל הנקודות');
  assert.equal(workingOnLabel(['רשת', 'היכל'], 'כל הנקודות', true, 'בר'), 'רשת › היכל › בר');
  assert.equal(workingOnLabel(['רשת'], 'כל הנקודות', false), 'רשת');
});
