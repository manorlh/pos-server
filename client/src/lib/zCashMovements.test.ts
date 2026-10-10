/**
 * Run with `npm test`. "Z — מזומן צפוי כולל הפקדות ותנועות מזומן": the lines a Z shows for the
 * Cash In / Cash Out / safe deposits that are part of its expected cash (lib/zCashMovements.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cashMovementRows, cashMovementsNet, hasCashMovementsBlock } from './zCashMovements';

describe('"Z — מזומן צפוי כולל הפקדות ותנועות מזומן"', () => {
  it('has no lines for a Z the parameter was off for — it reads as it always did', () => {
    assert.deepEqual(cashMovementRows(null), []);
    assert.deepEqual(cashMovementRows(undefined), []);
    assert.equal(hasCashMovementsBlock(undefined), false);
    assert.equal(cashMovementsNet(undefined), 0);
  });

  it('shows what moved, signed as the expected cash moves, in the paper order', () => {
    const block = { cashIn: '30.00', cashOut: '20.00', deposits: '150.00' };
    assert.deepEqual(cashMovementRows(block), [
      { key: 'cashIn', value: 30 },
      { key: 'cashOut', value: -20 },
      { key: 'deposits', value: -150 },
    ]);
    // 200 float + 100 cash + (30 − 20 − 150) = 160 — the count of 160 is no gap.
    assert.equal(200 + 100 + cashMovementsNet(block), 160);
  });

  it('shows no line for a movement that moved nothing, but knows the parameter applied', () => {
    const block = { cashIn: '0.00', cashOut: '0.00', deposits: '90.00' };
    assert.deepEqual(
      cashMovementRows(block).map((r) => r.key),
      ['deposits'],
    );
    const zeros = { cashIn: '0.00', cashOut: '0.00', deposits: '0.00' };
    assert.equal(hasCashMovementsBlock(zeros), true);
    assert.deepEqual(cashMovementRows(zeros), []);
  });

  it('takes numbers as well as strings, and what is not an amount as nothing', () => {
    assert.deepEqual(cashMovementRows({ cashIn: 5, cashOut: 'x', deposits: -3 }), [{ key: 'cashIn', value: 5 }]);
    assert.deepEqual(cashMovementRows({ cashIn: null, cashOut: true as unknown as string, deposits: NaN }), []);
  });

  it('adds up in cents', () => {
    assert.equal(cashMovementsNet({ cashIn: '0.10', cashOut: '0.20', deposits: '0.30' }), -0.4);
  });
});
