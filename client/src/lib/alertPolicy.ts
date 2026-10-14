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

/**
 * Whether a rule offers "שלח התראה לטלפון" (P:/specs/push-more.md §0): it is sent as a phone-alert type,
 * and not "שלמות נתונים" (the super admins', which no level switches off). An older server: never.
 */
export function offersPushSwitch(rule: { inheritedPush?: boolean; pushCategory?: string | null }): boolean {
  return rule.inheritedPush !== undefined && !!rule.pushCategory && rule.pushCategory !== 'integrity';
}

/**
 * A rule's param as "הגדרות חריגות" edits it: a number (a threshold), or a switch (`boolean` —
 * `shift_open_overdue.alertPastDate`, "התראה גם כשהמשמרת עוברת את התאריך שלה", off by default).
 */
export interface EditableParam {
  key: string;
  min: number;
  max: number;
  integer: boolean;
  /** A switch: true / false. Absent on an older server (every param a number). */
  boolean?: boolean;
}

/** The editor's text for a level's own value: '' = inherit; a switch 'true' / 'false'. */
export function paramText(value: number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Whether an edited text would be refused (the server refuses it too). '' (inherit) never is. */
export function paramInvalid(param: EditableParam | undefined, text: string): boolean {
  if (text.trim() === '') return false;
  if (!param) return true;
  if (param.boolean) return text !== 'true' && text !== 'false';
  const n = Number(text);
  if (!Number.isFinite(n)) return true;
  if (n < param.min || n > param.max) return true;
  return param.integer && !Number.isInteger(n);
}

/** The value to save for an edited text: null = inherit; a switch true / false; else the number. */
export function paramValue(param: EditableParam | undefined, text: string): number | boolean | null {
  if (text.trim() === '') return null;
  if (param?.boolean) return text === 'true';
  return Number(text);
}

/** The alert policy's rules (in its own order) and every other rule (in the server's order). */
export function splitPolicyRules<T extends { type: string }>(rules: readonly T[]): { policy: T[]; others: T[] } {
  const policy = ALERT_POLICY_TYPES.flatMap((type) => rules.filter((r) => r.type === type));
  const others = rules.filter((r) => !isAlertPolicyType(r.type));
  return { policy, others };
}
