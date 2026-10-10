/**
 * Run with `npm test`. Production of prepaid vouchers in groups (lib/prepaidVoucherGroups.ts):
 * what the form promises before a run is made — the same arithmetic as the server's group_plan.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { groupPlan, groupRange, groupSizeOf, serialRange } from './prepaidVoucherGroups';

describe('groupSizeOf', () => {
  it('reads the presets, a custom size and no grouping', () => {
    assert.equal(groupSizeOf('none', '7'), null);
    assert.equal(groupSizeOf('10', ''), 10);
    assert.equal(groupSizeOf('20', ''), 20);
    assert.equal(groupSizeOf('custom', ' 25 '), 25);
  });

  it('refuses a custom size that is not a whole number of at least 1', () => {
    for (const bad of ['', '0', '-3', '2.5', 'abc', '5001']) assert.equal(groupSizeOf('custom', bad), null);
  });
});

describe('groupPlan', () => {
  it('1000 in tens is 100 groups of 10', () => {
    assert.deepEqual(groupPlan(1000, 10), { groups: 100, size: 10, full: 100, last: null });
  });

  it('1005 in tens is 100 of 10 and one of 5', () => {
    assert.deepEqual(groupPlan(1005, 10), { groups: 101, size: 10, full: 100, last: 5 });
  });

  it('a custom size, and a run smaller than one group', () => {
    assert.deepEqual(groupPlan(20, 7), { groups: 3, size: 7, full: 2, last: 6 });
    assert.deepEqual(groupPlan(5, 20), { groups: 1, size: 20, full: 0, last: 5 });
  });

  it('no size or no vouchers is no plan', () => {
    assert.equal(groupPlan(1000, null), null);
    assert.equal(groupPlan(0, 10), null);
    assert.equal(groupPlan(Number.NaN, 10), null);
  });
});

describe('groupRange', () => {
  it('gives each group its serials, the last one short', () => {
    const plan = groupPlan(1005, 10)!;
    assert.deepEqual(groupRange(plan, 1), [1, 10]);
    assert.deepEqual(groupRange(plan, 3), [21, 30]);
    assert.deepEqual(groupRange(plan, 101), [1001, 1005]);
    assert.equal(serialRange(21, 30), '0021-0030');
  });
});
