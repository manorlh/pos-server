/**
 * A kiosk card sale's numbers, as the till computes them (pos-android domain/Cart.kt totals,
 * data/repo/SaleRepository.kt buildTransaction/buildItems, domain/XReport.kt):
 *
 *  - prices include VAT; a line's gross = unit × qty (HALF_UP to the agora); a unit = the dish's
 *    price + what each choice was charged (free choices, quantities, "הרבה" — client/src/lib/kioskMoney.ts)
 *    + on a meal, each component's upcharge and paid choices;
 *  - the promotions (kioskMoney.ts, the till's PromotionEngine) are the document's discount: each
 *    line carries its share, the total is the gross less them — and so are the discount vouchers
 *    ("שוברי הנחה", kioskVouchers.ts): a share of each line, inside the same discount, never a tender;
 *  - the VAT is computed ONCE per document: net = round(total / (1 + rate)), vat = total − net;
 *  - the card is charged total + tip; the card tender is the goods total, the tip goes in
 *    `tipAmount` (tipPaymentMethod "card");
 *  - the document is 320 (or 400 for an exempt dealer, at 0% VAT).
 *
 * Pure: amounts in agorot inside, shekels (2 decimals) on the wire.
 */

import { kioskTipAgorot, optionText, TIP_OTHER_MAX_SHEKELS, tipPercentOf, type TipRules } from '@dash-lib/kioskMoney';
import { ofShekels, times, toShekels, vatNet } from './money';

/** At most this many of one line (the Android kiosk's KioskViewModel.MAX_QTY). */
export const MAX_LINE_QTY = 20;

export interface SaleOption {
  groupId: string;
  optionId: string;
  name: string;
  /** The option's own price per unit, agorot. */
  priceAgorot: number;
  qty: number;
  /** "מעט / הרבה / בצד". */
  pre?: 'lite' | 'extra' | 'side' | null;
  /**
   * What it was charged per unit of the dish, after the group's free choices and "הרבה"
   * (kioskMoney.ts pickCharges). Absent on a document written before: price × qty.
   */
  chargedAgorot?: number;
  kind?: 'choice' | 'addon' | 'removal';
  groupName?: string;
}

/** One component of a meal line (LineDetails MealComponent). */
export interface SaleMealComponent {
  slotId: string;
  slotName: string;
  productId: string;
  name: string;
  categoryId: string | null;
  /** The component's own catalog price: what the meal's base is allocated by. */
  listPriceAgorot: number;
  upchargeAgorot: number;
  options: SaleOption[];
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
  /** A meal: its components (the line's product is the meal). */
  meal?: { productId: string; name: string; components: SaleMealComponent[] } | null;
  categoryId?: string | null;
  /** "לא מקבל הנחות". */
  noDiscount?: boolean;
  /** The line's share of the promotions, agorot, and the promotion that took most of it. */
  promotionAgorot?: number;
  promotionId?: string | null;
  promotionName?: string | null;
  /** The line's share of the discount vouchers, agorot; and the promotion's share that gave way to one. */
  voucherAgorot?: number;
  promotionYieldedAgorot?: number;
  /** "כלול בשובר #7 (1)": the goods voucher that paid for the line, as the till's document marks it (coverByVoucher); never printed in the kitchen. */
  voucherMark?: string;
  /**
   * "קיזוז שובר הפקה" (core/till/vouchers.ts, accounting `discount`): the production vouchers' deduction from this line — inside
   * the document's discount (the total and its VAT base are after it), on the wire `items[].prepaidDeduction`; never a tender,
   * never a "הנחה" on paper or in the X. Absent: none.
   */
  prepaidDeductionAgorot?: number;
  /**
   * "תפריטים": the menu active when the line was added and where its price came from (`menu` / `catalog`) — the document's
   * item carries them (`menuId` / `menuName` / `priceSource`) for the sales-by-menu report. Absent: no menu.
   */
  menuId?: string | null;
  menuName?: string | null;
  priceSource?: 'menu' | 'catalog' | null;
  /** With a menu: the catalog's own price then (the till's held sale carries it as `catalogPrice`). */
  catalogPriceAgorot?: number | null;
  /**
   * A till's manual line discount ("הנחה" on the line, or OTH's 100%), resolved to agorot: inside the document's discount,
   * never in the line's gross (core/till/discounts.ts). Absent: none.
   */
  discountAgorot?: number;
  /** OTH ("על חשבון הבית", core/till/discounts.ts): why, who gave it, who approved it. */
  oth?: { reason: string; by: string | null; approvedBy: string | null } | null;
  /** A credit-note line: the original line it credits (null: a return with no receipt), and what it credits (net). */
  refundOfItemId?: string | null;
  creditAgorot?: number;
  /**
   * The till's dish sheet (core/till/choices.ts): "! חשוב" and the diner's allergies (Hebrew names) — the kitchen ticket's
   * (KitchenTicketDesigns `important` / `allergies`), never a price or a document field.
   */
  important?: boolean;
  allergies?: string[];
}

/** What a line takes off by hand (the cashier's discount, OTH): never on a credit line. */
export function manualDiscount(l: Pick<SaleLine, 'discountAgorot'>): number {
  return Math.max(0, l.discountAgorot ?? 0);
}

/** What one choice adds to one unit of the dish. */
export function optionCharged(o: Pick<SaleOption, 'priceAgorot' | 'qty' | 'chargedAgorot'>): number {
  return o.chargedAgorot ?? o.priceAgorot * Math.max(1, o.qty);
}

/** A choice as the kitchen and the receipt word it: "הרבה טחינה ×2", "בלי בצל" (LineModifier.displayText). */
export function kitchenOptionText(o: Pick<SaleOption, 'name' | 'qty' | 'pre' | 'kind'>): string {
  return optionText({ kind: o.kind ?? 'addon', name: o.name, pre: o.pre ?? null, qty: o.qty });
}

/** A line's choices for the bon and the KDS: its own, and a meal's components with theirs. */
export function kitchenOptions(l: Pick<SaleLine, 'options' | 'meal'>): string[] {
  return [
    ...l.options.map(kitchenOptionText),
    ...(l.meal?.components ?? []).map((c) => (c.options.length > 0 ? `${c.name} (${c.options.map(kitchenOptionText).join(', ')})` : c.name)),
  ];
}

/** Unit price with the paid options, and a meal's upcharges and its components' paid choices (per unit). */
export function unitAgorot(l: Pick<SaleLine, 'basePriceAgorot' | 'options'> & { meal?: SaleLine['meal'] }): number {
  const options = l.options.reduce((s, o) => s + optionCharged(o), 0);
  const meal = (l.meal?.components ?? []).reduce((s, c) => s + c.upchargeAgorot + c.options.reduce((x, o) => x + optionCharged(o), 0), 0);
  return l.basePriceAgorot + options + meal;
}

export function lineGross(l: SaleLine): number {
  return times(unitAgorot(l), l.qty);
}

export interface SaleTotals {
  /** Σ line gross (before discounts) — the wire's totalAmount. */
  grossAgorot: number;
  /** Everything taken off: the promotions' and the discount vouchers' shares (the document's `documentDiscount`). */
  discountAgorot: number;
  /** What discount vouchers took off, inside [discountAgorot]. */
  voucherDiscountAgorot: number;
  /** The production vouchers' deductions ("קיזוז שובר הפקה"), inside [discountAgorot]. Absent: none. */
  prepaidDeductionAgorot?: number;
  /** What the goods cost: gross − discounts. The card tender. */
  totalAgorot: number;
  netAgorot: number;
  vatAgorot: number;
  tipAgorot: number;
  /** What the terminal is asked for. */
  chargeAgorot: number;
  vatRate: number;
}

/**
 * [basketDiscountAgorot]: a till's basket discount ("הנחה לחשבון"), already in money (Cart.documentDiscountAmount) — taken
 * after the lines' own discounts, inside the document's discount like them.
 */
export function saleTotals(lines: readonly SaleLine[], vatRate: number, tipAgorot = 0, basketDiscountAgorot = 0): SaleTotals {
  const gross = lines.reduce((s, l) => s + lineGross(l), 0);
  // The promotions' and the discount vouchers' shares (Cart.totals): the document's discount.
  const promotion = lines.reduce((s, l) => s + Math.max(0, l.promotionAgorot ?? 0), 0);
  const voucher = lines.reduce((s, l) => s + Math.max(0, l.voucherAgorot ?? 0), 0);
  // A till's manual line discounts (and OTH) and its basket discount: the same document discount.
  const manual = lines.reduce((s, l) => s + manualDiscount(l), 0);
  // The production vouchers' deductions ("קיזוז שובר הפקה"): fiscally the same discount (Cart.totals prepaidDeduction).
  const deduction = lines.reduce((s, l) => s + Math.max(0, l.prepaidDeductionAgorot ?? 0), 0);
  const discount = promotion + voucher + manual + Math.max(0, basketDiscountAgorot) + deduction;
  const total = gross - discount;
  const net = vatNet(total, vatRate);
  return {
    grossAgorot: gross,
    discountAgorot: discount,
    voucherDiscountAgorot: voucher,
    ...(deduction > 0 ? { prepaidDeductionAgorot: deduction } : {}),
    totalAgorot: total,
    netAgorot: net,
    vatAgorot: total - net,
    tipAgorot,
    chargeAgorot: total + tipAgorot,
    vatRate,
  };
}

/**
 * A credit note's totals (SaleRepository.recordRefund / buildBasketDocuments): the lines' credits (net of their discount
 * share) are its amount — no document discount on a credit — and its VAT split is taken from them at [vatRate] (none on
 * a receipt refund).
 */
export function creditTotals(lines: readonly SaleLine[], vatRate: number): SaleTotals {
  const credited = lines.reduce((s, l) => s + (l.creditAgorot ?? lineGross(l)), 0);
  const net = vatNet(credited, vatRate);
  return {
    grossAgorot: credited,
    discountAgorot: 0,
    voucherDiscountAgorot: 0,
    totalAgorot: credited,
    netAgorot: net,
    vatAgorot: credited - net,
    tipAgorot: 0,
    chargeAgorot: credited,
    vatRate,
  };
}

/** A credit document: a credit note (330) or an exempt dealer's receipt refund (−400) — DocumentType.isCredit. */
export function isCreditType(documentType: number): boolean {
  return documentType === 330 || documentType === -400;
}

/** A sale document: a tax invoice-receipt (320) or an exempt dealer's receipt (400) — DocumentType.isSale. */
export function isSaleType(documentType: number): boolean {
  return documentType === 320 || documentType === 400;
}

/**
 * Money back, crediting [originalType] (null: no receipt) — FiscalDocuments.creditTypeFor: a receipt refund (−400) for a
 * receipt or whenever the business is exempt now; a credit note (330) otherwise.
 */
export function creditDocumentType(dealerType: string | null | undefined, originalType: number | null): 330 | -400 {
  if (originalType === 400) return -400;
  if (dealerType === 'exempt') return -400;
  return 330;
}

/** The VAT rate a new document of [documentType] is written at: none on a receipt (400 / −400). */
export function vatRateForType(documentType: number, configured: number): number {
  return documentType === 400 || documentType === -400 ? 0 : configured;
}

/** KioskCustomer.tipOf: (goods × pct + 50) / 100 in integers (lib/kioskMoney.ts tipPercentOf — one copy). */
export function tipOf(goodsAgorot: number, pct: number | null): number {
  return tipPercentOf(goodsAgorot, pct);
}

/** "סכום אחר" at most ₪999 (KioskTip.OTHER_MAX_SHEKELS). */
export const TIP_OTHER_MAX_AGOROT = TIP_OTHER_MAX_SHEKELS * 100;

/**
 * The tip to charge (KioskViewModel.price, lib/kioskMoney.ts kioskTipAgorot — the Android kiosk's rule):
 * none with tips off; "סכום אחר" when "other" is on and it is whole shekels above zero, at most the
 * goods and ₪999; else the preset's percent of the goods after promotions.
 */
export function tipToCharge(rules: TipRules, goodsAgorot: number, pct: number | null, otherAgorot: number | null | undefined): number {
  return kioskTipAgorot(rules, goodsAgorot, pct, otherAgorot);
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
  /**
   * Production vouchers (core/till/vouchers.ts): the document's deductions ("קיזוז שובר הפקה" — out of the gross and out of the
   * discounts alike, their own section), and its ₪0 voucher units (no items of the shift). Absent: none.
   */
  prepaidDeductionAgorot?: number;
  offVoucherUnits?: number;
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
  /**
   * Mixed baskets (core/till/basket.ts): the net of the exchange legs — received on sales less given on credit notes, zero
   * when every basket is whole — as the cloud's `totalExchange`; and what the sales received in exchange. Absent when the
   * shift had no basket, so such a shift closes as it always did (ShiftClose.kt).
   */
  totalExchange?: number;
  exchangeReceived?: number;
  /**
   * "מגירת מזומן" (core/till/drawer.ts `tillWithDrawer`): the shift's Cash In / Cash Out / deposits, and the cash its payments
   * left with employees / employees deposited here ("הכסף אצלי", drawer-away §5.6) — only when not zero, already in expectedCash.
   */
  cashIn?: number;
  cashOut?: number;
  deposits?: number;
  walletIn?: number;
  walletDeposits?: number;
  /** "שוברי הפקה": what production vouchers paid as a tender — only when not zero; never cash, card or the drawer. */
  totalVouchers?: number;
  /** The X's production vouchers sections (core/till/vouchers.ts voucherInfoJson) — information, in no figure above. */
  prepaidVouchersInfo?: Record<string, unknown>;
  /**
   * "טיפ באשראי משולם מהמזומן" (core/till/cashWithTips.ts, P:/specs/x-z-cash-with-tips.md §2): the card tips paid out of
   * the drawer — already off expectedCash —, those owed to staff, the shortfall mode, "מזומן במגירה" of the old figure
   * (cash takings + cash tips − paid). Absent with the parameter off; `cardTipsNeedsChoice` only on an X under `ask`.
   */
  cardTipsFromDrawer?: number;
  cardTipsUnpaid?: number;
  cardTipsShortfall?: 'partial' | 'negative';
  cardTipsNeedsChoice?: boolean;
  drawerCash?: number;
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
    count = 0,
    exchangeIn = 0,
    exchangeOut = 0,
    vouchers = 0;
  let vatComplete = true;
  const ids: string[] = [];
  for (const d of docs) {
    if (!REPORTABLE.has(d.status)) continue;
    ids.push(d.id);
    count++;
    const credit = CREDIT_TYPES.has(d.documentType);
    if (credit) refunds += d.grossAgorot;
    else {
      // A production voucher's deduction is out of the gross and out of the discounts alike (XReport.kt); a ₪0 voucher's goods
      // are no items of the shift.
      const deduction = Math.min(Math.max(0, d.prepaidDeductionAgorot ?? 0), d.documentDiscountAgorot);
      sales += d.grossAgorot - deduction;
      items += Math.max(0, Math.trunc(d.itemsQty) - Math.max(0, d.offVoucherUnits ?? 0));
      discounts += d.documentDiscountAgorot - deduction;
    }
    const sign = credit ? -1 : 1;
    const legs = d.payments.length > 0 ? d.payments : [{ method: d.paymentMethod ?? 'cash', amountAgorot: credit ? d.grossAgorot : d.grossAgorot - d.documentDiscountAgorot }];
    for (const leg of legs) {
      if (leg.method === 'cash') cash += sign * leg.amountAgorot;
      else if (leg.method === 'card') card += sign * leg.amountAgorot;
      // Neither cash nor card, and never in the drawer: the exchange row (XReport.kt).
      else if (leg.method === 'exchange') {
        if (credit) exchangeOut += leg.amountAgorot;
        else exchangeIn += leg.amountAgorot;
      }
      // "שוברי הפקה", whichever code wrote the leg: its own line, never the drawer.
      else if (leg.method === 'production_voucher' || leg.method === 'voucher') vouchers += sign * leg.amountAgorot;
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
  // Only a shift with a mixed basket carries them (ShiftClose.kt: totalExchange takeIf moved, exchangeReceived when not zero).
  if (exchangeIn !== 0 || exchangeIn - exchangeOut !== 0) till.totalExchange = s(exchangeIn - exchangeOut);
  if (exchangeIn !== 0) till.exchangeReceived = s(exchangeIn);
  if (vouchers !== 0) till.totalVouchers = s(vouchers);
  return { till, reportableIds: ids };
}

/** `lastTransactionNumber` on a close: the highest over every non-pending document, all series mixed (as the till sends it). */
export function lastTransactionNumberOf(docs: ReadonlyArray<Pick<XDoc, 'status' | 'transactionNumber'>>): string | null {
  let max = 0;
  for (const d of docs) if (d.status !== 'pending' && d.transactionNumber > max) max = d.transactionNumber;
  return max > 0 ? String(max) : null;
}

export { ofShekels };
