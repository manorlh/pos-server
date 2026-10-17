/**
 * Run with `npm test`. "מדיניות התראות" — which exception rules are the alert policy (lib/alertPolicy.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_POLICY_TYPES,
  isAlertPolicyType,
  offersPushSwitch,
  paramInvalid,
  paramText,
  paramValue,
  splitPolicyRules,
} from './alertPolicy';

describe('the alert policy among the exception rules', () => {
  it('names the four kinds of the spec, and the device clock (clock_trust)', () => {
    assert.deepEqual([...ALERT_POLICY_TYPES], ['z_missing', 'shift_open_overdue', 'card_transmission_overdue', 'till_printer', 'till_clock']);
    assert.equal(isAlertPolicyType('till_clock'), true);
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

  it('offers the push switch only for a kind sent as a phone alert, never for integrity', () => {
    assert.equal(offersPushSwitch({ inheritedPush: false, pushCategory: 'discounts' }), true);
    assert.equal(offersPushSwitch({ inheritedPush: true, pushCategory: null }), false);
    assert.equal(offersPushSwitch({ inheritedPush: true, pushCategory: 'integrity' }), false);
    assert.equal(offersPushSwitch({ pushCategory: 'discounts' }), false);
  });

  it('an older server without them: no policy section', () => {
    const { policy, others } = splitPolicyRules([{ type: 'discount' }]);
    assert.equal(policy.length, 0);
    assert.equal(others.length, 1);
  });
});

describe('a rule param: a threshold or a switch (owner-decisions-1410 §3, alertPastDate)', () => {
  const hours = { key: 'hours', min: 1, max: 96, integer: true, boolean: false };
  const pastDate = { key: 'alertPastDate', min: 0, max: 1_000_000, integer: false, boolean: true };

  it('reads a level own value as the editor text, inherit as empty', () => {
    assert.equal(paramText(16), '16');
    assert.equal(paramText(true), 'true');
    assert.equal(paramText(false), 'false');
    assert.equal(paramText(null), '');
    assert.equal(paramText(undefined), '');
  });

  it('a switch takes true / false only, a threshold its range', () => {
    assert.equal(paramInvalid(pastDate, ''), false);
    assert.equal(paramInvalid(pastDate, 'true'), false);
    assert.equal(paramInvalid(pastDate, 'false'), false);
    assert.equal(paramInvalid(pastDate, '1'), true);
    assert.equal(paramInvalid(hours, '16'), false);
    assert.equal(paramInvalid(hours, '0'), true);
    assert.equal(paramInvalid(hours, '2.5'), true);
    assert.equal(paramInvalid(hours, 'x'), true);
    assert.equal(paramInvalid(undefined, '3'), true);
  });

  it('saves true / false for a switch, a number for a threshold, null to inherit', () => {
    assert.equal(paramValue(pastDate, 'true'), true);
    assert.equal(paramValue(pastDate, 'false'), false);
    assert.equal(paramValue(pastDate, ''), null);
    assert.equal(paramValue(hours, '20'), 20);
    assert.equal(paramValue(hours, ' '), null);
    // An older server (no `boolean`): every param a number.
    assert.equal(paramValue({ key: 'hours', min: 1, max: 96, integer: true }, '7'), 7);
  });
});
