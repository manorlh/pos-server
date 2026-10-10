/**
 * The flags the cloud records on a voucher redemption it took anyway — a fiscal fact by then, so recorded and
 * flagged, never refused (the production vouchers contract §8, and the helper's §18): each has a Hebrew label in
 * `prepaidVouchers.kinds.flag`, shown as a tag beside the redemption (the voucher's history, the till report's
 * drill-down and its export). A flag the dashboard does not know yet shows as its code.
 */
export const REDEMPTION_FLAGS = [
  // The core: a late confirm, the voucher's limits, the stacking / promotion rules, a cancelled voucher,
  // an offline sale after the device was released, a manager approval no longer valid.
  'late',
  'over_use',
  'over_daily',
  'over_sale',
  'stacking',
  'promotion',
  'cancelled',
  'after_release',
  'approval_invalid',
  // The helper's controls: a staff test voucher on the real path, redeemed while paused, over a quota.
  'test_real',
  'paused',
  'over_quota',
] as const;

export type RedemptionFlag = (typeof REDEMPTION_FLAGS)[number];

/** The flags' texts in order, each once: its label when [label] knows it, else the code itself. */
export function flagTexts(
  flags: readonly string[] | null | undefined,
  label: (flag: string) => string | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const flag of flags ?? []) {
    const code = String(flag ?? '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(label(code) || code);
  }
  return out;
}
