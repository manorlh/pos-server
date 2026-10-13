/**
 * Run with `npm test`. "סניף לא פעיל" — the switch's rules (lib/shopActive.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  lastShopActiveChange,
  SHOP_ACTIVE_REASON_MAX,
  shopActiveConfirmKind,
  shopActivePayload,
  shopActiveReasonError,
  withoutActiveFields,
} from './shopActive';

describe('the reason', () => {
  it('is required', () => {
    assert.equal(shopActiveReasonError(''), 'required');
    assert.equal(shopActiveReasonError('   '), 'required');
    assert.equal(shopActiveReasonError(undefined), 'required');
    assert.equal(shopActiveReasonError(null), 'required');
    assert.equal(shopActiveReasonError('החוזה הסתיים'), null);
  });

  it('is sent trimmed, at most 500 characters, with the new state', () => {
    assert.deepEqual(shopActivePayload(false, '  החוזה הסתיים '), { isActive: false, activeReason: 'החוזה הסתיים' });
    assert.equal(shopActivePayload(true, 'א'.repeat(600)).activeReason.length, SHOP_ACTIVE_REASON_MAX);
  });
});

describe('the edit form', () => {
  it('never sends the switch with the details', () => {
    const row = { id: 's1', name: 'מרכז', isActive: false, activeReason: 'x', city: 'תל אביב' };
    assert.deepEqual(withoutActiveFields(row), { id: 's1', name: 'מרכז', city: 'תל אביב' });
  });
});

describe('the confirmation', () => {
  it('turning off warns that every device locks; turning on releases them', () => {
    assert.equal(shopActiveConfirmKind(false), 'off');
    assert.equal(shopActiveConfirmKind(true), 'on');
  });

  it('the latest change is the first of the log', () => {
    const entry = { id: '2', active: false, reason: 'סגירה', at: '2026-10-13T10:00:00Z', userId: 'u', userName: 'admin' };
    assert.equal(lastShopActiveChange({ log: [entry, { ...entry, id: '1', active: true }] }), entry);
    assert.equal(lastShopActiveChange({ log: [] }), null);
    assert.equal(lastShopActiveChange(null), null);
  });
});
