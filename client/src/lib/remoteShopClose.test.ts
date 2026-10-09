/**
 * "סגירת יום סניפית" from remote control: the panel's pure parts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { confirmationAsked, itemTone, notClosedIds, runActive, runCounts, shopConfirmLabel } from './remoteShopClose';

const item = (machineId: string, status: string, errorCode: string | null = null) => ({
  id: `i-${machineId}`, machineId, machineName: machineId, posNumber: null, status, errorCode, words: '', online: true,
});

describe('remote shop close', () => {
  it('knows a run still going', () => {
    assert.equal(runActive('waiting'), true);
    assert.equal(runActive('building'), true);
    for (const s of ['completed', 'cancelled', 'expired', 'failed', 'empty', null, undefined]) assert.equal(runActive(s), false);
  });
  it('counts the tills closed out of those the run waits for', () => {
    const run = { items: [item('a', 'ready'), item('b', 'closing', 'sale_open'), item('c', 'excluded')] };
    assert.deepEqual(runCounts(run), { closed: 1, total: 2 });
    assert.deepEqual(notClosedIds(run), ['b']);
  });
  it('tones a deferred till as waiting, a closed one as done', () => {
    assert.equal(itemTone('closing', 'sale_open'), 'wait');
    assert.equal(itemTone('waiting_close', null), 'wait');
    assert.equal(itemTone('ready', null), 'ok');
    assert.equal(itemTone('failed', 'open_tables'), 'bad');
    assert.equal(itemTone('excluded', 'cancelled'), 'muted');
  });
  it("asks again only the wizard's own confirmations", () => {
    assert.equal(confirmationAsked('cloud_data_confirmation_required')?.flag, 'confirmCloudData');
    assert.equal(confirmationAsked('open_tills_need_confirmation')?.flag, 'confirmOpenTills');
    assert.equal(confirmationAsked('open_tills_block_z'), null);
    assert.equal(confirmationAsked('totals_changed'), null);
    assert.equal(confirmationAsked(undefined), null);
  });
  it('names the act with the next shop Z number', () => {
    assert.equal(shopConfirmLabel({ nextShopZNumber: 42 }), 'סגור את היום · Z 42');
  });
});
