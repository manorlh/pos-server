/**
 * Run with `npm test`. "פתיחת פריטים אוטומטית אחרי Z" and "חסימה קבועה" as the dashboard
 * shows and sends them (lib/availabilityReopen.ts; pos-server docs/SPEC_AVAILABILITY.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  autoReopenPatch,
  choiceOf,
  effectiveIgnoreStock,
  effectiveMode,
  ignoreStockChoiceOf,
  lockKind,
  parseAutoReopenMode,
  runItemNames,
  type AvailabilityReopenRun,
} from './availabilityReopen';

describe('the setting at one level', () => {
  it('reads only the three modes', () => {
    assert.equal(parseAutoReopenMode('day'), 'day');
    assert.equal(parseAutoReopenMode('sometimes'), null);
    assert.equal(parseAutoReopenMode(undefined), null);
    assert.equal(choiceOf(undefined), 'inherit');
    assert.equal(choiceOf('all'), 'all');
  });

  it('inherits, and is off when no level sets it', () => {
    assert.deepEqual(effectiveMode('inherit', undefined), { mode: 'off', from: 'default' });
    assert.deepEqual(effectiveMode('inherit', 'day'), { mode: 'day', from: 'inherited' });
    assert.deepEqual(effectiveMode('all', 'day'), { mode: 'all', from: 'own' });
    assert.deepEqual(effectiveMode('off', 'all'), { mode: 'off', from: 'own' }, 'a shop can switch it off under its company');
  });

  it('ignores stock only when a level says so', () => {
    assert.equal(effectiveIgnoreStock('inherit', undefined), false);
    assert.equal(effectiveIgnoreStock('inherit', true), true);
    assert.equal(effectiveIgnoreStock('off', true), false);
    assert.equal(ignoreStockChoiceOf(false), 'off');
  });
});

describe('the PATCH', () => {
  it('sends only what changed', () => {
    assert.deepEqual(autoReopenPatch({}, 'inherit', 'inherit'), {});
    assert.deepEqual(autoReopenPatch({ autoReopenAfterZ: 'day' }, 'day', 'inherit'), {});
    assert.deepEqual(autoReopenPatch({}, 'all', 'on'), { autoReopenAfterZ: 'all', autoReopenIgnoreStock: true });
  });

  it('sends null to inherit again', () => {
    assert.deepEqual(
      autoReopenPatch({ autoReopenAfterZ: 'all', autoReopenIgnoreStock: false }, 'inherit', 'inherit'),
      { autoReopenAfterZ: null, autoReopenIgnoreStock: null },
    );
  });
});

describe('a lock', () => {
  it('is temporary unless marked permanent, and only where a Z reopens', () => {
    assert.equal(lockKind('shop', { value: false }), 'temporary');
    assert.equal(lockKind('machine', { value: false, permanent: true }), 'permanent');
    assert.equal(lockKind('area', { value: null }), null);
    assert.equal(lockKind('company', { value: false }), null, 'no Z closes a company');
  });
});

describe('the log', () => {
  it('lists what a Z reopened and what it kept for stock', () => {
    const run: AvailabilityReopenRun = {
      zReportId: 'z', zNumber: 12, zOrigin: 'cloud', level: 'shop', targetId: 's', targetName: 'הרצליה',
      closedAt: '2026-10-06T21:00:00+00:00', mode: 'all', ignoreStock: false, reopenedCount: 2, keptCount: 1,
      items: [
        { kind: 'product', itemId: '1', name: 'קולה', outcome: 'reopened', blockedAt: null },
        { kind: 'category', itemId: '2', name: 'בירות', outcome: 'reopened', blockedAt: null },
        { kind: 'product', itemId: '3', name: 'עוגה', outcome: 'kept_stock', blockedAt: null },
      ],
    };
    assert.deepEqual(runItemNames(run), { reopened: ['בירות', 'קולה'], kept: ['עוגה'] });
  });
});
