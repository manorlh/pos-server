/**
 * Run with `npm test`. The branch code rules the shop form applies (lib/branchCode.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  branchCodeCreatePayload,
  branchCodeError,
  branchCodeInput,
  branchCodeReassigned,
  normalizeBranchCode,
  shouldPrefillBranchCode,
} from './branchCode';

describe('branchCodeError', () => {
  it('a shop must have a code', () => {
    assert.equal(branchCodeError(''), 'required');
    assert.equal(branchCodeError('   '), 'required');
    assert.equal(branchCodeError(undefined), 'required');
    assert.equal(branchCodeError(null), 'required');
  });

  it('digits only, one to seven of them (open-format field 1231 is X(7))', () => {
    assert.equal(branchCodeError('1'), null);
    assert.equal(branchCodeError('001'), null);
    assert.equal(branchCodeError('1234567'), null);
    assert.equal(branchCodeError(' 12 '), null);
    assert.equal(branchCodeError('12345678'), 'invalid');
    assert.equal(branchCodeError('A1'), 'invalid');
    assert.equal(branchCodeError('1-2'), 'invalid');
  });
});

describe('the field', () => {
  it('keeps digits only, at most seven', () => {
    assert.equal(branchCodeInput('a1b2-3'), '123');
    assert.equal(branchCodeInput('123456789'), '1234567');
  });

  it('sends the code trimmed', () => {
    assert.equal(normalizeBranchCode(' 7 '), '7');
  });
});

describe('the next code, pre-filled (P:/specs/shop-code-and-inactive.md §2)', () => {
  it('the suggestion left as it was is sent flagged, so a taken one becomes the next', () => {
    assert.deepEqual(branchCodeCreatePayload('12', '12'), { branchId: '12', branchIdAuto: true });
    assert.deepEqual(branchCodeCreatePayload(' 12 ', '12'), { branchId: '12', branchIdAuto: true });
  });

  it('a code typed by hand is sent plain (a taken one is a 409)', () => {
    assert.deepEqual(branchCodeCreatePayload('7', '12'), { branchId: '7' });
    assert.deepEqual(branchCodeCreatePayload('7', null), { branchId: '7' });
    assert.deepEqual(branchCodeCreatePayload('', ''), { branchId: '' });
  });

  it('a suggestion fills the field only while it is empty or still the previous suggestion', () => {
    assert.equal(shouldPrefillBranchCode('', null), true);
    assert.equal(shouldPrefillBranchCode(undefined, '3'), true);
    assert.equal(shouldPrefillBranchCode('3', '3'), true);
    assert.equal(shouldPrefillBranchCode('9', '3'), false);
    assert.equal(shouldPrefillBranchCode('9', null), false);
  });

  it('says when the shop got another code than the suggestion sent', () => {
    assert.equal(branchCodeReassigned({ branchId: '3', branchIdAuto: true }, '4'), '4');
    assert.equal(branchCodeReassigned({ branchId: '3', branchIdAuto: true }, '3'), null);
    assert.equal(branchCodeReassigned({ branchId: '3' }, '4'), null);
    assert.equal(branchCodeReassigned({ branchId: '3', branchIdAuto: true }, undefined), null);
  });
});
