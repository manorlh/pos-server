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
  | { t: 'text'; text: string; style: 'title' | 'heading' | 'body' | 'bodyBold' | 'small' | 'grand' | 'number'; align: 'center' | 'start' }
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
  /**
   * A till sale's tenders, in the order taken, with what the customer handed over and the change (ReceiptRenderer:
   * one cash tender prints "מזומן" with the note handed over and "עודף"; several print every leg, then the change).
   * Absent: the kiosk's one card payment.
   */
  tenders?: Array<{ method: 'cash' | 'card'; amountAgorot: number }>;
  tenderedAgorot?: number | null;
  changeAgorot?: number | null;
  footer: [string | null, string | null];
  logoUrl: string | null;
  /** Where it was issued — the shop, the till's number and name ([placeLine]); absent: no line. */
  place?: { shopName: string | null; posNumber: string | null; deviceName: string | null } | null;
  /**
   * "מספר הזמנה A-1" — the kiosk's order (pickup) number, large, near the top (`printing.orderNumberOnReceipt`,
   * the owner 08.10.2026: one paper). Absent / null / blank: no block (as before).
   */
  orderNumber?: string | null;
}

/**
 * The place line every printed document carries under the business (the owner, 07.10.2026):
 * "סניף הרצליה · קופה 3 · קיוסק רויאל". A shop already named "סניף …" is not prefixed again; a
 * till named as the shop or as its number says it once; nothing known — null. The same rule as
 * pos-android domain/Receipt.kt ReceiptPlace and the cloud's print_documents.place_line, pinned by
 * test/fixtures/receipt_place_cases.json (the same bytes in both repos).
 */
export function placeLine(shopName: string | null | undefined, posNumber: string | null | undefined, deviceName: string | null | undefined): string | null {
  const shopRaw = (shopName ?? '').trim() || null;
  const shop = shopRaw === null ? null : shopRaw.startsWith('סניף') ? shopRaw : `סניף ${shopRaw}`;
  const number = (posNumber ?? '').trim();
  const till = number ? `קופה ${number}` : null;
  let device = (deviceName ?? '').trim() || null;
  if (device !== null && (device === shopRaw || device === shop || device === till)) device = null;
  const line = [shop, till, device].filter((p): p is string => !!p).join(' · ');
  return line || null;
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
  // "סניף הרצליה · קופה 3 · קיוסק רויאל" — where it was issued, on the copies too.
  const issued = r.place ? placeLine(r.place.shopName, r.place.posNumber, r.place.deviceName) : null;
  if (issued) ops.push({ t: 'text', text: issued, style: 'small', align: 'center' });
  // "מספר הזמנה" and the number, big — what the customer waits to hear (pos-android ReceiptRenderer).
  const orderNumber = nonBlank(r.orderNumber ?? null);
  if (orderNumber) {
    ops.push({ t: 'divider', gap: 8 });
    ops.push({ t: 'text', text: 'מספר הזמנה', style: 'heading', align: 'center' });
    ops.push({ t: 'text', text: ltr(orderNumber), style: 'number', align: 'center' });
    ops.push({ t: 'gap', h: 6 });
  }
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
  const tenders = r.tenders ?? [];
  if (tenders.length > 1) {
    // A split: every leg on the paper, in the order handed over, then the change.
    const masked = r.card?.last4 ? `**** ${r.card.last4}` : '';
    for (const t of tenders) {
      const label = t.method === 'cash' ? 'מזומן' : masked ? `כרטיס אשראי ⁦${masked}⁩` : 'כרטיס אשראי';
      ops.push({ t: 'row', label, value: formatAgorot(t.amountAgorot), style: 'body' });
    }
    if ((r.changeAgorot ?? 0) > 0) ops.push({ t: 'row', label: 'עודף', value: formatAgorot(r.changeAgorot!), style: 'bodyBold' });
  } else if (tenders.length === 1 && tenders[0].method === 'cash') {
    ops.push({ t: 'row', label: 'מזומן', value: formatAgorot(r.tenderedAgorot ?? grand), style: 'body' });
    if ((r.changeAgorot ?? 0) > 0) ops.push({ t: 'row', label: 'עודף', value: formatAgorot(r.changeAgorot!), style: 'bodyBold' });
  }
  if (r.card) {
    if (tenders.length <= 1) ops.push({ t: 'row', label: 'כרטיס אשראי', value: formatAgorot(grand), style: 'body' });
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
  /** Null: the order has no service ("ללא סוג שירות") — no band. */
  dining: 'take_away' | 'eat_in' | null;
  lines: Array<{ qty: number; name: string; detail: string | null; mods: string[]; removals: string[]; notes: string | null }>;
  foot: string[];
  printerName: string | null;
}

export interface BonInput {
  pickupLabel: string;
  customerName: string | null;
  tableRef: string | null;
  documentNumber: string;
  service: 'take_away' | 'eat_in' | null;
  createdAt: Date;
  kioskName: string;
  posNumber: string | null;
  machineName: string | null;
  lines: Array<{ qty: number; name: string; options: string[]; notes: string | null }>;
  reprint: boolean;
  copy: number;
  printerName: string | null;
  /** In place of "מכירה #…": an order not paid yet ("ממתין לתשלום בקופה"). */
  sub?: string | null;
}

export function bonDoc(b: BonInput): BonDoc {
  const title = [`הזמנה ${b.pickupLabel}`, nonBlank(b.customerName), nonBlank(b.tableRef) ? `שולחן ${b.tableRef!.trim()}` : null].filter(Boolean).join(' · ');
  const notice = [b.reprint ? 'הדפסה חוזרת' : null, b.copy > 1 ? `עותק ${b.copy}` : null].filter(Boolean).join(' · ') || null;
  const source = [b.posNumber, b.machineName].filter((x) => x && String(x).trim()).join(' · ');
  return {
    kind: 'bon',
    title,
    sub: b.sub ?? `מכירה ${ltr(`#${b.documentNumber}`)}`,
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
  /** "טייק אווי" / "ישיבה במקום"; null — the order has none (no line). */
  service: string | null;
  summary: string;
  footer: string;
}

export function slipDoc(input: { businessName: string | null; pickupLabel: string; service: 'take_away' | 'eat_in' | null; itemCount: number; totalAgorot: number }): SlipDoc {
  return {
    kind: 'slip',
    businessName: nonBlank(input.businessName)?.slice(0, 32) ?? null,
    heading: 'מספר ההזמנה',
    label: ltr(input.pickupLabel),
    service: input.service === null ? null : input.service === 'eat_in' ? 'ישיבה במקום' : 'טייק אווי',
    summary: `${input.itemCount} פריטים · ${ltr(formatShekelSign(input.totalAgorot))}`,
    footer: 'המתינו לקריאה בדלפק',
  };
}

/* ------------------------------------------------------- an item ticket */

/** An item ticket ("שובר", pos-android hardware/printer/ItemTicketRenderer.kt), drawn at 384 and scaled. */
export interface TicketDoc {
  kind: 'ticket';
  businessName: string;
  /** The shop, under the business when it is not the same name. */
  shopName: string | null;
  /** "שובר", or "שובר ⁦2/5⁩" when the sale prints several. */
  title: string;
  /** One item: its name and its quantity big; several: a row each. */
  items: Array<{ name: string; qty: string }>;
  /** The time, the till ("קופה: … · מס' קופה: …"), the sale's number. */
  foot: string[];
}

export function ticketDoc(input: {
  businessName: string | null;
  shopName: string | null;
  machineName: string | null;
  posNumber: string | null;
  transactionNumber: string | null;
  issuedAt: Date;
  items: Array<{ name: string; quantity: number; unitLabel?: string | null; entry?: number | null; entries?: number | null }>;
  index: number;
  count: number;
}): TicketDoc {
  const business = nonBlank(input.businessName) ?? nonBlank(input.shopName) ?? 'POS';
  const shop = nonBlank(input.shopName);
  const qty = (i: { quantity: number; unitLabel?: string | null }) =>
    nonBlank(i.unitLabel ?? null) ? `${receiptQty(i.quantity)} ${i.unitLabel!.trim()}` : receiptQty(i.quantity);
  const till = [
    nonBlank(input.machineName) ? `קופה: ${input.machineName!.trim()}` : null,
    nonBlank(input.posNumber) ? `מס' קופה: ${ltr(input.posNumber!.trim())}` : null,
  ].filter(Boolean).join('  ·  ');
  return {
    kind: 'ticket',
    businessName: business,
    shopName: shop && shop !== business ? shop : null,
    title: input.count > 1 ? `שובר ${ltr(`${input.index}/${input.count}`)}` : 'שובר',
    items: input.items.map((i) => ({
      name: i.name,
      qty: i.entry && i.entries ? `כניסה ${ltr(`${i.entry}/${i.entries}`)}` : ltr(`× ${qty(i)}`),
    })),
    foot: [stamp(input.issuedAt), ...(till ? [till] : []), ...(nonBlank(input.transactionNumber) ? [`עסקה ${ltr(`#${input.transactionNumber!.trim()}`)}`] : [])],
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

/** What an X report is drawn from: the shift, its figures (core/sale.ts buildXTill) and who took it. */
export interface XInput {
  business: BusinessInfo;
  shopName: string | null;
  posNumber: string | null;
  machineName: string | null;
  cashierName: string;
  shiftNumber: number | null;
  businessDate: string | null;
  openedAt: Date;
  /** The close, or null on an interim X (the window has no end yet: "נכון לשעה"). */
  closedAt: Date | null;
  printedAt: Date;
  copy: boolean;
  logoUrl: string | null;
  /** buildXTill's figures, in shekels. */
  till: {
    openingCash: number;
    expectedCash: number;
    totalSales: number;
    totalDiscounts: number;
    totalRefunds: number;
    totalCash: number;
    totalCard: number;
    totalTips: number;
    vatTotal?: number;
    transactionsCount: number;
    itemsCount: number;
  };
  /** Counted cash on the close (shekels), null on an interim X or an uncounted close. */
  countedCash: number | null;
}

/**
 * The X report on paper — the Android till's ReportRenderer in the Z's own ops (centred / row / divider): who issued it,
 * the title ("דו״ח X ביניים" or "דו״ח X – סגירת משמרת #N"), the window, the takings (gross, discounts, refunds, net),
 * cash / card / VAT / tips, the counts and the drawer (opening float, expected, counted, variance).
 */
export function xDoc(x: XInput): ZDoc {
  const ops: ZOp[] = [];
  const c = (text: string, size = 18, bold = false) => ops.push({ t: 'centred', text, size, bold });
  const r = (label: string, value: string, bold = false) => ops.push({ t: 'row', label, value, bold });
  const d = () => ops.push({ t: 'divider' });
  const b = x.business;
  const t = x.till;
  c(nonBlank(b.companyName) ?? 'POS', 24, true);
  c(`${regLabel(320, b.dealerType)} ${nonBlank(b.companyRegNumber) ?? nonBlank(b.vatNumber) ?? '—'}`);
  if (x.shopName) c(`סניף: ${x.shopName}`, 20, true);
  const tillLine = [x.posNumber ? `קופה ${x.posNumber.trim()}` : null, nonBlank(x.machineName)].filter((v): v is string => !!v).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
  if (tillLine) c(tillLine, 20, true);
  c(x.closedAt ? `דו״ח X – סגירת משמרת #${x.shiftNumber ?? ''}`.trim() : 'דו״ח X ביניים', 26, true);
  if (x.copy) c('העתק', 22, true);
  d();
  r('תאריך הנפקה:', stamp(x.printedAt));
  if (x.businessDate) r('תאריך עסקים:', x.businessDate);
  r('מלצר/ית', x.cashierName);
  r('תחילת משמרת:', stamp(x.openedAt));
  r(x.closedAt ? 'סיום משמרת:' : 'נכון לשעה:', stamp(x.closedAt ?? x.printedAt));
  d();
  r('מכירות ברוטו', money(t.totalSales));
  r('הנחות', neg(t.totalDiscounts));
  r('זיכויים', neg(t.totalRefunds));
  r('סה"כ נטו', money(t.totalSales - t.totalDiscounts - t.totalRefunds), true);
  d();
  r('מזומן', money(t.totalCash));
  r('כרטיס אשראי', money(t.totalCard));
  if (b.dealerType === 'exempt') r('מע"מ', 'עוסק פטור — ללא מע״מ');
  else r('מע"מ', money(t.vatTotal ?? 0));
  if (t.totalTips !== 0) r('תשר', money(t.totalTips));
  r('סה"כ פריטים', String(t.itemsCount));
  r('מסמכים', String(t.transactionsCount));
  d();
  r('קופה פותחת', money(t.openingCash));
  r('מזומן צפוי', money(t.expectedCash), true);
  if (x.closedAt) {
    if (x.countedCash === null) r('מזומן שנספר', 'לא נספר');
    else {
      r('מזומן שנספר', money(x.countedCash));
      r('הפרש', money(Math.round((x.countedCash - t.expectedCash) * 100) / 100), true);
    }
  }
  return { kind: 'z', logoUrl: x.logoUrl, ops };
}

export type PrintDoc = ReceiptDoc | BonDoc | SlipDoc | ZDoc | TicketDoc;
