/**
 * "חזרה אוטומטית לקיוסק" — after a manager took R2M POS for Windows out to the desktop
 * ("יציאה לשולחן העבודה", DESKTOP_EXIT), the device is back in full screen by itself once nobody
 * has touched the keyboard or mouse for this many minutes. The owner (08.10.2026): on, 10 minutes,
 * set from the cloud (pos-server app/services/desktop_idle_return.py).
 *
 * One POS setting, `desktopIdleReturnMinutes`, on any layer (company → shop → point of sale →
 * device): a whole number 0–240, 0 = never by itself; unset = inherit (10 at the top). The rules
 * here are the dashboard form's and the Windows app's (kiosk-desktop imports this file):
 * the cloud's value, else the device's own kiosk.json, else 10.
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own, and so does
 * kiosk-desktop.
 */

export const DESKTOP_IDLE_RETURN_KEY = 'desktopIdleReturnMinutes';
export const DESKTOP_IDLE_RETURN_DEFAULT = 10;
export const DESKTOP_IDLE_RETURN_MAX = 240;

/** A value as the server takes it: a whole number 0–240; anything else is null. */
export function cleanIdleReturnMinutes(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  return v >= 0 && v <= DESKTOP_IDLE_RETURN_MAX ? v : null;
}

/** The Windows app: the cloud's minutes, else kiosk.json's, else 10. */
export function idleReturnMinutesFor(input: { cloud?: unknown; local?: unknown }): number {
  return cleanIdleReturnMinutes(input.cloud) ?? cleanIdleReturnMinutes(input.local) ?? DESKTOP_IDLE_RETURN_DEFAULT;
}

/** The text box: digits only → a value to save, '' → no value (null), out of range → undefined (invalid). */
export function parseIdleReturnInput(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  if (!/^[0-9]{1,3}$/.test(t)) return undefined;
  return cleanIdleReturnMinutes(Number(t)) ?? undefined;
}

export interface IdleReturnView {
  /** The minutes the device uses (0 = off). */
  minutes: number;
  on: boolean;
  /** Where they come from: this layer, a layer above, or the default. */
  from: 'own' | 'inherited' | 'default';
}

/** What a layer's form shows: its own value, else what it inherits, else the default. */
export function idleReturnView(own: unknown, inherited: unknown): IdleReturnView {
  const mine = cleanIdleReturnMinutes(own);
  if (mine !== null) return { minutes: mine, on: mine > 0, from: 'own' };
  const above = cleanIdleReturnMinutes(inherited);
  if (above !== null) return { minutes: above, on: above > 0, from: 'inherited' };
  return { minutes: DESKTOP_IDLE_RETURN_DEFAULT, on: true, from: 'default' };
}

/**
 * The switch: off saves 0; on saves the minutes shown before it was turned off (or the default
 * when they were 0) — never a "minutes" field left at 0 with the switch on.
 */
export function idleReturnSwitchValue(on: boolean, current: IdleReturnView): number {
  if (!on) return 0;
  return current.minutes > 0 ? current.minutes : DESKTOP_IDLE_RETURN_DEFAULT;
}
