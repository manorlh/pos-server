/**
 * Run with `npm test`. The printed voucher's layout (lib/voucherLayout.ts) is a port of the
 * server's app/services/prepaid_voucher_layout.py: for the cases of the shared golden fixture
 * server/tests/fixtures/prepaid_voucher_layout.json (written by the server's
 * tests/test_prepaid_voucher_print.py) it must produce the very same operations, and print
 * the very same words — so the dashboard's print and the server's PDF never disagree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { VOUCHER_TEXT, fakeMeasure, fit, layoutCard, wrap, type CardContent, type VoucherOp } from './voucherLayout';

interface GoldenCase {
  name: string;
  w: number;
  h: number;
  content: CardContent & { items?: [string, string, boolean][] };
  ops: VoucherOp[];
}

const golden = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'prepaid_voucher_layout.json'), 'utf8'),
) as { labels: Record<string, string>; cases: GoldenCase[] };

function same(actual: VoucherOp[], expected: VoucherOp[], name: string) {
  assert.equal(actual.length, expected.length, `${name}: number of operations`);
  actual.forEach((op, i) => {
    const want = expected[i] as unknown as Record<string, unknown>;
    const got = op as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${name} #${i}: fields`);
    for (const [k, v] of Object.entries(want)) {
      if (typeof v === 'number') assert.ok(Math.abs((got[k] as number) - v) <= 0.0011, `${name} #${i}.${k}: ${got[k]} ≠ ${v}`);
      else assert.deepEqual(got[k], v, `${name} #${i}.${k}`);
    }
  });
}

describe('voucher layout (the server draws the same)', () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      same(layoutCard(c.w, c.h, c.content, fakeMeasure), c.ops, c.name);
    });
  }

  it('prints the same words', () => {
    assert.deepEqual({ ...VOUCHER_TEXT }, golden.labels);
  });
});

describe('fit and wrap', () => {
  it('cuts with an ellipsis, keeps its own lines and wraps long ones', () => {
    assert.equal(fit(fakeMeasure, 'אבגדה', 1, false, 2), 'אבג…');
    assert.deepEqual(wrap(fakeMeasure, 'אב גד\nהו', 1, false, 10, 5), ['אב גד', 'הו']);
    assert.deepEqual(wrap(fakeMeasure, 'אבג דהו זחט', 1, false, 3, 5), ['אבג', 'דהו', 'זחט']);
    assert.deepEqual(wrap(fakeMeasure, 'אבג דהו זחט', 1, false, 3, 2), ['אבג', 'דהו…']);
    assert.deepEqual(wrap(fakeMeasure, 'אבג', 1, false, 4, 0), []);
  });
});
