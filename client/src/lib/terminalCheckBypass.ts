/**
 * "עקיפת בדיקת מספר מסוף" — the till parameter `terminalNumberCheckBypass` as the dashboard shows it
 * per device (pos-server app/services/terminal_check_bypass.py, docs/SPEC_KIOSK.md §20.1).
 *
 * The cloud resolves it per till (company → shop → point of sale → till) and sends, on every
 * machine: whether it is on, the level it comes from, who set that level and when, what the till
 * itself last reported it applies, and the card lock it lifts now. While on, `cardLock` is null —
 * so the machine page and device health show "בדיקת מספר מסוף מושבתת" instead, with the warning.
 *
 * Kept free of React and of the `@/` alias so `npm test` can compile and run it on its own.
 */

export type CardLockReason = 'mismatch' | 'not_configured' | 'unknown';

export interface CheckBypassChange {
  userEmail: string | null;
  userRole: string | null;
  scopeType: string | null;
  at: string | null;
}

export interface CheckBypassFields {
  terminalNumberCheckBypass: boolean;
  terminalNumberCheckBypassSource: string | null;
  terminalNumberCheckBypassChange: CheckBypassChange | null;
  terminalNumberCheckBypassReported: boolean | null;
  cardLockBypassed: CardLockReason | null;
}

const REASONS: readonly CardLockReason[] = ['mismatch', 'not_configured', 'unknown'];
const LEVELS = ['company', 'shop', 'area', 'machine', 'default'] as const;
export type CheckBypassLevel = (typeof LEVELS)[number];

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The fields off a machine row; all off for a server that predates them. */
export function normalizeCheckBypass(raw: Record<string, unknown>): CheckBypassFields {
  const on = raw.terminalNumberCheckBypass === true;
  const c = raw.terminalNumberCheckBypassChange;
  const change =
    on && c && typeof c === 'object' && !Array.isArray(c)
      ? {
          userEmail: text((c as Record<string, unknown>).userEmail),
          userRole: text((c as Record<string, unknown>).userRole),
          scopeType: text((c as Record<string, unknown>).scopeType),
          at: text((c as Record<string, unknown>).at),
        }
      : null;
  const lifted = REASONS.find((r) => r === raw.cardLockBypassed) ?? null;
  return {
    terminalNumberCheckBypass: on,
    terminalNumberCheckBypassSource: on ? text(raw.terminalNumberCheckBypassSource) : null,
    terminalNumberCheckBypassChange: change,
    terminalNumberCheckBypassReported:
      typeof raw.terminalNumberCheckBypassReported === 'boolean' ? raw.terminalNumberCheckBypassReported : null,
    cardLockBypassed: on ? lifted : null,
  };
}

/** What the warning says, for the components to word. Null: nothing to show (off). */
export interface CheckBypassView {
  /** The level it comes from, when one of the known ones. */
  level: CheckBypassLevel | null;
  /** The lock it lifts now ("without it, card payment would be locked: …"). */
  lifted: CardLockReason | null;
  /** Who set it and when, when the change log has it. */
  by: string | null;
  at: string | null;
  /**
   * The till's own report disagrees with the cloud (it has not synced the change yet): "pending"
   * when the till still reports the check on; null when it agrees or never said.
   */
  till: 'pending' | null;
}

export function checkBypassView(m: Partial<CheckBypassFields>): CheckBypassView | null {
  if (m.terminalNumberCheckBypass !== true) return null;
  const source = m.terminalNumberCheckBypassSource ?? null;
  const level = (LEVELS as readonly string[]).includes(source ?? '') ? (source as CheckBypassLevel) : null;
  const change = m.terminalNumberCheckBypassChange ?? null;
  return {
    level,
    lifted: m.cardLockBypassed ?? null,
    by: change?.userEmail ?? change?.userRole ?? null,
    at: change?.at ?? null,
    till: m.terminalNumberCheckBypassReported === false ? 'pending' : null,
  };
}

/**
 * A till that still applies the bypass after the cloud turned it off (it has not synced yet): the
 * dashboard says so rather than nothing — the check is still off on that device right now.
 */
export function tillStillBypassing(m: Partial<CheckBypassFields>): boolean {
  return m.terminalNumberCheckBypass !== true && m.terminalNumberCheckBypassReported === true;
}
