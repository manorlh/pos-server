/**
 * A kiosk card sale's numbers, as the till computes them (pos-android domain/Cart.kt totals,
 * data/repo/SaleRepository.kt buildTransaction/buildItems, domain/XReport.kt):
 *
 *  - prices include VAT; a line's gross = unit × qty (HALF_UP to the agora);
 *  - the VAT is computed ONCE per document: net = round(total / (1 + rate)), vat = total − net;
 *  - the card is charged total + tip; the card tender is the goods total, the tip goes in
 *    `tipAmount` (tipPaymentMethod "card");
 *  - the document is 320 (or 400 for an exempt dealer, at 0% VAT).
 *
 * Pure: amounts in agorot inside, shekels (2 decimals) on the wire.
 */

import { ofShekels, times, toShekels, vatNet } from './money';

export interface SaleOption {
  groupId: string;
  optionId: string;
  name: string;
  /** Extra per unit, agorot. */
  priceAgorot: number;
  qty: number;
}

export interface SaleLine {
  key: string;
  productId: string;
  name: string;
  sku: string | null;
  /** The product's own price, agorot. */
  basePriceAgorot: number;
  options: SaleOption[];
  notes: string[];
  qty: number;
}

/** Unit price with the paid options (per unit). */
export function unitAgorot(l: Pick<SaleLine, 'basePriceAgorot' | 'options'>): number {
  return l.basePriceAgorot + l.options.reduce((s, o) => s + o.priceAgorot * Math.max(1, o.qty), 0);
}

export function lineGross(l: SaleLine): number {
  return times(unitAgorot(l), l.qty);
}

export interface SaleTotals {
  /** Σ line gross (before discounts) — the wire's totalAmount. */
  grossAgorot: number;
  discountAgorot: number;
  /** What the goods cost: gross − discounts. The card tender. */
  totalAgorot: number;
  netAgorot: number;
  vatAgorot: number;
  tipAgorot: number;
  /** What the terminal is asked for. */
  chargeAgorot: number;
  vatRate: number;
}

export function saleTotals(lines: readonly SaleLine[], vatRate: number, tipAgorot = 0): SaleTotals {
  const gross = lines.reduce((s, l) => s + lineGross(l), 0);
  const discount = 0;
  const total = gross - discount;
  const net = vatNet(total, vatRate);
  return {
    grossAgorot: gross,
    discountAgorot: discount,
    totalAgorot: total,
    netAgorot: net,
    vatAgorot: total - net,
    tipAgorot,
    chargeAgorot: total + tipAgorot,
    vatRate,
  };
}

/** KioskCustomer.tipOf: (goods × pct + 50) / 100 in integers. */
export function tipOf(goodsAgorot: number, pct: number | null): number {
  if (!pct || pct <= 0) return 0;
  return Math.trunc((goodsAgorot * pct + 50) / 100);
}

/** The sale document type by the dealer type: an exempt dealer issues 400 receipts. */
export function saleDocumentType(dealerType: string | null | undefined): 320 | 400 {
  return dealerType === 'exempt' ? 400 : 320;
}

/** The VAT rate (fraction): the cloud's integer percent, 18 when absent; 0 for an exempt dealer or a 400. */
export function vatRateOf(globalTaxRate: unknown, dealerType: string | null | undefined): number {
  if (dealerType === 'exempt') return 0;
  const n = typeof globalTaxRate === 'number' ? globalTaxRate : typeof globalTaxRate === 'string' ? Number(globalTaxRate) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : 0.18;
}

/** The document's items as the till stores and sends them (buildItems). */
export function wireItems(lines: readonly SaleLine[], itemId: (l: SaleLine, i: number) => string) {
  return lines.map((l, i) => {
    const unit = unitAgorot(l);
    const detailMods = l.options.map((o) => ({ groupId: o.groupId, optionId: o.optionId, name: o.name, price: toShekels(o.priceAgorot), qty: o.qty }));
    return {
      id: itemId(l, i),
      productId: l.productId,
      productName: l.name,
      sku: l.sku,
      quantity: l.qty,
      unitPrice: toShekels(unit),
      totalPrice: toShekels(times(unit, l.qty)),
      discount: 0,
      discountType: 'fixed',
      transactionType: 2,
      lineDiscount: 0,
      notes: l.notes.length > 0 ? l.notes.join(' · ') : null,
      details: detailMods.length > 0 ? { modifiers: detailMods } : null,
    };
  });
}

/* --------------------------------------------------------------- X report */

/** The fields of a document the X reads (XReport.buildXReport). */
export interface XDoc {
  id: string;
  status: string;
  documentType: number;
  transactionNumber: number;
  grossAgorot: number;
  itemsQty: number;
  documentDiscountAgorot: number;
  payments: Array<{ method: string; amountAgorot: number }>;
  paymentMethod: string | null;
  vatAgorot: number | null;
  vatRate: number | null;
  tipAgorot: number;
  tipPaymentMethod: string | null;
}

const REPORTABLE = new Set(['completed', 'refunded', 'partial_refund']);
const CREDIT_TYPES = new Set([330, -400]);

export interface XTill {
  openingCash: number;
  expectedCash: number;
  totalSales: number;
  totalDiscounts: number;
  totalRefunds: number;
  totalCash: number;
  totalCard: number;
  totalTips: number;
  totalCashTips: number;
  totalCardTips: number;
  vatTotal?: number;
  transactionsCount: number;
  itemsCount: number;
}

export function buildXTill(docs: readonly XDoc[], openingCashAgorot: number, currentRate: number): { till: XTill; reportableIds: string[] } {
  let sales = 0,
    discounts = 0,
    refunds = 0,
    cash = 0,
    card = 0,
    tips = 0,
    cashTips = 0,
    cardTips = 0,
    vat = 0,
    items = 0,
    count = 0;
  let vatComplete = true;
  const ids: string[] = [];
  for (const d of docs) {
    if (!REPORTABLE.has(d.status)) continue;
    ids.push(d.id);
    count++;
    const credit = CREDIT_TYPES.has(d.documentType);
    if (credit) refunds += d.grossAgorot;
    else {
      sales += d.grossAgorot;
      items += Math.trunc(d.itemsQty);
      discounts += d.documentDiscountAgorot;
    }
    const sign = credit ? -1 : 1;
    const legs = d.payments.length > 0 ? d.payments : [{ method: d.paymentMethod ?? 'cash', amountAgorot: credit ? d.grossAgorot : d.grossAgorot - d.documentDiscountAgorot }];
    for (const leg of legs) {
      if (leg.method === 'cash') cash += sign * leg.amountAgorot;
      else if (leg.method === 'card') card += sign * leg.amountAgorot;
    }
    if (d.vatAgorot === null) {
      vatComplete = false;
      const base = d.grossAgorot - d.documentDiscountAgorot;
      vat += sign * (base - vatNet(base, d.vatRate ?? currentRate));
    } else vat += sign * d.vatAgorot;
    tips += d.tipAgorot;
    if (d.tipPaymentMethod === 'cash') cashTips += d.tipAgorot;
    else if (d.tipPaymentMethod === 'card') cardTips += d.tipAgorot;
  }
  const s = (a: number) => toShekels(a);
  const till: XTill = {
    openingCash: s(openingCashAgorot),
    expectedCash: s(openingCashAgorot + cash + cashTips),
    totalSales: s(sales),
    totalDiscounts: s(discounts),
    totalRefunds: s(refunds),
    totalCash: s(cash),
    totalCard: s(card),
    totalTips: s(tips),
    totalCashTips: s(cashTips),
    totalCardTips: s(cardTips),
    transactionsCount: count,
    itemsCount: items,
  };
  if (vatComplete) till.vatTotal = s(vat);
  return { till, reportableIds: ids };
}

/** `lastTransactionNumber` on a close: the highest over every non-pending document, all series mixed (as the till sends it). */
export function lastTransactionNumberOf(docs: ReadonlyArray<Pick<XDoc, 'status' | 'transactionNumber'>>): string | null {
  let max = 0;
  for (const d of docs) if (d.status !== 'pending' && d.transactionNumber > max) max = d.transactionNumber;
  return max > 0 ? String(max) : null;
}

export { ofShekels };
