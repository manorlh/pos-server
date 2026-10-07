/**
 * What the kiosk prints, as data — the receipt (320/400), the kiosk bon, the pickup slip and the
 * till Z — line for line as the Android till draws them (pos-android
 * hardware/printer/ReceiptRenderer.kt, hardware/kitchen/KitchenTicketRenderer.kt,
 * data/repo/KioskBonService.kt, hardware/printer/TillZRenderer.kt).
 *
 * The drawing (canvas, the same y-advances as the till) is renderer/print/draw.ts; the bytes are
 * core/escpos.ts. Everything is a picture: Hebrew prints exactly as drawn.
 */

import { BRAND_LABEL_HE, type CardBrand } from './nayax';
import { formatAgorot, formatShekelSign, ltr } from './money';

/* ---------------------------------------------------------- the receipt */

/** Ops in the till's 384-dot design space; the executor advances y exactly as ReceiptRenderer. */
export type ReceiptOp =
  | { t: 'logo' }
  | { t: 'gap'; h: number }
  | { t: 'text'; text: string; style: 'title' | 'heading' | 'body' | 'bodyBold' | 'small' | 'grand'; align: 'center' | 'start' }
  | { t: 'row'; label: string; value: string; style: 'body' | 'bodyBold' | 'small' | 'grand' }
  | { t: 'sub'; label: string; value: string }
  | { t: 'divider'; gap: number }
  | { t: 'footerRule' }
  | { t: 'end' };

export interface ReceiptDoc {
  kind: 'receipt';
  /** A local logo file URL (kiosk://media/...) or null for the "R2M POS" wordmark. */
  logoUrl: string | null;
  ops: ReceiptOp[];
}

export interface BusinessInfo {
  companyName: string | null;
  vatNumber: string | null;
  companyRegNumber: string | null;
  companyAddress: string | null;
  companyAddressNumber: string | null;
  companyCity: string | null;
  companyZip: string | null;
  phone: string | null;
  dealerType: string | null;
  branchId: string | null;
}

export interface ReceiptLine {
  name: string;
  qty: number;
  unitAgorot: number;
  totalAgorot: number;
  /** Paid modifiers only (free ones are not printed on the receipt). */
  paid: Array<{ text: string; priceAgorot: number }>;
}

export interface ReceiptInput {
  documentType: number;
  /** As printed: "20000057". */
  number: string;
  copy: 'original' | 'copy';
  issuedAt: Date;
  printedAt: Date;
  cashierName: string;
  business: BusinessInfo;
  lines: ReceiptLine[];
  totalAgorot: number;
  netAgorot: number;
  vatAgorot: number;
  vatRate: number;
  tipAgorot: number;
  /** The promotions the sale was priced with: "הנחת מבצע: <שם>" (the total is after them). */
  promotions?: Array<{ name: string; discountAgorot: number }>;
  card: { brand: CardBrand; last4: string | null; authNum: string | null; payments: number | null; firstPaymentAgorot: number | null } | null;
  footer: [string | null, string | null];
  logoUrl: string | null;
}

export const DEFAULT_FOOTER: [string, string] = ['ראנר מערכות קופות ממוחשבות', 'טלפון: 054-2666669'];

/** "yyyy-MM-dd HH:mm" in local time (formatLocalStamp). */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A whole number as "2", a fraction with two decimals ("0.75"). */
export function receiptQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

export function documentTitleFor(type: number): string {
  switch (type) {
    case 320:
      return 'חשבונית מס/קבלה';
    case 330:
      return 'חשבונית זיכוי';
    case 400:
      return 'קבלה';
    case -400:
      return 'קבלה – החזר כספי';
    default:
      return String(type);
  }
}

/** The registration label (DealerType.kt): עוסק פטור on a 400; עוסק מורשה for a licensed dealer; else ח.פ. */
export function regLabel(type: number, dealerType: string | null): string {
  if (type === 400 || type === -400 || dealerType === 'exempt') return 'עוסק פטור';
  return dealerType === 'licensed' ? 'עוסק מורשה' : 'ח.פ.';
}

const nonBlank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** The receipt's lines, in the till's order (ReceiptRenderer, 320 / 400). */
export function receiptDoc(r: ReceiptInput): ReceiptDoc {
  const ops: ReceiptOp[] = [];
  const b = r.business;
  ops.push({ t: 'logo' });
  ops.push({ t: 'gap', h: 8 });
  ops.push({ t: 'text', text: nonBlank(b.companyName) ?? 'POS', style: 'title', align: 'center' });
  ops.push({ t: 'text', text: `${regLabel(r.documentType, b.dealerType)} ${nonBlank(b.companyRegNumber) ?? nonBlank(b.vatNumber) ?? '—'}`, style: 'small', align: 'center' });
  const address = [nonBlank(b.companyAddress), nonBlank(b.companyAddressNumber)].filter(Boolean).join(' ');
  if (nonBlank(b.companyAddress)) ops.push({ t: 'text', text: address, style: 'small', align: 'center' });
  const city = [nonBlank(b.companyCity), nonBlank(b.companyZip)].filter(Boolean).join(' ');
  if (city) ops.push({ t: 'text', text: city, style: 'small', align: 'center' });
  if (nonBlank(b.phone)) ops.push({ t: 'text', text: `טלפון: ${b.phone!.trim()}`, style: 'small', align: 'center' });
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'text', text: documentTitleFor(r.documentType), style: 'heading', align: 'center' });
  ops.push({ t: 'text', text: r.copy === 'copy' ? 'העתק' : 'מקור', style: 'small', align: 'center' });
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'row', label: '#', value: r.number, style: 'small' });
  ops.push({ t: 'row', label: 'תאריך הנפקה:', value: stamp(r.issuedAt), style: 'small' });
  ops.push({ t: 'row', label: 'זמן הדפסה:', value: stamp(r.printedAt), style: 'small' });
  ops.push({ t: 'row', label: 'מלצר/ית', value: r.cashierName, style: 'small' });
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'row', label: 'תאור פריט', value: 'סה"כ', style: 'bodyBold' });
  ops.push({ t: 'divider', gap: 4 });
  for (const l of r.lines) {
    ops.push({ t: 'text', text: l.name, style: 'body', align: 'start' });
    for (const p of l.paid) ops.push({ t: 'sub', label: p.text, value: `(+${formatAgorot(p.priceAgorot)})` });
    ops.push({ t: 'row', label: `${receiptQty(l.qty)} × ${formatAgorot(l.unitAgorot)}`, value: formatAgorot(l.totalAgorot), style: 'small' });
  }
  ops.push({ t: 'divider', gap: 8 });
  for (const p of r.promotions ?? []) {
    if (p.discountAgorot > 0) ops.push({ t: 'row', label: `הנחת מבצע: ${p.name}`, value: formatAgorot(-p.discountAgorot), style: 'body' });
  }
  ops.push({ t: 'row', label: 'סה"כ פריטים לתשלום', value: formatAgorot(r.totalAgorot), style: 'body' });
  const showVat = r.documentType !== 400 && r.documentType !== -400;
  if (showVat) {
    ops.push({ t: 'row', label: 'סה"כ לפני מע"מ', value: formatAgorot(r.netAgorot), style: 'body' });
    ops.push({ t: 'row', label: `מע"מ ${formatRate(r.vatRate)}%`, value: formatAgorot(r.vatAgorot), style: 'body' });
  }
  if (r.tipAgorot !== 0) ops.push({ t: 'row', label: 'תשר', value: formatAgorot(r.tipAgorot), style: 'body' });
  ops.push({ t: 'divider', gap: 8 });
  const grand = r.totalAgorot + r.tipAgorot;
  ops.push({ t: 'row', label: 'סה"כ לתשלום', value: formatShekelSign(grand), style: 'grand' });
  ops.push({ t: 'divider', gap: 8 });
  if (r.card) {
    ops.push({ t: 'row', label: 'כרטיס אשראי', value: formatAgorot(grand), style: 'body' });
    const brand = BRAND_LABEL_HE[r.card.brand];
    const masked = r.card.last4 ? `**** ${r.card.last4}` : '';
    const cardText = [brand, masked].filter(Boolean).join(' ');
    if (cardText) ops.push({ t: 'row', label: 'כרטיס', value: cardText, style: 'small' });
    if (r.card.authNum) ops.push({ t: 'row', label: 'אישור', value: r.card.authNum, style: 'small' });
    if (r.card.payments && r.card.payments > 1) {
      ops.push({
        t: 'row',
        label: 'תשלומים',
        value: r.card.firstPaymentAgorot ? `${r.card.payments} × ${formatShekelSign(r.card.firstPaymentAgorot)}` : String(r.card.payments),
        style: 'small',
      });
    }
  }
  ops.push({ t: 'footerRule' });
  const footer = footerLines(r.footer);
  for (const line of footer) ops.push({ t: 'text', text: line, style: 'small', align: 'center' });
  ops.push({ t: 'end' });
  return { kind: 'receipt', logoUrl: r.logoUrl, ops };
}

/** The footer: the till parameters receipt.footer.line1/2 (null = the default, "" = no line). */
export function footerLines(params: [string | null, string | null]): string[] {
  return [0, 1]
    .map((i) => (params[i] === null || params[i] === undefined ? DEFAULT_FOOTER[i] : params[i]!.trim()))
    .filter((s): s is string => !!s);
}

/** 0.18 → "18", 0.175 → "17.5". */
export function formatRate(rate: number): string {
  const pct = Math.round(rate * 10000) / 100;
  return Number.isInteger(pct) ? String(pct) : String(pct);
}

/* ------------------------------------------------------------ the bon */

/** A kiosk bon (KitchenTicket as KioskBonService builds it), drawn natively 576 wide. */
export interface BonDoc {
  kind: 'bon';
  /** "הזמנה A-17 · דנה · שולחן 5". */
  title: string;
  /** "מכירה ⁦#20000057⁩". */
  sub: string;
  /** "הדפסה חוזרת" / "עותק 2" — a black band. */
  notice: string | null;
  dining: 'take_away' | 'eat_in';
  lines: Array<{ qty: number; name: string; detail: string | null; mods: string[]; removals: string[]; notes: string | null }>;
  foot: string[];
  printerName: string | null;
}

export interface BonInput {
  pickupLabel: string;
  customerName: string | null;
  tableRef: string | null;
  documentNumber: string;
  service: 'take_away' | 'eat_in';
  createdAt: Date;
  kioskName: string;
  posNumber: string | null;
  machineName: string | null;
  lines: Array<{ qty: number; name: string; options: string[]; notes: string | null }>;
  reprint: boolean;
  copy: number;
  printerName: string | null;
}

export function bonDoc(b: BonInput): BonDoc {
  const title = [`הזמנה ${b.pickupLabel}`, nonBlank(b.customerName), nonBlank(b.tableRef) ? `שולחן ${b.tableRef!.trim()}` : null].filter(Boolean).join(' · ');
  const notice = [b.reprint ? 'הדפסה חוזרת' : null, b.copy > 1 ? `עותק ${b.copy}` : null].filter(Boolean).join(' · ') || null;
  const source = [b.posNumber, b.machineName].filter((x) => x && String(x).trim()).join(' · ');
  return {
    kind: 'bon',
    title,
    sub: `מכירה ${ltr(`#${b.documentNumber}`)}`,
    notice,
    dining: b.service,
    lines: b.lines.map((l) => ({
      qty: l.qty,
      name: l.name,
      detail: null,
      mods: l.options.filter((o) => !o.startsWith('בלי ')).map((o) => `+ ${o}`),
      removals: l.options.filter((o) => o.startsWith('בלי ')),
      notes: nonBlank(l.notes),
    })),
    foot: [ltr(stamp(b.createdAt)), `מלצר/קופאי: ${b.kioskName}`, ...(source ? [`קופה: ${source}`] : [])],
    printerName: b.printerName,
  };
}

/* ------------------------------------------------------- the pickup slip */

export interface SlipDoc {
  kind: 'slip';
  businessName: string | null;
  heading: string;
  label: string;
  service: string;
  summary: string;
  footer: string;
}

export function slipDoc(input: { businessName: string | null; pickupLabel: string; service: 'take_away' | 'eat_in'; itemCount: number; totalAgorot: number }): SlipDoc {
  return {
    kind: 'slip',
    businessName: nonBlank(input.businessName)?.slice(0, 32) ?? null,
    heading: 'מספר ההזמנה',
    label: ltr(input.pickupLabel),
    service: input.service === 'eat_in' ? 'ישיבה במקום' : 'טייק אווי',
    summary: `${input.itemCount} פריטים · ${ltr(formatShekelSign(input.totalAgorot))}`,
    footer: 'המתינו לקריאה בדלפק',
  };
}

/* ------------------------------------------------------------ the Z */

export type ZOp =
  | { t: 'centred'; text: string; size: number; bold: boolean }
  | { t: 'row'; label: string; value: string; bold: boolean }
  | { t: 'divider' };

export interface ZDoc {
  kind: 'z';
  logoUrl: string | null;
  ops: ZOp[];
}

const money = (v: unknown): string => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 'לא ידוע';
  return formatShekelSign(Math.round(n * 100));
};
const neg = (v: unknown): string => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 'לא ידוע';
  return n === 0 ? '₪0.00' : formatShekelSign(-Math.abs(Math.round(n * 100)));
};

/** The till Z on paper (TillZRenderer), from the cloud's zReport (POST till-z answer). */
export function zDoc(z: Record<string, unknown>, opts: { business: BusinessInfo; shopName: string | null; posNumber: string | null; machineName: string | null; copy: boolean; logoUrl: string | null; printedAt: Date }): ZDoc {
  const ops: ZOp[] = [];
  const c = (text: string, size = 18, bold = false) => ops.push({ t: 'centred', text, size, bold });
  const r = (label: string, value: string, bold = false) => ops.push({ t: 'row', label, value, bold });
  const d = () => ops.push({ t: 'divider' });
  const b = opts.business;
  c(nonBlank(b.companyName) ?? 'POS', 24, true);
  c(`${regLabel(320, b.dealerType)} ${nonBlank(b.companyRegNumber) ?? nonBlank(b.vatNumber) ?? '—'}`);
  const address = [nonBlank(b.companyAddress), nonBlank(b.companyAddressNumber)].filter(Boolean).join(' ');
  if (address) c(address);
  const city = [nonBlank(b.companyCity), nonBlank(b.companyZip)].filter(Boolean).join(' ');
  if (city) c(city);
  if (opts.shopName) c(`סניף: ${opts.shopName}`);
  if (nonBlank(b.branchId)) c(`קוד סניף: ${b.branchId}`);
  const number = z.machineSequenceNumber ?? z.zNumber;
  c(`דו״ח Z מס׳ ${number ?? '?'}`, 26, true);
  if (opts.copy) c('עותק', 22, true);
  c(`קופה ${opts.posNumber ?? opts.machineName ?? ''}`.trim(), 22, true);
  d();
  r('תאריך הנפקה:', stamp(opts.printedAt));
  if (typeof z.businessDate === 'string') r('תאריך עסקים:', z.businessDate);
  if (typeof z.periodStart === 'string') r('תחילת תקופה:', stamp(new Date(z.periodStart)));
  if (typeof z.periodEnd === 'string') r('סיום תקופה:', stamp(new Date(z.periodEnd)));
  const per = Array.isArray(z.perMachine) && z.perMachine[0] && typeof z.perMachine[0] === 'object' ? (z.perMachine[0] as Record<string, unknown>) : {};
  if (per.firstShiftSequence !== undefined && per.firstShiftSequence !== null) {
    r('משמרות', `#${per.firstShiftSequence}–#${per.lastShiftSequence} (${per.shiftCount ?? z.shiftCount ?? ''})`);
  }
  const ranges = Array.isArray(per.documentRanges) ? (per.documentRanges as Array<Record<string, unknown>>) : [];
  const rangeLabel: Record<string, string> = { '320': 'חשבוניות מס קבלה', '330': 'חשבוניות זיכוי', '400': 'קבלות' };
  for (const rg of ranges) {
    const label = rangeLabel[String(rg.documentType)] ?? `מסמכים ${rg.documentType}`;
    r(label, rg.first === rg.last ? String(rg.first) : `${rg.first}–${rg.last}`);
  }
  r('מסמכים', String(z.transactionsCount ?? per.transactionsCount ?? 0));
  d();
  r('מכירות ברוטו', money(z.grossSales));
  r('הנחות', neg(z.discountsTotal));
  r('זיכויים', neg(z.totalRefunds));
  r('סה"כ נטו', money(z.netSales ?? z.totalSales), true);
  d();
  r('מזומן', money(z.totalCashSales));
  r('כרטיס אשראי', money(z.totalCardSales));
  r('מע"מ', money(z.vatTotal));
  const tips = Number(z.totalTips ?? 0);
  if (Number.isFinite(tips) && tips !== 0) r('תשר', money(z.totalTips));
  d();
  c('מגירה', 20, true);
  r('קופה פותחת', money(z.openingCash));
  r('מזומן צפוי', money(z.expectedCash), true);
  r('מזומן שנספר', z.actualCash === null || z.actualCash === undefined ? 'לא נספר' : money(z.actualCash));
  const ct = z.cardTransmission && typeof z.cardTransmission === 'object' ? (z.cardTransmission as Record<string, unknown>) : null;
  if (ct) {
    d();
    const outcome = ct.outcome === 'success' ? `אושר — אצווה ${ct.batchNumber ?? ''}`.trim() : ct.outcome === 'skipped' ? 'אין עסקאות לשידור' : 'נכשל';
    r('שידור אשראי', outcome, true);
    if (ct.outcome !== 'success' && ct.outcome !== 'skipped' && (ct.statusMessage || ct.error)) c(String(ct.statusMessage || ct.error), 16);
  }
  d();
  c(`הופק ע״י ${typeof z.createdByName === 'string' ? z.createdByName : 'הקיוסק'}`);
  return { kind: 'z', logoUrl: opts.logoUrl, ops };
}

export type PrintDoc = ReceiptDoc | BonDoc | SlipDoc | ZDoc;
