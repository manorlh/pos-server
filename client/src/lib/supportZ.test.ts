/**
 * Run with `npm test`. "הפקת Z מהענן ע״י התמיכה" — the rules the dialog shows (lib/supportZ.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { numberRanges, supportZBlock, type SupportZPreview } from './supportZ';

const base: SupportZPreview = {
  machineId: 'm',
  zMode: { kind: 'till' },
  online: false,
  shifts: [{ id: 's', status: 'open', willClose: true }],
  documents: { count: 2 },
  zNumber: 5,
  cloudLastZNumber: 2,
  skippedNumbers: [3, 4],
  documentCounters: { gaps: [] },
};

describe('numberRanges', () => {
  it('says consecutive numbers as a range', () => {
    assert.equal(numberRanges([3, 4]), '3–4');
    assert.equal(numberRanges([8, 3, 4, 5]), '3–5, 8');
    assert.equal(numberRanges([7]), '7');
    assert.equal(numberRanges([]), '');
  });
});

describe('supportZBlock', () => {
  it('not while the till is online, nor with nothing to close', () => {
    assert.equal(supportZBlock({ ...base, online: true }), 'online');
    assert.equal(supportZBlock({ ...base, shifts: [] }), 'nothing');
    assert.equal(supportZBlock(base), null);
  });
});
