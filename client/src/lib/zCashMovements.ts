/**
 * "Z — מזומן צפוי כולל הפקדות ותנועות מזומן" (till parameter `cashDrawer.zExpectedCashMovements`,
 * off by default; pos-server app/services/z_expected_cash.py, docs/SHIFTS_API.md §3.6).
 *
 * The till's X has always reckoned the drawer with the shift's Cash In / Cash Out and safe
 * deposits; the Z's "מזומן צפוי" did not. With the parameter on when a Z was produced, its
 * expected cash takes them — and the Z and each till's section carry a `cashMovements` block with
 * the figures that went in. Absent means the parameter was off (the Z reads as it always did);
 * the dashboard never reads the parameter itself — a Z shows what it froze.
 *
 * A management figure only: sales, VAT, payments and the document ranges never move with it.
 */

type Amount = string | number | null | undefined;

/** The block as a Z (or a till's section) freezes it: money as decimal strings. */
export interface ZCashMovements {
  cashIn?: Amount;
  cashOut?: Amount;
  deposits?: Amount;
}

export type CashMovementKey = 'cashIn' | 'cashOut' | 'deposits';

/** One line of the drawer: [value] as the expected cash moves — Cash In plus, the others minus. */
export interface CashMovementRow {
  key: CashMovementKey;
  value: number;
}

function amount(value: unknown): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 0;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The lines the drawer shows above the expected cash they are part of, in the paper's order:
 * "הכנסות מזומן" (+), "הוצאות" (−), "הפקדה לכספת" (−) — each only when it moved something.
 * None for a Z the parameter was off for (no block), so such a Z shows exactly what it always did.
 */
export function cashMovementRows(movements: ZCashMovements | null | undefined): CashMovementRow[] {
  if (!movements || typeof movements !== 'object') return [];
  const rows: CashMovementRow[] = [
    { key: 'cashIn', value: amount(movements.cashIn) },
    { key: 'cashOut', value: -amount(movements.cashOut) },
    { key: 'deposits', value: -amount(movements.deposits) },
  ];
  return rows.filter((r) => r.value !== 0);
}

/** What the movements add to the expected cash: Cash In − Cash Out − deposits. */
export function cashMovementsNet(movements: ZCashMovements | null | undefined): number {
  const cents = cashMovementRows(movements).reduce((acc, r) => acc + Math.round(r.value * 100), 0);
  return cents / 100;
}

/** Whether the Z (or section) says the parameter applied — even when nothing moved. */
export function hasCashMovementsBlock(movements: ZCashMovements | null | undefined): boolean {
  return !!movements && typeof movements === 'object';
}
