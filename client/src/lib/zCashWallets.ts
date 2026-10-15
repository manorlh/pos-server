/**
 * "הכסף אצלי" — cash kept by employees until deposited (P:/specs/drawer-away.md §5.6; pos-server
 * app/services/cash_wallets.py).
 *
 * A cash payment on a device away from a drawer may leave the money with the employee; it is counted into
 * a drawer later ("הפקדת מזומן מעובד"). Until then it is in no drawer: a Z's expected cash takes off what
 * the tills' payments left with employees and adds what they deposited — always, frozen with the Z — and
 * the Z lists "מזומן אצל עובדים (טרם הופקד)" per employee as it stood when the Z was built.
 * The dashboard never recomputes them: a Z shows what it froze. Absent blocks: the Z reads as it always did.
 */

type Amount = string | number | null | undefined;

/** A Z's (or a till's section's) `cashWallets` block: money as decimal strings. */
export interface ZCashWallets {
  walletIn?: Amount;
  walletDeposits?: Amount;
}

/** A Z's `cashWithStaff`: the employees holding cash not deposited when it was built. */
export interface ZCashWithStaff {
  total?: Amount;
  employees?: { employeeId: string; employeeName?: string | null; amount?: Amount }[] | null;
}

export type CashWalletKey = 'walletIn' | 'walletDeposits';

export interface CashWalletRow {
  key: CashWalletKey;
  /** As the expected cash moves: the cash with employees minus, their deposits plus. */
  value: number;
}

function amount(value: unknown): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return 0;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The drawer's lines, each only when it moved something: "הכסף אצל עובדים" (−), "הפקדות מעובדים" (+). */
export function cashWalletRows(block: ZCashWallets | null | undefined): CashWalletRow[] {
  if (!block || typeof block !== 'object') return [];
  const rows: CashWalletRow[] = [
    { key: 'walletIn', value: -amount(block.walletIn) },
    { key: 'walletDeposits', value: amount(block.walletDeposits) },
  ];
  return rows.filter((r) => r.value !== 0);
}

/** What they add to the expected cash: deposits − the cash with employees. */
export function cashWalletsNet(block: ZCashWallets | null | undefined): number {
  const cents = cashWalletRows(block).reduce((acc, r) => acc + Math.round(r.value * 100), 0);
  return cents / 100;
}

export interface CashWithStaffRow {
  employeeId: string;
  name: string;
  amount: number;
}

/** "מזומן אצל עובדים (טרם הופקד)": one row per employee holding any, and the total; none — nobody. */
export function cashWithStaffRows(staff: ZCashWithStaff | null | undefined): { rows: CashWithStaffRow[]; total: number } {
  const rows = (staff?.employees ?? [])
    .map((e) => ({ employeeId: e.employeeId, name: e.employeeName || e.employeeId, amount: amount(e.amount) }))
    .filter((r) => r.amount > 0);
  const cents = rows.reduce((acc, r) => acc + Math.round(r.amount * 100), 0);
  return { rows, total: cents / 100 };
}
