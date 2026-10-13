/**
 * The report framework's pure logic (P:\specs\reports-upgrade.md §2): the URL round trip of
 * the filters, the column order and visibility, the export column priority, sorting, the
 * export header lines and file names, and cutting a sheet / a PDF to the chosen columns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeReportFilters,
  clearedReportFilters,
  matchesSearch,
  parseReportFilters,
  reportApiParams,
  scopeApiParams,
  writeReportFilters,
  type ReportFilterSpec,
} from './reportFilters';
import {
  fromServerPrefs,
  groupRuns,
  moveColumn,
  nextSort,
  orderedColumnKeys,
  parseColumnPrefs,
  qualifiedExportList,
  resolveExportColumns,
  sortRows,
  toServerPrefs,
  toggleColumn,
  unqualify,
  visibleColumnKeys,
} from './reportColumns';
import {
  exportTablePdfBody,
  exportTableSheet,
  fileRange,
  pdfOrientation,
  readableFileName,
  reportFileName,
  reportHeaderLines,
  type ExportTable,
} from './reportExport';
import { selectSheetColumns, sheetHeading, type ExcelSheet } from './excelExport';
import { listOf, listValue, transactionsQuery, txExtrasOf } from './transactionsFilters';
import {
  listSheetCells,
  paymentColumnKey,
  sumMoney,
  transactionExportColumns,
  zTableColumns,
  zTillColumns,
} from './listExportColumns';
import { transactionsSheet, zTableSheets } from './reportSheets';
import type { TransactionExportRow, ZTable } from './reportCenterTypes';
import {
  cashVarianceTotals,
  isUuid,
  offlineDeclinedRows,
  promotionChoices,
  sequenceGapRows,
  sequenceGapText,
  varianceTone,
} from './auditReports';

const TODAY = '2026-10-13';
const SPEC: ReportFilterSpec = {
  filters: ['hours', 'area', 'cashier', 'search'],
  clientFilters: ['search'],
  extras: { limit: '200', meals: 'components' },
};

describe('report filters in the URL', () => {
  it('a fresh visit is not applied and holds the defaults (last 7 days, whole day)', () => {
    const p = parseReportFilters(new URLSearchParams(''), SPEC, TODAY);
    assert.equal(p.applied, false);
    assert.equal(p.values.from, '2026-10-07');
    assert.equal(p.values.to, TODAY);
    assert.deepEqual([p.values.fromHour, p.values.toHour], [0, 24]);
    assert.deepEqual(p.extras, { limit: '200', meals: 'components' });
  });

  it('round-trips every filter and keeps the scope and the page’s own params', () => {
    const start = new URLSearchParams('shop=s1&machine=m1&shiftId=x');
    const values = {
      ...parseReportFilters(start, SPEC, TODAY).values,
      from: '2026-10-01',
      to: '2026-10-13',
      fromHour: 18,
      toHour: 2,
      areaId: 'none',
      cashierId: 'c-1',
      q: 'קפה',
    };
    const url = writeReportFilters(start, values, { limit: '500', meals: 'components' }, SPEC);
    assert.equal(url.get('shop'), 's1');
    assert.equal(url.get('machine'), 'm1');
    assert.equal(url.get('shiftId'), 'x');
    assert.equal(url.get('limit'), '500');
    assert.equal(url.has('meals'), false, 'a default extra stays out of the URL');
    const back = parseReportFilters(new URLSearchParams(url.toString()), SPEC, TODAY);
    assert.equal(back.applied, true);
    assert.deepEqual(back.values, values);
    assert.equal(back.extras.limit, '500');
  });

  it('writes only what narrows: no hours for the whole day, no empty filters', () => {
    const p = parseReportFilters(new URLSearchParams(''), SPEC, TODAY);
    const url = writeReportFilters(new URLSearchParams('area=a1&method=cash'), p.values, p.extras, SPEC);
    assert.deepEqual([...url.keys()].sort(), ['from', 'to']);
  });

  it('ignores filters the report does not offer, and nonsense', () => {
    const p = parseReportFilters(
      new URLSearchParams('from=2026-10-01&to=bad&method=cash&fromHour=5&toHour=5&docType=abc'),
      { filters: ['hours', 'docType'] },
      TODAY,
    );
    assert.equal(p.applied, false, 'a broken day is no range');
    assert.equal(p.values.method, '');
    assert.deepEqual([p.values.fromHour, p.values.toHour], [0, 24], 'the same hour twice is no band');
    assert.equal(p.values.docType, '');
  });

  it('"נקה הכל" is the defaults, still applied', () => {
    const c = clearedReportFilters(SPEC, TODAY);
    assert.equal(c.applied, true);
    assert.deepEqual(activeReportFilters(c.values, SPEC), []);
  });

  it('counts the active filters', () => {
    const v = { ...clearedReportFilters(SPEC, TODAY).values, fromHour: 6, toHour: 12, cashierId: 'c' };
    assert.deepEqual(activeReportFilters(v, SPEC), ['hours', 'cashier']);
  });

  it('sends the server filters under the API names, never the client ones', () => {
    const v = { ...clearedReportFilters(SPEC, TODAY).values, fromHour: 22, toHour: 2, areaId: 'a1', cashierId: 'c1', q: 'x' };
    assert.deepEqual(reportApiParams(v, SPEC), {
      from: '2026-10-07',
      to: TODAY,
      fromHour: 22,
      toHour: 2,
      areaId: 'a1',
      cashierId: 'c1',
    });
  });

  it('search: every word, anywhere, without niqqud or geresh', () => {
    assert.equal(matchesSearch(['קפה שחור', 'SKU-12'], 'שחור קפה'), true);
    assert.equal(matchesSearch(['צ׳יפס'], 'ציפס'), true);
    assert.equal(matchesSearch(['קפה'], 'תה'), false);
    assert.equal(matchesSearch([null, 12], ''), true);
  });
});

const COLS = [{ key: 'name', required: true }, { key: 'a' }, { key: 'b' }, { key: 'c', defaultHidden: true }];

describe('report columns', () => {
  it('no saved choice: the report’s order, its default-hidden column hidden', () => {
    assert.deepEqual(visibleColumnKeys(COLS, null), ['name', 'a', 'b']);
  });

  it('a saved order wins; a new column lands beside its neighbour; a gone column is ignored', () => {
    // `a` follows `name` in the report, `c` follows `b`: each lands after its neighbour.
    const prefs = { order: ['b', 'name', 'gone'], hidden: [] };
    assert.deepEqual(orderedColumnKeys(COLS, prefs), ['b', 'c', 'name', 'a']);
  });

  it('hide and show; a required column cannot be hidden', () => {
    let prefs = toggleColumn(COLS, null, 'a', false);
    assert.deepEqual(visibleColumnKeys(COLS, prefs), ['name', 'b']);
    prefs = toggleColumn(COLS, prefs, 'name', false);
    assert.deepEqual(visibleColumnKeys(COLS, prefs), ['name', 'b']);
    prefs = toggleColumn(COLS, prefs, 'c', true);
    assert.deepEqual(visibleColumnKeys(COLS, prefs), ['name', 'b', 'c']);
  });

  it('a drag moves one column', () => {
    const prefs = moveColumn(COLS, null, 'b', 0);
    assert.deepEqual(prefs.order, ['b', 'name', 'a', 'c']);
    assert.deepEqual(prefs.hidden, ['c']);
  });

  it('reads back only well-formed choices', () => {
    assert.equal(parseColumnPrefs(null), null);
    assert.equal(parseColumnPrefs({ order: 'x', hidden: [] }), null);
    assert.deepEqual(parseColumnPrefs({ order: ['a', 3], hidden: [] }), { order: ['a'], hidden: [] });
  });

  it('the server keeps {visible, order}; hidden is the order minus the visible', () => {
    const prefs = { order: ['name', 'a', 'b'], hidden: ['a'] };
    assert.deepEqual(toServerPrefs(prefs), { order: ['name', 'a', 'b'], visible: ['name', 'b'] });
    assert.deepEqual(fromServerPrefs(toServerPrefs(prefs)), prefs);
    assert.equal(fromServerPrefs({ visible: [] }), null);
  });
});

describe('export columns: this export → company → visible → all', () => {
  const table = { tableId: 'main', keys: ['name', 'a', 'b', 'c'], visible: ['b', 'name'] };

  it('the choice for this export first', () => {
    assert.deepEqual(resolveExportColumns(table, { current: ['a', 'name'], company: ['c'] }), {
      keys: ['a', 'name'],
      source: 'current',
    });
  });

  it('then the company default (unknown keys dropped)', () => {
    assert.deepEqual(resolveExportColumns(table, { company: ['zzz', 'c', 'a'] }), { keys: ['c', 'a'], source: 'company' });
  });

  it('then what the user sees, then everything', () => {
    assert.deepEqual(resolveExportColumns(table, { company: ['zzz'] }), { keys: ['b', 'name'], source: 'visible' });
    assert.deepEqual(resolveExportColumns({ ...table, visible: null }, {}), { keys: ['name', 'a', 'b', 'c'], source: 'all' });
  });

  it('keys are qualified per table; another table’s keys do not count', () => {
    assert.equal(unqualify('main', 'amount'), 'amount');
    assert.equal(unqualify('main', 'methods.amount'), null);
    assert.equal(unqualify('methods', 'methods.amount'), 'amount');
    const methods = { tableId: 'methods', keys: ['method', 'amount'], visible: ['method', 'amount'] };
    assert.deepEqual(resolveExportColumns(methods, { company: ['net', 'methods.amount'] }), {
      keys: ['amount'],
      source: 'company',
    });
    assert.deepEqual(
      qualifiedExportList([
        { tableId: 'main', keys: ['net'] },
        { tableId: 'methods', keys: ['amount'] },
      ]),
      ['net', 'methods.amount'],
    );
  });
});

describe('sorting', () => {
  const rows = [
    { n: 'בננה', v: '10.50' },
    { n: 'אגס', v: 2 },
    { n: 'גזר', v: null },
    { n: 'דלעת', v: 10.5 },
  ];
  it('numbers as numbers (decimal strings too), stable, empty last both ways', () => {
    assert.deepEqual(sortRows(rows, (r) => r.v, 'asc').map((r) => r.n), ['אגס', 'בננה', 'דלעת', 'גזר']);
    assert.deepEqual(sortRows(rows, (r) => r.v, 'desc').map((r) => r.n), ['בננה', 'דלעת', 'אגס', 'גזר']);
  });
  it('text in Hebrew order', () => {
    assert.deepEqual(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n), ['אגס', 'בננה', 'גזר', 'דלעת']);
  });
  it('a header click cycles: first direction → the other → the report’s order', () => {
    const a = nextSort(null, 'net', 'desc');
    assert.deepEqual(a, { key: 'net', dir: 'desc' });
    const b = nextSort(a, 'net', 'desc');
    assert.deepEqual(b, { key: 'net', dir: 'asc' });
    assert.equal(nextSort(b, 'net', 'desc'), null);
    assert.deepEqual(nextSort(b, 'name'), { key: 'name', dir: 'asc' });
  });
});

const WORDS = {
  range: (r: string) => `תקופה: ${r}`,
  hours: (b: string) => `שעות: ${b} בכל יום`,
  filters: (l: string) => `סינון: ${l}`,
  generatedAt: (at: string) => `הופק: ${at}`,
  formatDateTime: () => '13/10/2026 14:05',
};

describe('export header lines and file names', () => {
  it('title · business and place · range · hours · filters · generated at', () => {
    assert.deepEqual(
      reportHeaderLines(
        {
          title: 'מכירות לפי מוצר',
          business: 'רויאל בר',
          place: 'סניף 2',
          from: '2026-10-01',
          to: '2026-10-13',
          hours: '18:00–22:00',
          filters: [
            { label: 'קופאי', value: 'דנה' },
            { label: 'אזור', value: '' },
          ],
          generatedAt: '2026-10-13T11:05:00Z',
        },
        WORDS,
      ),
      [
        'מכירות לפי מוצר',
        'רויאל בר · סניף 2',
        'תקופה: 01/10/2026 – 13/10/2026',
        'שעות: 18:00–22:00 בכל יום',
        'סינון: קופאי: דנה',
        'הופק: 13/10/2026 14:05',
      ],
    );
  });

  it('drops what is not there', () => {
    assert.deepEqual(reportHeaderLines({ title: 'דוח', generatedAt: 'x' }, WORDS), ['דוח', 'הופק: 13/10/2026 14:05']);
  });

  it('a clear Hebrew file name', () => {
    assert.equal(reportFileName('מכירות לפי מוצר', 'סניף X', '2026-10-01', '2026-10-13'), 'מכירות לפי מוצר — סניף X — 01.10–13.10');
    assert.equal(fileRange('2025-12-28', '2026-01-03'), '28.12.2025–03.01.2026');
    assert.equal(fileRange('2026-10-13', '2026-10-13'), '13.10.2026');
    assert.equal(reportFileName('דוח', '', null, null), 'דוח');
    assert.equal(readableFileName('a/b: "c"?'), 'a-b- -c-');
  });

  it('portrait up to 7 columns, landscape beyond, unless chosen', () => {
    assert.equal(pdfOrientation(7), 'portrait');
    assert.equal(pdfOrientation(8), 'landscape');
    assert.equal(pdfOrientation(20, 'portrait'), 'portrait');
  });
});

describe('a sheet cut to the export columns', () => {
  const sheet: ExcelSheet = {
    name: 'מוצרים',
    columns: [
      { key: 'name', header: 'מוצר' },
      { key: 'units', header: 'יחידות', kind: 'number' },
      { key: 'net', header: 'נטו', kind: 'money' },
    ],
    rows: [
      ['קפה', 3, 30],
      ['תה', 1, 8],
    ],
    totals: ['סה״כ', 4, 38],
  };

  it('keeps the chosen columns in the chosen order, rows and totals with them', () => {
    const cut = selectSheetColumns(sheet, ['net', 'name']);
    assert.deepEqual(cut.columns.map((c) => c.key), ['net', 'name']);
    assert.deepEqual(cut.rows, [
      [30, 'קפה'],
      [8, 'תה'],
    ]);
    assert.deepEqual(cut.totals, [38, 'סה״כ']);
  });

  it('the totals label survives losing its column', () => {
    const cut = selectSheetColumns(sheet, ['units', 'net']);
    // No text column left to hold it: the numbers stay numbers.
    assert.deepEqual(cut.totals, [4, 38]);
    const withText = selectSheetColumns(
      { ...sheet, columns: [...sheet.columns, { key: 'sku', header: 'מק״ט' }], rows: [], totals: ['סה״כ', 4, 38, null] },
      ['units', 'sku'],
    );
    assert.deepEqual(withText.totals, [4, 'סה״כ']);
  });

  it('no choice, or an unkeyed sheet: unchanged', () => {
    assert.equal(selectSheetColumns(sheet, null), sheet);
    const legacy = { ...sheet, columns: sheet.columns.map(({ header, kind }) => ({ header, kind })) };
    assert.equal(selectSheetColumns(legacy, ['net']), legacy);
  });

  it('every sheet gets the report’s header lines, then its own', () => {
    assert.deepEqual(sheetHeading({ ...sheet, heading: ['פירוט'] }, { heading: ['דוח', 'הופק'] }), ['דוח', 'הופק', 'פירוט']);
    assert.deepEqual(sheetHeading(sheet), []);
  });
});

describe('PDF body (§4.5)', () => {
  const table: ExportTable = {
    tableId: 'main',
    name: 'ימים',
    columns: [
      { key: 'day', header: 'יום', kind: 'date' },
      { key: 'at', header: 'נפתחה', kind: 'datetime' },
      { key: 'net', header: 'נטו', kind: 'money' },
    ],
    rows: [['2026-10-01', '2026-10-01T05:00:00Z', 12.5]],
    totals: ['סה״כ', null, 12.5],
  };
  it('columns with labels and kinds, rows in column order, totals by key', () => {
    const body = exportTablePdfBody(table, ['net', 'day'], {
      title: 'דוח',
      subtitleLines: ['עסק'],
      filterLines: [],
      fileName: 'דוח — 01.10',
    });
    assert.deepEqual(body.columns, [
      { key: 'net', label: 'נטו', kind: 'money' },
      { key: 'day', label: 'יום', kind: 'date' },
    ]);
    assert.deepEqual(body.rows, [[12.5, '2026-10-01']]);
    assert.deepEqual(body.totals, { net: 12.5, day: 'סה״כ' });
    assert.equal(body.orientation, 'portrait');
    assert.equal('companyId' in body, false);
  });
  it('a datetime goes as a date kind (the server writes the time)', () => {
    const body = exportTablePdfBody(table, null, { title: 't', subtitleLines: [], filterLines: [], fileName: 'f' });
    assert.equal(body.columns[1].kind, 'date');
    assert.equal(exportTableSheet(table, null).columns.length, 3);
  });
});

describe('the scope as report params', () => {
  it('shop and till as they are; the company only when nothing narrower', () => {
    assert.deepEqual(scopeApiParams({ companyId: 'c', shopId: 's', machineId: 'm' }), { shopId: 's', machineId: 'm' });
    assert.deepEqual(scopeApiParams({ companyId: 'c', shopId: null, machineId: null }), { companyId: 'c' });
    assert.deepEqual(scopeApiParams({ companyId: 'c' }, false), {});
    assert.deepEqual(scopeApiParams({}), {});
  });
});

describe('rows in runs of one group (a list by day)', () => {
  it('a heading wherever the group changes, carrying the run’s rows', () => {
    const rows = [
      { id: 1, day: '2026-10-13' },
      { id: 2, day: '2026-10-13' },
      { id: 3, day: '2026-10-12' },
      { id: 4, day: '2026-10-13' },
    ];
    const runs = groupRuns(rows, (r) => r.day);
    assert.deepEqual(
      runs.map((r) => (r ? [r.group, r.rows.map((x) => x.id)] : null)),
      [['2026-10-13', [1, 2]], null, ['2026-10-12', [3]], ['2026-10-13', [4]]],
    );
    assert.deepEqual(groupRuns([], (r: { day: string }) => r.day), []);
  });
});

describe('the transactions list: its own filters in the URL → the query', () => {
  it('lists are comma-separated in the URL, de-duplicated, empty parts dropped', () => {
    assert.deepEqual(listOf(' a,b,,c '), ['a', 'b', 'c']);
    assert.deepEqual(listOf(''), []);
    assert.equal(listValue(['b', 'a', 'b', ' ']), 'b,a');
  });

  it('a first visit: no days, the newest documents of every day', () => {
    const q = transactionsQuery({ extras: txExtrasOf({}), shopId: 's' });
    assert.deepEqual(q, { shopId: 's' });
  });

  it('every filter under the endpoint name; lists as lists', () => {
    const q = transactionsQuery({
      from: '2026-10-01',
      to: '2026-10-13',
      q: ' 20000057 ',
      shopId: 's',
      extras: txExtrasOf({
        card: '1234', item: 'קפה', method: 'card', tills: 'm1,m2', types: '320,-400', employees: 'e1',
        statuses: 'completed,refunded', amountMin: '10', amountMax: '99.5', doc: '2-57', basket: '0f8fad5b-d9cb-469f-a165-70867728950e',
      }),
    });
    assert.deepEqual(q, {
      shopId: 's', from: '2026-10-01', to: '2026-10-13', q: '20000057', cardLast4: '1234', item: 'קפה', method: 'card',
      machineIds: ['m1', 'm2'], documentTypes: ['320', '-400'], cashierIds: ['e1'], statuses: ['completed', 'refunded'],
      amountMin: '10', amountMax: '99.5', documentNumber: '2-57', basketId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    });
  });

  it('the scope till wins over a list of tills; "failed" and nonsense never go out', () => {
    const q = transactionsQuery({
      machineId: 'm9',
      extras: txExtrasOf({ tills: 'm1', method: 'failed', card: '12', types: 'abc', statuses: 'gone', amountMin: '1e3', doc: 'x' }),
    });
    assert.deepEqual(q, { machineId: 'm9' });
  });
});

describe('the lists server exports as report columns (same cells and totals as their sheets)', () => {
  const t = (k: string) => k;
  const row = (over: Partial<TransactionExportRow>): TransactionExportRow => ({
    id: 'a', createdAt: '2026-10-06T10:00:00Z', documentNumber: '20000057', documentType: 320, status: 'completed',
    shopName: 'הרצליה', machineId: 'm', machineName: 'קופה 1', posNumber: '1', cashierId: 'c', cashierName: 'דנה',
    paymentMethod: 'cash', totalAmount: '117.00', documentDiscount: '0.00', collected: '117.00', signedAmount: '117.00',
    vatAmount: '17.85', netOfVat: '99.15', vatRate: '18.00', tipAmount: '5.00', tipPaymentMethod: 'card', cash: '112.00',
    card: '0.00', other: '0.00', exchange: '0.00', productionVoucher: '5.00', legs: 2, cardBrands: ['visa'], cardLast4: [],
    approvalNumbers: [], refundOf: null, shiftNumber: 1, zNumber: null, customerName: null, customerVatNumber: null,
    mealKind: null, ...over,
  });
  const labels = { documentType: (n: number | null) => `type:${n}`, status: (s: string) => s, method: (m: string) => `pm:${m}` };

  it('transactions: every column of the sheet, plus the tender of the tip', () => {
    const rows = [row({}), row({ tipAmount: '0.00', tipPaymentMethod: null, totalAmount: '-20.00', signedAmount: '-20.00' })];
    const cols = transactionExportColumns(t, labels);
    const legacy = transactionsSheet(rows, t, 'x', labels);
    const at = cols.findIndex((c) => c.key === 'tipMethod');
    const without = cols.filter((c) => c.key !== 'tipMethod');
    const cells = listSheetCells(without, rows, 'total');
    assert.deepEqual(without.map((c) => c.header), legacy.columns.map((c) => c.header));
    assert.deepEqual(cells.rows, legacy.rows);
    assert.deepEqual(cells.totals, legacy.totals);
    const all = listSheetCells(cols, rows, 'total');
    assert.deepEqual(all.rows.map((r) => r[at]), ['pm:card', null]);
    assert.equal(new Set(cols.map((c) => c.key)).size, cols.length);
  });

  it('the Z table: a keyed column per payment method, every money column totalled', () => {
    const table: ZTable = {
      window: { from: '2026-10-01', to: '2026-10-07', dateBasis: 'business', timezone: 'Asia/Jerusalem' },
      total: 1,
      paymentMethods: ['cash', 'card'],
      zs: [
        {
          id: 'a', zNumber: 7, zType: 'shop', zTypeLabel: 'Z סניפי', origin: 'cloud', shopName: 'הרצליה', machineName: null,
          posNumber: null, tills: 'קופה 1', businessDate: '2026-10-06', productionDate: null, openedAt: null, periodEnd: null,
          closedAt: null, invoiceRange: null, creditNoteRange: null, receiptRange: null, invoiceCount: 9, creditNoteDocuments: 0,
          receiptCount: 0, transactionsCount: 9, salesCount: 9, creditNotesCount: 0, nonSaleDocumentsCount: 0, shiftCount: 2,
          machineCount: 2, grossSales: '100.00', discountsTotal: '0.00', lineDiscountsTotal: null, promotionDiscountsTotal: null,
          totalSales: '100.00', totalRefunds: '0.00', netSales: '100.00', vatTotal: '14.53', netOfVat: '85.47', cashSales: '60.00',
          cardSales: '40.00', payments: { cash: '60.00', card: '40.00' }, totalTips: '3.00', cashTips: '1.00', cardTips: '2.00',
          expectedCash: null, actualCash: null, discrepancy: null, lateDocuments: 0, amendedDocuments: 1, totalsMismatch: true,
          builtOffline: false,
          transmission: {
            batchCount: 1, successfulBatches: 1, failedBatches: 0, batchNumbers: ['777'], batchesAmount: '40.00', cardLegs: 1,
            transmittedLegs: 1, untransmittedLegs: 0, untransmittedAmount: '0.00',
          },
        },
      ],
      tills: [],
    };
    const [zs, tills] = zTableSheets(table, t, (m) => `pm:${m}`);
    const zc = zTableColumns(t, (m) => `pm:${m}`, table.paymentMethods);
    const cells = listSheetCells(zc, table.zs, 'total');
    assert.deepEqual(zc.map((c) => c.header), zs.columns.map((c) => c.header));
    assert.deepEqual(cells.rows, zs.rows);
    assert.deepEqual(cells.totals, zs.totals);
    assert.ok(zc.some((c) => c.key === paymentColumnKey('card')));
    assert.deepEqual(zTillColumns(t, (m) => `pm:${m}`, table.paymentMethods).map((c) => c.header), tills.columns.map((c) => c.header));
  });

  it('money sums to the agora, decimal strings and empty cells alike', () => {
    assert.equal(sumMoney(['0.10', '0.20', null, '', 0.3]), 0.6);
  });
});

describe('control reports: cash variance, sequence, offline runs, promotions', () => {
  it('a cash difference: over is green with a plus, short red, zero plain', () => {
    assert.equal(varianceTone(12.5), 'over');
    assert.equal(varianceTone(-0.1), 'short');
    assert.equal(varianceTone(0), 'even');
  });

  it('the per-cashier totals: every shift, the counted ones, Σ over / short to the agora, the net', () => {
    const tot = cashVarianceTotals(
      [
        { over: 0.1, short: 0 },
        { over: 0.2, short: 5.05 },
        { over: 0, short: 0 },
      ],
      7,
      2,
      -4.75,
    );
    assert.deepEqual(tot, { shifts: 7, counted: 5, over: 0.3, short: 5.05, net: -4.75 });
    assert.deepEqual(cashVarianceTotals([], 0, 0, 0), { shifts: 0, counted: 0, over: 0, short: 0, net: 0 });
  });

  it('a gap is one number or a run; every gap is its own sheet row', () => {
    assert.equal(sequenceGapText({ fromNumber: 1043, toNumber: 1043 }), '1043');
    assert.equal(sequenceGapText({ fromNumber: 1043, toNumber: 1047 }), '1043–1047');
    const rows = sequenceGapRows([
      {
        machineId: 'm1',
        machineName: 'קופה 1',
        documentType: 320,
        gaps: [
          { fromNumber: 5, toNumber: 5, missing: 1 },
          { fromNumber: 9, toNumber: 11, missing: 3 },
        ],
      },
      { machineId: 'm2', shopName: 'מרכז', documentType: null, gaps: [] },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.key, r.machineName, r.shopName, r.documentType, r.fromNumber, r.toNumber, r.missing]),
      [
        ['m1:320:5', 'קופה 1', null, 320, 5, 5, 1],
        ['m1:320:9', 'קופה 1', null, 320, 9, 11, 3],
      ],
    );
  });

  it('each declined uid of each run, with its run, in the runs’ order', () => {
    const runs = [
      { id: 'a', declined: [{ uid: 'x' }, { uid: 'y' }] },
      { id: 'b', declined: [] },
      { id: 'c', declined: [{ uid: 'z' }] },
    ];
    const rows = offlineDeclinedRows<{ uid: string }, (typeof runs)[number]>(runs);
    assert.deepEqual(
      rows.map((r) => [r.key, r.run.id, r.leg.uid]),
      [
        ['a:0', 'a', 'x'],
        ['a:1', 'a', 'y'],
        ['c:0', 'c', 'z'],
      ],
    );
  });

  it('the promotion filter: the tenant’s promotions and the report’s deleted ones, one per id, by name', () => {
    const choices = promotionChoices(
      [
        { id: 'p2', name: 'ב — שני' },
        { id: 'p1', name: 'א — ראשון' },
      ],
      [
        { promotionId: 'p1', name: 'שם ישן' },
        { promotionId: 'gone', name: 'ג — נמחק' },
        { promotionId: null, name: null },
      ],
    );
    assert.deepEqual(choices, [
      { id: 'p1', name: 'א — ראשון' },
      { id: 'p2', name: 'ב — שני' },
      { id: 'gone', name: 'ג — נמחק' },
    ]);
  });

  it('only a uuid goes to the server as an id', () => {
    assert.equal(isUuid('3f2b8c1e-9d4a-4f6b-8e2a-1c5d7e9f0a3b'), true);
    assert.equal(isUuid('3F2B8C1E-9D4A-4F6B-8E2A-1C5D7E9F0A3B'), true);
    assert.equal(isUuid('not-a-uuid'), false);
    assert.equal(isUuid(''), false);
    assert.equal(isUuid(null), false);
  });
});
