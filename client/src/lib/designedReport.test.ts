/**
 * The designed report's client half (P:\specs\reports-designed-pdf.md §1, §6): the previous
 * period, the KPI comparison, what the server is sent (KPIs, chart), the Excel's "סיכום ותובנות"
 * and the CSV.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  changePct,
  chartFromTable,
  cleanChart,
  cleanKpis,
  daysInRange,
  insightMark,
  previousWindow,
  summarySheet,
  tableCsv,
  withCompare,
  type ReportKpi,
} from './designedReport';

const WORDS = {
  sheetName: 'סיכום ותובנות',
  kpiHeader: 'מדד',
  valueHeader: 'ערך',
  previousHeader: 'תקופה קודמת',
  changeHeader: 'שינוי %',
  insightsHeading: 'תובנות',
};

describe('previousWindow', () => {
  it('one day: the same weekday a week before', () => {
    assert.deepEqual(previousWindow('2026-10-14', '2026-10-14'), { from: '2026-10-07', to: '2026-10-07' });
  });
  it('a range: as many days right before it', () => {
    assert.deepEqual(previousWindow('2026-10-08', '2026-10-14'), { from: '2026-10-01', to: '2026-10-07' });
    assert.deepEqual(previousWindow('2026-03-01', '2026-03-31'), { from: '2026-01-29', to: '2026-02-28' });
  });
  it('across a year and a DST night', () => {
    assert.deepEqual(previousWindow('2026-01-01', '2026-01-02'), { from: '2025-12-30', to: '2025-12-31' });
    assert.equal(daysInRange('2026-03-20', '2026-03-31'), 12);
  });
  it('no window without two days', () => {
    assert.equal(previousWindow(null, '2026-10-14'), null);
    assert.equal(previousWindow('2026-10-14', '2026-10-01'), null);
    assert.equal(previousWindow('x', 'y'), null);
  });
});

describe('KPI comparison', () => {
  const kpis: ReportKpi[] = [
    { key: 'net', label: 'מכירות נטו', value: 1200, kind: 'money' },
    { key: 'refunds', label: 'זיכויים', value: '50.00', kind: 'money' },
    { key: 'items', label: 'פריטים', value: 10, kind: 'count' },
    { key: 'note', label: 'הערה', value: 'שקט', kind: 'text' },
  ];
  it('the change in percent, never a division by zero', () => {
    assert.equal(changePct(110, 100), 10);
    assert.equal(changePct(90, 100), -10);
    assert.equal(changePct(0, 0), 0);
    assert.equal(changePct(5, 0), null);
  });
  it('the previous value by key, with what it is compared with (§7.1)', () => {
    const out = withCompare(kpis, { net: 1000, refunds: 25, items: 0 }, 'מול 07.10');
    assert.equal(out[0].compare, 1000);
    assert.equal(out[0].compareLabel, 'מול 07.10');
    assert.equal(out[1].compare, 25);
    assert.equal(out[2].compare, 0);
    assert.equal(out[3].compare, undefined);
  });
  it('a comparison the page set stays', () => {
    const own: ReportKpi = { key: 'net', label: 'נטו', value: 5, kind: 'money', compare: { value: 4, label: 'אירוע ב' } };
    assert.deepEqual(withCompare([own], { net: 1 })[0], own);
  });
  it('no previous period: the KPIs as they are', () => {
    assert.deepEqual(withCompare(kpis, null), kpis);
  });
  it('the server gets at most 8, keys unique and safe, its own kinds', () => {
    const many = [...kpis, ...kpis, { key: 'a b/c', label: 'x', value: 1, kind: 'number' as const }];
    const out = cleanKpis(many);
    assert.equal(out.length, 5);
    assert.equal(out[1].value, 50);
    assert.equal(out[2].kind, 'number');
    assert.equal(out[3].value, 'שקט');
    assert.equal(out[4].key, 'a_b_c');
    const ten = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, value: i, kind: 'number' as const }));
    assert.equal(cleanKpis(ten).length, 8);
  });
  it('minutes go as seconds (duration), with their comparison and sparkline', () => {
    const [k] = cleanKpis([{ key: 'seated', label: 'ישיבה', value: 42.5, kind: 'minutes', compare: 40, spark: [30, 40] }]);
    assert.deepEqual(k, { key: 'seated', label: 'ישיבה', value: 2550, kind: 'duration', compare: 2400, spark: [1800, 2400] });
  });
  it('better and icon pass through', () => {
    const [k] = cleanKpis([{ key: 'x', label: 'x', value: 1, kind: 'money', better: 'down', icon: 'refund' }]);
    assert.equal(k.better, 'down');
    assert.equal(k.icon, 'refund');
  });
});

describe('chart', () => {
  const table = {
    columns: [
      { key: 'product', header: 'מוצר' },
      { key: 'net', header: 'נטו' },
    ],
    rows: [
      ['קפה', 30],
      ['מאפה', '120.50'],
      ['', 5],
      ['מים', null],
      ['תה', 10],
    ],
  };
  it('the top rows by the figure, largest first', () => {
    const c = chartFromTable(table, 'product', 'net', { top: 2 })!;
    assert.equal(c.type, 'hbar');
    assert.deepEqual(c.labels, ['מאפה', 'קפה']);
    assert.deepEqual(c.series, [{ name: 'נטו', values: [120.5, 30] }]);
  });
  it('a line keeps the rows in order', () => {
    assert.deepEqual(chartFromTable(table, 'product', 'net', { type: 'line' })!.labels, ['קפה', 'מאפה', 'תה']);
  });
  it('an unknown column or an all-zero chart is no chart', () => {
    assert.equal(chartFromTable(table, 'nope', 'net'), undefined);
    assert.equal(cleanChart({ type: 'bar', labels: ['a'], series: [{ name: 'x', values: [0] }] }), undefined);
    assert.equal(cleanChart(null), undefined);
  });
  it('48 labels and 3 series at most (the server groups a donut past 12 into "אחר")', () => {
    const labels = Array.from({ length: 60 }, (_, i) => `m${i}`);
    const series = Array.from({ length: 4 }, (_, j) => ({ name: `s${j}`, values: labels.map((_, i) => i + j) }));
    const c = cleanChart({ type: 'bar', labels, series })!;
    assert.equal(c.labels.length, 48);
    assert.equal(c.series.length, 3);
    assert.equal(c.series[2].values.length, 48);
  });
  it('a hbar from a table keeps 12 rows unless asked', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`p${i}`, i + 1]);
    const c = chartFromTable({ columns: [{ key: 'p', header: 'מוצר' }, { key: 'n', header: 'נטו' }], rows }, 'p', 'n')!;
    assert.equal(c.labels.length, 12);
    assert.equal(c.labels[0], 'p19');
  });
});

describe('the Excel "סיכום ותובנות"', () => {
  it('KPIs with their comparison, then the insight sentences', () => {
    const kpis = withCompare([{ key: 'net', label: 'מכירות נטו', value: 1200, kind: 'money' }], { net: 1000 });
    const sheet = summarySheet(kpis, [{ type: 'leader', text: 'קפה מוביל עם 40% מהמכירות.' }], WORDS)!;
    assert.equal(sheet.name, 'סיכום ותובנות');
    assert.deepEqual(
      sheet.columns.map((c) => c.header),
      ['מדד', 'ערך', 'תקופה קודמת', 'שינוי %'],
    );
    assert.deepEqual(sheet.rows[0], ['מכירות נטו', 1200, 1000, 20]);
    assert.deepEqual(sheet.rows[1], [null, null, null, null]);
    assert.deepEqual(sheet.rows[2], ['תובנות', null, null, null]);
    assert.deepEqual(sheet.rows[3], ['🏆 קפה מוביל עם 40% מהמכירות.', null, null, null]);
    assert.equal(sheet.autoFilter, false);
  });
  it("the server's KPIs: its change, its display for what is not a number (§7.2)", () => {
    const sheet = summarySheet(
      [
        { key: 'net', label: 'נטו', kind: 'money', value: 110, display: '₪ 110.00', compare: 100, changePct: 10.01 },
        { key: 'best', label: 'היום החזק', kind: 'text', value: "יום ג' 14.10" },
        { key: 'avg', label: 'זמן', kind: 'duration', value: null, display: '—', compare: null, changePct: null },
      ],
      [],
      WORDS,
    )!;
    assert.deepEqual(sheet.rows, [
      ['נטו', 110, 100, 10.01],
      ['היום החזק', "יום ג' 14.10", null, null],
      ['זמן', '—', null, null],
    ]);
  });
  it('no comparison: two columns', () => {
    const sheet = summarySheet([{ key: 'n', label: 'עסקאות', value: 7, kind: 'count' }], [], WORDS)!;
    assert.equal(sheet.columns.length, 2);
    assert.deepEqual(sheet.rows, [['עסקאות', 7]]);
  });
  it('nothing to say: no sheet', () => {
    assert.equal(summarySheet([], [], WORDS), null);
  });
  it('each insight kind has a sign readable without colour', () => {
    assert.deepEqual(['leader', 'up', 'down', 'alert', 'tip', 'other'].map(insightMark), ['🏆', '📈', '📉', '⚠', '💡', '•']);
  });
});

describe('CSV', () => {
  it('headers, plain values and the totals row', () => {
    const csv = tableCsv({
      columns: [{ header: 'מוצר' }, { header: 'נטו' }],
      rows: [
        ['קפה, גדול', 12.5],
        ['=SUM(A1)', null],
      ],
      totals: ['סה"כ', 12.5],
    });
    assert.equal(csv, '\ufeffמוצר,נטו\r\n"קפה, גדול",12.5\r\n\'=SUM(A1),\r\n"סה""כ",12.5\r\n');
  });
});
