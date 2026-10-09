/**
 * Run with `npm test`. "איפוס נתוני קופה (תמיכה)" — the rules the dialog shows (lib/tillReset.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { keptZRanges, tillResetBlock, tillResetTone, type TillResetPreview } from './tillReset';

const base: TillResetPreview = {
  machineId: 'm',
  online: true,
  unsynced: { outbox: 0 },
  warnings: [],
  keptZs: { days: 31, numbers: [3, 4, 5], awaitingOnTill: 0 },
  counters: { stay: true, lastTillZNumber: 5, documentCounters: { cloud: { '320': 9 } } },
  pending: null,
  last: null,
};

describe('tillResetBlock', () => {
  it('needs a kind and a reason, and one command at a time', () => {
    assert.equal(tillResetBlock(base, null, 'נתונים פגומים'), 'kind');
    assert.equal(tillResetBlock(base, 'full', ' x '), 'reason');
    assert.equal(tillResetBlock(base, 'full', 'נתונים פגומים'), null);
    const pending = {
      ...base,
      pending: {
        id: 'c', kind: 'full' as const, kindText: 'איפוס מלא', reason: 'r', by: 'a', requestedAt: 't',
        status: 'pending' as const,
      },
    };
    assert.equal(tillResetBlock(pending, 'full', 'נתונים פגומים'), 'pending');
  });
});

describe('keptZRanges', () => {
  it('says consecutive Z numbers as a range', () => {
    assert.equal(keptZRanges([5, 3, 4, 9]), '3–5, 9');
    assert.equal(keptZRanges([]), '');
  });
});

describe('tillResetTone', () => {
  it('a refusal or a failure stands out', () => {
    assert.equal(tillResetTone('pending'), 'secondary');
    assert.equal(tillResetTone('done'), 'outline');
    assert.equal(tillResetTone('refused'), 'destructive');
    assert.equal(tillResetTone('expired'), 'destructive');
  });
});
