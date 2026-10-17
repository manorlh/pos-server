/**
 * X / Z — "מזומן במגירה" (P:/specs/x-z-cash-with-tips.md) on the Windows till (core/till/cashWithTips.ts): the shared golden
 * x_z_cash_with_tips_golden.json byte for byte (its SHA pinned — one rule, four copies), the X's figures with the card tips
 * paid out of the drawer (partial / negative / ask), the X and Z papers, the per-till table of a shop Z, the close freezing
 * paid / unpaid / the mode, the ask at the close; a till document's tip off its money leg (principalLegs).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildXTill, type XDoc } from '../src/core/sale';
import {
  CASH_WITH_TIPS_LABELS,
  amountText,
  cardTipsFromDrawerOn,
  cardTipsShortfallOf,
  drawerOf,
  tillTable,
  withCashWithTips,
  zDrawer,
  zPrintPerTill,
  cashBlock,
  type DrawerInput,
} from '../src/core/till/cashWithTips';
import { xDoc, zDoc } from '../src/core/printDocs';
import { formatShekelSign } from '../src/core/money';
import { principalLegs } from '../src/main/fiscal/ledger';
import { readyTill } from './tillEngineHarness';

const GOLDEN_SHA = '1f87e1c89566b147a4c097febe5c789b73f0a16340f94275757eb31f82c0eb98';
const raw = readFileSync(join(__dirname, 'fixtures', 'x_z_cash_with_tips_golden.json'));

type Money = string;
interface GoldenInput {
  opening: Money;
  cashSales: Money;
  deviceCash?: Money;
  cashTips: Money;
  cardTips: Money;
  movements: { cashIn: Money; cashOut: Money; deposits: Money } | null;
  wallet: { walletIn: Money; walletDeposits: Money } | null;
  between: Money | null;
  param: boolean;
  shortfall: 'partial' | 'negative' | 'ask';
  askChoice: 'partial' | 'negative' | null;
  showDrawerCash?: boolean;
}
const golden = JSON.parse(raw.toString('utf8')) as {
  labels: Record<string, string>;
  drawerCases: Array<{ name: string; input: GoldenInput; expect: Record<string, unknown> & { lines: unknown[] } }>;
  tillTableCases: Array<{ name: string; showDrawerCash: boolean; tills: Array<{ till: string; input: GoldenInput }>; expect: Record<string, unknown> }>;
};

const ag = (s: Money | null | undefined) => (s === null || s === undefined ? 0 : Math.round(Number(s) * 100));
const m = (a: number | null) => (a === null ? null : amountText(a));
function inputOf(g: GoldenInput): DrawerInput {
  return {
    opening: ag(g.opening),
    cashSales: ag(g.cashSales),
    deviceCash: ag(g.deviceCash),
    cashTips: ag(g.cashTips),
    cardTips: ag(g.cardTips),
    movements: g.movements ? { cashIn: ag(g.movements.cashIn), cashOut: ag(g.movements.cashOut), deposits: ag(g.movements.deposits) } : null,
    wallet: g.wallet ? { walletIn: ag(g.wallet.walletIn), walletDeposits: ag(g.wallet.walletDeposits) } : null,
    between: ag(g.between),
    param: g.param,
    shortfall: g.shortfall,
    askChoice: g.askChoice,
    showDrawerCash: g.showDrawerCash !== false,
  };
}

describe('the shared golden (x_z_cash_with_tips_golden.json)', () => {
  it('is the file every copy holds', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(GOLDEN_SHA);
    expect(golden.labels).toEqual(CASH_WITH_TIPS_LABELS);
  });

  for (const c of golden.drawerCases) {
    it(`drawer: ${c.name}`, () => {
      const r = drawerOf(inputOf(c.input));
      expect({
        available: m(r.available),
        paid: m(r.paid),
        unpaid: m(r.unpaid),
        frozenShortfall: r.mode,
        needsChoice: r.needsChoice,
        total: m(r.total),
        short: r.short,
        lines: r.lines.map((l) => ({ key: l.key, label: l.label, amount: amountText(l.agorot), bold: l.bold, warn: l.warn })),
      }).toEqual(c.expect);
    });
  }

  for (const c of golden.tillTableCases) {
    it(`till table: ${c.name}`, () => {
      const t = tillTable(c.tills.map((x) => ({ till: x.till, input: inputOf(x.input) })), c.showDrawerCash);
      expect({
        rows: t.rows.map((r) => ({ till: r.till, cashSales: m(r.cashSales), cashTips: m(r.cashTips), cardTipsPaid: m(r.cardTipsPaid), cardTipsUnpaid: m(r.cardTipsUnpaid), drawerCash: m(r.drawerCash), short: r.short })),
        totals: { cashSales: m(t.totals.cashSales), cashTips: m(t.totals.cashTips), cardTipsPaid: m(t.totals.cardTipsPaid), cardTipsUnpaid: m(t.totals.cardTipsUnpaid), drawerCash: m(t.totals.drawerCash), anyShort: t.totals.anyShort },
        unpaidTotal: m(t.unpaidTotal),
        summary: {
          totalCash: m(t.summary.totalCash),
          tips: m(t.summary.tips),
          unpaid: m(t.summary.unpaid),
          netCash: m(t.summary.netCash),
          lines: t.summary.lines.map((l) => ({ key: l.key, label: l.label, amount: amountText(l.agorot), bold: l.bold, warn: l.warn })),
        },
      }).toEqual(c.expect);
    });
  }
});

const doc = (id: string, method: 'cash' | 'card', tip = 0, gross = 5_000): XDoc => ({
  id,
  status: 'completed',
  documentType: 320,
  transactionNumber: Number(id),
  grossAgorot: gross,
  itemsQty: 1,
  documentDiscountAgorot: 0,
  payments: [{ method, amountAgorot: gross }],
  paymentMethod: method,
  vatAgorot: 763,
  vatRate: 18,
  tipAgorot: tip,
  tipPaymentMethod: tip > 0 ? method : null,
});

/** ₪50 in cash, and a card sale with a ₪10 tip. */
const day = (opening = 0, cardTip = 1_000) => buildXTill([doc('1', 'cash'), doc('2', 'card', cardTip)], opening, 18).till;
const opts = (shortfall: 'partial' | 'negative' | 'ask' = 'partial', askChoice: 'partial' | 'negative' | null = null) => ({ param: true, shortfall, askChoice });

describe('the till X (withCashWithTips)', () => {
  it("the owner's example — 50 in cash and a 10 card tip leave 40 in the drawer; nothing fiscal moves", () => {
    const off = day();
    const on = withCashWithTips(off, opts());
    expect([on.cardTipsFromDrawer, on.cardTipsUnpaid, on.cardTipsShortfall, on.drawerCash, on.expectedCash]).toEqual([10, 0, 'partial', 40, 40]);
    expect([on.totalCash, on.totalCard, on.totalTips, on.totalCardTips, on.vatTotal, on.totalSales]).toEqual([off.totalCash, off.totalCard, off.totalTips, off.totalCardTips, off.vatTotal, off.totalSales]);
  });

  it('off — the till as it was', () => {
    const off = withCashWithTips(day(), { param: false, shortfall: 'partial', askChoice: null });
    expect([off.expectedCash, off.cardTipsFromDrawer, off.cardTipsUnpaid]).toEqual([50, undefined, undefined]);
  });

  it('short: partial pays what is there, negative pays all, ask previews partial and asks', () => {
    const short = day(0, 8_000); // ₪80 of card tips over ₪50 in the drawer
    expect([withCashWithTips(short, opts()).cardTipsFromDrawer, withCashWithTips(short, opts()).cardTipsUnpaid, withCashWithTips(short, opts()).expectedCash]).toEqual([50, 30, 0]);
    const neg = withCashWithTips(short, opts('negative'));
    expect([neg.cardTipsFromDrawer, neg.cardTipsUnpaid, neg.expectedCash, neg.cardTipsShortfall]).toEqual([80, 0, -30, 'negative']);
    const ask = withCashWithTips(short, opts('ask'));
    expect([ask.cardTipsFromDrawer, ask.cardTipsNeedsChoice, ask.cardTipsShortfall]).toEqual([50, true, 'partial']);
    const chosen = withCashWithTips(short, opts('ask', 'negative'));
    expect([chosen.cardTipsFromDrawer, chosen.cardTipsNeedsChoice, chosen.cardTipsShortfall]).toEqual([80, undefined, 'negative']);
    expect(withCashWithTips(day(), opts('ask')).cardTipsNeedsChoice).toBeUndefined();
  });

  it('the parameters — off by default, never on a kiosk; the shortfall partial unless said', () => {
    expect(cardTipsFromDrawerOn({}, false)).toBe(false);
    expect(cardTipsFromDrawerOn({ 'cashDrawer.cardTipsFromDrawer': 'true' }, false)).toBe(true);
    expect(cardTipsFromDrawerOn({ 'cashDrawer.cardTipsFromDrawer': true }, true)).toBe(false);
    expect([cardTipsShortfallOf({}), cardTipsShortfallOf({ 'cashDrawer.cardTipsShortfall': 'negative' }), cardTipsShortfallOf({ 'cashDrawer.cardTipsShortfall': 'ask' }), cardTipsShortfallOf({ 'cashDrawer.cardTipsShortfall': 'x' })]).toEqual(['partial', 'negative', 'ask', 'partial']);
  });
});

const business = { companyName: 'בדיקה', vatNumber: '514000000', dealerType: 'company' };
const rows = (d: { ops: Array<{ t: string; label?: string; value?: string; bold?: boolean; text?: string }> }) => d.ops.filter((o) => o.t === 'row').map((o) => [o.label, o.value]);

describe('the papers', () => {
  const base = { business, shopName: null, posNumber: '2', machineName: null, logoUrl: null, printedAt: new Date(0), cashierName: 'דנה', shiftNumber: 3, businessDate: '2026-10-17', openedAt: new Date(0), copy: false } as unknown as Parameters<typeof xDoc>[0];

  it('the X: the block always, after the reconciliation; its total is מזומן צפוי; none of it hidden but the total under a blind count', () => {
    const on = withCashWithTips(day(0, 8_000), opts());
    const closed = rows(xDoc({ ...base, till: on, closedAt: new Date(0), countedCash: 0 }));
    const labels = closed.map((r) => r[0]);
    const at = labels.indexOf(CASH_WITH_TIPS_LABELS.opening, labels.indexOf('מזומן שנספר'));
    expect(closed.slice(at)).toEqual([
      [CASH_WITH_TIPS_LABELS.opening, '₪0.00'],
      [CASH_WITH_TIPS_LABELS.cashSales, '₪50.00'],
      [CASH_WITH_TIPS_LABELS.cashTips, '₪0.00'],
      [CASH_WITH_TIPS_LABELS.cardTips, '₪80.00'],
      [CASH_WITH_TIPS_LABELS.cardTipsPaid, formatShekelSign(-5_000)],
      [CASH_WITH_TIPS_LABELS.cardTipsUnpaid, '₪30.00'],
      [CASH_WITH_TIPS_LABELS.total, '₪0.00'],
    ]);
    expect(closed.find((r) => r[0] === 'מזומן צפוי')?.[1]).toBe('₪0.00');
    const blind = rows(xDoc({ ...base, till: on, closedAt: null, countedCash: null, blindCount: true })).map((r) => r[0]);
    expect(blind).toContain(CASH_WITH_TIPS_LABELS.cardTipsUnpaid);
    expect(blind).not.toContain(CASH_WITH_TIPS_LABELS.total);
    const off = rows(xDoc({ ...base, till: day(), closedAt: null, countedCash: null })).map((r) => r[0]);
    expect(off).toContain(CASH_WITH_TIPS_LABELS.total);
    expect(off).not.toContain(CASH_WITH_TIPS_LABELS.cardTips);
  });

  const zOpts = { business, shopName: null, posNumber: '2', machineName: null, copy: false, logoUrl: null, printedAt: new Date(0) } as unknown as Parameters<typeof zDoc>[1];

  it("a till Z: the block from the Z's frozen figures, its total the Z's expectedCash (the short line in it)", () => {
    const z = { zNumber: 7, openingCash: '0.00', expectedCash: '-30.00', actualCash: null, totalCashSales: '50.00', totalCashTips: '0.00', cardTipsFromDrawer: '80.00', cardTipsUnpaid: '0.00', cashMovements: { cashIn: '0.00', cashOut: '0.00', deposits: '0.00' } };
    const r = rows(zDoc(z, zOpts));
    expect(r.find((x) => x[0] === CASH_WITH_TIPS_LABELS.total)?.[1]).toBe(formatShekelSign(-3_000));
    expect(r.map((x) => x[0])).toContain(CASH_WITH_TIPS_LABELS.short);
    // An older Z with none of the tips' keys: the block still, no tips lines.
    const old = rows(zDoc({ zNumber: 8, openingCash: 100, expectedCash: 150, totalCashSales: 50 }, zOpts)).map((x) => x[0]);
    expect(old).toContain(CASH_WITH_TIPS_LABELS.total);
    expect(old).not.toContain(CASH_WITH_TIPS_LABELS.cardTips);
  });

  it('zDrawer reconciles the takings to the expected cash it was sent', () => {
    const one = zDrawer({ openingCash: '100', expectedCash: '170', cashSalesNet: '60', totalCashTips: '10', betweenShiftAdjustments: '0' });
    expect(cashBlock(one.input, one.paid, one.unpaid).total).toBe(17_000);
    expect(one.paid).toBeNull();
  });

  it('a shop Z over several tills: "מזומן במגירה לפי קופה" and the unpaid tips of the day', () => {
    const z = {
      zNumber: 9,
      openingCash: '500.00',
      expectedCash: '2620.00',
      perMachine: [
        { posNumber: '1', openingCash: '500.00', expectedCash: '2300.00', cashSalesNet: '2000.00', totalCashTips: '100.00', cardTipsFromDrawer: '300.00', cardTipsUnpaid: '0.00' },
        { posNumber: '2', openingCash: '0.00', expectedCash: '0.00', cashSalesNet: '40.00', totalCashTips: '0.00', cardTipsFromDrawer: '40.00', cardTipsUnpaid: '50.00' },
        { posNumber: '3', openingCash: '200.00', expectedCash: '920.00', cashSalesNet: '700.00', totalCashTips: '20.00' },
      ],
    };
    const d = zDoc(z, zOpts);
    const centred = d.ops.filter((o) => o.t === 'centred').map((o) => (o as { text: string }).text);
    expect(centred).toContain(CASH_WITH_TIPS_LABELS.tillTable);
    const r = rows(d);
    expect(r.find((x) => x[0] === 'קופה 2')?.[1]).toBe('₪0.00');
    expect(r.find((x) => x[0] === CASH_WITH_TIPS_LABELS.tillTotals)?.[1]).toBe(formatShekelSign(322_000));
    expect(r.find((x) => x[0] === CASH_WITH_TIPS_LABELS.unpaidDay)?.[1]).toBe('₪50.00');
    // The summary of all the drawers first: Σ available 3,560, tips 460, unpaid 50, net 3,050.
    expect(r.slice(r.findIndex((x) => x[0] === CASH_WITH_TIPS_LABELS.summaryCash)).slice(0, 4)).toEqual([
      [CASH_WITH_TIPS_LABELS.summaryCash, formatShekelSign(356_000)],
      [CASH_WITH_TIPS_LABELS.summaryTips, formatShekelSign(46_000)],
      [CASH_WITH_TIPS_LABELS.summaryUnpaid, formatShekelSign(5_000)],
      [CASH_WITH_TIPS_LABELS.summaryNet, formatShekelSign(305_000)],
    ]);
    // zPrintPerTillCash = summary_only: no per-till table on paper.
    const only = zDoc(z, { ...zOpts, perTillCash: zPrintPerTill({ zPrintPerTillCash: 'summary_only' }) });
    expect(only.ops.filter((o) => o.t === 'centred').map((o) => (o as { text: string }).text)).not.toContain(CASH_WITH_TIPS_LABELS.tillTable);
    expect(zPrintPerTill({})).toBe(true);
  });
});

describe("a till document's tip rides on its money leg (principalLegs)", () => {
  it('the leg that closed it pays the goods; the tip is its own figure', () => {
    expect(principalLegs([{ method: 'production_voucher', amountAgorot: 2_400 }, { method: 'cash', amountAgorot: 5_500 }], 500)).toEqual([
      { method: 'production_voucher', amountAgorot: 2_400 },
      { method: 'cash', amountAgorot: 5_000 },
    ]);
    expect(principalLegs([{ method: 'card', amountAgorot: 1_000 }], 0)).toEqual([{ method: 'card', amountAgorot: 1_000 }]);
  });
});

/** The engine with ₪80 of card tips on the shift (its drawer's figures, as the tips of kiosk orders paid here would make them). */
function withCardTips(h: Awaited<ReturnType<typeof readyTill>>, shekels: number): void {
  const e = h.engine as unknown as { withDrawer: (till: Record<string, unknown>, shiftId: string) => Record<string, unknown> };
  const real = e.withDrawer.bind(h.engine);
  e.withDrawer = (till, shiftId) => ({ ...real(till, shiftId), totalCardTips: shekels });
}

describe('the engine: every close freezes paid / unpaid / the mode', () => {
  it('on: the close carries cardTipsFromDrawer (paid), cardTipsUnpaid, cardTipsShortfall; the X its block', async () => {
    const h = await readyTill({ parameters: { 'cashDrawer.cardTipsFromDrawer': 'true' } }, undefined, 0);
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 4_200 });
    await h.ok('checkout.finish');
    const x = await h.ok<{ cardTipsFromDrawerAgorot?: number; expectedCashAgorot: number; cashBlock: Array<{ key: string; amountAgorot: number }> }>('report.x');
    expect([x.cardTipsFromDrawerAgorot, x.expectedCashAgorot]).toEqual([0, 4_200]);
    expect(x.cashBlock.find((l) => l.key === 'total')?.amountAgorot).toBe(4_200);
    await h.ok('shift.close', { countedCashAgorot: 4_200 });
    const till = (JSON.parse(h.svc.ledger.lastClosedShift()!.close_payload ?? '{}') as { till: Record<string, unknown> }).till;
    expect([till.cardTipsFromDrawer, till.cardTipsUnpaid, till.cardTipsShortfall, till.drawerCash, 'cardTipsNeedsChoice' in till]).toEqual([0, 0, 'partial', 42, false]);
    h.stop();
  });

  it('off: nothing of it on the close; the X still shows the block', async () => {
    const h = await readyTill({}, undefined, 0);
    const x = await h.ok<{ cashBlock: Array<{ key: string }> }>('report.x');
    expect(x.cashBlock.map((l) => l.key)).toEqual(['opening', 'cashSales', 'cashTips', 'total']);
    await h.ok('shift.close', { countedCashAgorot: 0 });
    const till = (JSON.parse(h.svc.ledger.lastClosedShift()!.close_payload ?? '{}') as { till: Record<string, unknown> }).till;
    expect('cardTipsFromDrawer' in till || 'cardTipsUnpaid' in till).toBe(false);
    h.stop();
  });

  it('ask and short: the close asks; the choice closes and is frozen', async () => {
    const h = await readyTill({ parameters: { 'cashDrawer.cardTipsFromDrawer': 'true', 'cashDrawer.cardTipsShortfall': 'ask' } }, undefined, 5_000);
    withCardTips(h, 80);
    const x = await h.ok<{ cardTipsNeedsChoice?: boolean; cardTipsFromDrawerAgorot?: number; cardTipsUnpaidAgorot?: number }>('report.x');
    expect([x.cardTipsNeedsChoice, x.cardTipsFromDrawerAgorot, x.cardTipsUnpaidAgorot]).toEqual([true, 5_000, 3_000]);
    const asked = await h.fail('shift.close', { countedCashAgorot: 0 });
    expect(asked.code).toBe('card_tips_choice');
    expect(String((asked.details as Record<string, unknown>).body)).toContain('80.00');
    await h.ok('shift.close', { countedCashAgorot: 0, cardTipsChoice: 'negative' });
    const till = (JSON.parse(h.svc.ledger.lastClosedShift()!.close_payload ?? '{}') as { till: Record<string, unknown> }).till;
    expect([till.cardTipsFromDrawer, till.cardTipsUnpaid, till.cardTipsShortfall, till.expectedCash, 'cardTipsNeedsChoice' in till]).toEqual([80, 0, 'negative', -30, false]);
    h.stop();
  });

  it('ask and not short: no question, frozen as partial', async () => {
    const h = await readyTill({ parameters: { 'cashDrawer.cardTipsFromDrawer': 'true', 'cashDrawer.cardTipsShortfall': 'ask' } }, undefined, 10_000);
    withCardTips(h, 80);
    await h.ok('shift.close', { countedCashAgorot: 2_000 });
    const till = (JSON.parse(h.svc.ledger.lastClosedShift()!.close_payload ?? '{}') as { till: Record<string, unknown> }).till;
    expect([till.cardTipsFromDrawer, till.cardTipsUnpaid, till.cardTipsShortfall, till.expectedCash]).toEqual([80, 0, 'partial', 20]);
    h.stop();
  });
});
