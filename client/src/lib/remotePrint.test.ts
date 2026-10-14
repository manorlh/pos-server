/**
 * Run with `npm test`. "הדפסה בקופה אחרת" (lib/remotePrint.ts; pos-server app/services/remote_print.py,
 * P:/specs/bill-print-other-till.md): the parameters' list of tills, the host picker and the table card's
 * words for a bill sent to print on another till.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ActionStatus } from './liveTables';
import { actionView, ACTION_REFUSALS, DIRECT_ERRORS } from './liveTables';
import {
  billPrintOnView,
  hostOffered,
  parseHostIds,
  REMOTE_PRINT_HOSTS_KEY,
  REMOTE_PRINT_KEYS,
  serializeHostIds,
  toggleHost,
} from './remotePrint';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

function status(over: Partial<ActionStatus>): ActionStatus {
  return {
    id: 'c1',
    currentId: 'c1',
    status: 'done',
    outcome: 'done',
    reason: null,
    retargeted: false,
    result: null,
    hostName: '1 · Till 1',
    tableLabel: '12',
    action: 'print-bill',
    ...over,
  } as ActionStatus;
}

describe('the parameters', () => {
  it('are the server\'s eight, the list of tills among them', () => {
    assert.deepEqual([...REMOTE_PRINT_KEYS], [
      'remotePrintEnabled', 'remotePrintDocuments', 'remotePrintFallback', 'remotePrintTimeoutSec',
      'remotePrintNotice', 'remotePrintHosts', 'remotePrintFromDashboard', 'remotePrintDrawer',
    ]);
    assert.ok((REMOTE_PRINT_KEYS as readonly string[]).includes(REMOTE_PRINT_HOSTS_KEY));
  });

  it('reads and writes the tills as ids in the shop\'s order', () => {
    assert.deepEqual(parseHostIds(` ${B.toUpperCase()} ;${A},${B}\n`), [B, A]);
    assert.deepEqual(parseHostIds(''), []);
    assert.deepEqual(parseHostIds(null), []);
    assert.equal(serializeHostIds([B, A], [A, B, C]), `${A},${B}`);
    // A till that left the shop is kept, after the shop's.
    assert.equal(serializeHostIds([C, A], [A, B]), `${A},${C}`);
    assert.equal(toggleHost('', B, true, [A, B]), B);
    assert.equal(toggleHost(`${A},${B}`, A, false, [A, B]), B);
    assert.equal(toggleHost(B, A, true, [A, B]), `${A},${B}`);
  });

  it('offers as a host only a build that prints documents', () => {
    assert.equal(hostOffered({ documentRelay: true }), true);
    assert.equal(hostOffered({ documentRelay: false }), false);
    assert.equal(hostOffered({}), false);
  });
});

describe('"הדפס חשבון" on another till', () => {
  const now = 1_000_000;

  it('says where it was sent, then whether it printed there', () => {
    const sending = actionView(null, now, 20, now);
    assert.deepEqual(billPrintOnView(sending, null, 'קופה 2'), { ...sending, key: 'sendingPrintOn', values: { till: 'קופה 2' } });
    const printed = status({ result: { printed: true, via: 'lan', printOn: B } });
    assert.deepEqual(billPrintOnView(actionView(printed, now, 20, now), printed, 'קופה 2').key, 'done.print-bill-printed');
    const local = status({ result: { printed: false, fallback: 'local' } });
    assert.equal(billPrintOnView(actionView(local, now, 20, now), local, 'קופה 2').key, 'done.print-bill-local');
    const sent = status({ result: { via: 'cloud', jobId: 'j1' } });
    const view = billPrintOnView(actionView(sent, now, 20, now), sent, 'קופה 2');
    assert.equal(view.key, 'done.print-bill-sent');
    assert.deepEqual(view.values, { till: 'קופה 2' });
  });

  it('names that till when it did not print anywhere', () => {
    const refused = status({ outcome: 'refused', status: 'refused', reason: 'print_target_unavailable' });
    const view = billPrintOnView(actionView(refused, now, 20, now), refused, 'קופה 2');
    assert.equal(view.phase, 'refused');
    assert.equal(view.key, 'refused.print_target_unavailable');
    assert.deepEqual(view.values, { till: 'קופה 2' });
    assert.ok((ACTION_REFUSALS as readonly string[]).includes('print_target_unavailable'));
    for (const code of ['remote_print_off', 'print_target_not_found', 'print_target_needs_update']) {
      assert.ok((DIRECT_ERRORS as readonly string[]).includes(code), code);
    }
  });

  it('leaves any other bill as it was', () => {
    const done = status({ result: { printerName: 'קבלות', marked: true } });
    const view = actionView(done, now, 20, now);
    assert.deepEqual(billPrintOnView(view, done, null), view);
    const timeout = actionView(null, now, 20, now + 60_000);
    assert.deepEqual(billPrintOnView(timeout, null, 'קופה 2'), timeout);
  });
});
