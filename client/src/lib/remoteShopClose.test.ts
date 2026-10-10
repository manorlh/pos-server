/**
 * "סגירת יום סניפית" from remote control: the panel's pure parts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { closePanels, confirmationAsked, forceReasonOk, itemTone, leavableIds, notClosedIds, runActive, runCounts, shopConfirmLabel } from './remoteShopClose';

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
  it("shows the shop's manager the shop panel, a point of sale's manager one panel per own area", () => {
    const area = (id: string) => ({ areaId: id, name: id, tills: 1, inShopZ: 1 });
    assert.deepEqual(closePanels({ shopId: 's', wholeShop: true, areas: [area('a'), area('b')] }), [{ areaId: null }]);
    assert.deepEqual(closePanels({ shopId: 's', wholeShop: false, areas: [area('a'), area('b')] }), [{ areaId: 'a' }, { areaId: 'b' }]);
    assert.deepEqual(closePanels({ shopId: 's', wholeShop: false, areas: [] }), []);
    assert.deepEqual(closePanels(undefined), []);
  });
  it("builds without only the tills whose own rule lets them wait", () => {
    const run = { items: [{ ...item('a', 'closing'), mayLeaveOut: false }, { ...item('b', 'waiting_close'), mayLeaveOut: true }, item('c', 'ready')] };
    assert.deepEqual(leavableIds(run), ['b']);
    assert.deepEqual(notClosedIds(run), ['a', 'b']);
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
  it("takes the force's reason only when typed", () => {
    assert.equal(forceReasonOk(''), false);
    assert.equal(forceReasonOk('   x   '), false);
    assert.equal(forceReasonOk('המכשיר לא נדלק'), true);
  });
  it('names the act with the next Z, never a predicted number', () => {
    assert.equal(shopConfirmLabel(), 'סגור את היום · Z הבא');
  });
});
