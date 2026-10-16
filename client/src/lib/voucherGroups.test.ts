/**
 * Run with `npm test`. Production vouchers of groups (lib/voucherGroups.ts): the cloud's `assign_units` and
 * `check_selection`, replayed from the shared fixture `server/tests/fixtures/prepaid_voucher_rules.json` (sections
 * `assignment`, `selection`; its SHA-256 is pinned in kioskVouchers.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assignUnits, assignUnitsBy, checkSelection, unitsText, type SelectionGroup } from './voucherGroups';

interface AssignmentCase {
  name: string;
  groups: Array<{ key: string; productIds: string[]; remaining: number }>;
  totalRemaining: number;
  units: Array<[string, string]>;
  expect: { assigned: Record<string, string>; unassigned: Array<{ ref: string; reason: string }>; ambiguous: Array<{ ref: string; groupKeys: string[] }> };
}

interface SelectionCase {
  name: string;
  groups: SelectionGroup[];
  totalMax: number;
  totalRemaining: number;
  wholeAtOnce: boolean;
  typeName: string | null;
  chosen: Array<[string, string, number]>;
  expect: { refusal: { code: string; text: string; groupKey: string | null } | null };
}

function fixture(): { assignment: AssignmentCase[]; selection: SelectionCase[] } {
  const name = 'prepaid_voucher_rules.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `${name} not found`);
  return JSON.parse(readFileSync(found, 'utf8'));
}

const data = fixture();

describe('assignUnits (the fixture)', () => {
  assert.ok(data.assignment.length >= 10);
  for (const c of data.assignment) {
    it(c.name, () => {
      const got = assignUnits(c.groups, c.units, c.totalRemaining);
      assert.deepEqual(got.assigned, c.expect.assigned);
      assert.deepEqual(got.unassigned, c.expect.unassigned);
      assert.deepEqual(got.ambiguous, c.expect.ambiguous);
    });
  }
});

describe('checkSelection (the fixture)', () => {
  assert.ok(data.selection.length >= 15);
  for (const c of data.selection) {
    it(c.name, () => {
      const got = checkSelection(c.groups, c.chosen, { totalMax: c.totalMax, totalRemaining: c.totalRemaining, wholeAtOnce: c.wholeAtOnce, typeName: c.typeName });
      assert.deepEqual(got, c.expect.refusal);
    });
  }
});

describe('assignUnitsBy', () => {
  it('takes any predicate: a group by category', () => {
    const units: Array<[string, { pid: string; cat: string }]> = [
      ['u1', { pid: 'a', cat: 'drinks' }],
      ['u2', { pid: 'b', cat: 'food' }],
    ];
    const got = assignUnitsBy(
      [
        { key: 'drink', remaining: 1, takes: (u: { cat: string }) => u.cat === 'drinks' },
        { key: 'food', remaining: 1, takes: (u: { cat: string }) => u.cat === 'food' },
      ],
      units,
      2,
    );
    assert.deepEqual(got.assigned, { u1: 'drink', u2: 'food' });
  });

  it('says units as the glossary does', () => {
    assert.equal(unitsText(1), 'פריט אחד');
    assert.equal(unitsText(3), '3 פריטים');
  });
});
