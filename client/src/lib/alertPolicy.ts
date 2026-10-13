/**
 * "מדיניות התראות" (P:/specs/manager-problems.md §2): the board's lights as alerts — a Z not made, a
 * shift open too long, card sales not transmitted, the till's printer. Each is an exception rule
 * (pos-server app/services/exceptions.py), set per organization / company / shop / point of sale /
 * till on "הגדרות חריגות" like every rule; this only says which rules they are, so the page shows
 * them first, under their own heading.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

export const ALERT_POLICY_TYPES = ['z_missing', 'shift_open_overdue', 'card_transmission_overdue', 'till_printer'] as const;
export type AlertPolicyType = (typeof ALERT_POLICY_TYPES)[number];

export function isAlertPolicyType(type: string): type is AlertPolicyType {
  return (ALERT_POLICY_TYPES as readonly string[]).includes(type);
}

/** The alert policy's rules (in its own order) and every other rule (in the server's order). */
export function splitPolicyRules<T extends { type: string }>(rules: readonly T[]): { policy: T[]; others: T[] } {
  const policy = ALERT_POLICY_TYPES.flatMap((type) => rules.filter((r) => r.type === type));
  const others = rules.filter((r) => !isAlertPolicyType(r.type));
  return { policy, others };
}
