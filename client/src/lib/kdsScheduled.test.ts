/**
 * Run with `npm test`. A scheduled line on the kitchen screens (P:/specs/fire-restaurant-flow.md §8.4): a hold task
 * with `scheduledAt` / `scheduledNote` reads "מתוזמן 20:30" / "מתוזמן · אחרי עיקריות", greyed with the held lines;
 * a plain held line or a released one says nothing of a schedule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledText } from './kdsBoard';

function localIso(h: number, m: number): string {
  const d = new Date(2026, 9, 14, h, m, 0, 0);
  return d.toISOString();
}

describe('kds: a scheduled line', () => {
  it('reads its local time', () => {
    assert.equal(scheduledText({ release: 'hold', scheduledAt: localIso(20, 30), scheduledNote: null }), 'מתוזמן 20:30');
    assert.equal(scheduledText({ release: 'hold', scheduledAt: localIso(9, 5) }), 'מתוזמן 09:05');
  });

  it('reads what it waits for', () => {
    assert.equal(scheduledText({ release: 'hold', scheduledAt: null, scheduledNote: 'אחרי עיקריות' }), 'מתוזמן · אחרי עיקריות');
  });

  it('says nothing for a plain held line or a released one', () => {
    assert.equal(scheduledText({ release: 'hold', scheduledAt: null, scheduledNote: null }), null);
    assert.equal(scheduledText({ release: 'hold' }), null);
    assert.equal(scheduledText({ release: 'released', scheduledAt: localIso(20, 30) }), null);
    assert.equal(scheduledText({ release: 'hold', scheduledAt: 'not a time' }), null);
  });
});
