/**
 * Run with `npm test`. A Z's identity — branch code on every Z, till number on every till Z
 * (lib/zIdentity.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { zIdentityLabel, zIdentityParts, zTillColumn, type IdentityFormat } from './zIdentity';

const he = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'messages', 'he.json'), 'utf8')) as {
  independentTill: { identity: Record<string, string> };
};
const format: IdentityFormat = (key, values = {}) =>
  he.independentTill.identity[key].replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);

describe('zIdentityLabel', () => {
  it('a shop Z: the branch code and the shop number', () => {
    assert.equal(
      zIdentityLabel({ branchCode: '12', origin: 'cloud', shopSequenceNumber: 1 }, format),
      'קוד סניף 12 · Z סניפי מס׳ 1',
    );
  });

  it('a till Z: the branch code, the till and its own number', () => {
    assert.equal(
      zIdentityLabel({ branchCode: '12', origin: 'till', posNumber: '6', machineSequenceNumber: 1 }, format),
      'קוד סניף 12 · קופה 6 · Z מס׳ 1',
    );
  });

  it('no branch code, no number: nothing invented', () => {
    assert.equal(zIdentityLabel({ origin: 'cloud', shopSequenceNumber: null }, format), 'Z סניפי');
    assert.equal(zIdentityLabel({ branchCode: ' ', origin: 'till', posNumber: '3' }, format), 'קופה 3 · Z');
    assert.deepEqual(
      zIdentityParts({ branchCode: '7', origin: 'till', posNumber: null, machineName: 'בר', machineSequenceNumber: 4 }),
      [
        { key: 'branch', values: { code: '7' } },
        { key: 'till', values: { n: 'בר' } },
        { key: 'tillZ', values: { n: '4' } },
      ],
    );
  });

  it('the till column: the till of a till Z, empty on a shop Z', () => {
    assert.equal(zTillColumn({ origin: 'till', posNumber: '6' }), '6');
    assert.equal(zTillColumn({ origin: 'cloud', posNumber: '6', shopSequenceNumber: 3 }), '');
  });
});
