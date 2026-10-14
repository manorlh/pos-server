/**
 * "סיכום יום" v2 and "מכירות מוצרים לפי ימים" on the client (P:\specs\reports-designed-pdf.md §3,
 * §7.3, §7.6, §8): the queries the pages send, the tree's depths, the KPIs the export sends, and
 * the by-day workbook (a sheet per day, "סיכום", "מוצר × יום") and CSV.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeHours,
  changeTone,
  dayExportKpis,
  daySummaryV2Query,
  hierarchyDepths,
  hierarchyExportRows,
  isDaySummaryV2,
  type DayHierarchyRow,
  type DayHour,
  type DayKpi,
} from './daySummaryV2';
import {
  productsByDayCsv,
  productsByDayQuery,
  productsByDaySheets,
  sortProducts,
  type ByDayWords,
  type ProductsByDayReport,
} from './productsByDay';

const node = (level: DayHierarchyRow['level'], id: string, parentId: string | null, name: string): DayHierarchyRow => ({
  level,
  id,
  parentId,
  name,
  net: 0,
  share: 0,
  documents: 0,
  averageTicket: 0,
  lastWeekNet: 0,
  changePct: null,
});

describe('day summary v2: the query', () => {
  it('the date makes it v2; lists repeat; empty ones are left out', () => {
    assert.equal(
      daySummaryV2Query({ date: '2026-10-14', companyId: 'c', shopIds: ['a', 'b'], areaIds: [], machineIds: ['m'] }),
      'date=2026-10-14&companyId=c&shopIds=a&shopIds=b&machineIds=m',
    );
    assert.equal(daySummaryV2Query({ date: null, areaIds: ['none'] }), 'areaIds=none');
  });
  it('a v1 roll-up is not taken for v2', () => {
    assert.equal(isDaySummaryV2({ days: [], totals: {} }), false);
    assert.equal(isDaySummaryV2({ version: 2, kpis: [] }), true);
  });
});

describe('day summary v2: the tree and the hours', () => {
  it('shop → point of sale → till; a till with no point of sale sits under its shop', () => {
    const rows = [
      node('shop', 's1', null, 'מרכז'),
      node('area', 'a1', 's1', 'בר'),
      node('till', 't1', 'a1', 'קופה 1'),
      node('till', 't2', 's1', 'קופה 2'),
      node('shop', 's2', null, 'צפון'),
    ];
    assert.deepEqual(hierarchyDepths(rows), [0, 1, 2, 1, 0]);
    assert.deepEqual(
      hierarchyExportRows(rows).map((r) => r.label),
      ['מרכז', '  · בר', '    · קופה 1', '  · קופה 2', 'צפון'],
    );
  });
  it('the chart keeps the hours from the first sale to the last, either day', () => {
    const h = (hour: number, net: number, lastWeekNet = 0): DayHour => ({
      hour,
      label: `${hour}:00`,
      net,
      documents: net ? 1 : 0,
      lastWeekNet,
      lastWeekDocuments: lastWeekNet ? 1 : 0,
    });
    const hours = [h(4, 0), h(5, 0), h(6, 10), h(7, 0), h(8, 0, 5), h(9, 0), h(10, 0)];
    assert.deepEqual(
      activeHours(hours).map((x) => x.hour),
      [6, 7, 8],
    );
    assert.deepEqual(activeHours([h(4, 0)]), []);
  });
  it('a change: its arrow, and good news by the KPI\'s direction', () => {
    assert.deepEqual(changeTone(12.3), { arrow: '▲', good: true });
    assert.deepEqual(changeTone(12.3, 'down'), { arrow: '▲', good: false });
    assert.deepEqual(changeTone(-4, 'down'), { arrow: '▼', good: true });
    assert.deepEqual(changeTone(null), { arrow: '—', good: null });
    assert.deepEqual(changeTone(0.01), { arrow: '—', good: null });
  });
  it('the export compares each KPI with the same weekday last week', () => {
    const k: DayKpi = {
      key: 'refunds',
      label: 'זיכויים',
      kind: 'money',
      icon: 'refund',
      better: 'down',
      value: 50,
      lastWeek: 40,
      avg4w: 45,
      changePct: 25,
      changePctAvg: 11.1,
      spark: [1, 2, 3],
    };
    assert.deepEqual(dayExportKpis([k, { ...k, key: 'net', lastWeek: null, spark: [] }], 'שבוע שעבר'), [
      { key: 'refunds', label: 'זיכויים', value: 50, kind: 'money', compare: 40, compareLabel: 'שבוע שעבר', spark: [1, 2, 3], better: 'down', icon: 'refund' },
      { key: 'net', label: 'זיכויים', value: 50, kind: 'money', better: 'down', icon: 'refund' },
    ]);
  });
});

const WORDS: ByDayWords = {
  summarySheet: 'סיכום',
  matrixSheet: 'מוצר × יום',
  daysSheet: 'ימים',
  date: 'תאריך',
  weekday: 'יום',
  items: 'פריטים',
  net: 'מכירות ₪',
  documents: 'עסקאות',
  change: 'שינוי',
  product: 'מוצר',
  department: 'מחלקה',
  units: 'כמות',
  share: '%',
  averagePerDay: 'ממוצע ליום',
  daysSold: 'ימים שנמכר',
  total: 'סה"כ',
  daySheetName: (d) => d.date.split('-').reverse().slice(0, 2).join('.'),
};

function report(amounts = true): ProductsByDayReport {
  return {
    window: { from: '2026-10-13', to: '2026-10-14' },
    generatedAt: '2026-10-15T07:00:00Z',
    scope: { label: 'כל הסניפים' },
    options: { amounts, hideEmptyDays: false, sort: 'qty', meals: 'components' },
    kpis: [],
    days: [
      {
        date: '2026-10-13',
        weekday: "יום ב'",
        label: "יום ב' 13.10.2026",
        items: 5,
        net: 50,
        documents: 3,
        changePct: null,
        products: [
          { productId: 'p1', name: 'קפה', department: 'שתייה', units: 2, net: 30, share: 60 },
          { productId: 'p2', name: 'מאפה', department: null, units: 3, net: 20, share: 40 },
        ],
      },
      { date: '2026-10-14', weekday: "יום ג'", label: "יום ג' 14.10.2026", items: 0, net: 0, documents: 0, changePct: -100, products: [] },
    ],
    summary: {
      products: [
        { productId: 'p1', name: 'קפה', department: 'שתייה', units: 2, net: 30, share: 60, averagePerDay: 1, daysSold: 1 },
        { productId: 'p2', name: 'מאפה', department: null, units: 3, net: 20, share: 40, averagePerDay: 1.5, daysSold: 1 },
      ],
      totals: { units: 5, net: 50, documents: 3, days: 2 },
    },
    matrix: {
      grouping: 'day',
      columns: [
        { key: '2026-10-13', label: '13.10' },
        { key: '2026-10-14', label: '14.10' },
      ],
      rows: [
        { productId: 'p2', name: 'מאפה', values: [3, 0], total: 3 },
        { productId: 'p1', name: 'קפה', values: [2, 0], total: 2 },
      ],
    },
    insights: [],
  };
}

describe('products by day', () => {
  it('the query leaves the defaults out', () => {
    assert.equal(productsByDayQuery({ from: '2026-10-01', to: '2026-10-14' }), 'from=2026-10-01&to=2026-10-14');
    assert.equal(
      productsByDayQuery({ from: 'a', to: 'b', categoryIds: ['c1', 'none'], amounts: false, hideEmptyDays: true, sort: 'amount', meals: 'meals', shopIds: ['s'] }),
      'from=a&to=b&shopIds=s&categoryIds=c1&categoryIds=none&amounts=false&hideEmptyDays=true&sort=amount&meals=meals',
    );
  });
  it('sorted by quantity, or by ₪', () => {
    const rows = report().days[0].products;
    assert.deepEqual(sortProducts(rows, 'qty').map((p) => p.name), ['מאפה', 'קפה']);
    assert.deepEqual(sortProducts(rows, 'amount').map((p) => p.name), ['קפה', 'מאפה']);
  });
  it('the workbook: days, a sheet per day, the summary, product × day', () => {
    const sheets = productsByDaySheets(report(), WORDS);
    assert.deepEqual(
      sheets.map((s) => s.name),
      ['ימים', '13.10', '14.10', 'סיכום', 'מוצר × יום'],
    );
    assert.deepEqual(sheets[0].rows[0], ['2026-10-13', "יום ב'", 5, 50, 3, null]);
    assert.deepEqual(sheets[0].totals, ['סה"כ', null, 5, 50, 3, null]);
    assert.deepEqual(sheets[1].heading, ["יום ב' 13.10.2026"]);
    assert.deepEqual(sheets[1].rows, [
      ['מאפה', '', 3, 20, 40],
      ['קפה', 'שתייה', 2, 30, 60],
    ]);
    assert.deepEqual(sheets[3].rows[0], ['מאפה', '', 3, 20, 40, 1.5, 1]);
    assert.deepEqual(sheets[4].columns.map((c) => c.header), ['מוצר', '13.10', '14.10', 'סה"כ']);
    assert.deepEqual(sheets[4].rows[0], ['מאפה', 3, 0, 3]);
  });
  it('quantities only: no ₪ column anywhere', () => {
    const sheets = productsByDaySheets(report(false), WORDS);
    for (const s of sheets) assert.ok(!s.columns.some((c) => c.kind === 'money'), s.name);
    assert.deepEqual(sheets[1].rows[0], ['מאפה', '', 3, 40]);
  });
  it('the CSV: a row per day × product', () => {
    const csv = productsByDayCsv(report(), WORDS);
    const lines = csv.replace('\ufeff', '').trim().split('\r\n');
    assert.equal(lines[0], 'תאריך,יום,מוצר,מחלקה,כמות,מכירות ₪,%');
    assert.equal(lines.length, 3);
    assert.equal(lines[1], "2026-10-13,יום ב',מאפה,,3,20,40");
  });
});
