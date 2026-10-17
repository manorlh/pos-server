/**
 * X / Z — "מזומן במגירה" (cash in the drawer incl. tips), P:/specs/x-z-cash-with-tips.md: the block every X and Z shows,
 * and the card tips paid out of the drawer ("טיפ באשראי משולם מהמזומן", `cashDrawer.cardTipsFromDrawer`) with the shortfall
 * policy (`cashDrawer.cardTipsShortfall` partial | negative | ask, default partial).
 *
 * One rule, four copies: the reference is %TEMP%\xzcash\gen_golden.py, pinned by x_z_cash_with_tips_golden.json
 * (test/tillCashWithTips.test.ts). Works in agorot. Pure.
 *
 *  - available = opening + cash takings + cash tips (+ Cash In − Cash Out − deposits when part of the expected cash)
 *    + wallet deposits − wallet in + between-shift adjustments — the expected cash before the tips payout;
 *  - partial: paid = min(card tips, max(available, 0)), the rest owed to staff; negative: all paid; ask: asked at the
 *    close only when short (before it, previewed as partial with `needsChoice`);
 *  - the block's total == the report's expected cash; total / short only where the expected cash may be seen.
 */

export const CASH_WITH_TIPS_LABELS = {
  title: 'מזומן במגירה',
  opening: 'קופה פותחת',
  cashSales: 'מזומן ממכירות',
  cashTips: 'טיפים במזומן',
  cashIn: 'הכנסות מזומן',
  cashOut: 'הוצאות',
  deposits: 'הפקדה לכספת',
  walletIn: 'הכסף אצל עובדים',
  walletDeposits: 'הפקדות מעובדים',
  between: 'תנועות בין משמרות',
  cardTips: 'טיפים באשראי',
  cardTipsPaid: 'שולמו מהמגירה',
  cardTipsUnpaid: 'לא שולמו — לתשלום לעובדים',
  total: '= מזומן במגירה (כולל טיפים)',
  short: 'חסר במגירה',
  unpaidDay: 'טיפים באשראי שטרם שולמו',
  tillTable: 'מזומן במגירה לפי קופה',
  tillTotals: 'סה״כ',
  perTill: 'פירוט לפי קופה',
  summaryCash: 'סה״כ מזומן',
  summaryTips: 'טיפים',
  summaryUnpaid: 'טיפים באשראי שטרם שולמו',
  summaryNet: '= סה״כ מזומן נטו (אחרי טיפים)',
} as const;

/** `zPrintPerTillCash` (§3): a shop / area Z's paper prints the per-till table under the summary (default) or the summary only. */
export const Z_PRINT_PER_TILL_CASH_KEY = 'zPrintPerTillCash';
export function zPrintPerTill(parameters: Record<string, unknown>): boolean {
  const v = parameters[Z_PRINT_PER_TILL_CASH_KEY];
  return !(typeof v === 'string' && v.trim().toLowerCase() === 'summary_only');
}

/** The manager's question at the close (ask, only when short). */
export const CARD_TIPS_ASK_TEXT = {
  title: 'אין מספיק מזומן לטיפים באשראי',
  body: (tips: string, room: string) => `טיפים באשראי ₪${tips}, במגירה ₪${room}. כיצד לשלם?`,
  partial: 'לשלם מהמגירה רק מה שיש',
  negative: 'לשלם הכל, גם אם המגירה במינוס',
} as const;

export const CARD_TIPS_FROM_DRAWER_KEY = 'cashDrawer.cardTipsFromDrawer';
export const CARD_TIPS_SHORTFALL_KEY = 'cashDrawer.cardTipsShortfall';

export type CardTipsShortfall = 'partial' | 'negative' | 'ask';
export type CardTipsChoice = 'partial' | 'negative';
export type CashLineKey = Exclude<keyof typeof CASH_WITH_TIPS_LABELS, 'title' | 'unpaidDay' | 'tillTable' | 'tillTotals' | 'perTill' | SummaryKey>;
export type SummaryKey = 'summaryCash' | 'summaryTips' | 'summaryUnpaid' | 'summaryNet';

/** A parameter's "on" (main/sync/cloud.ts parameterOn's rule). */
function on(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 'כן'].includes(v.trim().toLowerCase());
  return false;
}

/** On for this device: the parameter on, and not a self-order kiosk (it has no drawer). */
export function cardTipsFromDrawerOn(parameters: Record<string, unknown>, kiosk: boolean): boolean {
  return !kiosk && on(parameters[CARD_TIPS_FROM_DRAWER_KEY]);
}

/** `cashDrawer.cardTipsShortfall`, default partial (anything unknown reads as partial). */
export function cardTipsShortfallOf(parameters: Record<string, unknown>): CardTipsShortfall {
  const v = typeof parameters[CARD_TIPS_SHORTFALL_KEY] === 'string' ? (parameters[CARD_TIPS_SHORTFALL_KEY] as string).trim().toLowerCase() : '';
  return v === 'negative' || v === 'ask' ? v : 'partial';
}

export interface DrawerInput {
  opening: number;
  cashSales: number;
  cashTips: number;
  cardTips: number;
  /** null: the movements are not part of this report's expected cash (a Z without zExpectedCashMovements). */
  movements: { cashIn: number; cashOut: number; deposits: number } | null;
  wallet?: { walletIn: number; walletDeposits: number } | null;
  between?: number;
  param: boolean;
  shortfall?: CardTipsShortfall;
  askChoice?: CardTipsChoice | null;
  showDrawerCash?: boolean;
}

export interface Payout {
  /** null with the parameter off. */
  paid: number | null;
  unpaid: number | null;
  mode: CardTipsChoice | null;
  needsChoice: boolean;
}

export interface CashLine {
  key: CashLineKey;
  label: string;
  agorot: number;
  bold: boolean;
  warn: boolean;
}

/** The expected cash before the tips payout. */
export function availableOf(inp: DrawerInput): number {
  const w = inp.wallet ?? { walletIn: 0, walletDeposits: 0 };
  let a = inp.opening + inp.cashSales + inp.cashTips + w.walletDeposits - w.walletIn + (inp.between ?? 0);
  if (inp.movements) a += inp.movements.cashIn - inp.movements.cashOut - inp.movements.deposits;
  return a;
}

/** What the drawer pays of the card tips (gen_golden.py `payout`). */
export function payout(param: boolean, shortfall: CardTipsShortfall, askChoice: CardTipsChoice | null | undefined, available: number, cardTips: number): Payout {
  if (!param) return { paid: null, unpaid: null, mode: null, needsChoice: false };
  const tips = Math.max(cardTips, 0);
  const room = Math.max(available, 0);
  const isShort = tips > room;
  let needsChoice = false;
  let mode: CardTipsChoice = shortfall === 'negative' ? 'negative' : 'partial';
  if (shortfall === 'ask') {
    if (!isShort) mode = 'partial';
    else if (askChoice === 'partial' || askChoice === 'negative') mode = askChoice;
    else {
      mode = 'partial';
      needsChoice = true;
    }
  }
  const paid = mode === 'negative' ? tips : Math.min(tips, room);
  return { paid, unpaid: tips - paid, mode, needsChoice };
}

/** The block's lines and total, from figures (frozen or computed) — gen_golden.py `block`. */
export function cashBlock(inp: DrawerInput, paid: number | null, unpaid: number | null): { lines: CashLine[]; total: number } {
  const lines: CashLine[] = [];
  const add = (key: CashLineKey, agorot: number, bold = false, warn = false) => lines.push({ key, label: CASH_WITH_TIPS_LABELS[key], agorot, bold, warn });
  let total = inp.opening + inp.cashSales + inp.cashTips;
  add('opening', inp.opening);
  add('cashSales', inp.cashSales);
  add('cashTips', inp.cashTips);
  const mv = inp.movements;
  if (mv) {
    if (mv.cashIn !== 0) add('cashIn', mv.cashIn);
    if (mv.cashOut !== 0) add('cashOut', -mv.cashOut);
    if (mv.deposits !== 0) add('deposits', -mv.deposits);
    total += mv.cashIn - mv.cashOut - mv.deposits;
  }
  const w = inp.wallet ?? { walletIn: 0, walletDeposits: 0 };
  if (w.walletIn !== 0) add('walletIn', -w.walletIn);
  if (w.walletDeposits !== 0) add('walletDeposits', w.walletDeposits);
  total += w.walletDeposits - w.walletIn;
  const between = inp.between ?? 0;
  if (between !== 0) add('between', between);
  total += between;
  if (paid !== null) {
    const u = unpaid ?? 0;
    add('cardTips', paid + u);
    add('cardTipsPaid', -paid);
    if (u > 0) add('cardTipsUnpaid', u);
    total -= paid;
  }
  if (inp.showDrawerCash !== false) {
    add('total', total, true, total < 0);
    if (total < 0) add('short', -total, true, true);
  }
  return { lines, total };
}

/** A drawer's whole reckoning (gen_golden.py `drawer_case`). */
export function drawerOf(inp: DrawerInput): Payout & { available: number; total: number; short: boolean; lines: CashLine[] } {
  const available = availableOf(inp);
  const p = payout(inp.param, inp.shortfall ?? 'partial', inp.askChoice, available, inp.cardTips);
  const { lines, total } = cashBlock(inp, p.paid, p.unpaid);
  return { ...p, available, total, short: total < 0, lines };
}

export interface TillTableRow {
  till: string;
  cashSales: number;
  cashTips: number;
  cardTipsPaid: number | null;
  cardTipsUnpaid: number | null;
  /** null when the expected cash is hidden. */
  drawerCash: number | null;
  short: boolean;
}

export interface TillTable {
  rows: TillTableRow[];
  totals: { cashSales: number; cashTips: number; cardTipsPaid: number | null; cardTipsUnpaid: number | null; drawerCash: number | null; anyShort: boolean };
  unpaidTotal: number;
  /**
   * The shop / area summary first (§3): Σ available before any payout, the tips (cash + card paid), the unpaid card tips, the
   * business cash net of every tip; cash / net null where the expected cash is hidden.
   */
  summary: {
    totalCash: number | null;
    tips: number;
    unpaid: number;
    netCash: number | null;
    lines: Array<{ key: SummaryKey; label: string; agorot: number; bold: boolean; warn: boolean }>;
  };
}

/**
 * "מזומן במגירה לפי קופה" of a shop / area X or Z (spec §3): each drawer by its own figures — one till's cash never pays
 * another till's tips. `paid` / `unpaid` given: the till's frozen figures (a closed shift); absent: computed.
 */
export function tillTable(tills: Array<{ till: string; input: DrawerInput; paid?: number | null; unpaid?: number | null }>, show: boolean): TillTable {
  const rows: TillTableRow[] = [];
  let cashSales = 0;
  let cashTips = 0;
  let paidSum: number | null = null;
  let unpaidSum: number | null = null;
  let drawer = 0;
  let anyShort = false;
  let availableSum = 0;
  for (const t of tills) {
    const inp = { ...t.input, showDrawerCash: show };
    let paid: number | null;
    let unpaid: number | null;
    let total: number;
    if (t.paid !== undefined) {
      paid = t.paid;
      unpaid = paid === null ? null : (t.unpaid ?? 0);
      total = cashBlock(inp, paid, unpaid).total;
    } else {
      const c = drawerOf(inp);
      paid = c.paid;
      unpaid = c.unpaid;
      total = c.total;
    }
    availableSum += availableOf(inp);
    rows.push({ till: t.till, cashSales: inp.cashSales, cashTips: inp.cashTips, cardTipsPaid: paid, cardTipsUnpaid: unpaid, drawerCash: show ? total : null, short: show && total < 0 });
    cashSales += inp.cashSales;
    cashTips += inp.cashTips;
    if (paid !== null) {
      paidSum = (paidSum ?? 0) + paid;
      unpaidSum = (unpaidSum ?? 0) + (unpaid ?? 0);
    }
    drawer += total;
    anyShort = anyShort || total < 0;
  }
  const tips = cashTips + (paidSum ?? 0);
  const unpaid = unpaidSum ?? 0;
  const net = availableSum - tips - unpaid;
  const lines: TillTable['summary']['lines'] = [];
  const sadd = (key: SummaryKey, agorot: number, bold = false, warn = false) => lines.push({ key, label: CASH_WITH_TIPS_LABELS[key], agorot, bold, warn });
  if (show) sadd('summaryCash', availableSum);
  sadd('summaryTips', tips);
  if (unpaid > 0) sadd('summaryUnpaid', unpaid);
  if (show) sadd('summaryNet', net, true, net < 0);
  return {
    rows,
    totals: { cashSales, cashTips, cardTipsPaid: paidSum, cardTipsUnpaid: unpaidSum, drawerCash: show ? drawer : null, anyShort: show && anyShort },
    unpaidTotal: unpaid,
    summary: { totalCash: show ? availableSum : null, tips, unpaid, netCash: show ? net : null, lines },
  };
}

/** Agorot as the golden writes them: "12.34", "-25.50". */
export function amountText(agorot: number): string {
  const neg = agorot < 0;
  const a = Math.abs(Math.round(agorot));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** A money figure of the cloud's JSON (number or numeric string) in agorot; null when absent or not a number. */
export function agorotOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/* ------------------------------------------------------------------ the till's X */

/** The till X's figures the block reads (core/sale.ts XTill, shekels). */
export interface XCashFigures {
  openingCash: number;
  totalCash: number;
  totalCashTips: number;
  totalCardTips: number;
  expectedCash: number;
  cashIn?: number;
  cashOut?: number;
  deposits?: number;
  walletIn?: number;
  walletDeposits?: number;
  /** Frozen / computed payout (absent: the parameter off). */
  cardTipsFromDrawer?: number;
  cardTipsUnpaid?: number;
}

const ag = (shekels: number | undefined) => Math.round((shekels ?? 0) * 100);

/** The X's drawer input (movements always in the X's expected cash). */
export function xDrawerInput(t: XCashFigures, show: boolean): DrawerInput {
  return {
    opening: ag(t.openingCash),
    cashSales: ag(t.totalCash),
    cashTips: ag(t.totalCashTips),
    cardTips: ag(t.totalCardTips),
    movements: { cashIn: ag(t.cashIn), cashOut: ag(t.cashOut), deposits: ag(t.deposits) },
    wallet: { walletIn: ag(t.walletIn), walletDeposits: ag(t.walletDeposits) },
    between: 0,
    param: typeof t.cardTipsFromDrawer === 'number',
    showDrawerCash: show,
  };
}

/** The X's block from its figures (the payout already on them). */
export function xCashBlock(t: XCashFigures, show: boolean): CashLine[] {
  const paid = typeof t.cardTipsFromDrawer === 'number' ? ag(t.cardTipsFromDrawer) : null;
  return cashBlock(xDrawerInput(t, show), paid, paid === null ? null : ag(t.cardTipsUnpaid)).lines;
}

/* ------------------------------------------------------------------ the cloud's Z */

/** A Z's (or a Z section's) drawer: its frozen figures; the cash takings are what makes the total its expectedCash. */
export function zDrawer(z: Record<string, unknown>): { input: DrawerInput; paid: number | null; unpaid: number | null } {
  const mvRaw = z.cashMovements && typeof z.cashMovements === 'object' ? (z.cashMovements as Record<string, unknown>) : null;
  const wRaw = z.cashWallets && typeof z.cashWallets === 'object' ? (z.cashWallets as Record<string, unknown>) : null;
  const movements = mvRaw ? { cashIn: agorotOf(mvRaw.cashIn) ?? 0, cashOut: agorotOf(mvRaw.cashOut) ?? 0, deposits: agorotOf(mvRaw.deposits) ?? 0 } : null;
  const wallet = { walletIn: agorotOf(wRaw?.walletIn) ?? 0, walletDeposits: agorotOf(wRaw?.walletDeposits) ?? 0 };
  const paid = agorotOf(z.cardTipsFromDrawer);
  const unpaid = paid === null ? null : (agorotOf(z.cardTipsUnpaid) ?? 0);
  const input: DrawerInput = {
    opening: agorotOf(z.openingCash) ?? 0,
    cashSales: agorotOf(z.cashSalesNet) ?? agorotOf(z.totalCashSales) ?? agorotOf(z.totalCash) ?? 0,
    cashTips: agorotOf(z.totalCashTips) ?? 0,
    cardTips: (paid ?? 0) + (unpaid ?? 0),
    movements,
    wallet,
    between: agorotOf(z.betweenShiftAdjustments) ?? 0,
    param: paid !== null,
    showDrawerCash: true,
  };
  // The expected cash is the Z's own: where the cloud sent it, the takings line is what reconciles to it.
  const expected = agorotOf(z.expectedCash);
  if (expected !== null) input.cashSales += expected - cashBlock(input, paid, unpaid).total;
  return { input, paid, unpaid };
}

/* ------------------------------------------------------------------ the till's figures */

/** The XTill fields the payout adds (core/sale.ts XTill). */
export interface XTillCashFields {
  /** Paid out of the drawer (unchanged key the cloud reads); already off expectedCash. Absent: the parameter off. */
  cardTipsFromDrawer?: number;
  /** Owed to staff ("לא שולמו — לתשלום לעובדים"). */
  cardTipsUnpaid?: number;
  /** The resolved shortfall mode (ask → the manager's choice). */
  cardTipsShortfall?: CardTipsChoice;
  /** ask and short with no choice yet: the close must ask (an X previews partial). Only when true. */
  cardTipsNeedsChoice?: boolean;
  /** Back-compat "מזומן במגירה" of the old figure: cash takings + cash tips − paid. */
  drawerCash?: number;
}

/**
 * The till's X with the card tips paid out of the drawer (applied after the drawer's movements and wallets: the expected
 * cash then is the `available` of the spec). Off: the till as it was.
 */
export function withCashWithTips<T extends XCashFigures & XTillCashFields>(
  till: T,
  opts: { param: boolean; shortfall: CardTipsShortfall; askChoice: CardTipsChoice | null },
): T {
  if (!opts.param) return till;
  const available = ag(till.expectedCash);
  const p = payout(true, opts.shortfall, opts.askChoice, available, ag(till.totalCardTips));
  const paid = p.paid ?? 0;
  const out: T = {
    ...till,
    expectedCash: (available - paid) / 100,
    cardTipsFromDrawer: paid / 100,
    cardTipsUnpaid: (p.unpaid ?? 0) / 100,
    cardTipsShortfall: p.mode ?? 'partial',
    drawerCash: (ag(till.totalCash) + ag(till.totalCashTips) - paid) / 100,
  };
  if (p.needsChoice) out.cardTipsNeedsChoice = true;
  else delete out.cardTipsNeedsChoice;
  return out;
}
