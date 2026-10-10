/**
 * Run with `npm test`. A till Z closed with no connection, and the card transmission at
 * a Z, as the Z pages show them (lib/offlineZ.ts; pos-server docs/SPEC_OFFLINE_TILL_Z.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { discrepancyValue, sortedDiscrepancies, zTransmissionFailed } from './offlineZ';

describe('zTransmissionFailed', () => {
  it('is a failure only when the batch did not go', () => {
    assert.equal(zTransmissionFailed({ outcome: 'failed' }), true);
    assert.equal(zTransmissionFailed({ outcome: 'unknown' }), true);
    assert.equal(zTransmissionFailed({ outcome: 'busy' }), true);
    assert.equal(zTransmissionFailed({ outcome: 'success', batchNumber: '7' }), false);
    assert.equal(zTransmissionFailed({ outcome: 'skipped' }), false);
    assert.equal(zTransmissionFailed(null), false);
    assert.equal(zTransmissionFailed(undefined), false);
  });
});

describe('sortedDiscrepancies', () => {
  it('puts the number and the shifts first, then the money, unknown keys last', () => {
    const sorted = sortedDiscrepancies([
      { key: 'zzz', till: 1, cloud: 2 },
      { key: 'totalCash', till: '120', cloud: '100.00' },
      { key: 'machineSequenceNumber', till: 3, cloud: 1 },
      { key: 'shiftIds', till: ['a'], cloud: ['a', 'b'] },
    ]);
    assert.deepEqual(
      sorted.map((d) => d.key),
      ['machineSequenceNumber', 'shiftIds', 'totalCash', 'zzz'],
    );
  });

  it('reads null as none', () => {
    assert.deepEqual(sortedDiscrepancies(null), []);
  });
});

describe('discrepancyValue', () => {
  it('shows a list of shifts by its count and a missing value as a dash', () => {
    assert.equal(discrepancyValue(['a', 'b']), '2');
    assert.equal(discrepancyValue(null), '—');
    assert.equal(discrepancyValue(''), '—');
    assert.equal(discrepancyValue('130.00'), '130.00');
    assert.equal(discrepancyValue(12), '12');
  });
});
