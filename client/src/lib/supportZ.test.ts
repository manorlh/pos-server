/**
 * Run with `npm test`. "הפקת Z מהענן ע״י התמיכה" — the rules the dialog shows (lib/supportZ.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { numberRanges, supportZBlock, supportZReady, type SupportZPreview } from './supportZ';

const base: SupportZPreview = {
  machineId: 'm',
  zMode: { kind: 'till' },
  online: false,
  shifts: [{ id: 's', status: 'open', willClose: true }],
  documents: { count: 2 },
  zNumber: 3,
  cloudLastZNumber: 2,
  reportedByTill: { lastNumber: 4, pendingZs: 2, numbers: [3, 4] },
  state: { tills: [], requiresConfirmation: true },
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

describe('supportZReady', () => {
  it('a reason, and the explicit confirmation while the state warns', () => {
    assert.equal(supportZReady(base, 'lost', false), false);
    assert.equal(supportZReady(base, 'lost', true), true);
    assert.equal(supportZReady(base, null, true), false);
    assert.equal(supportZReady({ ...base, state: { tills: [], requiresConfirmation: false } }, 'lost', false), true);
    assert.equal(supportZReady({ ...base, online: true }, 'lost', true), false);
  });
});

describe('supportZBlock', () => {
  it('not while the till is online, nor with nothing to close', () => {
    assert.equal(supportZBlock({ ...base, online: true }), 'online');
    assert.equal(supportZBlock({ ...base, shifts: [] }), 'nothing');
    assert.equal(supportZBlock(base), null);
  });
});
