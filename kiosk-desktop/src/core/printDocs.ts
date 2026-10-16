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
import { isTemplate, resolveStyle, type KitchenTicket, type TicketStyle } from './kitchenTicketStyle';
import type { KitchenDoc } from './kitchen/doc';

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
  /** A QR code (centred): a cash credit's "CC:<code>" (P:/specs/cash-paylink.md §11.15א). */
  | { t: 'qr'; value: string; size: number }
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
  /** OTH ("על חשבון הבית"): printed at ₪0 with "OTH — <reason>" under it. */
  oth?: string | null;
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
  /** The discount vouchers ("שוברי הנחה"): "שובר #12 — פסטיבל הקיץ  −30.00" under the items — part of the discount, not a payment. */
  voucherDiscounts?: Array<{ label: string; amountAgorot: number }>;
  /** The goods vouchers that paid part of it: each a "שובר הפקה" leg in the payment (the card's leg is the rest). */
  voucherLegs?: Array<{ amountAgorot: number }>;
  card: { brand: CardBrand; last4: string | null; authNum: string | null; payments: number | null; firstPaymentAgorot: number | null } | null;
  /**
   * "מזומן" at the cash station (`cashReceiptLines`): שולם / עודף, what is owed and its code, the rounding; what the
   * customer chose for change owed (§11.15א: a slip, a credit, a tip) and a split's cash part (§11.15ב).
   */
  cash?: {
    receivedAgorot: number;
    changeAgorot: number;
    changeOwedAgorot: number;
    roundingAgorot: number;
    slipCode: string | null;
    lines: boolean;
    changeOwedAs?: 'slip' | 'credit' | 'tip' | null;
    splitAgorot?: number;
  } | null;
  /** Cash credits redeemed towards it ("זיכוי מזומן C-K7Q3MX"), legs of the payment. */
  creditLegs?: Array<{ code: string; amountAgorot: number }>;
  /**
   * A till sale's tenders, in the order taken, with what the customer handed over and the change (ReceiptRenderer:
   * one cash tender prints "מזומן" with the note handed over and "עודף"; several print every leg, then the change).
   * Absent: the kiosk's one card payment.
   */
  tenders?: Array<{ method: 'cash' | 'card' | 'exchange'; amountAgorot: number }>;
  tenderedAgorot?: number | null;
  changeAgorot?: number | null;
  /**
   * A till's discounts by hand (the line's, the basket's — OTH excluded, printed at ₪0 on its line): "סה״כ פריטים" (the
   * gross) and "הנחה" before the payable (ReceiptRenderer). Absent / 0: no rows (as before).
   */
  manualDiscountAgorot?: number;
  /** A credit note: the document it credits ("זיכוי עבור מסמך #20000057"). */
  refundOfNumber?: string | null;
  /** A credit note: the customer it went to, as taken down at the till. */
  customer?: { name: string; phone: string | null; address: string | null } | null;
  /** The shop's copy of a credit note: "העתק לבית העסק" and a line for the customer's signature. */
  merchantCopy?: boolean;
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
  ops.push({ t: 'text', text: r.merchantCopy ? 'העתק לבית העסק' : r.copy === 'copy' ? 'העתק' : 'מקור', style: 'small', align: 'center' });
  const credit = r.documentType === 330 || r.documentType === -400;
  if (credit && nonBlank(r.refundOfNumber ?? null)) ops.push({ t: 'text', text: `זיכוי עבור מסמך #${r.refundOfNumber!.trim()}`, style: 'small', align: 'center' });
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'row', label: '#', value: r.number, style: 'small' });
  ops.push({ t: 'row', label: 'תאריך הנפקה:', value: stamp(r.issuedAt), style: 'small' });
  ops.push({ t: 'row', label: 'זמן הדפסה:', value: stamp(r.printedAt), style: 'small' });
  ops.push({ t: 'row', label: 'מלצר/ית', value: r.cashierName, style: 'small' });
  // The buyer a return went to: required on paper, so it is printed as taken down.
  if (r.customer && (nonBlank(r.customer.name) || nonBlank(r.customer.phone) || nonBlank(r.customer.address))) {
    if (nonBlank(r.customer.name)) ops.push({ t: 'row', label: 'שם הלקוח:', value: r.customer.name.trim(), style: 'small' });
    if (nonBlank(r.customer.phone)) ops.push({ t: 'row', label: 'טלפון:', value: r.customer.phone!.trim(), style: 'small' });
    if (nonBlank(r.customer.address)) ops.push({ t: 'row', label: 'כתובת:', value: r.customer.address!.trim(), style: 'small' });
  }
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'row', label: 'תאור פריט', value: 'סה"כ', style: 'bodyBold' });
  ops.push({ t: 'divider', gap: 4 });
  for (const l of r.lines) {
    ops.push({ t: 'text', text: l.name, style: 'body', align: 'start' });
    for (const p of l.paid) ops.push({ t: 'sub', label: p.text, value: `(+${formatAgorot(p.priceAgorot)})` });
    // A line given free ("על חשבון הבית"): its list price above, ₪0 here, and why.
    ops.push({ t: 'row', label: `${receiptQty(l.qty)} × ${formatAgorot(l.unitAgorot)}`, value: formatAgorot(l.oth ? 0 : l.totalAgorot), style: 'small' });
    if (l.oth) ops.push({ t: 'text', text: `OTH — ${l.oth}`, style: 'small', align: 'start' });
  }
  ops.push({ t: 'divider', gap: 8 });
  for (const p of r.promotions ?? []) {
    if (p.discountAgorot > 0) ops.push({ t: 'row', label: `הנחת מבצע: ${p.name}`, value: formatAgorot(-p.discountAgorot), style: 'body' });
  }
  // Each discount voucher ("שובר #12 — <סדרה>"): part of the discount, never a payment (the till's receipt).
  for (const v of r.voucherDiscounts ?? []) {
    if (v.amountAgorot > 0) ops.push({ t: 'row', label: v.label, value: formatAgorot(-v.amountAgorot), style: 'body' });
  }
  // The till's discounts by hand: the gross first, then what came off, then the payable (ReceiptRenderer).
  const manual = Math.max(0, r.manualDiscountAgorot ?? 0);
  if (manual > 0) {
    ops.push({ t: 'row', label: 'סה"כ פריטים', value: formatAgorot(r.totalAgorot + manual), style: 'body' });
    ops.push({ t: 'row', label: 'הנחה', value: formatAgorot(-manual), style: 'body' });
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
  // The goods vouchers' legs ("שובר הפקה"), then the card's: what they did not pay, and the tip.
  const legs = [...(r.voucherLegs ?? []), ...(r.creditLegs ?? [])].filter((l) => l.amountAgorot > 0);
  for (const l of (r.voucherLegs ?? []).filter((x) => x.amountAgorot > 0)) ops.push({ t: 'row', label: 'שובר הפקה', value: formatAgorot(l.amountAgorot), style: 'body' });
  for (const l of (r.creditLegs ?? []).filter((x) => x.amountAgorot > 0)) ops.push({ t: 'row', label: `זיכוי מזומן ${ltr(l.code)}`, value: formatAgorot(l.amountAgorot), style: 'body' });
  // Cash + card (§11.15ב): the cash part first, the card the rest (and the tip).
  const splitCash = r.cash && r.card ? Math.max(0, r.cash.splitAgorot ?? 0) : 0;
  // A till sale's tenders (the kiosk has none): a split prints every leg in the order handed over, then the change; an
  // `exchange` leg is the returns of the same basket ("קיזוז החלפה"). A credit note states what was credited, then how.
  const tenders = r.tenders ?? [];
  const legLabel = (method: string) => {
    const masked = r.card?.last4 ? `**** ${r.card.last4}` : '';
    if (method === 'cash') return 'מזומן';
    if (method === 'exchange') return 'קיזוז החלפה';
    return masked ? `כרטיס אשראי ⁦${masked}⁩` : 'כרטיס אשראי';
  };
  if (credit && tenders.length > 0) {
    ops.push({ t: 'row', label: 'סכום זיכוי', value: formatAgorot(r.totalAgorot), style: 'body' });
    for (const t of tenders) ops.push({ t: 'row', label: legLabel(t.method), value: formatAgorot(t.amountAgorot), style: 'body' });
  } else if (tenders.length > 1 || tenders.some((t) => t.method === 'exchange')) {
    for (const t of tenders) ops.push({ t: 'row', label: legLabel(t.method), value: formatAgorot(t.amountAgorot), style: 'body' });
    if ((r.changeAgorot ?? 0) > 0) ops.push({ t: 'row', label: 'עודף', value: formatAgorot(r.changeAgorot!), style: 'bodyBold' });
  } else if (tenders.length === 1 && tenders[0].method === 'cash') {
    ops.push({ t: 'row', label: 'מזומן', value: formatAgorot(r.tenderedAgorot ?? grand), style: 'body' });
    if ((r.changeAgorot ?? 0) > 0) ops.push({ t: 'row', label: 'עודף', value: formatAgorot(r.changeAgorot!), style: 'bodyBold' });
  }
  if (r.card) {
    if (tenders.length <= 1 && !credit) ops.push({ t: 'row', label: 'כרטיס אשראי', value: formatAgorot(grand - legs.reduce((s, l) => s + l.amountAgorot, 0) - splitCash), style: 'body' });
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
  if (r.cash) {
    const due = splitCash > 0 ? splitCash : grand - legs.reduce((s, l) => s + l.amountAgorot, 0);
    ops.push({ t: 'row', label: 'מזומן', value: formatAgorot(due), style: 'body' });
    if (r.cash.lines) {
      if (r.cash.roundingAgorot !== 0) ops.push({ t: 'row', label: 'עיגול מזומן', value: formatAgorot(r.cash.roundingAgorot), style: 'small' });
      ops.push({ t: 'row', label: 'שולם במזומן', value: formatAgorot(r.cash.receivedAgorot), style: 'small' });
      ops.push({ t: 'row', label: 'עודף', value: formatAgorot(r.cash.changeAgorot), style: 'small' });
    }
    // Change owed (§11.15א): a slip for the till, a credit for the next order; left as a tip it is the "תשר" row above.
    if (r.cash.changeOwedAgorot > 0 && r.cash.changeOwedAs !== 'tip') {
      const credit = r.cash.changeOwedAs === 'credit';
      ops.push({ t: 'row', label: credit ? 'זיכוי להזמנה הבאה' : 'עודף חייב', value: formatAgorot(r.cash.changeOwedAgorot), style: 'bodyBold' });
      if (r.cash.slipCode) ops.push({ t: 'row', label: 'קוד', value: ltr(r.cash.slipCode), style: 'small' });
    }
  }
  if (r.merchantCopy) {
    // The customer signs the shop's copy for the money they took back.
    ops.push({ t: 'gap', h: 30 });
    ops.push({ t: 'row', label: 'חתימת הלקוח:', value: '', style: 'body' });
    ops.push({ t: 'divider', gap: 24 });
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
  /**
   * "עיצוב בון" (pos-server P:/specs/kitchen-ticket-designs.md §10): the bon as the till's ticket and
   * the look it prints in (core/kitchenTicketStyle.ts — the dashboard's preview engine, byte for
   * byte); absent — the cloud predates the designs: drawn as before.
   */
  ticket?: KitchenTicket;
  style?: TicketStyle;
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

/** The till parameters' defaults: a value equal to one is not taken as set (the kiosk gets resolved values). */
const TICKET_PARAM_DEFAULTS: Record<string, unknown> = {
  kitchenTicketFontScale: 100,
  kitchenTicketHeader: 'table,guests,waiter,time,till,order,customer',
  kitchenTicketCheckboxes: false,
  kitchenTicketElapsed: false,
  kitchenTicketFit: 'fit',
  kitchenTicketMinTextSize: 's',
  kitchenTicketMaxTextSize: 'm',
  kitchenTicketHeaderSize: 'm',
  kitchenTicketInlineMods: true,
  kitchenTicketOrder: 'added',
  kitchenTicketOrderList: '',
  kitchenTicketGroupHeaders: 'auto',
  kitchenTicketNoCourse: 'last',
};

/**
 * The kiosk bon's look from the kiosk's till parameters (`kitchenTicketDesign` and its options). Its
 * own printer is no kitchen printer of the shop, so the parameters alone decide: a template (a named
 * design's id — the kiosk has no designs — prints `classic`), the options that differ from their
 * defaults, the ink saver (on unless off). Null — a cloud that predates the designs, or the ticket of
 * before with the ink saver off: drawn exactly as before.
 */
export function kioskBonStyle(params: Record<string, unknown>): TicketStyle | null {
  const design = params.kitchenTicketDesign;
  if (design === undefined || design === null) return null;
  const template = isTemplate(design) ? design : 'classic';
  const ink = params.kitchenTicketInkSaver !== false;
  if (template === 'classic_legacy' && !ink) return null;
  const set: Record<string, unknown> = { kitchenTicketInkSaver: ink };
  for (const [key, def] of Object.entries(TICKET_PARAM_DEFAULTS)) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== def) set[key] = params[key];
  }
  return resolveStyle(template, { params: set });
}

/** The bon as the till's ticket (KioskBonService's): the order's label as its headline. */
export function bonTicket(b: BonInput): KitchenTicket {
  const title = [`הזמנה ${b.pickupLabel}`, nonBlank(b.customerName), nonBlank(b.tableRef) ? `שולחן ${b.tableRef!.trim()}` : null].filter(Boolean).join(' · ');
  const source = [b.posNumber, b.machineName].filter((x) => x && String(x).trim()).join(' · ');
  return {
    source: 'sale',
    customerName: title,
    orderRef: b.sub ? null : nonBlank(b.documentNumber),
    waiterName: b.kioskName,
    createdAt: b.createdAt.toISOString(),
    sourceName: source || null,
    dining: b.service,
    // "ממתין לתשלום בקופה", "הדפסה חוזרת", "עותק 2": each in its band.
    notice: [nonBlank(b.sub ?? null), b.reprint ? 'הדפסה חוזרת' : null, b.copy > 1 ? `עותק ${b.copy}` : null].filter(Boolean).join(' · ') || null,
    lines: b.lines.map((l) => ({
      name: l.name,
      quantity: l.qty,
      mods: l.options.filter((o) => !o.startsWith('בלי ')).map((o) => `+ ${o}`),
      removals: l.options.filter((o) => o.startsWith('בלי ')),
      notes: nonBlank(l.notes),
    })),
  };
}

export function bonDoc(b: BonInput, style: TicketStyle | null = null): BonDoc {
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
    ...(style ? { ticket: bonTicket(b), style } : {}),
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

/* ------------------------------------------------------- "לתשלום בקופה" (an order no till can see yet) */

/**
 * The Android kiosk's cash slip (pos-android domain/KioskPayAtTill.kt KioskCashSlip, KioskCashSlipRenderer): the
 * business, "לתשלום בקופה", the number big, what to pay, the items, what the amount already counts (vouchers, the
 * tip), the order's QR ("KO:<id>"), the time, the footer — and "הזמנה ממתינה לסנכרון" while neither the cloud nor
 * the shop's LAN host has the order. The words come from the kiosk's texts (the caller). Drawn as a receipt page.
 */
export function payAtTillSlipDoc(input: {
  businessName: string | null;
  title: string;
  label: string;
  amountLabel: string;
  dueAgorot: number;
  lines: ReadonlyArray<{ name: string; quantity: number; totalAgorot: number }>;
  notes: readonly string[];
  code: string;
  at: Date;
  footer: string;
  pending: string | null;
}): ReceiptDoc {
  const ops: ReceiptOp[] = [];
  ops.push({ t: 'text', text: nonBlank(input.businessName) ?? 'R2M', style: 'title', align: 'center' });
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'text', text: input.title, style: 'heading', align: 'center' });
  ops.push({ t: 'text', text: ltr(input.label), style: 'number', align: 'center' });
  ops.push({ t: 'row', label: input.amountLabel, value: ltr(formatShekelSign(input.dueAgorot)), style: 'grand' });
  ops.push({ t: 'divider', gap: 8 });
  for (const l of input.lines) {
    const q = Number.isInteger(l.quantity) ? String(l.quantity) : l.quantity.toFixed(3);
    ops.push({ t: 'row', label: `${q} × ${l.name}`, value: formatAgorot(l.totalAgorot), style: 'body' });
  }
  for (const n of input.notes) ops.push({ t: 'text', text: n, style: 'small', align: 'center' });
  ops.push({ t: 'divider', gap: 8 });
  ops.push({ t: 'qr', value: input.code, size: 200 });
  ops.push({ t: 'text', text: stamp(input.at), style: 'small', align: 'center' });
  ops.push({ t: 'text', text: input.footer, style: 'bodyBold', align: 'center' });
  if (input.pending) ops.push({ t: 'text', text: input.pending, style: 'bodyBold', align: 'center' });
  ops.push({ t: 'end' });
  return { kind: 'receipt', logoUrl: null, ops };
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
    /** "מגירת מזומן" (core/till/drawer.ts tillWithDrawer): only when not zero, already in expectedCash. */
    cashIn?: number;
    cashOut?: number;
    deposits?: number;
    walletIn?: number;
    walletDeposits?: number;
  };
  /** Counted cash on the close (shekels), null on an interim X or an uncounted close. */
  countedCash: number | null;
  /** "ספירה עיוורת" (`cashDrawer.blindCount`): the interim X does not state the expected cash (Android DrawerCount.InterimBlind). */
  blindCount?: boolean;
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
  // The drawer's movements and the employees' cash (drawer spec §8, drawer-away §5.6): each only when it moved something.
  if (t.cashIn) r('הכנסות', money(t.cashIn));
  if (t.cashOut) r('הוצאות', neg(t.cashOut));
  if (t.deposits) r('הפקדות', neg(t.deposits));
  if (t.walletIn) r('הכסף אצל עובדים', neg(t.walletIn));
  if (t.walletDeposits) r('הפקדות מעובדים', money(t.walletDeposits));
  if (x.closedAt || !x.blindCount) r('מזומן צפוי', money(t.expectedCash), true);
  if (x.closedAt) {
    if (x.countedCash === null) r('מזומן שנספר', 'לא נספר');
    else {
      r('מזומן שנספר', money(x.countedCash));
      r('הפרש', money(Math.round((x.countedCash - t.expectedCash) * 100) / 100), true);
    }
  }
  return { kind: 'z', logoUrl: x.logoUrl, ops };
}

/** `kitchen`: a kitchen printer's ticket (core/kitchen/doc.ts, main/kitchen/kitchenService.ts). */
export type PrintDoc = ReceiptDoc | BonDoc | SlipDoc | ZDoc | TicketDoc | KitchenDoc;

/* ------------------------------------------------------- the cash station's slips (P:/specs/cash-paylink.md §11.7) */

/**
 * "עודף חייב" — change the station could not pay (notify, §9א): the amount, the order, the code the
 * till's "שולם ללקוח" finds, the station. And the fault slip — a payment the station holds or that
 * went silent: the transaction, what went in, "פנו לצוות". Drawn as a receipt page (ops).
 */
export function cashSlipDoc(input: {
  kind: 'change_owed' | 'credit' | 'fault';
  businessName: string | null;
  amountAgorot: number;
  orderLabel: string | null;
  slipCode: string | null;
  txShort: string;
  stationName: string | null;
  at: Date;
}): ReceiptDoc {
  const ops: ReceiptOp[] = [];
  ops.push({ t: 'text', text: nonBlank(input.businessName) ?? 'R2M', style: 'title', align: 'center' });
  ops.push({ t: 'divider', gap: 8 });
  if (input.kind === 'change_owed') {
    ops.push({ t: 'text', text: 'עודף חייב', style: 'heading', align: 'center' });
    ops.push({ t: 'text', text: ltr(formatShekelSign(input.amountAgorot)), style: 'number', align: 'center' });
    if (input.orderLabel) ops.push({ t: 'row', label: 'הזמנה', value: ltr(input.orderLabel), style: 'body' });
    if (input.slipCode) ops.push({ t: 'row', label: 'קוד', value: ltr(input.slipCode), style: 'bodyBold' });
    ops.push({ t: 'divider', gap: 8 });
    ops.push({ t: 'text', text: 'מכשיר המזומן לא יכול היה לתת את כל העודף.', style: 'small', align: 'center' });
    ops.push({ t: 'text', text: 'גשו עם הפתק לקופה ותקבלו את העודף.', style: 'bodyBold', align: 'center' });
  } else if (input.kind === 'credit') {
    // "זיכוי להזמנה הבאה" (§11.15א): the code and its QR ("CC:" + the code), redeemed at a till or a kiosk.
    ops.push({ t: 'text', text: 'זיכוי להזמנה הבאה', style: 'heading', align: 'center' });
    ops.push({ t: 'text', text: ltr(formatShekelSign(input.amountAgorot)), style: 'number', align: 'center' });
    if (input.slipCode) {
      ops.push({ t: 'qr', value: `CC:${input.slipCode}`, size: 200 });
      ops.push({ t: 'row', label: 'קוד', value: ltr(input.slipCode), style: 'bodyBold' });
    }
    if (input.orderLabel) ops.push({ t: 'row', label: 'הזמנה', value: ltr(input.orderLabel), style: 'body' });
    ops.push({ t: 'divider', gap: 8 });
    ops.push({ t: 'text', text: 'מכשיר המזומן לא יכול היה לתת את כל העודף.', style: 'small', align: 'center' });
    ops.push({ t: 'text', text: 'הציגו את הפתק בקופה או סרקו אותו בקיוסק בהזמנה הבאה.', style: 'bodyBold', align: 'center' });
  } else {
    ops.push({ t: 'text', text: 'תקלה במזומן — פנו לצוות', style: 'heading', align: 'center' });
    if (input.amountAgorot > 0) ops.push({ t: 'row', label: 'הוכנסו', value: formatAgorot(input.amountAgorot), style: 'body' });
    if (input.orderLabel) ops.push({ t: 'row', label: 'הזמנה', value: ltr(input.orderLabel), style: 'body' });
    if (input.slipCode) ops.push({ t: 'row', label: 'קוד', value: ltr(input.slipCode), style: 'bodyBold' });
    ops.push({ t: 'divider', gap: 8 });
    ops.push({ t: 'text', text: 'הכסף שמור במכשיר. הצוות יחזיר אותו או יקזז אותו בהזמנה.', style: 'small', align: 'center' });
  }
  ops.push({ t: 'row', label: 'עסקה', value: ltr(input.txShort), style: 'small' });
  if (input.stationName) ops.push({ t: 'row', label: 'עמדה', value: input.stationName, style: 'small' });
  ops.push({ t: 'row', label: 'זמן', value: stamp(input.at), style: 'small' });
  ops.push({ t: 'end' });
  return { kind: 'receipt', logoUrl: null, ops };
}

/**
 * "דוח X סניפי" on paper (P:/specs/shop-x-report.md §4): the cloud's `printDocument` as it wrote it — the title, the
 * business, the subtitle ("דוח ביניים, אינו סוגר יום"), each section's rows (an emphasised row in bold), the footer —
 * in the till's X format. No number: it is not a document.
 */
export function shopXPrintDoc(d: { title: string; businessName: string | null; subtitle: string | null; sections: Array<{ title: string | null; rows: Array<{ label: string; value: string; emphasis: boolean }> }>; footer: string | null }, logoUrl: string | null): ZDoc {
  const ops: ZOp[] = [];
  if (d.businessName) ops.push({ t: 'centred', text: d.businessName, size: 24, bold: true });
  ops.push({ t: 'centred', text: d.title, size: 26, bold: true });
  if (d.subtitle) ops.push({ t: 'centred', text: d.subtitle, size: 18, bold: false });
  for (const s of d.sections) {
    ops.push({ t: 'divider' });
    if (s.title) ops.push({ t: 'centred', text: s.title, size: 20, bold: true });
    for (const r of s.rows) ops.push({ t: 'row', label: r.label, value: r.value, bold: r.emphasis });
  }
  ops.push({ t: 'divider' });
  if (d.footer) ops.push({ t: 'centred', text: d.footer, size: 16, bold: false });
  return { kind: 'z', logoUrl, ops };
}
