/**
 * Run with `npm test`. "שלבי הגשה": a course's auto-fire minutes (lib/courseFire.ts,
 * P:/specs/courses-fire-v2.md §5); the server checks the same 1–180 on `PUT /menu/courses`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FIRE_MINUTES_DEFAULT, fireMinutesInput, fireMinutesText, parseFireMinutes } from './courseFire';

describe('a course auto-fire minutes', () => {
  it('takes a whole number 1–180 only', () => {
    assert.equal(parseFireMinutes('15'), 15);
    assert.equal(parseFireMinutes(' 1 '), 1);
    assert.equal(parseFireMinutes('180'), 180);
    assert.equal(parseFireMinutes('015'), 15);
    assert.equal(parseFireMinutes('0'), null);
    assert.equal(parseFireMinutes('181'), null);
    assert.equal(parseFireMinutes(''), null);
    assert.equal(parseFireMinutes('2.5'), null);
    assert.equal(parseFireMinutes('-5'), null);
    assert.equal(parseFireMinutes('abc'), null);
    assert.equal(parseFireMinutes('1000'), null);
  });

  it('reads the stored value, else the default of 15', () => {
    assert.equal(FIRE_MINUTES_DEFAULT, 15);
    assert.equal(fireMinutesText(20), '20');
    assert.equal(fireMinutesText(undefined), '15');
    assert.equal(fireMinutesText(null), '15');
    assert.equal(fireMinutesText(7.5), '15');
  });

  it('keeps digits only while typing', () => {
    assert.equal(fireMinutesInput('12a'), '12');
    assert.equal(fireMinutesInput('1234'), '123');
    assert.equal(fireMinutesInput(''), '');
  });
});
