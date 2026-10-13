/**
 * Run with `npm test`. "מדיניות התראות" — which exception rules are the alert policy (lib/alertPolicy.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALERT_POLICY_TYPES, isAlertPolicyType, splitPolicyRules } from './alertPolicy';

describe('the alert policy among the exception rules', () => {
  it('names the four kinds of the spec', () => {
    assert.deepEqual([...ALERT_POLICY_TYPES], ['z_missing', 'shift_open_overdue', 'card_transmission_overdue', 'till_printer']);
    assert.equal(isAlertPolicyType('till_printer'), true);
    assert.equal(isAlertPolicyType('till_offline'), false);
  });

  it('puts them first in their own order and keeps the rest in the server order', () => {
    const rules = [
      { type: 'discount' },
      { type: 'till_printer' },
      { type: 'refund' },
      { type: 'z_missing' },
      { type: 'card_transmission_overdue' },
      { type: 'shift_open_overdue' },
    ];
    const { policy, others } = splitPolicyRules(rules);
    assert.deepEqual(policy.map((r) => r.type), ['z_missing', 'shift_open_overdue', 'card_transmission_overdue', 'till_printer']);
    assert.deepEqual(others.map((r) => r.type), ['discount', 'refund']);
  });

  it('an older server without them: no policy section', () => {
    const { policy, others } = splitPolicyRules([{ type: 'discount' }]);
    assert.equal(policy.length, 0);
    assert.equal(others.length, 1);
  });
});
