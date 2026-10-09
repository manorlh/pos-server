/**
 * "עקיפת בדיקת מספר מסוף" — the till parameter `terminalNumberCheckBypass` (pos-server
 * app/services/terminal_check_bypass.py, docs/SPEC_KIOSK.md §20.1; the till's
 * domain/TerminalCheckBypass.kt). Set per company / shop / point of sale / device in the cloud.
 * On, the card lock's terminal-number check (main/payment/synqpay/provider.ts `cardLockOf`) never
 * locks or declines a card: not another number, not a missing machine-level number, not an
 * unread identity. Everything else stays — not paired, not answering, one sale at a time.
 */

export const TERMINAL_CHECK_BYPASS_KEY = 'terminalNumberCheckBypass';

/** What the technician screen shows while it is on. */
export const TERMINAL_CHECK_BYPASS_WARNING = 'בדיקת מספר מסוף מושבתת';

/** The parameter as the cloud sent it — lenient like every boolean parameter (true / 1 / yes / on / כן). */
export function checkBypassOn(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 'כן'].includes(v.trim().toLowerCase());
  return false;
}
