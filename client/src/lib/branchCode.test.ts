/**
 * Run with `npm test`. The branch code rules the shop form applies (lib/branchCode.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { branchCodeError, branchCodeInput, normalizeBranchCode } from './branchCode';

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
