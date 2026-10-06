/**
 * Run with `npm test`. The state shown before a Z from the cloud (lib/zDataState.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { flaggedTills, needsCloudDataConfirmation, offSyncedTills, tillLabel, type TillDataState } from './zDataState';

const quiet: TillDataState = {
  machineId: 'm1',
  posNumber: '3',
  online: false,
  lastHeartbeatAt: '2026-10-06T07:00:00Z',
  openShifts: [],
  offlineZs: { pending: 2, conflict: false, lastNumber: 5, numbers: [4, 5] },
  warnings: ['not_synced', 'offline_zs'],
};
const fine: TillDataState = { ...quiet, machineId: 'm2', posNumber: '4', online: true, offlineZs: { ...quiet.offlineZs, pending: 0, numbers: [] }, warnings: [] };

describe('needsCloudDataConfirmation', () => {
  it('any warning on any till asks for the confirmation', () => {
    assert.equal(needsCloudDataConfirmation([fine]), false);
    assert.equal(needsCloudDataConfirmation([fine, quiet]), true);
    assert.equal(needsCloudDataConfirmation([null, undefined]), false);
    assert.deepEqual(flaggedTills([fine, quiet, null]).map((t) => t.machineId), ['m1']);
  });
});

describe('offSyncedTills', () => {
  it('a till off for the night, closed and fully synced, is listed and asks for nothing', () => {
    const night: TillDataState = { ...fine, machineId: 'm3', online: false, status: 'off_synced', warnings: [] };
    assert.deepEqual(offSyncedTills([fine, night, quiet]).map((t) => t.machineId), ['m3']);
    assert.equal(needsCloudDataConfirmation([night]), false);
  });
});

describe('tillLabel', () => {
  it('the till number, else the name, else the id', () => {
    assert.equal(tillLabel(quiet), '3');
    assert.equal(tillLabel({ machineId: 'x', name: 'Bar', posNumber: null }), 'Bar');
    assert.equal(tillLabel({ machineId: 'x' }), 'x');
  });
});
