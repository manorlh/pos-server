/**
 * Run with `npm test`. A kiosk's shift and Z by its Z mode (lib/kioskZ.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPendingState,
  jobTone,
  kioskLastJob,
  kioskZActionOf,
  kioskZKindOf,
  kioskZOffer,
  zSwitchBody,
  zSwitchOf,
  type KioskJob,
} from './kioskZ';

const job = (over: Partial<KioskJob>): KioskJob => ({ id: 'r', state: 'sent', pending: true, ...over });

describe('the mode, per device', () => {
  it('reads the cloud’s zKind, else the old zMode and the independent flag', () => {
    assert.equal(kioskZKindOf({ zKind: 'independent', zMode: 'till' }), 'independent');
    assert.equal(kioskZKindOf({ zKind: 'shop' }), 'shop');
    assert.equal(kioskZKindOf({ zMode: 'till' }), 'own');
    assert.equal(kioskZKindOf({ zMode: 'till', independentTill: true }), 'independent');
    assert.equal(kioskZKindOf({ zMode: 'cloud' }), 'shop');
    assert.equal(kioskZKindOf({}), 'shop');
  });
});

describe('the actions per mode', () => {
  it('offers a shop-Z kiosk the shift close only — never a Z', () => {
    assert.equal(kioskZActionOf('shop'), 'close_shift');
    const offer = kioskZOffer({ zKind: 'shop', shiftOpen: true }, true);
    assert.deepEqual(offer, { kind: 'shop', action: 'close_shift', enabled: true, block: null });
    assert.equal(kioskZOffer({ zKind: 'shop', shiftOpen: false }, true).block, 'no_open_shift');
  });

  it('offers a kiosk with its own Z the Z only — never a bare close', () => {
    assert.equal(kioskZActionOf('independent'), 'till_z');
    assert.equal(kioskZActionOf('own'), 'till_z');
    const offer = kioskZOffer({ zKind: 'independent', shiftOpen: false }, true);
    assert.deepEqual(offer, { kind: 'independent', action: 'till_z', enabled: true, block: null });
  });

  it('holds the button while the last one is pending, and for read-only users', () => {
    const k = { zKind: 'shop' as const, shiftOpen: true, shiftClose: job({ state: 'waiting_payment' }) };
    assert.equal(kioskZOffer(k, true).block, 'in_progress');
    assert.equal(kioskZOffer({ zKind: 'shop', shiftOpen: true }, false).block, 'no_write');
    // A finished close does not hold the next one.
    assert.equal(kioskZOffer({ ...k, shiftClose: job({ state: 'closed', pending: false }) }, true).enabled, true);
    // A Z pending holds the Z, not anything else.
    const z = { zKind: 'own' as const, tillZRequest: job({ state: 'producing' }), shiftClose: job({ state: 'closed' }) };
    assert.equal(kioskZOffer(z, true).block, 'in_progress');
  });

  it('shows the last job of the kiosk’s own action', () => {
    const close = job({ id: 'c', state: 'closed', pending: false });
    const z = job({ id: 'z', state: 'done', pending: false, zNumber: 3 });
    assert.equal(kioskLastJob({ zKind: 'shop', shiftClose: close, tillZRequest: z })?.id, 'c');
    assert.equal(kioskLastJob({ zKind: 'independent', shiftClose: close, tillZRequest: z })?.id, 'z');
    assert.equal(kioskLastJob({ zKind: 'independent' }), null);
  });

  it('tones and pending states', () => {
    for (const s of ['queued', 'sent', 'waiting_payment', 'waiting_customer', 'closing', 'producing']) {
      assert.equal(isPendingState(s), true, s);
      assert.equal(jobTone(s), 'wait', s);
    }
    assert.equal(isPendingState('done'), false);
    assert.equal(jobTone('closed'), 'ok');
    assert.equal(jobTone('done'), 'ok');
    assert.equal(jobTone('failed'), 'bad');
    assert.equal(jobTone('expired'), 'bad');
    assert.equal(jobTone('cancelled'), 'muted');
  });
});

describe('the kiosk’s own Z mode switch', () => {
  it('is the super admin’s alone and only over a clean break', () => {
    assert.deepEqual(zSwitchOf('shop', { canEdit: true, openShift: false, awaitingZ: 0 }), {
      target: 'independent',
      allowed: true,
      block: null,
    });
    assert.equal(zSwitchOf('independent', { canEdit: true }).target, 'shop');
    assert.equal(zSwitchOf('own', { canEdit: true }).target, 'independent');
    assert.equal(zSwitchOf('shop', { canEdit: false }).block, 'not_super_admin');
    assert.equal(zSwitchOf('shop', { canEdit: true, openShift: true }).block, 'open_shift');
    assert.equal(zSwitchOf('shop', { canEdit: true, awaitingZ: 2 }).block, 'awaiting_z');
    assert.equal(zSwitchOf('shop', null).allowed, false);
  });

  it('changes this kiosk only', () => {
    assert.deepEqual(zSwitchBody('k-1', 'independent'), { participants: [], independent: ['k-1'] });
    assert.deepEqual(zSwitchBody('k-1', 'shop'), { participants: ['k-1'], independent: [] });
  });
});
