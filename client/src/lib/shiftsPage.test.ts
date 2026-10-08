/**
 * Run with `npm test`. The shifts page's rules (lib/shiftsPage.ts): its "סניף" / "קופה" filters
 * beside the scope bar, the tills offered, the register number, "רק פתוחות", and closing open
 * shifts from the page — one, or all of a place's at once — by the devices page's rules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bulkCloseOutcome,
  canCloseShiftRemotely,
  deadTill,
  planBulkClose,
  shiftCloseOffer,
  shiftPlace,
  shiftRegisterNumber,
  tillOptions,
  toggleOpenOnly,
  type ShiftDevice,
  type ShiftRow,
} from './shiftsPage';

const SHOP_A = 'shop-a';
const SHOP_B = 'shop-b';

function device(over: Partial<ShiftDevice> & { id: string }): ShiftDevice {
  return {
    name: over.id,
    shopId: SHOP_A,
    posNumber: '1',
    isActive: true,
    pairingStatus: 'assigned',
    shiftStatus: 'open',
    closeShiftPending: false,
    pendingCloseSource: null,
    ...over,
  };
}

const open = (id: string, machineId: string, over: Partial<ShiftRow> = {}): ShiftRow => ({ id, machineId, shopId: SHOP_A, status: 'open', ...over });

const DEVICES: ShiftDevice[] = [
  device({ id: 'a2', name: 'בר', posNumber: '2' }),
  device({ id: 'a1', name: 'קופה ראשית', posNumber: '1' }),
  device({ id: 'a-none', name: 'אחורית', posNumber: null }),
  device({ id: 'a-kds', name: 'מטבח', posNumber: null, deviceRole: 'kds', fiscal: false }),
  device({ id: 'b1', name: 'צפון', shopId: SHOP_B, posNumber: '1' }),
  device({ id: 'loose', name: 'לא משויך', shopId: null, pairingStatus: 'paired' }),
];

describe('"מספר קופה": the shift\'s till\'s register number', () => {
  it('the server\'s number first; its null (the till moved shops) stays null', () => {
    assert.equal(shiftRegisterNumber({ ...open('s', 'a2'), posNumber: '2' }, DEVICES[0]), 2);
    assert.equal(shiftRegisterNumber({ ...open('s', 'a2'), posNumber: null }, DEVICES[0]), null);
  });

  it('an older server (no posNumber): the till\'s number, only while it is in the shift\'s shop', () => {
    assert.equal(shiftRegisterNumber(open('s', 'a2'), DEVICES[0]), 2);
    assert.equal(shiftRegisterNumber(open('s', 'a2', { shopId: SHOP_B }), DEVICES[0]), null);
    assert.equal(shiftRegisterNumber(open('s', 'x'), undefined), null);
    assert.equal(shiftRegisterNumber({ ...open('s', 'a2'), posNumber: '0' }, DEVICES[0]), null);
  });
});

describe('the page\'s "סניף" and "קופה" filters never fight the scope bar', () => {
  it('nothing in the bar: the page picks a shop and one of its tills', () => {
    assert.deepEqual(shiftPlace({ shopId: null, machineId: null }, { branch: SHOP_A, till: 'a2' }, DEVICES), {
      shopId: SHOP_A, machineId: 'a2', shopLocked: false, tillLocked: false,
    });
    assert.deepEqual(shiftPlace({ shopId: null, machineId: null }, { branch: '', till: '' }, DEVICES), {
      shopId: null, machineId: null, shopLocked: false, tillLocked: false,
    });
    // A till alone (any shop): the server filters on it.
    assert.equal(shiftPlace({ shopId: null, machineId: null }, { branch: '', till: 'b1' }, DEVICES).machineId, 'b1');
  });

  it('a till of another shop than the one chosen (a stale link) is dropped', () => {
    assert.equal(shiftPlace({ shopId: null, machineId: null }, { branch: SHOP_A, till: 'b1' }, DEVICES).machineId, null);
  });

  it('the bar\'s shop is the page\'s (locked); the page narrows to one of its tills', () => {
    const p = shiftPlace({ shopId: SHOP_B, machineId: null }, { branch: SHOP_A, till: 'b1' }, DEVICES);
    assert.deepEqual(p, { shopId: SHOP_B, machineId: 'b1', shopLocked: true, tillLocked: false });
    assert.equal(shiftPlace({ shopId: SHOP_B, machineId: null }, { branch: '', till: 'a1' }, DEVICES).machineId, null);
  });

  it('the bar\'s till fixes both', () => {
    assert.deepEqual(shiftPlace({ shopId: null, machineId: 'b1' }, { branch: SHOP_A, till: 'a1' }, DEVICES), {
      shopId: SHOP_B, machineId: 'b1', shopLocked: true, tillLocked: true,
    });
  });
});

describe('the tills the "קופה" filter offers', () => {
  it('the chosen shop\'s, in the counter\'s order, never a screen', () => {
    assert.deepEqual(tillOptions(DEVICES, SHOP_A).map((t) => [t.id, t.number]), [['a1', 1], ['a2', 2], ['a-none', null]]);
  });

  it('every shop\'s when none is chosen, by shop name first; never one without a shop', () => {
    const names: Record<string, string> = { [SHOP_A]: 'מרכז', [SHOP_B]: 'אילת' };
    assert.deepEqual(tillOptions(DEVICES, null, (id) => names[id] ?? '').map((t) => t.id), ['b1', 'a1', 'a2', 'a-none']);
  });
});

describe('"רק פתוחות"', () => {
  it('sets the status to open, again back to all; it clears "awaiting a Z" (closed only)', () => {
    assert.deepEqual(toggleOpenOnly({ status: 'all', awaitingZ: false }), { status: 'open', awaitingZ: false });
    assert.deepEqual(toggleOpenOnly({ status: 'closed', awaitingZ: false }), { status: 'open', awaitingZ: false });
    assert.deepEqual(toggleOpenOnly({ status: 'open', awaitingZ: false }), { status: 'all', awaitingZ: false });
    assert.deepEqual(toggleOpenOnly({ status: 'closed', awaitingZ: true }), { status: 'open', awaitingZ: false });
  });
});

describe('"סגור משמרת" for an open shift — the devices page\'s rules', () => {
  it('a reachable till is asked (a remote close); a dead one gets the administrative close instead', () => {
    const till = device({ id: 'a1' });
    assert.deepEqual(shiftCloseOffer(open('s', 'a1'), till, true), { action: 'remote', pending: false, blocked: null });
    assert.deepEqual(shiftCloseOffer(open('s', 'a1'), till, false), { action: 'administrative', pending: false, blocked: null });
    assert.equal(deadTill(till, false), true);
    assert.equal(deadTill(till, true), false);
    assert.equal(deadTill({ ...till, isActive: false }, false), false, 'a removed till is not a dead one');
  });

  it('a close on its way shows as pending; a standalone one can still be followed', () => {
    const pending = device({ id: 'a1', closeShiftPending: true, pendingCloseSource: 'request' });
    assert.deepEqual(shiftCloseOffer(open('s', 'a1'), pending, true), { action: 'remote', pending: true, blocked: null });
    const zRun = device({ id: 'a1', closeShiftPending: true, pendingCloseSource: 'z_run' });
    assert.equal(canCloseShiftRemotely(zRun), false);
    assert.deepEqual(shiftCloseOffer(open('s', 'a1'), zRun, true), { action: null, pending: true, blocked: 'z_run' });
  });

  it('nothing for a closed shift, an unknown device, a screen, a removed or unassigned till', () => {
    assert.equal(shiftCloseOffer({ ...open('s', 'a1'), status: 'closed' }, device({ id: 'a1' }), true).action, null);
    assert.equal(shiftCloseOffer(open('s', 'x'), undefined, true).blocked, 'unknown_device');
    assert.equal(shiftCloseOffer(open('s', 'a-kds'), DEVICES[3], true).blocked, 'screen');
    assert.equal(shiftCloseOffer(open('s', 'a1'), device({ id: 'a1', isActive: false }), true).blocked, 'removed');
    assert.equal(shiftCloseOffer(open('s', 'l'), DEVICES[5], true).blocked, 'unassigned');
    assert.equal(shiftCloseOffer(open('s', 'a1'), device({ id: 'a1', shiftStatus: 'none' }), true).blocked, 'no_open_shift');
  });
});

describe('"סגור את כל המשמרות הפתוחות"', () => {
  const devices = [
    device({ id: 'on1' }),
    device({ id: 'on2', posNumber: '2' }),
    device({ id: 'dead', posNumber: '3' }),
    device({ id: 'zrun', posNumber: '4', closeShiftPending: true, pendingCloseSource: 'z_run' }),
  ];
  const online = (d: ShiftDevice) => d.id !== 'dead';

  it('reachable tills are asked, one request per device; dead ones listed apart; the rest blocked', () => {
    const plan = planBulkClose(
      [open('s1', 'on1'), open('s1b', 'ON1'), open('s2', 'on2'), open('s3', 'dead'), open('s4', 'zrun'), open('s5', 'gone'), { ...open('s6', 'on2'), status: 'closed' }],
      devices,
      online,
    );
    assert.deepEqual(plan.remote.map((i) => i.shift.id), ['s1', 's2']);
    assert.deepEqual(plan.administrative.map((i) => i.shift.id), ['s3']);
    assert.deepEqual(plan.blocked.map((i) => [i.shift.id, i.offer.blocked]), [['s4', 'z_run'], ['s5', 'unknown_device']]);
  });

  it('nothing open: nothing to send', () => {
    const plan = planBulkClose([], devices, online);
    assert.equal(plan.remote.length + plan.administrative.length + plan.blocked.length, 0);
  });

  it('each row\'s state: sending, sent, waiting at the till, closed, refused', () => {
    assert.equal(bulkCloseOutcome(null), 'sending');
    assert.equal(bulkCloseOutcome({ status: 'waiting_close' }), 'sent');
    assert.equal(bulkCloseOutcome({ status: 'closing' }), 'pending');
    assert.equal(bulkCloseOutcome({ status: 'completed' }), 'closed');
    for (const s of ['failed', 'expired', 'cancelled']) assert.equal(bulkCloseOutcome({ status: s }), 'refused');
    assert.equal(bulkCloseOutcome({ failed: true }), 'refused');
  });
});
