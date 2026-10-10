/**
 * Production of prepaid vouchers ("שוברי הפקה") in groups (pos-server
 * docs/SPEC_VOUCHER_PRODUCTION.md): "1000 vouchers in groups of 10" is 100 files of 10, one
 * per envelope. The server numbers the groups when it issues the vouchers
 * (`app/services/prepaid_vouchers.group_plan`); this is the same arithmetic, so the form can
 * say what will come out — including the smaller last group — before anything is made.
 */

/** The sizes offered as one tap; anything else is "מותאם". */
export const GROUP_PRESETS = [10, 20] as const;

export type GroupMode = 'none' | '10' | '20' | 'custom';

/** The largest group: the largest run (the server's MAX_GROUP_SIZE). */
export const MAX_GROUP_SIZE = 5000;

/** The size the form's choice stands for: null for no groups, or for a custom size that is not a whole number ≥ 1. */
export function groupSizeOf(mode: GroupMode, custom: string): number | null {
  if (mode === 'none') return null;
  if (mode === '10') return 10;
  if (mode === '20') return 20;
  const n = Number(custom.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_GROUP_SIZE ? n : null;
}

export interface GroupPlan {
  /** Groups in all. */
  groups: number;
  /** The size of every group but maybe the last. */
  size: number;
  /** Groups of exactly [size]. */
  full: number;
  /** The last group's size when smaller than [size]; null when the count divides. */
  last: number | null;
}

/** [count] vouchers in groups of [size]; null when not grouped (or nothing to group). */
export function groupPlan(count: number, size: number | null): GroupPlan | null {
  if (!size || size < 1 || !Number.isInteger(count) || count < 1) return null;
  const full = Math.floor(count / size);
  const rest = count % size;
  return { groups: full + (rest ? 1 : 0), size, full, last: rest || null };
}

/** Serial range of group [n] (1-based) of a plan whose first voucher is [firstSerial]. */
export function groupRange(plan: GroupPlan, n: number, firstSerial = 1): [number, number] {
  const lo = firstSerial + (n - 1) * plan.size;
  const count = n === plan.groups && plan.last ? plan.last : plan.size;
  return [lo, lo + count - 1];
}

/** "0021-0030" — four digits, as on the vouchers and the cover sheets. */
export function serialRange(lo: number, hi: number): string {
  return `${String(lo).padStart(4, '0')}-${String(hi).padStart(4, '0')}`;
}
