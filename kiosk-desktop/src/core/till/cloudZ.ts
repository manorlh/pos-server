/**
 * "דוחות Z" from the cloud on the Windows till (pos-android ui/reports/CloudZScreen.kt, ZPrintJobs.kt `CloudZPrinter`,
 * ShopZLogic.kt `tillsInOrder` / `tillLabel` / `printSequenceMessage`, FailedPaymentsUi.kt `failedPaymentsOnCloudPaper`):
 * the shop's Zs as the cloud produced them — the till never had them — printed on this till's printer as the cloud lays
 * them out (`print-document`), so the same Z prints the same here as in the dashboard's till view.
 *
 *  - `GET /sync/{m}/z-reports?limit=30&offset=0` — the shop's Zs, newest first (`{items, total}`); Android asks 30 and no
 *    more (no paging);
 *  - `GET /sync/{m}/z-reports/{id}/print-document` — the whole Z; `?part=summary` — a shop Z's totals and one line per
 *    till; `?till=<machineId>` — one till's detail, a document of its own;
 *  - a Z over tills asks what to print (its summary, one till's detail, every till's detail each apart); a Z without the
 *    tills listed prints whole; "הדפס רצף" prints the ticked Zs one after another in Z-number order (a shop Z: its
 *    summary), stopping at the first that does not print;
 *  - "עסקאות שלא הושלמו" / "מכירות שבוטלו" (sections keyed `failed_payments` / `cancelled_sales`) stay off the paper unless
 *    `printFailedPaymentsWithReports` puts them there.
 *
 * Not to be confused with the till's own "דוחות Z" (`till_z_history`, core/till/localReports.ts): this is the cloud's list,
 * Android's menu key `z_reports`. Pure.
 */

import type { ZDoc, ZOp } from '../printDocs';

export const CLOUD_Z_KEY = 'z_reports';
export const CLOUD_Z_PERMISSION = 'VIEW_REPORTS';
/** Android CloudZViewModel.LIMIT: the list asks this many, once. */
export const CLOUD_Z_LIMIT = 30;
export const CLOUD_Z_SUMMARY = 'summary';
export const PRINT_FAILED_PAYMENTS_PARAM = 'printFailedPaymentsWithReports';
const FAILED_PAYMENT_SECTION_KEYS: ReadonlySet<string> = new Set(['failed_payments', 'cancelled_sales']);

/** Android's words (res/values/strings.xml `cloud_z_*`, strings_report_printer.xml, ShopZLogic.kt, ZPrintJobs.kt). */
export const CLOUD_Z_TEXT = {
  title: 'דוחות Z',
  loading: 'טוען מהענן…',
  empty: 'עדיין לא הופקו דוחות Z לסניף.',
  unavailable: 'לא ניתן לטעון את דוחות ה־Z מהענן (בדקו חיבור).',
  number: (n: number) => `דו״ח Z ‏#${n}`,
  print: 'הדפס',
  printing: 'מדפיס…',
  printed: (n: number) => `דו״ח Z ‏#${n} נשלח למדפסת.`,
  selectAll: 'בחר הכל',
  printSequence: (n: number) => `הדפס רצף (${n})`,
  sequencePrinting: (progress: string) => `מדפיס ${progress}…`,
  sequenceDone: (printed: number, total: number) => `הודפסו ${printed} מתוך ${total} דוחות Z.`,
  sequenceFailed: (printed: number, total: number, why: string) => `הודפסו ${printed} מתוך ${total} דוחות Z — ${why}`,
  printWhat: (n: number) => `מה להדפיס מדו״ח Z ‏#${n}?`,
  printSummary: 'סיכום (סה״כ הסניף ושורה לכל קופה)',
  printTill: (label: string) => `פירוט ${label}`,
  printAllTills: (n: number) => `פירוט כל הקופות, כל אחת בנפרד (${n})`,
  printingTill: (i: number, total: number) => `מדפיס קופה ${i} מתוך ${total}…`,
  cancel: 'ביטול',
  stopping: 'עוצר…',
  notPrinted: (why: string) => `הדוח לא הודפס: ${why}`,
  noPrinter: 'אין מדפסת זמינה להדפסת הדוח — הגדירו מדפסת בענן (מדפסות)',
  failedOther: (why: string) => `ההדפסה נכשלה (${why})`,
  offline: 'אין חיבור לענן',
  cancelled: (printed: number, total: number) => `ההדפסה הופסקה — הודפסו ${printed} מתוך ${total}`,
  failedOf: (failure: string, printed: number, total: number) => `${failure} (הודפסו ${printed} מתוך ${total})`,
  tillFallback: 'קופה',
} as const;

/* ------------------------------------------------------------------ the cloud's answers */

/** One till of a Z, as the cloud lists it for printing its detail apart. */
export interface CloudZTill {
  machineId: string;
  posNumber: string | null;
  name: string | null;
}

/** One Z of the shop (`GET /sync/{m}/z-reports` item). */
export interface CloudZItem {
  id: string;
  number: number | null;
  businessDate: string | null;
  /** Formatted by the cloud, "₪1,234.00". */
  totalSales: string | null;
  /** The tills the Z covers; null — a Z from before they were listed (prints whole). */
  tills: CloudZTill[] | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);

function tillOf(v: unknown): CloudZTill | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  const machineId = str(t.machineId);
  if (!machineId) return null;
  const pos = t.posNumber === null || t.posNumber === undefined ? null : String(t.posNumber);
  return { machineId, posNumber: pos && pos.trim() ? pos : null, name: str(t.name) };
}

export function cloudZTillsOf(v: unknown): CloudZTill[] | null {
  if (!Array.isArray(v)) return null;
  return v.map(tillOf).filter((t): t is CloudZTill => t !== null);
}

/** The list's answer, read leniently (a row without an id is left out). */
export function cloudZListOf(body: unknown): { items: CloudZItem[]; total: number } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const raw = Array.isArray(b.items) ? b.items : [];
  const items: CloudZItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const z = r as Record<string, unknown>;
    const id = str(z.id);
    if (!id) continue;
    items.push({ id, number: num(z.number), businessDate: str(z.businessDate), totalSales: str(z.totalSales), tills: cloudZTillsOf(z.tills) });
  }
  return { items, total: num(b.total) ?? items.length };
}

/** A Z's tills in till-number order (numbers as numbers), then the unnumbered by name. */
export function tillsInOrder(tills: readonly CloudZTill[]): CloudZTill[] {
  const n = (t: CloudZTill) => {
    const s = t.posNumber?.trim() ?? '';
    return /^-?\d+$/.test(s) ? Number(s) : null;
  };
  return tills
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const na = n(a.t);
      const nb = n(b.t);
      if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
      if (na !== null && nb !== null && na !== nb) return na - nb;
      const byName = (a.t.name ?? '').localeCompare(b.t.name ?? '');
      return byName !== 0 ? byName : a.i - b.i;
    })
    .map((x) => x.t);
}

/** "#4 קופה 1": a till as the print prompts name it. */
export function tillLabel(t: CloudZTill): string {
  const parts = [t.posNumber?.trim() ? `#${t.posNumber.trim()}` : null, t.name?.trim() || null].filter((p): p is string => !!p);
  return parts.join(' ') || CLOUD_Z_TEXT.tillFallback;
}

/** A row's second line: "2026-10-16 · ₪12,480.00" (each part kept left-to-right). */
export function cloudZLine(z: Pick<CloudZItem, 'businessDate' | 'totalSales'>): string {
  return [z.businessDate, z.totalSales]
    .filter((p): p is string => !!p)
    .map((p) => `⁦${p}⁩`)
    .join(' · ');
}

/** "הדפס רצף": the ticked Zs in Z-number order (a Z without a number last). */
export function sequenceOrder(items: readonly CloudZItem[], selected: ReadonlySet<string>): CloudZItem[] {
  return items
    .filter((z) => selected.has(z.id))
    .map((z, i) => ({ z, i }))
    .sort((a, b) => (a.z.number ?? Number.MAX_SAFE_INTEGER) - (b.z.number ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    .map((x) => x.z);
}

/** How a run of separate prints ended (ShopZLogic.PrintSequenceOutcome). */
export interface PrintSequenceOutcome {
  printed: number;
  total: number;
  cancelled: boolean;
  error: string | null;
}

/** What a run of separate prints says when it is over; null — every one printed (nothing to say). */
export function printSequenceMessage(o: PrintSequenceOutcome): string | null {
  if (o.error !== null) return CLOUD_Z_TEXT.failedOf(CLOUD_Z_TEXT.notPrinted(o.error), o.printed, o.total);
  if (o.cancelled) return CLOUD_Z_TEXT.cancelled(o.printed, o.total);
  return null;
}

/* ------------------------------------------------------------------ the paper */

export interface CloudPrintRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export interface CloudPrintSection {
  title: string | null;
  rows: CloudPrintRow[];
  key: string | null;
}

/** The cloud's print document (`app/services/z_print.py`): a Z in its till view. */
export interface CloudPrintDocument {
  title: string | null;
  number: number | null;
  copyMark: string | null;
  businessName: string | null;
  subtitle: string[];
  sections: CloudPrintSection[];
  footer: string[];
  /** A shop Z's summary: its tills. */
  tills: CloudZTill[] | null;
}

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? '' : String(x))).filter((s) => s.trim() !== '') : typeof v === 'string' && v.trim() ? [v] : []);

/** The cloud's document read field by field (anything missing left out, never invented). Null: not one. */
export function cloudPrintDocumentOf(raw: unknown): CloudPrintDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const sections = (Array.isArray(d.sections) ? d.sections : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      title: str(s.title),
      key: str(s.key),
      rows: (Array.isArray(s.rows) ? s.rows : [])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ label: r.label === null || r.label === undefined ? '' : String(r.label), value: r.value === null || r.value === undefined ? '' : String(r.value), emphasis: r.emphasis === true })),
    }));
  return {
    title: str(d.title),
    number: num(d.number),
    copyMark: str(d.copyMark),
    businessName: str(d.businessName),
    subtitle: lines(d.subtitle),
    sections,
    footer: lines(d.footer),
    tills: cloudZTillsOf(d.tills),
  };
}

/** A parameter's "on" (Android domain/OfflineTillZ.kt `parameterOn`). */
export function parameterOn(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw === null || raw === undefined || raw === false) return false;
  return ['true', '1', 'yes', 'on', 'כן'].includes(String(raw).trim().toLowerCase());
}

/** [doc] without the failed payments' sections unless `printFailedPaymentsWithReports` puts them on the paper. */
export function failedPaymentsOnCloudPaper(params: Record<string, unknown> | null | undefined, doc: CloudPrintDocument): CloudPrintDocument {
  if (parameterOn((params ?? {})[PRINT_FAILED_PAYMENTS_PARAM])) return doc;
  return { ...doc, sections: doc.sections.filter((s) => !(s.key && FAILED_PAYMENT_SECTION_KEYS.has(s.key))) };
}

/**
 * The document on the till's paper as Android's PrintDocumentRenderer draws it: the business, "<title> #<number>", the
 * copy mark, each sub-line, each section (a rule, its title, its label / value rows — emphasised ones bold), then the
 * footer under a rule. In the Z's own ops (core/printDocs.ts), the logo on top as every report.
 */
export function cloudZPaper(doc: CloudPrintDocument, logoUrl: string | null): ZDoc {
  const ops: ZOp[] = [];
  if (doc.businessName) ops.push({ t: 'centred', text: doc.businessName, size: 24, bold: true });
  const head = [doc.title, doc.number !== null ? `#${doc.number}` : null].filter((p): p is string => !!p).join(' ');
  ops.push({ t: 'centred', text: head || CLOUD_Z_TEXT.title, size: 28, bold: true });
  if (doc.copyMark) ops.push({ t: 'centred', text: doc.copyMark, size: 18, bold: false });
  for (const s of doc.subtitle) ops.push({ t: 'centred', text: s, size: 18, bold: false });
  for (const s of doc.sections) {
    ops.push({ t: 'divider' });
    if (s.title) ops.push({ t: 'row', label: s.title, value: '', bold: true });
    for (const r of s.rows) ops.push({ t: 'row', label: r.label, value: r.value, bold: r.emphasis });
  }
  if (doc.footer.length > 0) {
    ops.push({ t: 'divider' });
    for (const f of doc.footer) ops.push({ t: 'centred', text: f, size: 17, bold: false });
  }
  return { kind: 'z', logoUrl, ops };
}

/** The print-document's path: the whole Z, its summary, or one till's detail. */
export function printDocumentPath(machineId: string, zId: string, o: { part?: string | null; till?: string | null } = {}): string {
  const q: string[] = [];
  if (o.part) q.push(`part=${encodeURIComponent(o.part)}`);
  if (o.till) q.push(`till=${encodeURIComponent(o.till)}`);
  return `sync/${machineId}/z-reports/${encodeURIComponent(zId)}/print-document${q.length ? `?${q.join('&')}` : ''}`;
}

/* ------------------------------------------------------------------ the screen's state */

export interface CloudZRowView {
  id: string;
  /** "דו״ח Z ‏#57". */
  title: string;
  /** "2026-10-16 · ₪12,480.00". */
  line: string;
  checked: boolean;
  /** This Z is printing now ("מדפיס…" on its button). */
  printing: boolean;
}

export interface CloudZChoiceView {
  id: string;
  /** "מה להדפיס מדו״ח Z ‏#57?". */
  title: string;
  summaryLabel: string;
  tills: Array<{ machineId: string; label: string }>;
  /** "פירוט כל הקופות, כל אחת בנפרד (3)" — more than one till only. */
  allLabel: string | null;
}

/** What the "דוחות Z" screen draws (the TillState's `cloudZ`). */
export interface CloudZState {
  title: string;
  loading: boolean;
  /** "טוען מהענן…" while loading. */
  loadingText: string | null;
  /** The last word: a failure, a sequence's end, "נשלח למדפסת". */
  message: string | null;
  /** "עדיין לא הופקו דוחות Z לסניף." — loaded, none, nothing said. */
  empty: string | null;
  /** An older cloud without the route (404): the row should be hidden. */
  unsupported: boolean;
  rows: CloudZRowView[];
  /** Something prints now: every print button and tick waits. */
  busy: boolean;
  selectAllLabel: string;
  /** "הדפס רצף (2)" or "מדפיס 1/2…". */
  sequenceLabel: string;
  canSequence: boolean;
  printLabel: string;
  printingLabel: string;
  choice: CloudZChoiceView | null;
  /** "מדפיס קופה 2 מתוך 3…", the till, and its cancel. */
  progress: { text: string; detail: string | null; cancelLabel: string; cancelling: boolean } | null;
  cancelLabel: string;
}

export interface CloudZModel {
  loading: boolean;
  loaded: boolean;
  unsupported: boolean;
  items: CloudZItem[];
  message: string | null;
  selected: ReadonlySet<string>;
  printingId: string | null;
  sequenceProgress: string | null;
  choosingFor: CloudZItem | null;
  tillProgress: string | null;
  tillProgressDetail: string | null;
  cancelling: boolean;
}

export function cloudZView(m: CloudZModel): CloudZState {
  const busy = m.printingId !== null || m.tillProgress !== null;
  const choiceTills = m.choosingFor ? tillsInOrder(m.choosingFor.tills ?? []) : [];
  return {
    title: CLOUD_Z_TEXT.title,
    loading: m.loading,
    loadingText: m.loading ? CLOUD_Z_TEXT.loading : null,
    message: m.message,
    empty: m.loaded && !m.loading && m.items.length === 0 && m.message === null ? CLOUD_Z_TEXT.empty : null,
    unsupported: m.unsupported,
    rows: m.items.map((z) => ({ id: z.id, title: CLOUD_Z_TEXT.number(z.number ?? 0), line: cloudZLine(z), checked: m.selected.has(z.id), printing: m.printingId === z.id })),
    busy,
    selectAllLabel: CLOUD_Z_TEXT.selectAll,
    sequenceLabel: m.sequenceProgress ? CLOUD_Z_TEXT.sequencePrinting(m.sequenceProgress) : CLOUD_Z_TEXT.printSequence(m.selected.size),
    canSequence: m.selected.size > 0 && m.printingId === null && m.tillProgress === null,
    printLabel: CLOUD_Z_TEXT.print,
    printingLabel: CLOUD_Z_TEXT.printing,
    choice: m.choosingFor
      ? {
          id: m.choosingFor.id,
          title: CLOUD_Z_TEXT.printWhat(m.choosingFor.number ?? 0),
          summaryLabel: CLOUD_Z_TEXT.printSummary,
          tills: choiceTills.map((t) => ({ machineId: t.machineId, label: CLOUD_Z_TEXT.printTill(tillLabel(t)) })),
          allLabel: choiceTills.length > 1 ? CLOUD_Z_TEXT.printAllTills(choiceTills.length) : null,
        }
      : null,
    progress: m.tillProgress ? { text: m.tillProgress, detail: m.tillProgressDetail, cancelLabel: m.cancelling ? CLOUD_Z_TEXT.stopping : CLOUD_Z_TEXT.cancel, cancelling: m.cancelling } : null,
    cancelLabel: CLOUD_Z_TEXT.cancel,
  };
}
