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
  companyDefaultColumns,
  fromServerPrefs,
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
import { ACCOUNTING_EXPORT_EXTRAS, parseAccountingExportForm } from './accountingExportForm';
import { taxOpenFormatExtras, taxOpenFormatMode, taxOpenFormatParams } from './taxOpenFormatForm';

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

  it('a status colour stays with its row when the columns are cut', () => {
    const table: ExportTable = {
      tableId: 'main',
      name: 'התאמה',
      columns: sheet.columns.map((c) => ({ key: c.key!, header: c.header, kind: c.kind })),
      rows: sheet.rows,
      rowFills: ['FFFFE5E3', null],
    };
    const cut = exportTableSheet(table, ['net']);
    assert.deepEqual(cut.rows, [[30], [8]]);
    assert.deepEqual(cut.rowFills, ['FFFFE5E3', null]);
    // No colour at all: no fills on the sheet.
    assert.equal(exportTableSheet({ ...table, rowFills: [null, null] }, null).rowFills, undefined);
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

describe('ZIP export pages: the form in the URL (accounting-export, tax-reports)', () => {
  const ACCOUNTING_SPEC: ReportFilterSpec = { filters: [], defaultDaysBack: 30, extras: ACCOUNTING_EXPORT_EXTRAS };
  const DEFAULT_FORM = {
    basis: 'business',
    onlyUnexported: true,
    format: 'hashavshevet',
    grouping: 'z',
    level: '',
    consolidate: '',
    encoding: '',
    method: '',
  };

  it('accounting: the last 30 days and "from the settings" by default; defaults stay out of the URL', () => {
    const fresh = parseReportFilters(new URLSearchParams(''), ACCOUNTING_SPEC, '2026-10-13');
    assert.equal(fresh.applied, false);
    assert.equal(fresh.values.from, '2026-09-13');
    assert.equal(fresh.values.to, '2026-10-13');
    assert.deepEqual(parseAccountingExportForm(fresh.extras), DEFAULT_FORM);
    const url = writeReportFilters(new URLSearchParams(''), fresh.values, fresh.extras, ACCOUNTING_SPEC);
    assert.deepEqual([...url.keys()].sort(), ['from', 'to']);
  });

  it('accounting: a link holds the range, the Zs listed and every export option', () => {
    const fresh = parseReportFilters(new URLSearchParams(''), ACCOUNTING_SPEC, '2026-10-13');
    const extras = {
      ...fresh.extras,
      basis: 'production',
      unexported: '0',
      format: 'priority',
      grouping: 'month',
      level: 'shop',
      consolidate: 'true',
      encoding: 'cp862',
      importMethod: 'detailed',
    };
    const url = writeReportFilters(
      new URLSearchParams('company=c1&shop=s1'),
      { ...fresh.values, from: '2026-10-01', to: '2026-10-12' },
      extras,
      ACCOUNTING_SPEC,
    );
    assert.equal(url.get('shop'), 's1');
    const back = parseReportFilters(url, ACCOUNTING_SPEC, '2026-10-13');
    assert.equal(back.applied, true);
    assert.equal(back.values.from, '2026-10-01');
    assert.deepEqual(parseAccountingExportForm(back.extras), {
      basis: 'production',
      onlyUnexported: false,
      format: 'priority',
      grouping: 'month',
      level: 'shop',
      consolidate: 'true',
      encoding: 'cp862',
      method: 'detailed',
    });
  });

  it('accounting: a hand-edited value falls back to the default', () => {
    assert.deepEqual(
      parseAccountingExportForm({
        basis: 'week',
        unexported: 'no',
        format: 'csv',
        grouping: 'year',
        level: 'till',
        consolidate: 'yes',
        encoding: 'utf8',
        importMethod: 'x',
      }),
      DEFAULT_FORM,
    );
    assert.deepEqual(parseAccountingExportForm({}), DEFAULT_FORM);
  });

  it('tax: the request the page always sent — the shop, else the company; a range or a year', () => {
    const form = { shopId: '', companyId: 'c1', mode: 'date-range' as const, from: '2026-01-01', to: '2026-06-30', year: '2026' };
    assert.deepEqual(taxOpenFormatParams(form), {
      scope: 'company',
      mode: 'date-range',
      companyId: 'c1',
      from: '2026-01-01',
      to: '2026-06-30',
    });
    const shop = taxOpenFormatParams({ ...form, shopId: 's1' });
    assert.deepEqual(shop, { scope: 'shop', mode: 'date-range', shopId: 's1', from: '2026-01-01', to: '2026-06-30' });
    // Same keys in the same order: the query string the server always got.
    assert.deepEqual(Object.keys(shop!), ['scope', 'mode', 'shopId', 'from', 'to']);
    assert.deepEqual(taxOpenFormatParams({ ...form, mode: 'year', year: '2025', from: '', to: '' }), {
      scope: 'company',
      mode: 'year',
      companyId: 'c1',
      year: 2025,
    });
  });

  it('tax: nothing to send while something is missing or wrong', () => {
    const form = { shopId: '', companyId: 'c1', mode: 'date-range' as const, from: '2026-01-01', to: '2026-06-30', year: '2026' };
    assert.equal(taxOpenFormatParams({ ...form, companyId: '' }), null);
    assert.equal(taxOpenFormatParams({ ...form, from: '' }), null);
    assert.equal(taxOpenFormatParams({ ...form, from: '2026-07-01' }), null);
    assert.equal(taxOpenFormatParams({ ...form, mode: 'year', year: '' }), null);
    assert.equal(taxOpenFormatParams({ ...form, mode: 'year', year: 'abc' }), null);
  });

  it('tax: today and the date range by default; the mode and the year in a link', () => {
    const spec: ReportFilterSpec = { filters: [], defaultDaysBack: 0, extras: taxOpenFormatExtras('2026') };
    const fresh = parseReportFilters(new URLSearchParams('company=c1'), spec, '2026-10-13');
    assert.equal(fresh.values.from, '2026-10-13');
    assert.equal(fresh.values.to, '2026-10-13');
    assert.equal(taxOpenFormatMode(fresh.extras.mode), 'date-range');
    assert.equal(fresh.extras.year, '2026');
    const url = writeReportFilters(new URLSearchParams('company=c1'), fresh.values, { mode: 'year', year: '2025' }, spec);
    assert.equal(url.get('company'), 'c1');
    const back = parseReportFilters(url, spec, '2026-10-13');
    assert.equal(taxOpenFormatMode(back.extras.mode), 'year');
    assert.equal(back.extras.year, '2025');
    assert.equal(taxOpenFormatMode('weekly'), 'date-range');
    assert.equal(taxOpenFormatMode(undefined), 'date-range');
  });
});

describe('the company default of a report with many tables (§4.3: up to 100 columns)', () => {
  const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => prefix + i);
  it('everything that fits is saved as chosen', () => {
    const list = companyDefaultColumns([{ tableId: 'main', keys: ['a', 'b'], all: ['a', 'b', 'c'] }]);
    assert.deepEqual(list, ['a', 'b']);
  });
  it('too many: only the tables whose choice is narrower than all their columns', () => {
    const big = keys('k', 60);
    const tables = [
      { tableId: 'main', keys: big, all: big },
      { tableId: 'days', keys: ['net'], all: ['net', 'tips'] },
      { tableId: 'zs', keys: big, all: big },
    ];
    assert.deepEqual(companyDefaultColumns(tables), ['days.net']);
  });
  it('nothing narrowed: the first table, never an empty list (empty deletes the default)', () => {
    const big = keys('k', 60);
    assert.deepEqual(companyDefaultColumns([
      { tableId: 'main', keys: big, all: big },
      { tableId: 'zs', keys: big, all: big },
    ]), big);
  });
  it('still too many: null (the reader narrows)', () => {
    const big = keys('k', 120);
    assert.equal(companyDefaultColumns([{ tableId: 'main', keys: big.slice(1), all: big }]), null);
  });
});

describe('a label / value sheet keeps its autofilter off', () => {
  it('autoFilter: false reaches the sheet; the default is on', () => {
    const table: ExportTable = {
      tableId: 'tips',
      name: 'טיפים',
      columns: [{ key: 'item', header: 'פריט' }, { key: 'amount', header: 'סכום', kind: 'money' }],
      rows: [['טיפים', 12]],
      autoFilter: false,
    };
    assert.equal(exportTableSheet(table, null).autoFilter, false);
    assert.equal(exportTableSheet({ ...table, autoFilter: undefined }, null).autoFilter, undefined);
  });
});
