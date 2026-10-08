/**
 * "טיפ באשראי משולם מהמזומן" (till parameter `cashDrawer.cardTipsFromDrawer`): card tips
 * handed to staff in cash out of the drawer (pos-server docs/SHIFTS_API.md §1.3, §3.6).
 *
 * The till freezes the amount on each shift's close (`tillTotals.cardTipsFromDrawer`, only
 * when the parameter was on); a Z and its sections carry `cardTipsFromDrawer` and
 * `drawerCash` ("מזומן במגירה") only then. Without the figure nothing new is shown. Tips
 * are no revenue: the sales and tips figures never change — only the drawer.
 */

type Amount = string | number | null | undefined;

function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The card tips a closed shift's till paid out of the drawer, or null when its close did not say. */
export function cardTipsFromDrawerOf(tillTotals: Record<string, unknown> | null | undefined): number | null {
  if (!tillTotals || !('cardTipsFromDrawer' in tillTotals)) return null;
  const n = amount(tillTotals.cardTipsFromDrawer);
  return n !== null && n >= 0 ? n : null;
}

/** "מזומן במגירה" of one shift: its cash takings + cash tips − the card tips paid from the drawer. */
export function shiftDrawerCash(totalCash: Amount, totalCashTips: Amount, cardTipsFromDrawer: number): number {
  const cents = Math.round(((amount(totalCash) ?? 0) + (amount(totalCashTips) ?? 0) - cardTipsFromDrawer) * 100);
  return cents / 100;
}

/** Whether a Z or section carries the figure (then both rows are shown; a zero is a figure). */
export function hasDrawerTips(value: Amount): boolean {
  return amount(value) !== null;
}
