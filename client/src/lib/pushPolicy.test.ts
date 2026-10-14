/**
 * Run with `npm test`. "התראות בנייד" — the policy editors' pure rules (lib/pushPolicy.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deviceReady,
  effectiveRule,
  EMPTY_POLICY,
  healthRank,
  parsePolicy,
  policyBody,
  samePolicy,
  setNotify,
  setRequired,
} from './pushPolicy';

describe('a level’s policy', () => {
  it('reads forgivingly: unknown values inherit', () => {
    assert.deepEqual(parsePolicy(null), EMPTY_POLICY);
    assert.deepEqual(
      parsePolicy({ required: 'sometimes', notify: { approvals: { requireInteraction: 'nah', vibrate: 'urgent' }, x: 5 } }),
      { required: null, notify: { approvals: { vibrate: 'urgent' } } },
    );
    assert.deepEqual(parsePolicy({ required: 'required', notify: {} }), { required: 'required', notify: {} });
  });

  it('sets and clears field by field; an emptied category is dropped', () => {
    let p = setRequired(EMPTY_POLICY, 'reminder');
    p = setNotify(p, 'approvals', 'requireInteraction', 'never');
    p = setNotify(p, 'approvals', 'vibrate', 'long');
    assert.deepEqual(policyBody(p), { required: 'reminder', notify: { approvals: { requireInteraction: 'never', vibrate: 'long' } } });
    p = setNotify(p, 'approvals', 'requireInteraction', null);
    assert.deepEqual(p.notify, { approvals: { vibrate: 'long' } });
    p = setNotify(p, 'approvals', 'vibrate', null);
    assert.deepEqual(p.notify, {});
    assert.equal(samePolicy(setRequired(p, null), EMPTY_POLICY), true);
    assert.equal(samePolicy(p, EMPTY_POLICY), false);
  });

  it('a category’s own fields over what it inherits', () => {
    assert.deepEqual(effectiveRule({ requireInteraction: 'always', vibrate: 'urgent' }, { vibrate: 'short' }), {
      requireInteraction: 'always',
      vibrate: 'short',
    });
    assert.deepEqual(effectiveRule({ requireInteraction: 'critical', vibrate: 'default' }, undefined), {
      requireInteraction: 'critical',
      vibrate: 'default',
    });
  });
});

describe('devices', () => {
  it('this device is ready when registered and not failing', () => {
    assert.equal(deviceReady(null), false);
    assert.equal(deviceReady({ thisDeviceRegistered: false, thisDevice: null }), false);
    assert.equal(deviceReady({ thisDeviceRegistered: true, thisDevice: { lastSuccessAt: null, lastFailureAt: null, failing: false } }), true);
    assert.equal(deviceReady({ thisDeviceRegistered: true, thisDevice: { lastSuccessAt: null, lastFailureAt: 'x', failing: true } }), false);
  });

  it('who must have notifications and has none comes first', () => {
    const h = (required: 'off' | 'reminder' | 'required', tone: 'green' | 'yellow' | 'red') => ({
      devices: 0, lastSuccessAt: null, lastFailureAt: null, tone, required,
    });
    const order = [h('off', 'green'), h('required', 'green'), h('reminder', 'red'), h('required', 'red'), h('required', 'yellow')]
      .sort((a, b) => healthRank(a) - healthRank(b))
      .map((x) => `${x.required}/${x.tone}`);
    assert.deepEqual(order, ['required/red', 'required/yellow', 'required/green', 'reminder/red', 'off/green']);
    assert.equal(healthRank(undefined), 9);
  });
});
