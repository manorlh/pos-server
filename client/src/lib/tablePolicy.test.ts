/**
 * Run with `npm test`. The floor editor's table policies (lib/tablePolicy.ts) — the server
 * resolves the same (app/services/table_policies.py; tests/test_table_policies.py) and the
 * till applies it (pos-android domain/TablePolicy.kt).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  draftOf,
  mealEmployees,
  parseDiscount,
  percentText,
  policyBadge,
  policyBody,
  resolveDraft,
  typeBody,
  typeDraftOf,
  validatePolicyDraft,
  validateTypeDraft,
  type TableType,
} from './tablePolicy';

const staffType: TableType = {
  id: 't-staff',
  shopId: 's',
  name: 'עובדים',
  kind: 'staff',
  discountPercent: 50,
  requireApproval: false,
  requireReason: false,
  staffMode: 'percent',
  staffAllowance: null,
  sortOrder: 0,
};

describe('a discount as typed', () => {
  it('takes 0–100 with up to two decimals, empty as none', () => {
    assert.equal(parseDiscount(''), 0);
    assert.equal(parseDiscount('10'), 10);
    assert.equal(parseDiscount('12.5'), 12.5);
    assert.equal(parseDiscount('100'), 100);
    for (const bad of ['-1', '100.01', '101', 'abc', '1.234', '1e2']) assert.equal(parseDiscount(bad), null, bad);
  });
});

describe('the table form', () => {
  it('refuses a bad discount, an unknown kind and a type that is gone', () => {
    assert.deepEqual(validatePolicyDraft({ typeId: '', kind: 'regular', discount: '10' }, []), []);
    assert.deepEqual(validatePolicyDraft({ typeId: '', kind: 'staff', discount: '120' }, []), ['discount_invalid']);
    assert.deepEqual(
      validatePolicyDraft({ typeId: '', kind: 'vip' as never, discount: '' }, []),
      ['kind_invalid'],
    );
    assert.deepEqual(validatePolicyDraft({ typeId: 'nope', kind: 'regular', discount: 'x' }, [staffType]), ['type_missing']);
    // With a type, the table's own discount is not what counts.
    assert.deepEqual(validatePolicyDraft({ typeId: 't-staff', kind: 'regular', discount: 'x' }, [staffType]), []);
  });

  it('sends a type, or the own kind and discount (0 clears it)', () => {
    assert.deepEqual(policyBody({ typeId: 't-staff', kind: 'regular', discount: '5' }), { typeId: 't-staff' });
    assert.deepEqual(policyBody({ typeId: '', kind: 'managers', discount: '100' }), {
      typeId: null,
      kind: 'managers',
      discountPercent: 100,
    });
    assert.deepEqual(policyBody({ typeId: '', kind: 'regular', discount: '' }), {
      typeId: null,
      kind: 'regular',
      discountPercent: null,
    });
    assert.deepEqual(draftOf({ typeId: null, kind: 'staff', discountPercent: 30 }), { typeId: '', kind: 'staff', discount: '30' });
    assert.deepEqual(draftOf(null), { typeId: '', kind: 'regular', discount: '' });
  });

  it('resolves like the server: a type wins, managers always ask for a manager and a reason', () => {
    const viaType = resolveDraft({ typeId: 't-staff', kind: 'managers', discount: '100' }, [staffType]);
    assert.equal(viaType.kind, 'staff');
    assert.equal(viaType.discountPercent, 50);
    assert.equal(viaType.requireEmployee, true);
    assert.equal(viaType.typeName, 'עובדים');
    const own = resolveDraft({ typeId: '', kind: 'managers', discount: '100' }, [staffType]);
    assert.deepEqual([own.requireApproval, own.requireReason, own.requireEmployee], [true, true, false]);
  });
});

describe('the badge on a table', () => {
  it('says the kind and the discount, nothing on an ordinary table', () => {
    assert.equal(policyBadge({ kind: 'regular', discountPercent: 0 }), null);
    assert.deepEqual(policyBadge({ kind: 'regular', discountPercent: 10 }), { kind: null, discount: '-10%' });
    assert.deepEqual(policyBadge({ kind: 'staff', discountPercent: 12.5 }), { kind: 'staff', discount: '-12.5%' });
    assert.deepEqual(policyBadge({ kind: 'managers', discountPercent: 0 }), { kind: 'managers', discount: null });
    assert.equal(percentText(33.333), '33.33');
  });
});

describe('a table type', () => {
  it('needs a name and a valid discount; an allowance only for a staff type that uses one', () => {
    const base = typeDraftOf(null);
    assert.deepEqual(validateTypeDraft(base), ['name_required']);
    assert.deepEqual(validateTypeDraft({ ...base, name: 'VIP', discount: '10' }), []);
    assert.deepEqual(validateTypeDraft({ ...base, name: 'VIP', discount: '150' }), ['discount_invalid']);
    assert.deepEqual(
      validateTypeDraft({ ...base, name: 'עובדים', kind: 'staff', staffMode: 'allowance', allowance: '' }),
      ['allowance_invalid'],
    );
    assert.deepEqual(
      validateTypeDraft({ ...base, name: 'עובדים', kind: 'staff', staffMode: 'allowance', allowance: '45' }),
      [],
    );
  });

  it('a managers type always asks for a manager; the staff mode only on a staff type', () => {
    const body = typeBody({ ...typeDraftOf(null), name: ' מנהלים ', kind: 'managers', discount: '100', staffMode: 'allowance' });
    assert.deepEqual(body, {
      name: 'מנהלים',
      kind: 'managers',
      discountPercent: 100,
      requireApproval: true,
      requireReason: false,
      staffMode: 'percent',
      staffAllowance: null,
    });
    const staff = typeBody({ ...typeDraftOf(staffType), staffMode: 'allowance', allowance: '45' });
    assert.equal(staff.staffAllowance, 45);
    assert.equal(staff.discountPercent, 50);
  });
});

describe('the meals report', () => {
  it('lists each employee once, by name', () => {
    const report = {
      byEmployee: [
        { kind: 'staff' as const, employeeId: '2', employee: 'יוסי', count: 1, before: 1, discount: 1, paid: 0 },
        { kind: 'staff' as const, employeeId: '1', employee: 'דנה', count: 1, before: 1, discount: 1, paid: 0 },
        { kind: 'managers' as const, employeeId: null, employee: 'דנה', count: 1, before: 1, discount: 1, paid: 0 },
        { kind: 'managers' as const, employeeId: null, employee: null, count: 1, before: 1, discount: 1, paid: 0 },
      ],
    };
    assert.deepEqual(mealEmployees(report), ['דנה', 'יוסי']);
    assert.deepEqual(mealEmployees(null), []);
  });
});
