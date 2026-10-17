/**
 * "מזומן במגירה כולל טיפים" — the cash in the drawer, tips included, on every X and Z
 * (P:/specs/x-z-cash-with-tips.md). The same rule as pos-server `app/services/cash_with_tips.py`,
 * pos-android `domain/CashWithTips.kt` and the Windows till, pinned by the shared golden
 * `server/tests/fixtures/x_z_cash_with_tips_golden.json` (cashWithTips.test.ts). Pure, in agorot.
 *
 * * The payout (§2): with `cashDrawer.cardTipsFromDrawer` on, how much of the card tips the drawer
 *   pays under `cashDrawer.cardTipsShortfall` — `partial` (default) pays only what is there,
 *   `negative` pays everything, `ask` lets the manager choose at the close (only when short).
 * * The block (§1): "קופה פותחת … = מזומן במגירה (כולל טיפים)"; its total is the report's expected
 *   cash exactly. `total` / `short` only where the expected cash may be seen.
 * * The per-till table (§3) of a shop / area Z or X: each drawer apart, a totals row, the unpaid.
 *
 * Money in and out as decimal strings (two places, "-" for a negative).
 */

export type Money = string | number | null | undefined;

export type Shortfall = 'partial' | 'negative' | 'ask';

export const SHORTFALL_OPTIONS: readonly Shortfall[] = ['partial', 'negative', 'ask'];

export type LineKey =
  | 'opening'
  | 'cashSales'
  | 'deviceCash'
  | 'cashTips'
  | 'cashIn'
  | 'cashOut'
  | 'deposits'
  | 'walletIn'
  | 'walletDeposits'
  | 'between'
  | 'cardTips'
  | 'cardTipsPaid'
  | 'cardTipsUnpaid'
  | 'total'
  | 'short';

export type SummaryKey = 'summaryCash' | 'summaryTips' | 'summaryUnpaid' | 'summaryNet';

export type LabelKey = LineKey | SummaryKey | 'title' | 'unpaidDay' | 'tillTable' | 'tillTotals' | 'perTill';

/** The screens' words (the golden's `labels`; he.json `cashWithTips.labels` has the same). */
export const LABELS: Record<LabelKey, string> = {
  title: 'מזומן במגירה',
  opening: 'קופה פותחת',
  cashSales: 'מזומן ממכירות',
  deviceCash: 'מזומן במכשיר',
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
};

/** The Z print setting (§3): under a shop / area Z's summary, the per-till table too or not. */
export const PRINT_PER_TILL_KEY = 'zPrintPerTillCash';

export interface Movements {
  cashIn?: Money;
  cashOut?: Money;
  deposits?: Money;
}

export interface Wallet {
  walletIn?: Money;
  walletDeposits?: Money;
}

/** The golden's input. `movements` null: not part of this report's expected cash. */
export interface DrawerInput {
  opening?: Money;
  cashSales?: Money;
  /** "מזומן במכשיר": the part of cashSales a cash device (CashMag / PayLink) took — never in the drawer. */
  deviceCash?: Money;
  cashTips?: Money;
  cardTips?: Money;
  movements?: Movements | null;
  wallet?: Wallet | null;
  between?: Money;
  param?: boolean;
  shortfall?: string | null;
  askChoice?: string | null;
  showDrawerCash?: boolean;
}

export interface Line {
  key: LineKey | SummaryKey;
  label: string;
  amount: string;
  bold: boolean;
  warn: boolean;
}

export interface DrawerExpect {
  available: string;
  paid: string | null;
  unpaid: string | null;
  frozenShortfall: 'partial' | 'negative' | null;
  needsChoice: boolean;
  total: string;
  short: boolean;
  lines: Line[];
}

/** Money to agorot, exact for decimal strings (half away from zero past two places); null for none. */
export function toAgorot(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  let cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (Number((frac + '000').charAt(2)) >= 5) cents += 1;
  return negative ? -cents : cents;
}

const ag = (value: unknown): number => toAgorot(value) ?? 0;

/** Agorot as a decimal string, "-" for a negative ("12.30", "-0.50"). */
export function money(agorot: number): string;
export function money(agorot: number | null): string | null;
export function money(agorot: number | null): string | null {
  if (agorot === null) return null;
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(agorot);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function normalizeShortfall(value: unknown): Shortfall {
  const text = String(value ?? '').trim().toLowerCase();
  return (SHORTFALL_OPTIONS as readonly string[]).includes(text) ? (text as Shortfall) : 'partial';
}

export interface Payout {
  paid: number | null;
  unpaid: number | null;
  mode: 'partial' | 'negative' | null;
  needsChoice: boolean;
}

/** §2 — `available` (agorot): the expected cash before the payout; `cardTips` net of reversals. */
export function payout(param: boolean, shortfall: unknown, askChoice: unknown, available: number, cardTips: number): Payout {
  if (!param) return { paid: null, unpaid: null, mode: null, needsChoice: false };
  const tips = Math.max(cardTips, 0);
  const room = Math.max(available, 0);
  const short = tips > room;
  let needsChoice = false;
  let mode: Shortfall = normalizeShortfall(shortfall);
  if (mode === 'ask') {
    const choice = String(askChoice ?? '').trim().toLowerCase();
    if (!short) mode = 'partial';
    else if (choice === 'partial' || choice === 'negative') mode = choice;
    else {
      mode = 'partial';
      needsChoice = true;
    }
  }
  const paid = mode === 'negative' ? tips : Math.min(tips, room);
  return { paid, unpaid: tips - paid, mode, needsChoice };
}

/** The expected cash before the tips payout (§2 "available"), agorot. */
export function availableOf(inp: DrawerInput): number {
  let total = ag(inp.opening) + ag(inp.cashSales) - ag(inp.deviceCash) + ag(inp.cashTips)
    + ag(inp.wallet?.walletDeposits) - ag(inp.wallet?.walletIn) + ag(inp.between);
  if (inp.movements) total += ag(inp.movements.cashIn) - ag(inp.movements.cashOut) - ag(inp.movements.deposits);
  return total;
}

/**
 * The block's lines and total (agorot) from figures, frozen or computed. `paid` null: the parameter
 * was off — no card tips lines. `show` (default: the input's `showDrawerCash`, else true): without
 * it the `total` / `short` lines are dropped, every other line stays.
 */
export function block(
  inp: DrawerInput,
  paid: number | null,
  unpaid: number | null,
  opts: { show?: boolean; labels?: Partial<Record<LabelKey, string>> } = {},
): { lines: Line[]; total: number } {
  const L = { ...LABELS, ...(opts.labels ?? {}) };
  const lines: Line[] = [];
  const add = (key: LineKey, amount: number, bold = false, warn = false) =>
    lines.push({ key, label: L[key], amount: money(amount), bold, warn });

  const opening = ag(inp.opening);
  const sales = ag(inp.cashSales);
  const ctips = ag(inp.cashTips);
  let total = opening + sales + ctips;
  add('opening', opening);
  add('cashSales', sales);
  const device = ag(inp.deviceCash);
  if (device !== 0) {
    add('deviceCash', -device);
    total -= device;
  }
  add('cashTips', ctips);
  if (inp.movements) {
    const cin = ag(inp.movements.cashIn);
    const cout = ag(inp.movements.cashOut);
    const dep = ag(inp.movements.deposits);
    if (cin !== 0) add('cashIn', cin);
    if (cout !== 0) add('cashOut', -cout);
    if (dep !== 0) add('deposits', -dep);
    total += cin - cout - dep;
  }
  const win = ag(inp.wallet?.walletIn);
  const wdep = ag(inp.wallet?.walletDeposits);
  if (win !== 0) add('walletIn', -win);
  if (wdep !== 0) add('walletDeposits', wdep);
  total += wdep - win;
  const between = ag(inp.between);
  if (between !== 0) add('between', between);
  total += between;
  if (paid !== null) {
    const owed = unpaid ?? 0;
    add('cardTips', paid + owed);
    add('cardTipsPaid', -paid);
    if (owed > 0) add('cardTipsUnpaid', owed);
    total -= paid;
  }
  const visible = opts.show ?? inp.showDrawerCash ?? true;
  if (visible) {
    add('total', total, true, total < 0);
    if (total < 0) add('short', -total, true, true);
  }
  return { lines, total };
}

/** One X / Z drawer from raw figures: the golden's `expect` (the payout computed here). */
export function drawerCase(inp: DrawerInput): DrawerExpect {
  const available = availableOf(inp);
  const pay = payout(!!inp.param, inp.shortfall ?? 'partial', inp.askChoice, available, ag(inp.cardTips));
  const { lines, total } = block(inp, pay.paid, pay.unpaid);
  return {
    available: money(available),
    paid: money(pay.paid),
    unpaid: money(pay.unpaid),
    frozenShortfall: pay.mode,
    needsChoice: pay.needsChoice,
    total: money(total),
    short: total < 0,
    lines,
  };
}

export interface TillRow {
  till: string;
  input: DrawerInput;
  paid: number | null;
  unpaid: number | null;
}

export interface TableRow {
  till: string;
  cashSales: string;
  cashTips: string;
  cardTipsPaid: string | null;
  cardTipsUnpaid: string | null;
  drawerCash: string | null;
  short: boolean;
}

export interface TillTable {
  rows: TableRow[];
  totals: {
    cashSales: string;
    cashTips: string;
    cardTipsPaid: string | null;
    cardTipsUnpaid: string | null;
    drawerCash: string | null;
    anyShort: boolean;
  };
  unpaidTotal: string;
  /**
   * §3 "summary first": the drawers' cash before any payout, the tips that belong to staff (cash tips +
   * card tips paid), the card tips still owed, and the business cash left ("מזומן נטו אחרי טיפים").
   */
  summary: {
    totalCash: string | null;
    tips: string;
    unpaid: string;
    netCash: string | null;
    lines: Line[];
  };
}

/** §3 "מזומן במגירה לפי קופה": per till, a totals row and the day's unpaid card tips. */
export function tillTable(rows: TillRow[], show = true, labels: Partial<Record<LabelKey, string>> = {}): TillTable {
  const L = { ...LABELS, ...labels };
  const out: TableRow[] = [];
  let available = 0;
  let sales = 0;
  let tips = 0;
  let drawer = 0;
  let paidSum: number | null = null;
  let unpaidSum: number | null = null;
  let anyShort = false;
  for (const r of rows) {
    const { total } = block(r.input, r.paid, r.unpaid, { show: false });
    available += total + (r.paid ?? 0);
    const s = ag(r.input.cashSales);
    const c = ag(r.input.cashTips);
    out.push({
      till: r.till,
      cashSales: money(s),
      cashTips: money(c),
      cardTipsPaid: money(r.paid),
      cardTipsUnpaid: money(r.paid === null ? null : (r.unpaid ?? 0)),
      drawerCash: show ? money(total) : null,
      short: show && total < 0,
    });
    sales += s;
    tips += c;
    if (r.paid !== null) {
      paidSum = (paidSum ?? 0) + r.paid;
      unpaidSum = (unpaidSum ?? 0) + (r.unpaid ?? 0);
    }
    drawer += total;
    anyShort = anyShort || total < 0;
  }
  const tipsAll = tips + (paidSum ?? 0);
  const owedAll = unpaidSum ?? 0;
  const net = available - tipsAll - owedAll;
  const summary: Line[] = [];
  const sadd = (key: SummaryKey, amount: number, bold = false, warn = false) =>
    summary.push({ key, label: L[key], amount: money(amount), bold, warn });
  if (show) sadd('summaryCash', available);
  sadd('summaryTips', tipsAll);
  if (owedAll > 0) sadd('summaryUnpaid', owedAll);
  if (show) sadd('summaryNet', net, true, net < 0);
  return {
    rows: out,
    totals: {
      cashSales: money(sales),
      cashTips: money(tips),
      cardTipsPaid: money(paidSum),
      cardTipsUnpaid: money(unpaidSum),
      drawerCash: show ? money(drawer) : null,
      anyShort: show && anyShort,
    },
    unpaidTotal: money(unpaidSum ?? 0),
    summary: {
      totalCash: show ? money(available) : null,
      tips: money(tipsAll),
      unpaid: money(owedAll),
      netCash: show ? money(net) : null,
      lines: summary,
    },
  };
}

/** The golden's `tillTableCases[].expect`: each till's payout computed from its raw figures. */
export function tillTableCase(tills: { till: string; input: DrawerInput }[], show = true): TillTable {
  return tillTable(
    tills.map((t) => {
      const pay = payout(!!t.input.param, t.input.shortfall ?? 'partial', t.input.askChoice, availableOf(t.input), ag(t.input.cardTips));
      return { till: t.till, input: t.input, paid: pay.paid, unpaid: pay.unpaid };
    }),
    show,
  );
}

// ── A Z's (or X's) frozen figures ─────────────────────────────────────────────

/** The fields of a Z section (or a Z's header read the same way) the block reads. */
export interface DrawerFigures {
  kiosk?: boolean | null;
  posNumber?: string | number | null;
  machineName?: string | null;
  openingCash?: Money;
  expectedCash?: Money;
  cashSalesNet?: Money;
  totalCash?: Money;
  /** "מזומן במכשיר": inside the cash, never in expectedCash (absent: none). */
  deviceCash?: Money;
  betweenShiftAdjustments?: Money;
  cashMovements?: Movements | null;
  cashWallets?: Wallet | null;
  cardTipsFromDrawer?: Money;
  cardTipsUnpaid?: Money;
}

/**
 * A section as the block's input and its frozen paid / unpaid; null when it carries no drawer (a
 * legacy Z, a kiosk). The cash tips line is what the expected holds beside the other lines, so the
 * block's total is the section's `expectedCash` exactly (as pos-server `figures_of_section`).
 */
export function figuresOfSection(
  s: DrawerFigures | null | undefined,
): { input: DrawerInput; paid: number | null; unpaid: number | null } | null {
  if (!s || s.kiosk) return null;
  const opening = toAgorot(s.openingCash);
  const expected = toAgorot(s.expectedCash);
  if (opening === null || expected === null) return null;
  const sales = toAgorot(s.cashSalesNet) ?? ag(s.totalCash);
  const paid = toAgorot(s.cardTipsFromDrawer);
  const unpaid = paid === null ? null : (toAgorot(s.cardTipsUnpaid) ?? 0);
  const input: DrawerInput = {
    opening: money(opening),
    cashSales: money(sales),
    deviceCash: money(ag(s.deviceCash)),
    cashTips: '0.00',
    movements: s.cashMovements
      ? { cashIn: money(ag(s.cashMovements.cashIn)), cashOut: money(ag(s.cashMovements.cashOut)), deposits: money(ag(s.cashMovements.deposits)) }
      : null,
    wallet: { walletIn: money(ag(s.cashWallets?.walletIn)), walletDeposits: money(ag(s.cashWallets?.walletDeposits)) },
    between: money(ag(s.betweenShiftAdjustments)),
  };
  const withoutTips = block(input, paid, unpaid, { show: false }).total;
  input.cashTips = money(expected - withoutTips);
  return { input, paid, unpaid };
}

/** A till's name in the table: "קופה 3" by its register number, else its name. */
export function tillLabel(s: DrawerFigures, word = 'קופה'): string {
  if (s.posNumber !== null && s.posNumber !== undefined && s.posNumber !== '') return `${word} ${s.posNumber}`;
  return (s.machineName ?? '').trim() || word;
}

/** The per-till table over a Z's (or X's) sections; null for one drawer or none (§3). */
export function tableOfSections(
  sections: (DrawerFigures | null | undefined)[],
  show = true,
  word = 'קופה',
  labels: Partial<Record<LabelKey, string>> = {},
): TillTable | null {
  const rows: TillRow[] = [];
  for (const s of sections) {
    const f = figuresOfSection(s);
    if (f && s) rows.push({ till: tillLabel(s, word), input: f.input, paid: f.paid, unpaid: f.unpaid });
  }
  return rows.length >= 2 ? tillTable(rows, show, labels) : null;
}

/** A Z as the dashboard has it: its drawer figures and its tills' sections. */
export interface ZDrawerLike {
  openingCash?: Money;
  expectedCash?: Money;
  totalCashSales?: Money;
  deviceCash?: Money;
  betweenShiftAdjustments?: Money;
  cashMovements?: Movements | null;
  cashWallets?: Wallet | null;
  cardTipsFromDrawer?: Money;
  cardTipsUnpaid?: Money;
  perMachine?: DrawerFigures[] | null;
}

export interface CashWithTips {
  lines: Line[];
  total: string | null;
  short: boolean;
  table: TillTable | null;
}

/**
 * The block (and, over several drawers, the table) of a Z from what it froze; null when it has no
 * drawer (a legacy Z, kiosks only). Its total is the Z's `expectedCash`.
 */
export function cashWithTipsOfZ(
  z: ZDrawerLike,
  opts: { show?: boolean; labels?: Partial<Record<LabelKey, string>>; tillWord?: string } = {},
): CashWithTips | null {
  const sections = (z.perMachine ?? []).filter(Boolean);
  if (sections.length > 0 && sections.every((s) => s.kiosk)) return null;
  const allNet = sections.length > 0 && sections.every((s) => s.cashSalesNet !== null && s.cashSalesNet !== undefined);
  const cashSales = allNet ? sections.reduce((sum, s) => sum + ag(s.cashSalesNet), 0) : ag(z.totalCashSales);
  const device = sections.length > 0 ? sections.reduce((sum, s) => sum + ag(s.deviceCash), 0) : ag(z.deviceCash);
  const between = sections.length > 0
    ? sections.reduce((sum, s) => sum + ag(s.betweenShiftAdjustments), 0)
    : ag(z.betweenShiftAdjustments);
  const figures = figuresOfSection({
    openingCash: z.openingCash,
    expectedCash: z.expectedCash,
    cashSalesNet: money(cashSales),
    deviceCash: money(device),
    betweenShiftAdjustments: money(between),
    cashMovements: z.cashMovements ?? null,
    cashWallets: z.cashWallets ?? null,
    cardTipsFromDrawer: z.cardTipsFromDrawer,
    cardTipsUnpaid: z.cardTipsUnpaid,
  });
  if (!figures) return null;
  const show = opts.show ?? true;
  const { lines, total } = block(figures.input, figures.paid, figures.unpaid, { show, labels: opts.labels });
  return {
    lines,
    total: show ? money(total) : null,
    short: show && total < 0,
    table: tableOfSections(sections, show, opts.tillWord, opts.labels),
  };
}

/** One till's section, compact (where the old two rows were): paid, unpaid and "חסר במגירה". */
export function sectionTipsLines(s: DrawerFigures, labels: Partial<Record<LabelKey, string>> = {}): Line[] {
  const L = { ...LABELS, ...labels };
  const out: Line[] = [];
  const paid = toAgorot(s.cardTipsFromDrawer);
  if (paid !== null) {
    const owed = toAgorot(s.cardTipsUnpaid) ?? 0;
    out.push({ key: 'cardTipsPaid', label: L.cardTipsPaid, amount: money(-paid), bold: false, warn: false });
    if (owed > 0) out.push({ key: 'cardTipsUnpaid', label: L.cardTipsUnpaid, amount: money(owed), bold: false, warn: false });
  }
  const expected = toAgorot(s.expectedCash);
  if (expected !== null && expected < 0 && !s.kiosk) {
    out.push({ key: 'short', label: L.short, amount: money(-expected), bold: true, warn: true });
  }
  return out;
}

// ── A shift's X (the dashboard's shift page) ────────────────────────────────

/** The till's frozen key for the card tips paid from the drawer, as a close carries it. */
function frozenAmount(till: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!till || !(key in till)) return null;
  const a = toAgorot(till[key]);
  return a !== null && a >= 0 ? a : null;
}

/**
 * A closed shift's block from what its close froze (`tillTotals`): the till's own X rule — opening +
 * cash + cash tips + its Cash In / Out / deposits and wallets (the keys it froze) − the paid card tips.
 * `cardTipsShortfall`: the mode it froze (null on an older close or with the parameter off). An open
 * shift has nothing frozen yet: no card tips lines.
 */
export function shiftCashWithTips(
  shift: {
    openingCash?: Money;
    totalCash?: Money;
    totalCashTips?: Money;
    /** "מזומן במכשיר" the cloud counted (absent: the close's own `totalDeviceCash`, else none). */
    totalDeviceCash?: Money;
    tillTotals?: Record<string, unknown> | null;
    open?: boolean;
  },
  opts: { show?: boolean; labels?: Partial<Record<LabelKey, string>> } = {},
): CashWithTips & { shortfall: 'partial' | 'negative' | null } {
  const till = shift.open ? null : (shift.tillTotals ?? null);
  const paid = frozenAmount(till, 'cardTipsFromDrawer');
  const unpaid = paid === null ? null : (frozenAmount(till, 'cardTipsUnpaid') ?? 0);
  const moved = !!till && ['cashIn', 'cashOut', 'deposits'].some((k) => k in till);
  const input: DrawerInput = {
    opening: shift.openingCash,
    cashSales: shift.totalCash,
    deviceCash: shift.totalDeviceCash ?? (shift.tillTotals?.totalDeviceCash as Money) ?? null,
    cashTips: shift.totalCashTips,
    movements: moved ? { cashIn: till!.cashIn as Money, cashOut: till!.cashOut as Money, deposits: till!.deposits as Money } : null,
    wallet: till ? { walletIn: till.walletIn as Money, walletDeposits: till.walletDeposits as Money } : null,
  };
  const show = opts.show ?? true;
  const { lines, total } = block(input, paid, unpaid, { show, labels: opts.labels });
  const mode = String(till?.cardTipsShortfall ?? '').trim().toLowerCase();
  return {
    lines,
    total: show ? money(total) : null,
    short: show && total < 0,
    table: null,
    shortfall: paid !== null && (mode === 'partial' || mode === 'negative') ? mode : null,
  };
}
