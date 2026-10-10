/**
 * Zs by the date they were produced ("תאריך הפקת Z") — the list's date choice, the day's
 * summary card, the month's view and their CSVs. Presentation only: every figure is the
 * one the Z froze at build (pos-server app/services/z_by_date.py); nothing here computes a
 * fiscal number.
 *
 * The production date is the Z's own (`closedAt`) on the shop's clock — the night of 30.9
 * closed by a Z at 02:00 on 1.10 is a Z of 1.10 — never its business date, and never the
 * date of the documents inside it. VAT reporting and the uniform file go by the document's
 * date, which is why the month shows each Z's documents by document month.
 *
 * Run the tests with `npm test` (lib/zByDate.test.ts).
 */
import { toCsv, type CsvCell } from './csv';
import { HEBREW_MONTHS, addDaysIso, formatCurrency, formatTime, isoDate } from './format';

// ── The date choice ─────────────────────────────────────────────────────────

export type ZDateBasis = 'production' | 'business';

/** In the order the choice shows them: "תאריך הפקת Z" first, and the default. */
export const Z_DATE_BASES: readonly ZDateBasis[] = ['production', 'business'];
export const DEFAULT_Z_DATE_BASIS: ZDateBasis = 'production';

export function isZDateBasis(value: unknown): value is ZDateBasis {
  return value === 'production' || value === 'business';
}

// ── The kind of a Z ─────────────────────────────────────────────────────────

/** "סוג Z" as the list shows it: the server's types, with a shop Z run for an area apart. */
export type ZKind = 'shop' | 'area' | 'till' | 'independent' | 'kiosk' | 'legacy';
export const Z_KINDS: readonly ZKind[] = ['shop', 'area', 'till', 'independent', 'kiosk', 'legacy'];

/** The kind of a row of `GET /z-reports` (its `zType`, and the area it was started for). */
export function zKindOf(z: { zType?: string | null; areaId?: string | null; areaName?: string | null }): ZKind | null {
  const type = z.zType;
  if (type === 'shop') return z.areaId || z.areaName ? 'area' : 'shop';
  if (type === 'till' || type === 'independent' || type === 'kiosk' || type === 'legacy') return type;
  return null;
}

// ── The wire ────────────────────────────────────────────────────────────────

type Money = string | null;

export interface ZByDateTotals {
  count: number;
  totalSales: Money;
  totalRefunds: Money;
  netSales: Money;
  vatTotal: Money;
  cashSales: Money;
  cardSales: Money;
  totalTips: Money;
  documents: number;
  /** Zs whose VAT is not known (a document of it declared none): not summed as zero. */
  vatUnknownCount: number;
}

/** One Z's documents dated in one month (on the shop's clock). */
export interface ZDocumentMonth {
  /** "2026-09". */
  month: string;
  netSales: Money;
  vatTotal: Money;
  documents: number;
}

export interface ZByDateTill {
  posNumber?: string | null;
  machineName?: string | null;
}

/** One Z of the summary (`zs[]`). Money as decimal strings. */
export interface ZByDateLine {
  id: string;
  zNumber: number | null;
  zType: string;
  kind: ZKind;
  origin: 'cloud' | 'till';
  shopId: string | null;
  shopName: string | null;
  shopNumber: number | null;
  branchCode?: string | null;
  areaId: string | null;
  areaName: string | null;
  /** `z`: the area the Z was started for; `shifts`: a till Z, by the area its shifts were in. */
  areaSource: 'z' | 'shifts' | null;
  machineId: string | null;
  machineName: string | null;
  posNumber: string | null;
  machineSequenceEpoch?: number;
  tills: ZByDateTill[];
  machineCount: number | null;
  shiftCount: number | null;
  /** When it was produced (an instant), and that on the shop's clock. */
  producedAt: string | null;
  productionDate: string | null;
  productionTime: string | null;
  businessDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  builtOffline: boolean;
  uploadedAt: string | null;
  totalSales: Money;
  totalRefunds: Money;
  netSales: Money;
  vatTotal: Money;
  cashSales: Money;
  cardSales: Money;
  totalTips: Money;
  documents: number;
  /** The month view only. */
  documentMonths?: ZDocumentMonth[];
  otherMonthDocuments?: boolean;
  /** False when its documents now add up to other than the figures it was built with. */
  documentsMatchZ?: boolean;
}

export type ZByDateShop = ZByDateTotals & { shopId: string | null; shopName: string | null; shopNumber: number | null };
export type ZByDateArea = ZByDateShop & { areaId: string | null; areaName: string | null };

export interface ZByDateWindow {
  from: string;
  to: string;
  dateBasis: ZDateBasis;
  timezone: string;
  month?: string;
}

export interface ZByDateSummary {
  window: ZByDateWindow;
  count: number;
  totals: ZByDateTotals;
  byShop: ZByDateShop[];
  byArea: ZByDateArea[];
  byKind: (ZByDateTotals & { kind: ZKind })[];
  byDay: (ZByDateTotals & { date: string | null })[];
  zs: ZByDateLine[];
}

export interface ZByDateMonth extends ZByDateSummary {
  /** "דיווח מע״מ ומבנה אחיד נעשים לפי תאריך המסמך". */
  note: string;
  /** The month's Zs' documents by document month. */
  documentMonths: ZDocumentMonth[];
}

// ── Dates and months ────────────────────────────────────────────────────────

const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-\d{2}$/;

/** "2026-10-01" → "2026-10"; '' for anything else. */
export function monthOfDay(day: string | null | undefined): string {
  const m = day ? DAY.exec(day) : null;
  return m ? `${m[1]}-${m[2]}` : '';
}

/** "2026-09" → "ספטמבר", or "ספטמבר 2026" with the year. '' for anything else. */
export function monthName(month: string, withYear = false): string {
  const m = MONTH.exec(month);
  if (!m) return '';
  const index = Number(m[2]) - 1;
  if (index < 0 || index > 11) return '';
  return withYear ? `${HEBREW_MONTHS[index]} ${m[1]}` : HEBREW_MONTHS[index];
}

/** "2026-10" ± n months. */
export function addMonths(month: string, n: number): string {
  const m = MONTH.exec(month);
  if (!m) return '';
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const year = Math.floor(total / 12);
  return `${year}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** The first and last day of a month: "2026-02" → ["2026-02-01", "2026-02-28"]. */
export function monthBounds(month: string): [string, string] | null {
  const m = MONTH.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return [`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`];
}

/** The list's window with no dates: the last 90 days (`DEFAULT_WINDOW_DAYS` on the server). */
export const LIST_DEFAULT_WINDOW_DAYS = 90;

/**
 * The days the Z list covers, both ends — what its CSV asks the summary for. No dates: the
 * last 90 days; only "from": up to today; only "to": the 90 days up to it.
 */
export function listWindow(from: string, to: string, today: string): { from: string; to: string } {
  const end = to || (from && from > today ? from : today);
  const start = from || addDaysIso(end, -LIST_DEFAULT_WINDOW_DAYS);
  return { from: start, to: end };
}

/**
 * The days the day-summary card shows: the picked day or range; only "from": up to today;
 * only "to": that day; nothing picked: today.
 */
export function summaryWindow(from: string, to: string, today: string): { from: string; to: string } {
  if (from && to) return from <= to ? { from, to } : { from: to, to: from };
  if (from) return { from, to: from > today ? from : today };
  if (to) return { from: to, to };
  return { from: today, to: today };
}

/** The day a Z was produced on, on the shop's clock (`zone` from the server's window). */
export function productionDayOf(closedAt: string | null | undefined, zone: string | null | undefined): string {
  return closedAt ? isoDate(closedAt, zone || undefined) : '';
}

/** "02:00" — when a Z was produced, on the shop's clock. */
export function productionTimeOf(closedAt: string | null | undefined, zone: string | null | undefined): string {
  return closedAt ? formatTime(closedAt, { timeZone: zone || undefined }) : '—';
}

/**
 * A page of `GET /z-reports` cut into the days it shows, in its order: one group per
 * production day (or business day), each with its Zs. A day split across pages is two
 * groups on two pages — the day's totals come from the summary, not from a page.
 */
export function groupByDay<T>(rows: readonly T[], dayOf: (row: T) => string | null | undefined): { day: string; rows: T[] }[] {
  const out: { day: string; rows: T[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row) || '';
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else out.push({ day, rows: [row] });
  }
  return out;
}

// ── The split by document month ─────────────────────────────────────────────

/** True when a Z holds documents dated in a month other than the one it was produced in. */
export function hasOtherMonthDocuments(line: Pick<ZByDateLine, 'documentMonths' | 'productionDate' | 'otherMonthDocuments'>): boolean {
  if (typeof line.otherMonthDocuments === 'boolean') return line.otherMonthDocuments;
  const produced = monthOfDay(line.productionDate);
  return (line.documentMonths ?? []).some((m) => m.month !== produced);
}

/**
 * "₪100.00 מסמכי ספטמבר · ₪50.00 מסמכי אוקטובר" — a Z's documents by the month they are
 * dated in. A month of another year names its year. '' when the Z has no split.
 */
export function documentMonthsText(months: readonly ZDocumentMonth[] | null | undefined, productionDate?: string | null): string {
  if (!months || months.length === 0) return '';
  const year = monthOfDay(productionDate).slice(0, 4);
  return months
    .map((m) => `${formatCurrency(m.netSales)} מסמכי ${monthName(m.month, Boolean(year) && m.month.slice(0, 4) !== year)}`)
    .join(' · ');
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** "קופה 2 (בר)" / "קופה 2" / "בר" — a till as the lists name it. */
export function tillLabel(till: ZByDateTill): string {
  const pos = till.posNumber ? `קופה ${till.posNumber}` : '';
  if (pos && till.machineName) return `${pos} (${till.machineName})`;
  return pos || till.machineName || '';
}

/** The tills of a Z, "קופה 1 (קדמית), קופה 2". */
export function tillsLabel(line: Pick<ZByDateLine, 'tills'>): string {
  return (line.tills ?? []).map(tillLabel).filter(Boolean).join(', ');
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** The column heads, from the page's translations (`zByDate.csv.*`). */
export type CsvLabel = (key: string) => string;

const MONEY_COLS = ['totalSales', 'totalRefunds', 'netSales', 'vatTotal', 'cashSales', 'cardSales', 'totalTips'] as const;

function totalsCells(t: ZByDateTotals): CsvCell[] {
  return [t.count, ...MONEY_COLS.map((k) => t[k]), t.documents];
}

function totalsHeader(label: CsvLabel): string[] {
  return [label('count'), ...MONEY_COLS.map((k) => label(k)), label('documents')];
}

/**
 * The Z list as CSV: one row per Z, both dates, its kind, where, the time it was produced and
 * its totals — and, from the month view, its documents by document month.
 */
export function zLinesCsv(lines: readonly ZByDateLine[], label: CsvLabel, kindLabel: (kind: ZKind) => string): string {
  const withMonths = lines.some((l) => l.documentMonths !== undefined);
  const header = [
    label('zNumber'), label('kind'), label('shopNumber'), label('shop'), label('area'), label('tills'),
    label('productionDate'), label('productionTime'), label('businessDate'),
    ...MONEY_COLS.map((k) => label(k)), label('documents'),
    ...(withMonths ? [label('documentMonths'), label('otherMonthDocuments')] : []),
  ];
  const rows: CsvCell[][] = lines.map((l) => [
    l.zNumber,
    kindLabel(l.kind),
    l.shopNumber,
    l.shopName,
    l.areaName,
    tillsLabel(l),
    l.productionDate,
    l.productionTime,
    l.businessDate,
    ...MONEY_COLS.map((k) => l[k]),
    l.documents,
    ...(withMonths
      ? [
          (l.documentMonths ?? []).map((m) => `${m.month}: ${m.netSales ?? ''}`).join('; '),
          hasOtherMonthDocuments(l) ? label('yes') : label('no'),
        ]
      : []),
  ]);
  return toCsv(header, rows);
}

/**
 * A summary as CSV: the grand totals, then by shop, by area, by kind and by day — each a block
 * under its own title row, so one file opens as one sheet.
 */
export function zSummaryCsv(
  summary: ZByDateSummary | ZByDateMonth,
  label: CsvLabel,
  kindLabel: (kind: ZKind) => string,
): string {
  const head = totalsHeader(label);
  const rows: CsvCell[][] = [];
  const block = (title: string, keys: string[], body: CsvCell[][]) => {
    if (rows.length) rows.push([]);
    rows.push([title]);
    rows.push([...keys, ...head]);
    rows.push(...body);
  };
  block(label('grandTotal'), [label('range')], [[`${summary.window.from} – ${summary.window.to}`, ...totalsCells(summary.totals)]]);
  block(label('byShop'), [label('shopNumber'), label('shop')], summary.byShop.map((s) => [s.shopNumber, s.shopName, ...totalsCells(s)]));
  block(
    label('byArea'),
    [label('shop'), label('area')],
    summary.byArea.map((a) => [a.shopName, a.areaName ?? label('noArea'), ...totalsCells(a)]),
  );
  block(label('byKind'), [label('kind')], summary.byKind.map((k) => [kindLabel(k.kind), ...totalsCells(k)]));
  block(label('byDay'), [label('date')], summary.byDay.map((d) => [d.date, ...totalsCells(d)]));
  if ('documentMonths' in summary && summary.documentMonths) {
    if (rows.length) rows.push([]);
    rows.push([label('documentMonthsTitle')]);
    rows.push([label('documentMonth'), label('netSales'), label('vatTotal'), label('documents')]);
    rows.push(...summary.documentMonths.map((m) => [m.month, m.netSales, m.vatTotal, m.documents]));
    rows.push([]);
    rows.push([summary.note]);
  }
  // `toCsv` takes a header row; the blocks carry their own, so the file starts with the title.
  const [first, ...rest] = rows;
  return toCsv(first.map((c) => (c === null || c === undefined ? '' : String(c))), rest);
}

/** A file name with the window in it: "zs-production-2026-10-01.csv". */
export function csvFileName(kind: string, window: Pick<ZByDateWindow, 'from' | 'to' | 'dateBasis' | 'month'>): string {
  const span = window.month ?? (window.from === window.to ? window.from : `${window.from}_${window.to}`);
  return `zs-${kind}-${window.dateBasis}-${span}.csv`;
}
