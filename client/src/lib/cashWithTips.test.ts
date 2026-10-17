/**
 * Run with `npm test`. "מזומן במגירה כולל טיפים" (P:/specs/x-z-cash-with-tips.md): the shared golden —
 * the server's copy, the same bytes as kiosk-desktop's and the till's — every case, every field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LABELS,
  cashWithTipsOfZ,
  drawerCase,
  figuresOfSection,
  block,
  money,
  sectionTipsLines,
  shiftCashWithTips,
  tableOfSections,
  tillTableCase,
  toAgorot,
  type DrawerExpect,
  type DrawerInput,
  type TillTable,
} from './cashWithTips';

const ROOT = join(__dirname, '..');
const FIXTURE = join(ROOT, '..', 'server', 'tests', 'fixtures', 'x_z_cash_with_tips_golden.json');
const HE = join(ROOT, 'src', 'messages', 'he.json');
const GOLDEN_SHA256 = '9e7ccd52d809f17d5633e2dfbbf51107076c5afc708097aa0903e15cb379b13d';

interface Golden {
  labels: Record<string, string>;
  drawerCases: { name: string; input: DrawerInput; expect: DrawerExpect }[];
  tillTableCases: { name: string; showDrawerCash: boolean; tills: { till: string; input: DrawerInput }[]; expect: TillTable }[];
}

const bytes = () => readFileSync(FIXTURE);
const golden = (): Golden => JSON.parse(bytes().toString('utf8')) as Golden;

test('the golden is the pinned bytes', () => {
  assert.ok(existsSync(FIXTURE), FIXTURE);
  assert.equal(createHash('sha256').update(bytes()).digest('hex'), GOLDEN_SHA256);
});

test('the labels are the golden ones, and he.json has the same words', () => {
  assert.deepEqual(LABELS, golden().labels);
  const he = JSON.parse(readFileSync(HE, 'utf8')).cashWithTips.labels;
  assert.deepEqual(he, golden().labels);
});

test('every drawer case, every field', () => {
  for (const c of golden().drawerCases) {
    assert.deepEqual(drawerCase(c.input), c.expect, c.name);
  }
});

test('every till table case, every field', () => {
  for (const c of golden().tillTableCases) {
    assert.deepEqual(tillTableCase(c.tills, c.showDrawerCash), c.expect, c.name);
  }
});

test('agorot are exact', () => {
  assert.equal(toAgorot('10.05'), 1005);
  assert.equal(toAgorot('-25.50'), -2550);
  assert.equal(toAgorot(0.1 + 0.2), 30);
  assert.equal(toAgorot('x'), null);
  assert.equal(money(-50), '-0.50');
  assert.equal(money(0), '0.00');
});

test("a section's block totals to its expected cash", () => {
  const f = figuresOfSection({
    openingCash: '100.00', expectedCash: '135.00', cashSalesNet: '50.00', betweenShiftAdjustments: '-5.00',
    cardTipsFromDrawer: '20.00', cardTipsUnpaid: '7.00',
    cashMovements: { cashIn: '10.00', cashOut: '0.00', deposits: '30.00' },
    cashWallets: { walletIn: '0.00', walletDeposits: '15.00' },
  })!;
  assert.equal(f.input.cashTips, '15.00');
  const { lines, total } = block(f.input, f.paid, f.unpaid);
  assert.equal(total, 13500);
  assert.deepEqual(lines.map((l) => l.key), [
    'opening', 'cashSales', 'cashTips', 'cashIn', 'deposits', 'walletDeposits', 'between',
    'cardTips', 'cardTipsPaid', 'cardTipsUnpaid', 'total',
  ]);
  assert.equal(figuresOfSection({ kiosk: true, openingCash: '0', expectedCash: '0' }), null);
  assert.equal(figuresOfSection({ totalCash: '5' }), null);
});

test('a Z: the block over the header, the table over several drawers', () => {
  const one = { posNumber: 1, openingCash: '100.00', cashSalesNet: '200.00', expectedCash: '260.00', cardTipsFromDrawer: '50.00', cardTipsUnpaid: '0.00' };
  const two = { posNumber: 2, openingCash: '0.00', cashSalesNet: '40.00', expectedCash: '-10.00', cardTipsFromDrawer: '50.00', cardTipsUnpaid: '0.00' };
  const z = cashWithTipsOfZ({
    openingCash: '100.00', expectedCash: '250.00', cardTipsFromDrawer: '100.00', cardTipsUnpaid: '0.00',
    perMachine: [one, two, { kiosk: true }],
  })!;
  assert.equal(z.total, '250.00');
  assert.equal(z.short, false);
  assert.deepEqual(z.table!.rows.map((r) => [r.till, r.drawerCash, r.short]), [['קופה 1', '260.00', false], ['קופה 2', '-10.00', true]]);
  assert.equal(z.table!.totals.anyShort, true);
  // The summary first (§3): before payouts − (cash tips + paid) − unpaid = net; nothing owed here.
  assert.deepEqual(
    z.table!.summary.lines.map((l) => [l.key, l.amount]),
    [['summaryCash', z.table!.summary.totalCash], ['summaryTips', z.table!.summary.tips], ['summaryNet', z.table!.summary.netCash]],
  );
  assert.equal(
    toAgorot(z.table!.summary.netCash)!,
    toAgorot(z.table!.summary.totalCash)! - toAgorot(z.table!.summary.tips)! - toAgorot(z.table!.summary.unpaid)!,
  );
  assert.equal(cashWithTipsOfZ({ openingCash: '0', expectedCash: '1', perMachine: [one] })!.table, null);
  assert.equal(cashWithTipsOfZ({ perMachine: [{ kiosk: true }] }), null);
  assert.equal(cashWithTipsOfZ({ openingCash: null, expectedCash: '1' }), null);
  assert.equal(tableOfSections([one]), null);
  const hidden = cashWithTipsOfZ({ openingCash: '0', expectedCash: '-5', cardTipsFromDrawer: '5' }, { show: false })!;
  assert.equal(hidden.total, null);
  assert.ok(!hidden.lines.some((l) => l.key === 'total' || l.key === 'short'));
});

test("a till section's compact lines", () => {
  assert.deepEqual(sectionTipsLines({ expectedCash: '-30.00', cardTipsFromDrawer: '80.00', cardTipsUnpaid: '0' }).map((l) => [l.key, l.amount]), [
    ['cardTipsPaid', '-80.00'], ['short', '30.00'],
  ]);
  assert.deepEqual(sectionTipsLines({ expectedCash: '10.00' }), []);
});

test("a shift's block from its close", () => {
  const b = shiftCashWithTips({
    openingCash: '0.00', totalCash: '50.00', totalCashTips: '0.00',
    tillTotals: { cardTipsFromDrawer: 50, cardTipsUnpaid: 30, cardTipsShortfall: 'partial', cashOut: 10 },
  });
  assert.deepEqual(b.lines.map((l) => [l.key, l.amount]), [
    ['opening', '0.00'], ['cashSales', '50.00'], ['cashTips', '0.00'], ['cashOut', '-10.00'],
    ['cardTips', '80.00'], ['cardTipsPaid', '-50.00'], ['cardTipsUnpaid', '30.00'], ['total', '-10.00'], ['short', '10.00'],
  ]);
  assert.equal(b.shortfall, 'partial');
  const older = shiftCashWithTips({ openingCash: '0', totalCash: '50', tillTotals: { cardTipsFromDrawer: 10 } });
  assert.equal(older.total, '40.00');
  assert.equal(older.shortfall, null);
  const open = shiftCashWithTips({ openingCash: '0', totalCash: '50', tillTotals: { cardTipsFromDrawer: 10 }, open: true });
  assert.ok(!open.lines.some((l) => l.key === 'cardTips'));
});
