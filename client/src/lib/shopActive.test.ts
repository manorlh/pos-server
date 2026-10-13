/**
 * Run with `npm test`. "סניף לא פעיל" — the switch's rules (lib/shopActive.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeDayOffered,
  closeDayPermission,
  kioskCloseDay,
  lastShopActiveChange,
  managerCodeReleases,
  newSaleAllowed,
  SHOP_ACTIVE_REASON_MAX,
  SHOP_LOCK_FLOW,
  SHOP_LOCK_TEXT,
  shopActiveAfter,
  shopActiveConfirmKind,
  shopActiveKept,
  shopActivePayload,
  shopActiveReasonError,
  shopActiveSaid,
  shopLockAllows,
  shopLockEngaged,
  shopLockShown,
  withoutActiveFields,
  type ShopLockSurface,
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

/* ── the devices: the Windows app, the browser kiosk / KDS / board / customer display ── */

describe('shopActive from the cloud', () => {
  it('is read at the top level, else from settings; absent says nothing', () => {
    assert.equal(shopActiveSaid({ shopActive: false }), false);
    assert.equal(shopActiveSaid({ shopActive: true, settings: { shopActive: false } }), true);
    assert.equal(shopActiveSaid({ syncType: 'full', settings: { shopActive: false } }), false);
    assert.equal(shopActiveSaid({ syncType: 'unchanged', shopActive: false }), false);
    assert.equal(shopActiveSaid({ ok: true }), null);
    assert.equal(shopActiveSaid({ settings: [] }), null);
    assert.equal(shopActiveSaid(null), null);
    assert.equal(shopActiveSaid('false'), null);
  });

  it('absent is active: an older server never locks, and a kept value stays until said otherwise', () => {
    assert.equal(shopActiveAfter(true, null), true);
    // A heartbeat or machines/me that says nothing leaves a lock as it was…
    assert.equal(shopActiveAfter(false, null), false);
    // …a full settings answer with neither field is an older server's: active.
    assert.equal(shopActiveAfter(false, null, true), true);
    assert.equal(shopActiveAfter(true, false), false);
    assert.equal(shopActiveAfter(false, true), true);
    assert.equal(shopActiveKept(undefined), true);
    assert.equal(shopActiveKept(null), true);
    assert.equal(shopActiveKept('garbage'), true);
    assert.equal(shopActiveKept(false), false);
    assert.equal(shopActiveKept('false'), false);
  });
});

describe('the lock screen', () => {
  it('waits for the kiosk customer ordering or paying, then stays up', () => {
    assert.equal(shopLockShown({ shopActive: false, surface: 'kiosk', saleInProgress: true }), false);
    assert.equal(shopLockShown({ shopActive: false, surface: 'kiosk', saleInProgress: false }), true);
    // Engaged: a sale that would start under it does not lift it.
    assert.equal(shopLockShown({ shopActive: false, surface: 'kiosk', saleInProgress: true, engaged: true }), true);
    assert.equal(shopLockShown({ shopActive: false, surface: 'till', saleInProgress: true }), false);
  });

  it('a kitchen screen, a board and a customer display lock at once', () => {
    for (const surface of ['kds', 'board', 'customer_display'] as ShopLockSurface[]) {
      assert.equal(shopLockShown({ shopActive: false, surface, saleInProgress: true }), true, surface);
      assert.equal(shopLockShown({ shopActive: true, surface }), false, surface);
    }
  });

  it('re-activation unlocks at once, whatever was engaged', () => {
    assert.equal(shopLockShown({ shopActive: true, surface: 'kiosk', engaged: true }), false);
    assert.equal(shopLockEngaged(true, true, true), false);
    assert.equal(shopLockEngaged(false, true, false), true);
    assert.equal(shopLockEngaged(true, false, false), true);
    assert.equal(shopLockEngaged(false, false, false), false);
  });

  it('a manager code never releases the shop lock (the device own lock it does)', () => {
    assert.equal(managerCodeReleases('shop'), false);
    assert.equal(managerCodeReleases('device'), true);
  });

  it('no new sale once engaged; the sale it waited for finishes', () => {
    assert.equal(newSaleAllowed(false, false), true);
    assert.equal(newSaleAllowed(false, true), false);
    assert.equal(newSaleAllowed(true, true), true);
  });

  it('blocks selling, orders, tables, kiosk and vouchers — never uploads, the heartbeat, the pulls, the close', () => {
    for (const a of ['sell', 'order', 'tables', 'kiosk_order', 'voucher_redeem'] as const) assert.equal(shopLockAllows(a, false), false, a);
    for (const a of ['shift_close', 'z', 'upload', 'heartbeat', 'settings_pull'] as const) assert.equal(shopLockAllows(a, false), true, a);
    assert.equal(shopLockAllows('sell', true), true);
  });

  it('the Android words, and the flow a kiosk reports under it', () => {
    assert.equal(SHOP_LOCK_TEXT.title, 'הסניף אינו פעיל — פנו לתמיכה');
    assert.deepEqual(SHOP_LOCK_FLOW, { flowState: 'paused', screen: 'shop_locked' });
  });
});

describe('"סגירת משמרת ו-Z" from the lock', () => {
  it('is offered where shifts are made', () => {
    assert.equal(closeDayOffered('kiosk'), true);
    assert.equal(closeDayOffered('till'), true);
    assert.equal(closeDayOffered('kds'), false);
    assert.equal(closeDayOffered('customer_display'), false);
  });

  it('by the Z mode: the own Z, else the shift close, else nothing', () => {
    assert.equal(kioskCloseDay({ zMode: 'till', shiftOpen: false }), 'till_z');
    assert.equal(kioskCloseDay({ zMode: 'till', shiftOpen: true }), 'till_z');
    assert.equal(kioskCloseDay({ zMode: 'cloud', shiftOpen: true }), 'shift_close');
    assert.equal(kioskCloseDay({ zMode: 'cloud', shiftOpen: false }), null);
    assert.equal(closeDayPermission('till_z'), 'Z');
    assert.equal(closeDayPermission('shift_close'), 'SHIFT_CLOSE');
  });
});
