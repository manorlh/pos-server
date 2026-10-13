/**
 * Run with `npm test`. The LAN mode's table cancel as the dashboard follows it (lib/remoteTableCancel.ts;
 * pos-server app/services/remote_table_cancel.py `view`, tests/test_remote_table_cancel.py).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GRACE_MS, doneKey, remoteCancelView, stillSending, type RemoteCancelStatus } from './remoteTableCancel';

const base: RemoteCancelStatus = {
  id: 'c1',
  currentId: 'c1',
  status: 'pending',
  outcome: 'waiting',
  reason: null,
  retargeted: false,
  voidedPrinters: [],
  kds: null,
  hostName: 'קופה 1',
  tableLabel: '12',
  expiresAt: null,
};

describe('the remote cancel as the dialog shows it', () => {
  it('sends until the host answers, and keeps polling', () => {
    const v = remoteCancelView(null, 0, 20, 1_000);
    assert.equal(v.phase, 'sending');
    assert.equal(v.key, 'sending');
    assert.equal(stillSending(v), true);
    assert.equal(remoteCancelView({ ...base, status: 'delivered' }, 0, 20, 5_000).key, 'sending');
  });

  it('says it went on to the current host', () => {
    assert.equal(remoteCancelView({ ...base, retargeted: true }, 0, 20, 5_000).key, 'retargeting');
  });

  it('done: what reached the kitchen', () => {
    assert.equal(doneKey(['מטבח'], false), 'donePrinted');
    assert.equal(doneKey([], true), 'doneKds');
    assert.equal(doneKey(['מטבח'], true), 'donePrintedKds');
    assert.equal(doneKey(null, null), 'done');
    const v = remoteCancelView({ ...base, status: 'done', outcome: 'done', voidedPrinters: ['מטבח'] }, 0, 20, 3_000);
    assert.deepEqual([v.phase, v.key, v.refresh, stillSending(v)], ['done', 'donePrinted', true, false]);
  });

  it('each refusal with its own words; an unknown one with its code', () => {
    for (const reason of ['table_not_open', 'payment_in_progress', 'not_host', 'order_changed']) {
      const v = remoteCancelView({ ...base, status: 'refused', outcome: 'refused', reason }, 0, 20, 3_000);
      assert.equal(v.phase, 'refused');
      assert.equal(v.key, `refused.${reason}`);
    }
    const changed = remoteCancelView({ ...base, outcome: 'refused', reason: 'order_changed' }, 0, 20, 3_000);
    assert.equal(changed.refresh, true);
    const other = remoteCancelView({ ...base, outcome: 'refused', reason: 'sale_in_progress' }, 0, 20, 3_000);
    assert.deepEqual([other.key, other.values], ['refused.other', { reason: 'sale_in_progress' }]);
  });

  it('timeout: the cloud says so, or nothing came well past the timeout', () => {
    assert.equal(remoteCancelView({ ...base, status: 'expired', outcome: 'timeout' }, 0, 20, 21_000).key, 'timeout');
    assert.equal(remoteCancelView(null, 0, 20, 20_000 + GRACE_MS + 1).phase, 'timeout');
    assert.equal(remoteCancelView(null, 0, 20, 20_000 + GRACE_MS - 1).phase, 'sending');
  });
});
