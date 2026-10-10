/**
 * Run with `npm test`. Zs by the date they were produced (lib/zByDate.ts): the list's date
 * choice, the day groups, the month's split by document month and the CSVs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_Z_DATE_BASIS,
  Z_DATE_BASES,
  addMonths,
  csvFileName,
  documentMonthsText,
  groupByDay,
  hasOtherMonthDocuments,
  isZDateBasis,
  listWindow,
  monthBounds,
  monthName,
  monthOfDay,
  productionDayOf,
  productionTimeOf,
  summaryWindow,
  tillLabel,
  tillsLabel,
  zKindOf,
  zLinesCsv,
  zSummaryCsv,
  type ZByDateLine,
  type ZByDateMonth,
  type ZByDateTotals,
} from './zByDate';
import { formatCurrency } from './format';

const IL = 'Asia/Jerusalem';

function totals(over: Partial<ZByDateTotals> = {}): ZByDateTotals {
  return {
    count: 1, totalSales: '150.00', totalRefunds: '0.00', netSales: '150.00', vatTotal: '21.79',
    cashSales: '100.00', cardSales: '50.00', totalTips: '5.00', documents: 2, vatUnknownCount: 0, ...over,
  };
}

function line(over: Partial<ZByDateLine> = {}): ZByDateLine {
  return {
    id: 'z1', zNumber: 12, zType: 'shop', kind: 'shop', origin: 'cloud',
    shopId: 's1', shopName: 'מרכז', shopNumber: 3, areaId: null, areaName: null, areaSource: null,
    machineId: null, machineName: null, posNumber: null, tills: [{ posNumber: '1', machineName: 'קדמית' }],
    machineCount: 1, shiftCount: 1,
    producedAt: '2026-09-30T23:00:00+00:00', productionDate: '2026-10-01', productionTime: '02:00',
    businessDate: '2026-09-30', periodStart: null, periodEnd: null, builtOffline: false, uploadedAt: null,
    totalSales: '150.00', totalRefunds: '0.00', netSales: '150.00', vatTotal: '21.79', cashSales: '100.00',
    cardSales: '50.00', totalTips: '5.00', documents: 2,
    ...over,
  };
}

const label = (key: string) => `[${key}]`;
const kindLabel = (kind: string) => `<${kind}>`;

describe('the date choice', () => {
  it('offers the production date first, and defaults to it', () => {
    assert.equal(DEFAULT_Z_DATE_BASIS, 'production');
    assert.deepEqual([...Z_DATE_BASES], ['production', 'business']);
  });

  it('knows its two values', () => {
    assert.equal(isZDateBasis('production'), true);
    assert.equal(isZDateBasis('business'), true);
    assert.equal(isZDateBasis('documents'), false);
    assert.equal(isZDateBasis(undefined), false);
  });
});

describe('the kind of a Z', () => {
  it('tells an area Z from the shop Z', () => {
    assert.equal(zKindOf({ zType: 'shop', areaId: null }), 'shop');
    assert.equal(zKindOf({ zType: 'shop', areaId: 'a1' }), 'area');
    assert.equal(zKindOf({ zType: 'shop', areaName: 'בר' }), 'area');
  });

  it('keeps every other type, and nothing for an unknown one', () => {
    for (const t of ['till', 'independent', 'kiosk', 'legacy'] as const) assert.equal(zKindOf({ zType: t }), t);
    assert.equal(zKindOf({ zType: null }), null);
    assert.equal(zKindOf({ zType: 'other' }), null);
  });
});

describe('the production day, on the shop clock', () => {
  it('puts a Z produced at 02:00 on 1.10 on 1.10, though its UTC date is 30.9', () => {
    assert.equal(productionDayOf('2026-09-30T23:00:00+00:00', IL), '2026-10-01');
    assert.equal(productionTimeOf('2026-09-30T23:00:00+00:00', IL), '02:00');
    assert.equal(productionDayOf('2026-09-30T23:00:00+00:00', 'UTC'), '2026-09-30');
  });

  it('reads the 25-hour day when Israel leaves DST (25.10.2026)', () => {
    // 01:30 IDT and 01:30 IST — an hour apart, the same local day and time.
    assert.equal(productionDayOf('2026-10-24T22:30:00Z', IL), '2026-10-25');
    assert.equal(productionDayOf('2026-10-24T23:30:00Z', IL), '2026-10-25');
    assert.equal(productionTimeOf('2026-10-24T22:30:00Z', IL), '01:30');
    assert.equal(productionTimeOf('2026-10-24T23:30:00Z', IL), '01:30');
    // 23:30 IST on 25.10 — at a fixed +3 it would read 00:30 on 26.10.
    assert.equal(productionDayOf('2026-10-25T21:30:00Z', IL), '2026-10-25');
    assert.equal(productionTimeOf('2026-10-25T21:30:00Z', IL), '23:30');
  });

  it('reads the 23-hour day when Israel enters DST (26.3.2027)', () => {
    // 00:30 IDT on 27.3 — at a fixed +2 it would read 23:30 on 26.3.
    assert.equal(productionDayOf('2027-03-26T21:30:00Z', IL), '2027-03-27');
    assert.equal(productionDayOf('2027-03-26T20:50:00Z', IL), '2027-03-26');
  });

  it('cuts a month on a DST day in another zone (New York, 1.11.2026)', () => {
    assert.equal(monthOfDay(productionDayOf('2026-11-01T03:30:00Z', 'America/New_York')), '2026-10');
    assert.equal(monthOfDay(productionDayOf('2026-11-01T04:30:00Z', 'America/New_York')), '2026-11');
    assert.equal(productionTimeOf('2026-11-01T06:30:00Z', 'America/New_York'), '01:30');
  });

  it('says nothing for a Z with no moment', () => {
    assert.equal(productionDayOf(null, IL), '');
    assert.equal(productionTimeOf(undefined, IL), '—');
  });
});

describe('the same Zs, grouped both ways', () => {
  const zs = [
    { id: 'evening', businessDate: '2026-10-01', closedAt: '2026-10-01T20:30:00Z' },
    { id: 'after-midnight', businessDate: '2026-09-30', closedAt: '2026-09-30T23:00:00Z' },
    { id: 'same-night', businessDate: '2026-09-30', closedAt: '2026-09-30T20:50:00Z' },
  ];

  it('by production day the Z after midnight joins 1.10', () => {
    const groups = groupByDay(zs, (z) => productionDayOf(z.closedAt, IL));
    assert.deepEqual(groups.map((g) => [g.day, g.rows.map((z) => z.id)]), [
      ['2026-10-01', ['evening', 'after-midnight']],
      ['2026-09-30', ['same-night']],
    ]);
  });

  it('by business day it stays on 30.9', () => {
    const groups = groupByDay(zs, (z) => z.businessDate);
    assert.deepEqual(groups.map((g) => [g.day, g.rows.map((z) => z.id)]), [
      ['2026-10-01', ['evening']],
      ['2026-09-30', ['after-midnight', 'same-night']],
    ]);
  });

  it('keeps the order it was given (a page is already sorted)', () => {
    const groups = groupByDay(['a', 'b', 'a'], (x) => x);
    assert.deepEqual(groups.map((g) => g.day), ['a', 'b', 'a']);
  });
});

describe('windows', () => {
  const today = '2026-10-10';

  it('the list CSV covers what the list shows', () => {
    assert.deepEqual(listWindow('', '', today), { from: '2026-07-12', to: today });
    assert.deepEqual(listWindow('2026-10-01', '', today), { from: '2026-10-01', to: today });
    assert.deepEqual(listWindow('2026-10-01', '2026-10-03', today), { from: '2026-10-01', to: '2026-10-03' });
    assert.deepEqual(listWindow('', '2026-10-03', today), { from: '2026-07-05', to: '2026-10-03' });
  });

  it('the summary card shows the picked day, else today', () => {
    assert.deepEqual(summaryWindow('', '', today), { from: today, to: today });
    assert.deepEqual(summaryWindow('2026-10-01', '2026-10-01', today), { from: '2026-10-01', to: '2026-10-01' });
    assert.deepEqual(summaryWindow('2026-10-01', '', today), { from: '2026-10-01', to: today });
    assert.deepEqual(summaryWindow('', '2026-10-01', today), { from: '2026-10-01', to: '2026-10-01' });
    assert.deepEqual(summaryWindow('2026-10-05', '2026-10-01', today), { from: '2026-10-01', to: '2026-10-05' });
  });
});

describe('months', () => {
  it('names, steps and bounds a month', () => {
    assert.equal(monthOfDay('2026-10-01'), '2026-10');
    assert.equal(monthOfDay('nope'), '');
    assert.equal(monthName('2026-09'), 'ספטמבר');
    assert.equal(monthName('2026-09', true), 'ספטמבר 2026');
    assert.equal(monthName('2026-13'), '');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.deepEqual(monthBounds('2028-02'), ['2028-02-01', '2028-02-29']);
    assert.deepEqual(monthBounds('2026-10'), ['2026-10-01', '2026-10-31']);
    assert.equal(monthBounds('x'), null);
  });
});

describe('the split by document month', () => {
  const months = [
    { month: '2026-09', netSales: '100.00', vatTotal: '14.53', documents: 1 },
    { month: '2026-10', netSales: '50.00', vatTotal: '7.26', documents: 1 },
  ];

  it('reads "₪X מסמכי ספטמבר · ₪Y מסמכי אוקטובר"', () => {
    assert.equal(
      documentMonthsText(months, '2026-10-01'),
      `${formatCurrency('100.00')} מסמכי ספטמבר · ${formatCurrency('50.00')} מסמכי אוקטובר`,
    );
  });

  it('names the year of a month of another year', () => {
    const text = documentMonthsText([{ month: '2026-12', netSales: '10.00', vatTotal: null, documents: 1 }], '2027-01-01');
    assert.equal(text, `${formatCurrency('10.00')} מסמכי דצמבר 2026`);
  });

  it('is empty without a split', () => {
    assert.equal(documentMonthsText([], '2026-10-01'), '');
    assert.equal(documentMonthsText(undefined), '');
  });

  it('flags a Z holding documents of another month', () => {
    assert.equal(hasOtherMonthDocuments({ documentMonths: months, productionDate: '2026-10-01' }), true);
    assert.equal(hasOtherMonthDocuments({ documentMonths: [months[1]], productionDate: '2026-10-01' }), false);
    // The server's flag wins when it is there.
    assert.equal(hasOtherMonthDocuments({ documentMonths: months, productionDate: '2026-10-01', otherMonthDocuments: false }), false);
  });
});

describe('labels', () => {
  it('names a till', () => {
    assert.equal(tillLabel({ posNumber: '2', machineName: 'בר' }), 'קופה 2 (בר)');
    assert.equal(tillLabel({ posNumber: '2' }), 'קופה 2');
    assert.equal(tillLabel({ machineName: 'בר' }), 'בר');
    assert.equal(tillsLabel({ tills: [{ posNumber: '1' }, { posNumber: '2', machineName: 'בר' }] }), 'קופה 1, קופה 2 (בר)');
  });
});

describe('CSV', () => {
  it('a row per Z with both dates, its kind and totals', () => {
    const csv = zLinesCsv([line()], label, kindLabel);
    assert.ok(csv.startsWith('﻿'));
    const [head, row] = csv.slice(1).trim().split('\r\n');
    assert.equal(
      head,
      '[zNumber],[kind],[shopNumber],[shop],[area],[tills],[productionDate],[productionTime],[businessDate],' +
        '[totalSales],[totalRefunds],[netSales],[vatTotal],[cashSales],[cardSales],[totalTips],[documents]',
    );
    assert.equal(row, '12,<shop>,3,מרכז,,קופה 1 (קדמית),2026-10-01,02:00,2026-09-30,150.00,0.00,150.00,21.79,100.00,50.00,5.00,2');
  });

  it('from the month, with the split by document month', () => {
    const months = [
      { month: '2026-09', netSales: '100.00', vatTotal: '14.53', documents: 1 },
      { month: '2026-10', netSales: '50.00', vatTotal: '7.26', documents: 1 },
    ];
    const csv = zLinesCsv([line({ documentMonths: months, otherMonthDocuments: true })], label, kindLabel);
    const [head, row] = csv.slice(1).trim().split('\r\n');
    assert.ok(head.endsWith('[documentMonths],[otherMonthDocuments]'));
    assert.ok(row.endsWith('2026-09: 100.00; 2026-10: 50.00,[yes]'));
  });

  it('a summary as blocks: grand total, shop, area, kind, day — and the month note', () => {
    const month: ZByDateMonth = {
      window: { from: '2026-10-01', to: '2026-10-31', dateBasis: 'production', timezone: IL, month: '2026-10' },
      count: 1,
      totals: totals(),
      byShop: [{ shopId: 's1', shopName: 'מרכז', shopNumber: 3, ...totals() }],
      byArea: [{ shopId: 's1', shopName: 'מרכז', shopNumber: 3, areaId: null, areaName: null, ...totals() }],
      byKind: [{ kind: 'shop', ...totals() }],
      byDay: [{ date: '2026-10-01', ...totals() }],
      zs: [line()],
      note: 'דיווח מע״מ ומבנה אחיד נעשים לפי תאריך המסמך',
      documentMonths: [{ month: '2026-09', netSales: '100.00', vatTotal: '14.53', documents: 1 }],
    };
    const lines = zSummaryCsv(month, label, kindLabel).slice(1).trim().split('\r\n');
    assert.equal(lines[0], '[grandTotal]');
    assert.equal(lines[2], '2026-10-01 – 2026-10-31,1,150.00,0.00,150.00,21.79,100.00,50.00,5.00,2');
    for (const title of ['[byShop]', '[byArea]', '[byKind]', '[byDay]', '[documentMonthsTitle]']) {
      assert.ok(lines.includes(title), title);
    }
    assert.ok(lines.includes('מרכז,[noArea],1,150.00,0.00,150.00,21.79,100.00,50.00,5.00,2'));
    assert.ok(lines.includes('<shop>,1,150.00,0.00,150.00,21.79,100.00,50.00,5.00,2'));
    assert.ok(lines.includes('2026-09,100.00,14.53,1'));
    assert.equal(lines[lines.length - 1], 'דיווח מע״מ ומבנה אחיד נעשים לפי תאריך המסמך');
  });

  it('names the file by its window', () => {
    assert.equal(csvFileName('list', { from: '2026-10-01', to: '2026-10-01', dateBasis: 'production' }), 'zs-list-production-2026-10-01.csv');
    assert.equal(csvFileName('summary', { from: '2026-10-01', to: '2026-10-05', dateBasis: 'business' }), 'zs-summary-business-2026-10-01_2026-10-05.csv');
    assert.equal(csvFileName('month', { from: '2026-10-01', to: '2026-10-31', dateBasis: 'production', month: '2026-10' }), 'zs-month-production-2026-10.csv');
  });
});
