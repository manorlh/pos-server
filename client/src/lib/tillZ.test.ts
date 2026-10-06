/**
 * Run with `npm test`. The Z-on-the-till rules the dashboard applies (lib/tillZ.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canAskTillForZ,
  isTillZPending,
  latestTillZRequestFor,
  splitCandidatesByZMode,
  tillNameForZ,
  tillZOutcome,
  tillZStatusVariant,
  zModeOf,
  zModeSwitchRefusal,
  zNumberOf,
} from './tillZ';
import type { TillZRequest, ZCandidateMachine, ZCandidates } from './types';

const till = (id: string, zMode?: 'cloud' | 'till'): ZCandidateMachine => ({
  machineId: id,
  online: true,
  closedShifts: [],
  ...(zMode ? { zMode } : {}),
});

const request = (over: Partial<TillZRequest>): TillZRequest => ({
  id: 'r',
  machineId: 'm1',
  status: 'waiting',
  ...over,
});

const refused = (data: unknown) => ({ response: { status: 409, data } });

describe('zModeOf', () => {
  it('reads till, and treats anything else (or nothing) as cloud', () => {
    assert.equal(zModeOf({ zMode: 'till' }), 'till');
    assert.equal(zModeOf({ zMode: 'cloud' }), 'cloud');
    assert.equal(zModeOf({}), 'cloud');
    assert.equal(zModeOf({ zMode: 'TILL' }), 'cloud');
    assert.equal(zModeOf(null), 'cloud');
  });
});

describe('splitCandidatesByZMode', () => {
  const c: ZCandidates = {
    shopId: 's1',
    shopName: 'Shop',
    zScope: 'shop',
    machines: [till('a'), till('b', 'till'), till('c', 'cloud'), till('d', 'till')],
  };

  it('keeps the cloud tills in the candidates shape and lists the till-mode ones apart', () => {
    const { cloud, till: own } = splitCandidatesByZMode(c);
    assert.deepEqual(cloud.machines.map((m) => m.machineId), ['a', 'c']);
    assert.deepEqual(own.map((m) => m.machineId), ['b', 'd']);
    assert.equal(cloud.shopId, 's1');
    assert.equal(cloud.zScope, 'shop');
  });

  it('does not touch the input', () => {
    splitCandidatesByZMode(c);
    assert.equal(c.machines.length, 4);
  });

  it('a shop of only till-mode tills has no cloud tills', () => {
    const { cloud, till: own } = splitCandidatesByZMode({ ...c, machines: [till('x', 'till')] });
    assert.equal(cloud.machines.length, 0);
    assert.equal(own.length, 1);
  });
});

describe('canAskTillForZ', () => {
  it('only a till of the shop that is active', () => {
    assert.equal(canAskTillForZ({}), true);
    assert.equal(canAskTillForZ({ inShop: true, isActive: true }), true);
    assert.equal(canAskTillForZ({ inShop: false }), false);
    assert.equal(canAskTillForZ({ isActive: false }), false);
  });
});

describe('request status', () => {
  it('waiting and in_progress are pending, the rest ended', () => {
    assert.equal(isTillZPending('waiting'), true);
    assert.equal(isTillZPending('in_progress'), true);
    for (const s of ['completed', 'failed', 'expired', 'cancelled'] as const) {
      assert.equal(isTillZPending(s), false);
    }
  });

  it('maps to badge variants', () => {
    assert.equal(tillZStatusVariant('completed'), 'default');
    assert.equal(tillZStatusVariant('failed'), 'destructive');
    assert.equal(tillZStatusVariant('expired'), 'destructive');
    assert.equal(tillZStatusVariant('cancelled'), 'outline');
    assert.equal(tillZStatusVariant('waiting'), 'secondary');
    assert.equal(tillZStatusVariant('in_progress'), 'secondary');
  });

  it('completed with a Z, completed with nothing to report, or neither', () => {
    assert.equal(tillZOutcome({ status: 'completed', zReportId: 'z1' }), 'z');
    assert.equal(
      tillZOutcome({ status: 'completed', zReportId: null, errorCode: 'nothing_to_report' }),
      'nothing',
    );
    assert.equal(tillZOutcome({ status: 'failed', zReportId: null }), 'other');
  });
});

describe('latestTillZRequestFor', () => {
  it('the newest of that till, ignoring other tills', () => {
    const list = [
      request({ id: 'old', createdAt: '2026-10-01T08:00:00Z' }),
      request({ id: 'other', machineId: 'm2', createdAt: '2026-10-01T12:00:00Z' }),
      request({ id: 'new', createdAt: '2026-10-01T10:00:00Z' }),
    ];
    assert.equal(latestTillZRequestFor(list, 'm1')?.id, 'new');
    assert.equal(latestTillZRequestFor(list, 'm3'), null);
  });

  it('a request without a time loses to one with', () => {
    const list = [request({ id: 'dated', createdAt: '2026-10-01T08:00:00Z' }), request({ id: 'undated' })];
    assert.equal(latestTillZRequestFor(list, 'm1')?.id, 'dated');
  });
});

describe('tillNameForZ', () => {
  it('a plain register number wins', () => {
    assert.equal(tillNameForZ({ posNumber: '2', machineName: 'Bar' }), '2');
  });
  it('falls back to the name, never a code or a zero', () => {
    assert.equal(tillNameForZ({ posNumber: 'M-AB12', machineName: 'Bar' }), 'Bar');
    assert.equal(tillNameForZ({ posNumber: '0', machineName: 'Bar' }), 'Bar');
    assert.equal(tillNameForZ({ posNumber: null, machineName: '  ' , machineId: 'abcdef123456' }), 'abcdef12');
    assert.equal(tillNameForZ({}), '—');
  });
});

describe('zNumberOf', () => {
  it('a cloud Z is the shop number', () => {
    assert.deepEqual(zNumberOf({ shopSequenceNumber: 7 }), { kind: 'shop', number: 7 });
    assert.deepEqual(zNumberOf({ origin: 'cloud', shopSequenceNumber: 7 }), { kind: 'shop', number: 7 });
  });
  it('a legacy Z with no shop number stays a shop Z without a number', () => {
    assert.deepEqual(zNumberOf({ shopSequenceNumber: null }), { kind: 'shop', number: null });
  });
  it('a till Z is the till and its own number, whatever the shop number says', () => {
    assert.deepEqual(
      zNumberOf({
        origin: 'till',
        shopSequenceNumber: null,
        machineSequenceNumber: 12,
        posNumber: '3',
        machineName: 'Bar',
      }),
      { kind: 'till', till: '3', number: 12 },
    );
    assert.deepEqual(
      zNumberOf({ origin: 'till', machineSequenceNumber: 1, machineName: 'Bar' }),
      { kind: 'till', till: 'Bar', number: 1 },
    );
  });
});

describe('zModeSwitchRefusal — offline Zs', () => {
  it('a till holding Zs closed offline', () => {
    assert.deepEqual(
      zModeSwitchRefusal(refused({ detail: 'till_offline_zs_unsynced', reason: 'pending', pending: 2 })),
      { code: 'till_offline_zs_unsynced', reason: 'pending', pending: 2 },
    );
  });
  it('a till that may close offline and is not seen', () => {
    assert.deepEqual(
      zModeSwitchRefusal(refused({ detail: 'till_offline_zs_unsynced', reason: 'not_seen' })),
      { code: 'till_offline_zs_unsynced', reason: 'not_seen', pending: null },
    );
  });
});

describe('zModeSwitchRefusal', () => {
  it('unreported shifts, with the count beside detail', () => {
    assert.deepEqual(zModeSwitchRefusal(refused({ detail: 'unreported_shifts', count: 3 })), {
      code: 'unreported_shifts',
      count: 3,
    });
  });
  it('unreported shifts, with the count inside detail', () => {
    assert.deepEqual(
      zModeSwitchRefusal(refused({ detail: { code: 'unreported_shifts', count: '2' } })),
      { code: 'unreported_shifts', count: 2 },
    );
  });
  it('unreported shifts with no count', () => {
    assert.deepEqual(zModeSwitchRefusal(refused({ detail: 'unreported_shifts' })), {
      code: 'unreported_shifts',
      count: null,
    });
  });
  it('a Z in progress', () => {
    assert.deepEqual(zModeSwitchRefusal(refused({ detail: 'z_in_progress' })), { code: 'z_in_progress' });
  });
  it('anything else is not a switching refusal', () => {
    assert.equal(zModeSwitchRefusal(refused({ detail: 'machine_has_open_shift' })), null);
    assert.equal(zModeSwitchRefusal(new Error('network')), null);
    assert.equal(zModeSwitchRefusal(null), null);
  });
});
