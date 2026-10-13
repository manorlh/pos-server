/**
 * Run with `npm test`. "בניית חברת הדגמה" — the rules the dashboard applies (lib/demoCompany.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBody,
  deviceState,
  EMPTY_DEMO_FORM,
  formatCode,
  minutesLeft,
  pairingProgress,
  phoneProblem,
  vatNumberProblem,
} from './demoCompany';
import type { DemoDevice, DemoShop } from './demoCompany';

const NOW = new Date('2026-10-13T10:00:00Z');

const device = (over: Partial<DemoDevice> = {}): DemoDevice => ({
  key: 'till',
  label: 'קופה',
  role: 'till',
  roleLabel: 'קופה',
  code: 'AB12CD34',
  expiresAt: '2026-10-13T10:14:30Z',
  status: 'waiting',
  machineId: null,
  machineName: null,
  ...over,
});

const shop = (devices: DemoDevice[]): DemoShop => ({
  key: 'snack', id: 's1', name: 'מזנון', present: true, trainingMode: false, devices, checklist: [],
});

describe('the build body', () => {
  it('sends nothing for an empty form: every detail is filled later', () => {
    assert.deepEqual(buildBody(EMPTY_DEMO_FORM), {});
  });

  it('sends what was typed, trimmed; spaces out of the VAT number', () => {
    assert.deepEqual(
      buildBody({ vatNumber: ' 515 151 515 ', dealerType: 'licensed', address: ' הרצל 1 ', city: 'תל אביב', phone: ' 03-5555555 ' }),
      { vatNumber: '515151515', dealerType: 'licensed', address: 'הרצל 1', city: 'תל אביב', phone: '03-5555555' },
    );
  });

  it('leaves the dealer type out when not chosen (the server keeps its default)', () => {
    assert.equal('dealerType' in buildBody({ ...EMPTY_DEMO_FORM, vatNumber: '1' }), false);
  });
});

describe('the form checks', () => {
  it('a VAT number: digits, at most nine, or empty', () => {
    assert.equal(vatNumberProblem(''), null);
    assert.equal(vatNumberProblem('515151515'), null);
    assert.equal(vatNumberProblem('51515a'), 'digits');
    assert.equal(vatNumberProblem('5151515151'), 'length');
  });

  it('a phone: seven digits or more, dashes and a leading plus allowed, or empty', () => {
    assert.equal(phoneProblem(''), null);
    assert.equal(phoneProblem('03-5555555'), null);
    assert.equal(phoneProblem('+972 50 555 5555'), null);
    assert.equal(phoneProblem('12345'), 'invalid');
    assert.equal(phoneProblem('03-555555x'), 'invalid');
  });
});

describe('the devices', () => {
  it('minutes left, never below zero', () => {
    assert.equal(minutesLeft('2026-10-13T10:14:30Z', NOW), 14);
    assert.equal(minutesLeft('2026-10-13T09:00:00Z', NOW), 0);
    assert.equal(minutesLeft(null, NOW), null);
    assert.equal(minutesLeft('not a date', NOW), null);
  });

  it('a waiting code whose time ran out reads as expired', () => {
    assert.equal(deviceState(device(), NOW), 'waiting');
    assert.equal(deviceState(device({ expiresAt: '2026-10-13T09:59:00Z' }), NOW), 'expired');
    assert.equal(deviceState(device({ status: 'paired', code: null, expiresAt: null }), NOW), 'paired');
  });

  it('progress: paired, still to pair, and the codes to renew', () => {
    const p = pairingProgress(
      [shop([device(), device({ key: 'k', status: 'paired', code: null }), device({ key: 'e', expiresAt: '2026-10-13T09:00:00Z' })])],
      NOW,
    );
    assert.deepEqual(p, { total: 3, paired: 1, toPair: 2, expired: 1 });
    assert.deepEqual(pairingProgress(undefined, NOW), { total: 0, paired: 0, toPair: 0, expired: 0 });
  });

  it('a code in two halves, for typing', () => {
    assert.equal(formatCode('AB12CD34'), 'AB12 CD34');
    assert.equal(formatCode('ABC1234'), 'ABC1 234');
    assert.equal(formatCode('ABC'), 'ABC');
    assert.equal(formatCode(null), '');
  });
});
