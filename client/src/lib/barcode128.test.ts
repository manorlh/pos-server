/**
 * Run with `npm test`. The voucher's Code 128 barcode (lib/barcode128.ts) — pinned by the same
 * golden widths as the server's tests/test_prepaid_voucher_production.py, so both draw the same bars.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CODE128_PATTERNS, code128Bars, code128Values, code128Widths } from './barcode128';

const GOLDEN_TEXT = 'PV:ABCDEFGH23456789';
const GOLDEN_WIDTHS =
  '2112143131213111233212211113231311231313211123131321131323112113132311132232112211322212312132122231' +
  '123121313112223211223211222331112';

describe('code128', () => {
  it('draws the golden symbol the server draws', () => {
    assert.equal(code128Widths(GOLDEN_TEXT), GOLDEN_WIDTHS);
  });

  it('has the checksum of subset B', () => {
    const values = code128Values(GOLDEN_TEXT);
    assert.equal(values[0], 104);
    assert.equal(values[values.length - 2], 25);
    assert.equal(values[values.length - 1], 106);
  });

  it('is 21 symbols of 11 modules, the stop of 13 and two quiet zones', () => {
    assert.equal(code128Bars(GOLDEN_TEXT).width, 21 * 11 + 13 + 20);
  });

  it('has a sound table', () => {
    assert.equal(CODE128_PATTERNS.length, 107);
    assert.equal(new Set(CODE128_PATTERNS).size, 107);
    for (const p of CODE128_PATTERNS.slice(0, 106)) {
      assert.equal([...p].reduce((s, c) => s + Number(c), 0), 11);
    }
    assert.equal([...CODE128_PATTERNS[106]].reduce((s, c) => s + Number(c), 0), 13);
  });

  it('refuses what subset B cannot carry', () => {
    assert.throws(() => code128Widths('שובר'));
    assert.throws(() => code128Widths(''));
  });
});
