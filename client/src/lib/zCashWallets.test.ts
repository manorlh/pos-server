/**
 * Run with `npm test`. "הכסף אצלי" (P:/specs/drawer-away.md §5.6): the drawer's wallet lines and
 * "מזומן אצל עובדים (טרם הופקד)" as a Z froze them (lib/zCashWallets.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cashWalletRows, cashWalletsNet, cashWithStaffRows } from './zCashWallets';

describe('"הכסף אצלי" on a Z', () => {
  it('has no lines without the block — the Z reads as it always did', () => {
    assert.deepEqual(cashWalletRows(null), []);
    assert.deepEqual(cashWalletRows(undefined), []);
    assert.equal(cashWalletsNet(undefined), 0);
    assert.deepEqual(cashWithStaffRows(null), { rows: [], total: 0 });
  });

  it('takes the cash with employees off and their deposits on, each only when not zero', () => {
    assert.deepEqual(cashWalletRows({ walletIn: '140.00', walletDeposits: '90.00' }), [
      { key: 'walletIn', value: -140 },
      { key: 'walletDeposits', value: 90 },
    ]);
    assert.deepEqual(cashWalletRows({ walletIn: '0.00', walletDeposits: '90.00' }), [{ key: 'walletDeposits', value: 90 }]);
    assert.equal(cashWalletsNet({ walletIn: '140.00', walletDeposits: '90.10' }), -49.9);
    // What is not an amount is no claim.
    assert.deepEqual(cashWalletRows({ walletIn: 'x', walletDeposits: -5 }), []);
  });

  it('lists the employees holding cash, and their total', () => {
    const out = cashWithStaffRows({
      total: '40.00',
      employees: [
        { employeeId: 'u-1', employeeName: 'יוסי', amount: '40.00' },
        { employeeId: 'u-2', employeeName: null, amount: '12.50' },
        { employeeId: 'u-3', employeeName: 'דנה', amount: '0.00' },
      ],
    });
    assert.deepEqual(out.rows, [
      { employeeId: 'u-1', name: 'יוסי', amount: 40 },
      { employeeId: 'u-2', name: 'u-2', amount: 12.5 },
    ]);
    assert.equal(out.total, 52.5);
  });
});
