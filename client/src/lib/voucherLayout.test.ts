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

import {
  VOUCHER_TEXT, fakeMeasure, fit, layoutCard, layoutVoucher, wrap, type CardContent, type FreeTextFit, type VoucherOp,
} from './voucherLayout';

interface GoldenCase {
  name: string;
  w: number;
  h: number;
  content: CardContent & { items?: [string, string, boolean][] };
  ops: VoucherOp[];
  freeText: FreeTextFit;
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
      const out = layoutVoucher(c.w, c.h, c.content, fakeMeasure);
      same(out.ops, c.ops, c.name);
      // How much of the free text is printed — what the dashboard warns about.
      assert.deepEqual(out.freeText, c.freeText, `${c.name}: free text`);
      assert.deepEqual(layoutCard(c.w, c.h, c.content, fakeMeasure), out.ops);
    });
  }

  it('prints the same words', () => {
    assert.deepEqual({ ...VOUCHER_TEXT }, golden.labels);
  });
});

describe('a long benefit and the free text (the owner, 12.10.2026)', () => {
  const byName = (name: string) => golden.cases.find((c) => c.name === name)!;
  const freeOps = (c: GoldenCase, ops: VoucherOp[]) =>
    ops.filter((o) => o.op === 'text' && !o.bold && (c.content.freeText ?? '').split(/\s+/).some((w) => w && o.text.includes(w)));

  it('the 80×50 ticket prints the free text beside a three-line benefit', () => {
    const c = byName('ticket 80x50, logo, long benefit, short free text');
    const out = layoutVoucher(c.w, c.h, c.content, fakeMeasure);
    assert.deepEqual(freeOps(c, out.ops).map((o) => (o as { text: string }).text), ['יחידה אחת!!!!!!!']);
    assert.deepEqual(out.freeText, { shown: 1, total: 1, cut: false });
    // The benefit shrank a little for it — no more than BENEFIT_MIN.
    const benefit = out.ops.filter((o) => o.op === 'text' && o.bold && o.text.includes('הנחה'));
    assert.ok(benefit.length > 0 && benefit.every((o) => o.op === 'text' && o.size < 3.3 && o.size >= 3.3 * 0.62));
  });

  it('a free text the card cannot hold whole says so', () => {
    const c = byName('ticket 80x50, logo, long benefit, free text cut');
    const out = layoutVoucher(c.w, c.h, c.content, fakeMeasure);
    assert.equal(out.freeText.cut, true);
    assert.equal(out.freeText.shown, 2);
    assert.ok(out.freeText.total > out.freeText.shown);
  });

  it('a word too wide for the card is cut too', () => {
    const c = byName('ticket 80x50, long benefit, short free text, room enough');
    const out = layoutVoucher(c.w, c.h, { ...c.content, freeText: 'א'.repeat(200) }, fakeMeasure);
    assert.deepEqual(out.freeText, { shown: 1, total: 1, cut: true });
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
