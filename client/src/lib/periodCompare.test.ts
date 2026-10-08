import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addMonths,
  addYears,
  comparedRange,
  compareQuery,
  comparisonSheets,
  curvePoints,
  defaultVs,
  delta,
  orderedRange,
  parseCompareParams,
  pctText,
  peakIndex,
  periodRange,
  rangeDays,
  shares,
  sideBySideSheets,
  sideReady,
  stepAnchor,
  toHourPoints,
  toSalesFigures,
  toggleSideId,
  weekStart,
  type CompareParams,
  type ExportWords,
  type FiguresLike,
} from './periodCompare';

const TODAY = '2026-10-08'; // a Thursday
const url = (q: string) => {
  const p = new URLSearchParams(q);
  return (key: string) => p.get(key);
};
const params = (q: string) => parseCompareParams(url(q));

describe('the URL', () => {
  it('reads nothing as the board, a day against the same weekday last week', () => {
    const p = params('');
    assert.equal(p.view, 'board');
    assert.equal(p.period, 'day');
    assert.equal(p.vs, 'lastWeek');
    assert.equal(p.mode, 'periods');
    assert.equal(p.side, 'shop');
    assert.deepEqual(p.ids, []);
  });

  it('reads every filter back, and ignores what it does not know', () => {
    const p = params(
      'view=compare&period=month&date=2026-09-10&vs=lastYear&mode=side&side=machine&ids=a,b,a,c,d,e&junk=1',
    );
    assert.equal(p.view, 'compare');
    assert.equal(p.period, 'month');
    assert.equal(p.date, '2026-09-10');
    assert.equal(p.vs, 'lastYear');
    assert.equal(p.mode, 'side');
    assert.equal(p.side, 'machine');
    // Repeats dropped, four at most.
    assert.deepEqual(p.ids, ['a', 'b', 'c', 'd']);
    assert.equal(params('period=year&vs=moon&side=planet').period, 'day');
    assert.equal(params('period=week&vs=moon').vs, 'prev');
    assert.equal(params('side=planet').side, 'shop');
    assert.equal(params('date=2026-02-30').date, null);
  });

  it('a comparison that names nothing to compare with is none', () => {
    assert.equal(params('vs=custom').vs, 'none');
    assert.equal(params('vs=custom&vsFrom=2026-01-01').vs, 'custom');
    assert.equal(params('vs=event').vs, 'none');
    assert.equal(params('vs=event&vsEvent=e2').vsEvent, 'e2');
  });

  it('an event is compared with an event, days, or nothing', () => {
    assert.equal(params('event=e1').vs, 'none');
    assert.equal(params('event=e1&vs=lastWeek').vs, 'none');
    assert.equal(params('event=e1&vs=event&vsEvent=e2').vs, 'event');
    assert.equal(params('event=e1&vs=custom&vsFrom=2026-10-01&vsTo=2026-10-02').vs, 'custom');
    // An id that is not one is dropped.
    assert.equal(params('event=<script>').event, null);
  });

  it('writes only what differs from the defaults, and round-trips', () => {
    assert.deepEqual(compareQuery({ view: 'board', period: 'day', vs: 'lastWeek', mode: 'periods', side: 'shop', ids: [] }), {
      view: null, period: null, vs: null, mode: null, side: null, ids: null,
    });
    const chosen: Partial<CompareParams> = {
      view: 'compare', period: 'week', vs: 'lastYear', mode: 'side', side: 'cashier', ids: ['x', 'y'], date: '2026-10-01',
    };
    const q = compareQuery(chosen);
    assert.equal(q.vs, 'lastYear');
    assert.equal(q.ids, 'x,y');
    const back = parseCompareParams((k) => q[k] ?? null);
    assert.equal(back.period, 'week');
    assert.equal(back.vs, 'lastYear');
    assert.deepEqual(back.ids, ['x', 'y']);
    // The week's default comparison is the week before: not written.
    assert.equal(compareQuery({ period: 'week', vs: 'prev' }).vs, null);
    assert.equal(defaultVs('month'), 'prev');
  });
});

describe('periods', () => {
  it('a day, never past today', () => {
    assert.deepEqual(periodRange({ period: 'day', date: null, from: null, to: null }, TODAY), { from: TODAY, to: TODAY });
    assert.deepEqual(periodRange({ period: 'day', date: '2027-01-01', from: null, to: null }, TODAY), { from: TODAY, to: TODAY });
  });

  it('a week is Sunday to Saturday, a running one up to today', () => {
    assert.equal(weekStart(TODAY), '2026-10-04');
    assert.deepEqual(periodRange({ period: 'week', date: null, from: null, to: null }, TODAY), { from: '2026-10-04', to: TODAY });
    assert.deepEqual(periodRange({ period: 'week', date: '2026-09-30', from: null, to: null }, TODAY), {
      from: '2026-09-27', to: '2026-10-03',
    });
  });

  it('a month from its 1st, a running one up to today', () => {
    assert.deepEqual(periodRange({ period: 'month', date: null, from: null, to: null }, TODAY), { from: '2026-10-01', to: TODAY });
    assert.deepEqual(periodRange({ period: 'month', date: '2026-02-11', from: null, to: null }, TODAY), {
      from: '2026-02-01', to: '2026-02-28',
    });
  });

  it('a range in order, never past today, at most 366 days', () => {
    assert.deepEqual(periodRange({ period: 'range', date: null, from: '2026-10-05', to: '2026-10-01' }, TODAY), {
      from: '2026-10-01', to: '2026-10-05',
    });
    assert.deepEqual(periodRange({ period: 'range', date: null, from: '2026-10-05', to: '2026-12-01' }, TODAY), {
      from: '2026-10-05', to: TODAY,
    });
    const long = periodRange({ period: 'range', date: null, from: '2020-01-01', to: TODAY }, TODAY);
    assert.equal(rangeDays(long), 366);
    assert.deepEqual(periodRange({ period: 'range', date: null, from: null, to: null }, TODAY), { from: TODAY, to: TODAY });
    assert.deepEqual(orderedRange('2026-12-01', '2026-12-05', TODAY), { from: TODAY, to: TODAY });
  });

  it('the calendar helpers', () => {
    assert.equal(rangeDays({ from: '2026-03-01', to: '2026-03-31' }), 31);
    assert.equal(rangeDays({ from: '2026-10-08', to: '2026-10-08' }), 1);
    assert.equal(addYears('2028-02-29', -1), '2027-02-28');
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  });
});

describe('what a period is compared with', () => {
  const a = (period: CompareParams['period'], from: string, to: string) => ({ period, range: { from, to } });

  it('the day before, the same weekday last week, the same weekday last year', () => {
    const { range } = a('day', TODAY, TODAY);
    const vs = (v: CompareParams['vs']) => comparedRange({ period: 'day', vs: v, vsFrom: null, vsTo: null }, range, TODAY);
    assert.deepEqual(vs('prev'), { from: '2026-10-07', to: '2026-10-07' });
    assert.deepEqual(vs('lastWeek'), { from: '2026-10-01', to: '2026-10-01' });
    // 364 days back: a Thursday again.
    assert.deepEqual(vs('lastYear'), { from: '2025-10-09', to: '2025-10-09' });
    assert.equal(vs('none'), null);
    assert.equal(vs('event'), null);
  });

  it('a running week against the same days of the week before', () => {
    const range = { from: '2026-10-04', to: TODAY };
    assert.deepEqual(comparedRange({ period: 'week', vs: 'prev', vsFrom: null, vsTo: null }, range, TODAY), {
      from: '2026-09-27', to: '2026-10-01',
    });
  });

  it('a running month against the same days of the month before; a whole month against the whole one', () => {
    const running = { from: '2026-10-01', to: TODAY };
    assert.deepEqual(comparedRange({ period: 'month', vs: 'prev', vsFrom: null, vsTo: null }, running, TODAY), {
      from: '2026-09-01', to: '2026-09-08',
    });
    const march = { from: '2026-03-01', to: '2026-03-31' };
    assert.deepEqual(comparedRange({ period: 'month', vs: 'prev', vsFrom: null, vsTo: null }, march, TODAY), {
      from: '2026-02-01', to: '2026-02-28',
    });
    // 31 March running against February: held to February's end.
    assert.deepEqual(
      comparedRange({ period: 'month', vs: 'prev', vsFrom: null, vsTo: null }, { from: '2026-03-01', to: '2026-03-30' }, '2026-03-30'),
      { from: '2026-02-01', to: '2026-02-28' },
    );
    assert.deepEqual(comparedRange({ period: 'month', vs: 'lastYear', vsFrom: null, vsTo: null }, march, TODAY), {
      from: '2025-03-01', to: '2025-03-31',
    });
  });

  it('a range against the same length just before it, or the same dates last year', () => {
    const range = { from: '2026-10-01', to: '2026-10-05' };
    assert.deepEqual(comparedRange({ period: 'range', vs: 'prev', vsFrom: null, vsTo: null }, range, TODAY), {
      from: '2026-09-26', to: '2026-09-30',
    });
    assert.deepEqual(comparedRange({ period: 'range', vs: 'lastYear', vsFrom: null, vsTo: null }, range, TODAY), {
      from: '2025-10-01', to: '2025-10-05',
    });
  });

  it('any range, in order', () => {
    assert.deepEqual(
      comparedRange({ period: 'day', vs: 'custom', vsFrom: '2026-09-10', vsTo: '2026-09-01' }, { from: TODAY, to: TODAY }, TODAY),
      { from: '2026-09-01', to: '2026-09-10' },
    );
    assert.deepEqual(
      comparedRange({ period: 'day', vs: 'custom', vsFrom: '2026-09-10', vsTo: null }, { from: TODAY, to: TODAY }, TODAY),
      { from: '2026-09-10', to: '2026-09-10' },
    );
    assert.equal(comparedRange({ period: 'day', vs: 'custom', vsFrom: null, vsTo: null }, { from: TODAY, to: TODAY }, TODAY), null);
  });

  it('the arrows step a whole period', () => {
    assert.equal(stepAnchor({ period: 'day' }, { from: TODAY, to: TODAY }, -1), '2026-10-07');
    assert.equal(stepAnchor({ period: 'week' }, { from: '2026-10-04', to: TODAY }, -1), '2026-09-27');
    assert.equal(stepAnchor({ period: 'month' }, { from: '2026-10-01', to: TODAY }, -1), '2026-09-01');
    assert.equal(stepAnchor({ period: 'range' }, { from: '2026-10-01', to: '2026-10-05' }, -1), '2026-09-26');
  });
});

describe('change', () => {
  it('a number and a percent', () => {
    assert.deepEqual(delta(150, 100), { abs: 50, pct: 50 });
    assert.deepEqual(delta(80, 100), { abs: -20, pct: -20 });
    assert.deepEqual(delta(0.3, 0.1), { abs: 0.2, pct: 200 });
  });

  it('never divides by zero: from nothing is "new", nothing to nothing is no change', () => {
    assert.deepEqual(delta(25, 0), { abs: 25, pct: null });
    assert.deepEqual(delta(0, 0), { abs: 0, pct: 0 });
    assert.deepEqual(delta(0, 40), { abs: -40, pct: -100 });
    assert.ok(Number.isFinite(delta(1e-9, 0).abs));
  });

  it('the percent as text, "new" left to the words', () => {
    assert.equal(pctText(12.345), '+12.3%');
    assert.equal(pctText(-3), '−3.0%');
    assert.equal(pctText(0.01), '0%');
    assert.equal(pctText(null), null);
  });
});

describe('curves', () => {
  const s = (index: number, current: number | null, previous: number | null) => ({
    index, label: `${String(index).padStart(2, '0')}:00`, current, previous,
  });

  it('running totals, the line stopping where a period has no bucket', () => {
    const pts = curvePoints([s(0, 10, 5), s(1, 20, null), s(2, null, 7)], false);
    assert.deepEqual(pts.map((p) => [p.ca, p.cb]), [[10, 5], [30, null], [null, 12]]);
  });

  it('trims the quiet hours at both ends, keeps the ones between', () => {
    const pts = curvePoints([s(0, 0, 0), s(8, 0, 4), s(9, 0, 0), s(10, 15, 0), s(11, 0, 0), s(12, null, 0)], true);
    assert.deepEqual(pts.map((p) => p.index), [8, 9, 10]);
    assert.equal(peakIndex(pts), 10);
    assert.deepEqual(curvePoints([s(0, 0, 0)], true), []);
    assert.equal(peakIndex([]), null);
  });
});

describe('side by side', () => {
  it('two to four; a fifth replaces the oldest; a second tap drops', () => {
    assert.deepEqual(toggleSideId([], 'a'), ['a']);
    assert.deepEqual(toggleSideId(['a', 'b', 'c', 'd'], 'e'), ['b', 'c', 'd', 'e']);
    assert.deepEqual(toggleSideId(['a', 'b'], 'a'), ['b']);
    assert.equal(sideReady(['a']), false);
    assert.equal(sideReady(['a', 'b']), true);
    assert.equal(sideReady(['a', 'b', 'c', 'd', 'e']), false);
  });

  it('shares add up and never divide by zero', () => {
    assert.deepEqual(shares([30, 10]), [75, 25]);
    assert.deepEqual(shares([0, 0]), [0, 0]);
    assert.deepEqual(shares([-5, 5]), [0, 100]);
  });
});

const ZERO: FiguresLike = {
  sales: 0, gross: 0, discounts: 0, refunds: 0, documents: 0, salesCount: 0, refundsCount: 0,
  averageTicket: 0, items: 0, cash: 0, card: 0, other: 0, tips: 0,
};
const WORDS: ExportWords = {
  summary: 'סיכום', curve: 'גרף', items: 'פריטים', vouchers: 'שוברים', figure: 'נתון', change: 'שינוי',
  changePct: 'שינוי %', bucket: 'זמן', item: 'פריט', sku: 'מק״ט', qty: 'יח׳', net: 'נטו', total: 'סה״כ',
  voucher: 'שובר', voucherCount: 'שוברים', units: 'יחידות', value: 'שווי',
  figures: {
    sales: 'מכירות', gross: 'ברוטו', discounts: 'הנחות', refunds: 'החזרות', documents: 'מסמכים',
    salesCount: 'עסקאות', refundsCount: 'זיכויים', averageTicket: 'ממוצע', items: 'פריטים', cash: 'מזומן',
    card: 'אשראי', other: 'אחר', tips: 'טיפים',
  },
};

describe('exports', () => {
  it('the comparison: each figure with its change, the curve with totals, the items, the vouchers', () => {
    const sheets = comparisonSheets(
      {
        title: 'השוואות', labelA: 'היום', labelB: 'שבוע שעבר',
        current: { ...ZERO, sales: 150, documents: 3 },
        previous: { ...ZERO, sales: 100 },
        series: curvePoints([{ index: 0, label: '08:00', current: 50, previous: 0 }, { index: 1, label: '09:00', current: 100, previous: 100 }], false),
        items: [{ name: 'קפה', qty: 3, net: 30, previousQty: 0, previousNet: 0 }],
        vouchers: [{ name: 'צוות', current: { vouchers: 2, units: 3, value: 0 }, previous: { vouchers: 1, units: 1, value: 0 } }],
      },
      WORDS,
    );
    assert.deepEqual(sheets.map((x) => x.name), ['סיכום', 'גרף', 'פריטים', 'שוברים']);
    assert.deepEqual(sheets[0].rows[0], ['מכירות', 150, 100, 50, 50]);
    // Documents from nothing: "new" — an empty cell, never Infinity.
    assert.deepEqual(sheets[0].rows[1], ['מסמכים', 3, 0, 3, null]);
    assert.deepEqual(sheets[1].rows[0], ['08:00', 50, 0, 50, null]);
    assert.deepEqual(sheets[1].totals, ['סה״כ', 150, 100, 50, 50]);
    assert.deepEqual(sheets[2].rows[0], ['קפה', null, 3, 0, 30, 0, null]);
    assert.deepEqual(sheets[3].rows[0], ['צוות', 2, 1, 3, 0, 100]);
  });

  it('without a comparison, only the period', () => {
    const sheets = comparisonSheets(
      { title: 't', labelA: 'היום', labelB: null, current: { ...ZERO, sales: 5 }, previous: null, series: [], items: [] },
      WORDS,
    );
    assert.equal(sheets.length, 3);
    assert.equal(sheets[0].columns.length, 2);
    assert.deepEqual(sheets[0].rows[0], ['מכירות', 5]);
  });

  it('side by side: one column per entity', () => {
    const [summary, curve] = sideBySideSheets(
      {
        title: 'זה מול זה', period: 'היום', buckets: ['08:00', '09:00'],
        entities: [
          { name: 'קופה 1', figures: { ...ZERO, sales: 10 }, series: [4, 6] },
          { name: 'קופה 2', figures: { ...ZERO, sales: 20 }, series: [null, 20] },
        ],
      },
      WORDS,
    );
    assert.deepEqual(summary.columns.map((c) => c.header), ['נתון', 'קופה 1', 'קופה 2']);
    assert.deepEqual(summary.rows[0], ['מכירות', 10, 20]);
    assert.deepEqual(curve.rows[0], ['08:00', 4, null]);
    assert.deepEqual(curve.totals, ['סה״כ', 10, 20]);
  });
});

describe("the board's own shapes", () => {
  it('a comparison figure set reads as the board cards', () => {
    const f = toSalesFigures({ ...ZERO, sales: 9, documents: 3, salesCount: 2, refundsCount: 1, cash: 9 });
    assert.equal(f.salesToday, 9);
    assert.equal(f.documentsToday, 3);
    assert.equal(f.cash, 9);
    const [p] = toHourPoints(curvePoints([{ index: 2, label: '20:00', current: 5, previous: 1 }], false));
    assert.deepEqual(p, { hour: 2, label: '20:00', a: 5, b: 1, ca: 5, cb: 1 });
  });
});
