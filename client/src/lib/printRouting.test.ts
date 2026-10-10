/**
 * Run with `npm test`. The printers page's network scan and per-zone redirect rules (lib/printRouting.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  orderScanResults,
  scanErrorKey,
  scanResultUsable,
  scanRunning,
  zoneRowsDirty,
  zoneRowsProblem,
  zoneRowsToMap,
} from './printRouting';

describe('the network scan', () => {
  it('runs while pending or scanning', () => {
    assert.equal(scanRunning({ status: 'pending' }), true);
    assert.equal(scanRunning({ status: 'scanning' }), true);
    assert.equal(scanRunning({ status: 'done' }), false);
    assert.equal(scanRunning({ status: 'expired' }), false);
    assert.equal(scanRunning(null), false);
  });

  it('offers only raw-port printers for the network form', () => {
    assert.equal(scanResultUsable({ kind: 'escpos' }), true);
    assert.equal(scanResultUsable({ kind: 'unknown' }), true);
    assert.equal(scanResultUsable({ kind: 'other' }), false);
  });

  it('lists new ESC/POS printers first, configured ones last, otherwise in order', () => {
    const rows = [
      { id: 'a', kind: 'other', configuredPrinterId: null },
      { id: 'b', kind: 'escpos', configuredPrinterId: 'p1' },
      { id: 'c', kind: 'unknown', configuredPrinterId: null },
      { id: 'd', kind: 'escpos', configuredPrinterId: null },
      { id: 'e', kind: 'escpos', configuredPrinterId: null },
    ];
    assert.deepEqual(
      orderScanResults(rows).map((r) => r.id),
      ['d', 'e', 'c', 'a', 'b'],
    );
  });

  it('says why a scan ended without results', () => {
    assert.equal(scanErrorKey({ status: 'done', error: null }), null);
    assert.equal(scanErrorKey({ status: 'failed', error: 'not_on_lan' }), 'notOnLan');
    assert.equal(scanErrorKey({ status: 'failed', error: 'cancelled' }), 'cancelled');
    assert.equal(scanErrorKey({ status: 'failed', error: 'boom' }), 'failed');
    assert.equal(scanErrorKey({ status: 'expired', error: 'not_picked_up' }), 'notPickedUp');
    assert.equal(scanErrorKey({ status: 'expired', error: 'no_report' }), 'noReport');
    assert.equal(scanErrorKey(undefined), null);
  });
});

describe('the zone redirect rows', () => {
  it('must name both printers, differ, and redirect each printer once', () => {
    assert.equal(zoneRowsProblem([]), null);
    assert.equal(zoneRowsProblem([{ fromPrinterId: 'a', toPrinterId: 'b' }]), null);
    assert.equal(zoneRowsProblem([{ fromPrinterId: 'a', toPrinterId: '' }]), 'incomplete');
    assert.equal(zoneRowsProblem([{ fromPrinterId: 'a', toPrinterId: 'a' }]), 'same');
    assert.equal(
      zoneRowsProblem([
        { fromPrinterId: 'a', toPrinterId: 'b' },
        { fromPrinterId: 'a', toPrinterId: 'c' },
      ]),
      'duplicate',
    );
    // Two printers into one target is fine.
    assert.equal(
      zoneRowsProblem([
        { fromPrinterId: 'a', toPrinterId: 'c' },
        { fromPrinterId: 'b', toPrinterId: 'c' },
      ]),
      null,
    );
  });

  it('go to the API as a map and know when they changed', () => {
    const rows = [
      { fromPrinterId: 'a', toPrinterId: 'c' },
      { fromPrinterId: 'b', toPrinterId: 'c' },
    ];
    assert.deepEqual(zoneRowsToMap(rows), { a: 'c', b: 'c' });
    assert.equal(zoneRowsDirty(rows, [...rows].reverse()), false);
    assert.equal(zoneRowsDirty(rows, rows.slice(1)), true);
  });
});
