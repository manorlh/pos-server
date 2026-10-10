/**
 * "דו״ח Z — גרסה 2": the owner's sections of a Z (`reportSections`, pos-server
 * app/services/z_sections.py) as lines — the same lines the till prints (ZReportSections.kt)
 * and the cloud's print document has, pinned by the shared golden fixture
 * (server/tests/fixtures/z_report_v2_golden.json, read by zReportSections.test.ts).
 *
 * Pure: the labels come in (he.json `zReports.reportSections.labels`), and so does the money
 * formatter — the test prints plain decimals, the page prints shekels.
 */

export type Money = string | null;

export interface ZSectionsVatRate {
  rate: string | null;
  total: Money;
  vat: Money;
  base: Money;
}

export interface ZSectionsTerminal {
  terminal: string | null;
  status: string;
  legs: number;
  transmittedLegs: number;
  transmitted: Money;
  batches: { at: string | null; batch: string | null; count: number | null; amount: Money }[];
}

export interface ZSectionsEmployee {
  id: string | null;
  name: string | null;
  cash: Money;
  card: Money;
  other: Money;
  cashTip: Money;
  cardTip: Money;
  sales: Money;
  tips: Money;
  total: Money;
}

export interface ZReportSections {
  version: number;
  sales: { gross: Money; discounts: Money; refunds: Money; total: Money };
  vat: { known: boolean; base: Money; vat: Money; total: Money; rates: ZSectionsVatRate[] };
  payments: { rows: { method: string; amount: Money }[]; total: Money };
  tips: {
    cash: Money;
    card: Money;
    refunds: Money;
    cashRefunds: Money;
    cardRefunds: Money;
    net: Money;
    paidFromDrawer: Money;
    direct: Money;
    toDistribute: Money;
  };
  receipts: { rows: { method: string; sales: Money; tips: Money; total: Money }[]; total: Money };
  drawer: {
    opening: Money;
    cashReceipts: Money;
    tipsPaidFromDrawer: Money;
    betweenShifts: Money;
    cashIn: Money;
    expenses: Money;
    safeDrop: Money;
    expected: Money;
    countRequired: boolean;
    showCount: boolean;
    counted: Money;
    gap: Money;
  } | null;
  sold: { documents: number; units: string; average: Money };
  orderTypes: { rows: { type: string; count: number; total: Money; average: Money }[]; count: number; total: Money; average: Money };
  employees: ZSectionsEmployee[] | null;
  cardBrands: { rows: { brand: string; count: number; sale: Money; tip: Money; amount: Money }[]; count: number; sale: Money; tip: Money; amount: Money };
  transmission: {
    status: string;
    legs: number;
    transmittedLegs: number;
    transmitted: Money;
    cardTotal: Money;
    matched: boolean;
    terminals: ZSectionsTerminal[];
  } | null;
}

/** The words, as he.json `zReports.reportSections.labels` has them ("{rate}", "{batch}", "{count}" filled in here). */
export type ZSectionsLabels = Record<string, string> & {
  methods: Record<string, string>;
  types: Record<string, string>;
  brands: Record<string, string>;
} & Record<string, unknown>;

export type ZSectionRow = [label: string, value: string, bold: boolean];
export type ZSectionBlock = [title: string, rows: ZSectionRow[]];

/** Money to agorot, half away from zero; null for none. */
export function agorot(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '000').slice(0, 2));
  const roundUp = Number((frac + '000')[2]) >= 5 ? 1 : 0;
  const abs = cents + roundUp;
  return negative ? -abs : abs;
}

function ag(value: unknown): number {
  return agorot(value) ?? 0;
}

/** Agorot as a decimal string, "12.30", "-0.50". */
export function money(value: number | null): Money {
  if (value === null) return null;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A figure that comes off (discounts, refunds, paid out): negative unless zero. */
function neg(value: Money): Money {
  const a = agorot(value);
  return a === null ? null : money(a === 0 ? 0 : -Math.abs(a));
}

const NAME_MAX = 20;

function clip(text: string): string {
  const t = text.trim();
  return [...t].length <= NAME_MAX ? t : [...t].slice(0, NAME_MAX - 1).join('').trimEnd() + '…';
}

export interface ZSectionsLinesOptions {
  exempt?: boolean;
  fmt?: (value: Money) => string;
  stamp?: (iso: string | null) => string;
}

/**
 * The sections as the paper lists them: [title, [[label, value, bold]]] per block, in the
 * owner's order, a block with no data left out — `z_sections.lines` word for word.
 */
export function zSectionLines(s: ZReportSections | null | undefined, L: ZSectionsLabels, opts: ZSectionsLinesOptions = {}): ZSectionBlock[] {
  if (!s) return [];
  const fmt = opts.fmt ?? ((v: Money) => v ?? '—');
  const stamp = opts.stamp ?? ((v: string | null) => v ?? '—');
  const l = (key: string) => String(L[key] ?? key);
  const signed = (v: Money) => {
    const a = agorot(v);
    if (a === null) return fmt(null);
    return (a > 0 ? '+' : '') + fmt(v);
  };
  const method = (m: string) => L.methods[m] ?? m;
  const out: ZSectionBlock[] = [];

  out.push([l('sales'), [
    [l('salesGross'), fmt(s.sales.gross), false],
    [l('salesDiscounts'), fmt(neg(s.sales.discounts)), false],
    [l('salesRefunds'), fmt(neg(s.sales.refunds)), false],
    [l('salesTotal'), fmt(s.sales.total), true],
  ]]);

  const vat = s.vat;
  const vatRows: ZSectionRow[] = [];
  if (opts.exempt && !ag(vat.vat)) {
    vatRows.push([l('vatRow'), l('vatExempt'), false]);
  } else if (vat.known === false) {
    vatRows.push([l('vatRow'), l('vatUnknown'), false]);
  } else {
    const rates = vat.rates ?? [];
    vatRows.push([l('vatBase'), fmt(vat.base), false]);
    if (rates.length >= 2) {
      for (const r of rates) {
        if (r.rate === null) {
          vatRows.push([l('vatRow'), fmt(r.vat), false]);
          continue;
        }
        vatRows.push([l('vatRateBase').replace('{rate}', r.rate), fmt(r.base), false]);
        vatRows.push([l('vatRateRow').replace('{rate}', r.rate), fmt(r.vat), false]);
      }
      vatRows.push([l('vatRow'), fmt(vat.vat), false]);
    } else if (rates.length === 1 && rates[0].rate !== null) {
      vatRows.push([l('vatRateRow').replace('{rate}', rates[0].rate), fmt(vat.vat), false]);
    } else {
      vatRows.push([l('vatRow'), fmt(vat.vat), false]);
    }
    vatRows.push([l('vatTotal'), fmt(vat.total), true]);
  }
  out.push([l('vat'), vatRows]);

  out.push([l('payments'), [
    ...s.payments.rows.map((r): ZSectionRow => [method(r.method), fmt(r.amount), false]),
    [l('paymentsTotal'), fmt(s.payments.total), true],
  ]]);

  const t = s.tips;
  const hasTips = [t.cash, t.card, t.refunds, t.direct].some((v) => ag(v) !== 0) || (t.paidFromDrawer ?? null) !== null;
  if (hasTips) {
    const rows: ZSectionRow[] = [
      [l('tipCash'), fmt(t.cash), false],
      [l('tipCard'), fmt(t.card), false],
    ];
    if (ag(t.refunds)) rows.push([l('tipRefunds'), fmt(neg(t.refunds)), false]);
    rows.push([l('tipNet'), fmt(t.net), true]);
    if ((t.paidFromDrawer ?? null) !== null) rows.push([l('tipPaidFromDrawer'), fmt(neg(t.paidFromDrawer)), false]);
    rows.push([l('tipToDistribute'), fmt(t.toDistribute), true]);
    if (ag(t.direct)) rows.push([l('tipDirect'), fmt(t.direct), false]);
    out.push([l('tips'), rows]);
  }

  out.push([l('receipts'), [
    ...s.receipts.rows.map((r): ZSectionRow => [method(r.method), fmt(r.total), false]),
    [l('receiptsTotal'), fmt(s.receipts.total), true],
  ]]);

  const d = s.drawer;
  if (d) {
    const rows: ZSectionRow[] = [
      [l('drawerOpening'), fmt(d.opening), false],
      [l('drawerCashReceipts'), fmt(d.cashReceipts), false],
    ];
    if ((d.tipsPaidFromDrawer ?? null) !== null) rows.push([l('drawerTipsPaid'), fmt(neg(d.tipsPaidFromDrawer)), false]);
    if (ag(d.betweenShifts)) rows.push([l('drawerBetweenShifts'), signed(d.betweenShifts), false]);
    if (ag(d.cashIn)) rows.push([l('drawerCashIn'), fmt(d.cashIn), false]);
    if (ag(d.expenses)) rows.push([l('drawerExpenses'), fmt(neg(d.expenses)), false]);
    if (ag(d.safeDrop)) rows.push([l('drawerSafeDrop'), fmt(neg(d.safeDrop)), false]);
    rows.push([l('drawerExpected'), fmt(d.expected), true]);
    if (d.showCount) {
      rows.push([l('drawerCounted'), d.counted !== null && d.counted !== undefined ? fmt(d.counted) : l('drawerNotCounted'), false]);
      rows.push([l('drawerGap'), d.gap !== null && d.gap !== undefined ? signed(d.gap) : l('drawerGapWithheld'), true]);
    }
    out.push([l('drawer'), rows]);
  }

  const tr = s.transmission;
  if (tr) {
    const word = tr.status === 'sent' ? l('transmissionSent') : tr.status === 'partial' ? l('transmissionPartial') : l('transmissionNotSent');
    const rows: ZSectionRow[] = [[l('transmissionStatus'), word, true]];
    for (const term of tr.terminals ?? []) {
      rows.push([l('transmissionTerminal'), term.terminal || '—', false]);
      for (const b of term.batches ?? []) {
        rows.push([l('transmissionBatch').replace('{batch}', b.batch || '—').trim(), stamp(b.at), false]);
        rows.push([l('transmissionBatchFigures'), `${b.count === null || b.count === undefined ? '—' : b.count} · ${fmt(b.amount)}`, false]);
      }
      const pending = (term.legs || 0) - (term.transmittedLegs || 0);
      if (pending > 0) rows.push([l('transmissionPending'), String(pending), false]);
    }
    rows.push([l('transmissionCardTotal'), fmt(tr.cardTotal), false]);
    rows.push([l('transmissionTransmitted'), fmt(tr.transmitted), false]);
    rows.push([l('transmissionMatch'), tr.matched ? l('transmissionMatched') : l('transmissionNotMatched'), true]);
    out.push([l('transmission'), rows]);
  }

  if ((s.sold?.documents ?? 0) > 0) {
    out.push([l('sold'), [
      [l('soldDocuments'), String(s.sold.documents), false],
      [l('soldUnits'), String(s.sold.units || '0'), false],
      [l('soldAverage'), fmt(s.sold.average), true],
    ]]);
  }

  const types = s.orderTypes;
  if (types?.rows?.length) {
    const rows: ZSectionRow[] = [];
    for (const r of types.rows) {
      rows.push([`${L.types[r.type] ?? r.type} (${r.count || 0})`, fmt(r.total), false]);
      rows.push([l('orderTypeAverage'), fmt(r.average), false]);
    }
    rows.push([l('orderTypesTotal').replace('{count}', String(types.count || 0)), fmt(types.total), true]);
    rows.push([l('soldAverage'), fmt(types.average), false]);
    out.push([l('orderTypes'), rows]);
  }

  const brands = s.cardBrands;
  if (brands?.rows?.length) {
    const rows: ZSectionRow[] = [];
    for (const r of brands.rows) {
      rows.push([`${L.brands[r.brand] ?? r.brand} (${r.count || 0})`, fmt(r.amount), false]);
      rows.push([l('brandSplit'), `${fmt(r.sale)} / ${fmt(r.tip)}`, false]);
    }
    rows.push([l('brandsTotal').replace('{count}', String(brands.count || 0)), fmt(brands.amount), true]);
    rows.push([l('brandSplit'), `${fmt(brands.sale)} / ${fmt(brands.tip)}`, false]);
    out.push([l('cardBrands'), rows]);
  }

  if (s.employees && s.employees.length) {
    const rows: ZSectionRow[] = [];
    for (const e of s.employees) {
      rows.push([clip(e.name || l('employeeNone')), fmt(e.total), true]);
      rows.push([l('employeeCard'), fmt(e.card), false]);
      rows.push([l('employeeCash'), fmt(e.cash), false]);
      if (ag(e.other)) rows.push([l('employeeOther'), fmt(e.other), false]);
      if (ag(e.cardTip)) rows.push([l('employeeCardTip'), fmt(e.cardTip), false]);
      if (ag(e.cashTip)) rows.push([l('employeeCashTip'), fmt(e.cashTip), false]);
      rows.push([l('employeeSales'), fmt(e.sales), false]);
      rows.push([l('employeeTips'), fmt(e.tips), false]);
    }
    out.push([l('employees'), rows]);
  }
  return out;
}
