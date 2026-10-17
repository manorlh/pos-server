/**
 * The menu's "דוחות" folder on the Windows till, from the till's own records — the Android till's local reports
 * (pos-android domain/RangeReports.kt, domain/ReportWindow.kt, ui/reports/ShiftHistoryScreen.kt, TillZHistoryScreen.kt):
 *
 *  - "מכירות לפי מוצר", "דוח לפי עובד", "דוח תשר" over a range ("היום", "אתמול", "השבוע", "בוקר", "ערב"): the reportable
 *    documents only (completed / refunded / partial refund — the Z's own rule, never a cancelled or pending one); a credit
 *    note's money is never added to a total — it is its own "זיכויים", and the net is sales less refunds (RangeReports.kt);
 *  - "היסטוריית משמרות": the till's shifts, newest first, with what each sold and how it stands with the cloud;
 *  - "דוחות Z": the Zs this till holds, each printable again (a copy).
 *
 * Pure: the engine hands it the documents and the rows, and draws nothing itself.
 */

import type { LocalReportView, ReportPreset } from '../../shared/till/protocol';
import { formatShekelSign } from '../money';

/** A credit note: its money is a refund, never a sale (DocumentType.isCredit). */
const CREDIT_TYPES = new Set([330, -400]);
const REPORTABLE = new Set(['completed', 'refunded', 'partial_refund']);

export const REPORT_TEXT = {
  products: 'מכירות לפי מוצר',
  workers: 'דוח לפי עובד',
  tips: 'דוח תשר',
  shifts: 'היסטוריית משמרות',
  zOnlyShifts: 'היסטוריית דו״חות X',
  tillZs: 'דוחות Z',
  sales: 'מכירות',
  refunds: 'זיכויים',
  net: 'נטו',
  units: 'יחידות (נטו)',
  lineUnits: (n: string) => `${n} יחידות`,
  documents: 'מסמכים',
  creditNotes: (n: number) => `זיכויים (${n})`,
  cash: 'מזומן',
  card: 'אשראי',
  unlisted: 'מוצר שאינו בקטלוג',
  unknownUser: 'לא ידוע',
  productsEmpty: 'אין מכירות בטווח הזה.',
  tipsEmpty: 'לא נרשם תשר בטווח הזה.',
  tipsDocuments: 'מסמכים עם תשר',
  tipsByMethod: 'לפי אמצעי תשלום',
  tipsByCashier: 'לפי עובד',
  tipsUnknownMethod: 'לא צוין',
  total: 'סה״כ',
  shiftNumber: (n: number) => `משמרת #${n}`,
  shiftOpen: 'פתוחה',
  shiftClosing: 'בסגירה — ממתינה לענן',
  shiftClosed: 'נסגרה',
  shiftInZ: (z: number | null) => (z !== null ? `בדוח Z ${z}` : 'בדוח Z'),
  openedBy: (name: string) => `נפתחה ע״י ${name}`,
  shiftsEmpty: 'אין משמרות בקופה.',
  zNumber: (n: number) => `Z ${n}`,
  zPrinted: 'הודפס',
  zEmpty: 'אין דוחות Z בקופה.',
  presets: { today: 'היום', yesterday: 'אתמול', week: 'השבוע', morning: 'משמרת בוקר', evening: 'משמרת ערב' } as Record<ReportPreset, string>,
} as const;

/** Android ReportWindows: the morning and the evening shift a counter runs. */
export const MORNING = { from: 6, to: 14 } as const;
export const EVENING = { from: 14, to: 22 } as const;

export const REPORT_PRESETS: readonly ReportPreset[] = ['today', 'yesterday', 'week', 'morning', 'evening'];

export function presetOf(raw: unknown): ReportPreset {
  return typeof raw === 'string' && (REPORT_PRESETS as readonly string[]).includes(raw) ? (raw as ReportPreset) : 'today';
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayText = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const hmText = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const at = (d: Date, h: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0);

/**
 * The range's local wall-clock window [from, to) and its words: "היום" from midnight to the next; "השבוע" from Sunday
 * (an Israeli week); the shifts' hours today.
 */
export function reportWindow(preset: ReportPreset, now: Date): { from: Date; to: Date; label: string } {
  const today = at(now, 0);
  const next = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  switch (preset) {
    case 'yesterday': {
      const from = next(today, -1);
      return { from, to: today, label: `${REPORT_TEXT.presets.yesterday} · ${dayText(from)}` };
    }
    case 'week': {
      const from = next(today, -today.getDay());
      return { from, to: next(today, 1), label: `${dayText(from)} עד ${dayText(today)}` };
    }
    case 'morning':
      return { from: at(now, MORNING.from), to: at(now, MORNING.to), label: `${dayText(today)} · ${pad(MORNING.from)}:00 עד ${pad(MORNING.to)}:00` };
    case 'evening':
      return { from: at(now, EVENING.from), to: at(now, EVENING.to), label: `${dayText(today)} · ${pad(EVENING.from)}:00 עד ${pad(EVENING.to)}:00` };
    default:
      return { from: today, to: next(today, 1), label: `${REPORT_TEXT.presets.today} · ${dayText(today)}` };
  }
}

/** One document as the range reports read it. */
export interface ReportDoc {
  status: string;
  documentType: number;
  createdAt: string;
  cashierId: string;
  cashierName: string | null;
  /** Each line's product and its money as the document booked it (a credit line: what it credits). */
  lines: Array<{ productId: string; name: string; sku?: string | null; qty: number; agorot: number }>;
  /** The tenders (an exchange leg is in no drawer). */
  payments: Array<{ method: string; amountAgorot: number }>;
  tipAgorot: number;
  tipMethod: string | null;
}

const reportable = (d: ReportDoc) => REPORTABLE.has(d.status);
const isCredit = (d: ReportDoc) => CREDIT_TYPES.has(d.documentType);
const sh = (agorot: number) => formatShekelSign(agorot);
/** A refund's money, said as a credit. */
const credit = (agorot: number) => (agorot === 0 ? sh(0) : `−${sh(agorot)}`);
const signed = (agorot: number) => (agorot < 0 ? `−${sh(-agorot)}` : sh(agorot));

/** `3`, not `3.0`; `1.25` kept (formatUnits). */
export function formatUnits(units: number): string {
  return String(Math.round(units * 1000) / 1000);
}

/** The documents of the window, reportable only. */
export function docsIn(docs: readonly ReportDoc[], from: Date, to: Date): ReportDoc[] {
  const a = from.getTime();
  const b = to.getTime();
  return docs.filter((d) => {
    const t = Date.parse(d.createdAt);
    return reportable(d) && Number.isFinite(t) && t >= a && t < b;
  });
}

/** "מכירות לפי מוצר": best seller first (by net), the name breaking ties. */
export function productSalesReport(docs: readonly ReportDoc[], preset: ReportPreset, label: string): LocalReportView {
  const by = new Map<string, { name: string; sku: string | null; sold: number; credited: number; gross: number; refunds: number }>();
  for (const d of docs) {
    if (!reportable(d)) continue;
    const c = isCredit(d);
    for (const l of d.lines) {
      const e = by.get(l.productId) ?? { name: l.name?.trim() || REPORT_TEXT.unlisted, sku: l.sku ?? null, sold: 0, credited: 0, gross: 0, refunds: 0 };
      if (c) {
        e.credited += l.qty;
        e.refunds += l.agorot;
      } else {
        e.sold += l.qty;
        e.gross += l.agorot;
      }
      by.set(l.productId, e);
    }
  }
  const lines = [...by.values()].sort((a, b) => b.gross - b.refunds - (a.gross - a.refunds) || a.name.localeCompare(b.name, 'he'));
  const gross = lines.reduce((s, l) => s + l.gross, 0);
  const refunds = lines.reduce((s, l) => s + l.refunds, 0);
  const units = lines.reduce((s, l) => s + l.sold - l.credited, 0);
  return {
    kind: 'products',
    title: REPORT_TEXT.products,
    subtitle: label,
    preset,
    empty: lines.length === 0 ? REPORT_TEXT.productsEmpty : null,
    sections:
      lines.length === 0
        ? []
        : [
            {
              title: null,
              rows: [
                { label: REPORT_TEXT.sales, value: sh(gross) },
                { label: REPORT_TEXT.refunds, value: credit(refunds) },
                { label: REPORT_TEXT.net, value: signed(gross - refunds), emphasis: true },
                { label: REPORT_TEXT.units, value: formatUnits(units) },
              ],
            },
            {
              title: REPORT_TEXT.products,
              rows: lines.map((l) => ({
                label: l.name,
                value: signed(l.gross - l.refunds),
                sub: [REPORT_TEXT.lineUnits(formatUnits(l.sold - l.credited)), l.refunds > 0 ? `${REPORT_TEXT.refunds} ${credit(l.refunds)}` : null, l.sku].filter(Boolean).join(' · '),
              })),
            },
          ],
  };
}

/** "דוח לפי עובד": per cashier — documents (credit notes too, as the Z counts them), sales, refunds, net, cash and card. */
export function workerReport(docs: readonly ReportDoc[], preset: ReportPreset, label: string): LocalReportView {
  const by = new Map<string, { name: string; documents: number; creditNotes: number; gross: number; refunds: number; cash: number; card: number }>();
  for (const d of docs) {
    if (!reportable(d)) continue;
    const c = isCredit(d);
    const e = by.get(d.cashierId) ?? { name: d.cashierName?.trim() || REPORT_TEXT.unknownUser, documents: 0, creditNotes: 0, gross: 0, refunds: 0, cash: 0, card: 0 };
    e.documents += 1;
    if (c) e.creditNotes += 1;
    const money = d.lines.reduce((s, l) => s + l.agorot, 0);
    if (c) e.refunds += money;
    else e.gross += money;
    for (const p of d.payments) {
      const v = c ? -p.amountAgorot : p.amountAgorot;
      if (p.method === 'cash') e.cash += v;
      else if (p.method === 'card') e.card += v;
    }
    by.set(d.cashierId, e);
  }
  const lines = [...by.values()].sort((a, b) => b.gross - b.refunds - (a.gross - a.refunds) || a.name.localeCompare(b.name, 'he'));
  const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((s, l) => s + f(l), 0);
  return {
    kind: 'workers',
    title: REPORT_TEXT.workers,
    subtitle: label,
    preset,
    empty: lines.length === 0 ? REPORT_TEXT.productsEmpty : null,
    sections:
      lines.length === 0
        ? []
        : [
            {
              title: null,
              rows: [
                { label: REPORT_TEXT.documents, value: String(sum((l) => l.documents)) },
                { label: REPORT_TEXT.sales, value: sh(sum((l) => l.gross)) },
                { label: REPORT_TEXT.refunds, value: credit(sum((l) => l.refunds)) },
                { label: REPORT_TEXT.net, value: signed(sum((l) => l.gross - l.refunds)), emphasis: true },
              ],
            },
            ...lines.map((l) => ({
              title: l.name,
              rows: [
                { label: REPORT_TEXT.net, value: signed(l.gross - l.refunds), emphasis: true },
                { label: REPORT_TEXT.documents, value: String(l.documents) },
                { label: REPORT_TEXT.sales, value: sh(l.gross) },
                { label: REPORT_TEXT.creditNotes(l.creditNotes), value: credit(l.refunds) },
                { label: REPORT_TEXT.cash, value: signed(l.cash) },
                { label: REPORT_TEXT.card, value: signed(l.card) },
              ],
            })),
          ],
  };
}

const METHOD_WORD: Record<string, string> = { cash: 'מזומן', card: 'אשראי' };

/** "דוח תשר": the tips of the range — by tender, by cashier (every document's tip, as the X adds them). */
export function tipsReport(docs: readonly ReportDoc[], preset: ReportPreset, label: string): LocalReportView {
  const byMethod = new Map<string, { total: number; documents: number }>();
  const byCashier = new Map<string, { name: string; total: number; documents: number }>();
  for (const d of docs) {
    if (!reportable(d) || d.tipAgorot === 0) continue;
    const m = d.tipMethod ?? '';
    const em = byMethod.get(m) ?? { total: 0, documents: 0 };
    em.total += d.tipAgorot;
    em.documents += 1;
    byMethod.set(m, em);
    const ec = byCashier.get(d.cashierId) ?? { name: d.cashierName?.trim() || REPORT_TEXT.unknownUser, total: 0, documents: 0 };
    ec.total += d.tipAgorot;
    ec.documents += 1;
    byCashier.set(d.cashierId, ec);
  }
  const total = [...byMethod.values()].reduce((s, x) => s + x.total, 0);
  const documents = [...byCashier.values()].reduce((s, x) => s + x.documents, 0);
  return {
    kind: 'tips',
    title: REPORT_TEXT.tips,
    subtitle: label,
    preset,
    empty: documents === 0 ? REPORT_TEXT.tipsEmpty : null,
    sections:
      documents === 0
        ? []
        : [
            {
              title: null,
              rows: [
                { label: REPORT_TEXT.total, value: sh(total), emphasis: true },
                { label: REPORT_TEXT.tipsDocuments, value: String(documents) },
              ],
            },
            {
              title: REPORT_TEXT.tipsByMethod,
              rows: [...byMethod.entries()].sort((a, b) => b[1].total - a[1].total).map(([m, x]) => ({ label: METHOD_WORD[m] ?? REPORT_TEXT.tipsUnknownMethod, value: sh(x.total), sub: `${x.documents} ${REPORT_TEXT.documents}` })),
            },
            {
              title: REPORT_TEXT.tipsByCashier,
              rows: [...byCashier.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'he')).map((x) => ({ label: x.name, value: sh(x.total), sub: `${x.documents} ${REPORT_TEXT.documents}` })),
            },
          ],
  };
}

/** One shift as "היסטוריית משמרות" lists it. */
export interface ReportShift {
  number: number;
  businessDate: string;
  openedAt: string;
  closedAt: string | null;
  openedByName: string | null;
  status: 'open' | 'closing' | 'closed' | 'retired';
  zNumber: number | null;
  inZ: boolean;
  /** What it sold, net (agorot), and its documents — the close's X, or the open shift's figures now. */
  netAgorot: number | null;
  transactions: number | null;
}

export function shiftsReport(shifts: readonly ReportShift[], zOnly: boolean): LocalReportView {
  const rows = shifts
    .filter((s) => s.status !== 'retired')
    .map((s) => {
      const opened = new Date(s.openedAt);
      const closed = s.closedAt ? new Date(s.closedAt) : null;
      const state = s.status === 'open' ? REPORT_TEXT.shiftOpen : s.inZ ? REPORT_TEXT.shiftInZ(s.zNumber) : s.status === 'closing' ? REPORT_TEXT.shiftClosing : REPORT_TEXT.shiftClosed;
      const when = Number.isNaN(opened.getTime()) ? s.businessDate : `${dayText(opened)} ${hmText(opened)}${closed && !Number.isNaN(closed.getTime()) ? `–${hmText(closed)}` : ''}`;
      return {
        label: `${REPORT_TEXT.shiftNumber(s.number)} · ${state}`,
        value: s.netAgorot === null ? '—' : signed(s.netAgorot),
        sub: [when, s.openedByName ? REPORT_TEXT.openedBy(s.openedByName) : null, s.transactions !== null ? `${s.transactions} ${REPORT_TEXT.documents}` : null].filter(Boolean).join(' · '),
        tone: (s.status === 'open' ? 'ok' : s.status === 'closing' ? 'warn' : null) as 'ok' | 'warn' | null,
      };
    });
  return {
    kind: 'shifts',
    title: zOnly ? REPORT_TEXT.zOnlyShifts : REPORT_TEXT.shifts,
    subtitle: null,
    preset: null,
    empty: rows.length === 0 ? REPORT_TEXT.shiftsEmpty : null,
    sections: rows.length === 0 ? [] : [{ title: null, rows }],
  };
}

/** One Z the till holds. */
export interface ReportZ {
  id: string;
  number: number;
  closedAt: string;
  state: string;
}

export function tillZsReport(zs: readonly ReportZ[]): LocalReportView {
  const rows = zs
    .filter((z) => z.state !== 'superseded')
    .map((z) => {
      const d = new Date(z.closedAt);
      return {
        label: REPORT_TEXT.zNumber(z.number),
        value: Number.isNaN(d.getTime()) ? z.closedAt : `${dayText(d)} ${hmText(d)}`,
        sub: z.state === 'printed' ? REPORT_TEXT.zPrinted : null,
        reprintZ: z.id,
      };
    });
  return { kind: 'tillZs', title: REPORT_TEXT.tillZs, subtitle: null, preset: null, empty: rows.length === 0 ? REPORT_TEXT.zEmpty : null, sections: rows.length === 0 ? [] : [{ title: null, rows }] };
}
