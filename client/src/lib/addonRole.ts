/**
 * "תוספת" — a product's add-on role (`addonRole`, pos-server app/services/addon_role.py):
 *
 *  - `none` — "פריט רגיל", as every product before this (and a row without the field);
 *  - `addon_only` — "תוספת בלבד": in no sell catalog (tills, kiosks, the web kiosk, online, the digital menu),
 *    only an add-on option's linked product or a meal's component;
 *  - `both` — "גם וגם": sold on its own and used as an add-on.
 *
 * Pure; no imports (the node tests and the kiosks compile it on their own).
 */

export const ADDON_ROLES = ['none', 'addon_only', 'both'] as const;
export type AddonRole = (typeof ADDON_ROLES)[number];

/** A row's code: anything the client does not know (or none) is `none`, as the server reads it. */
export function addonRoleOf(v: unknown): AddonRole {
  return v === 'addon_only' || v === 'both' ? v : 'none';
}

/** "תוספת בלבד": never on a sell screen — a catalog row of any device. */
export function isAddonOnly(p: { addonRole?: unknown } | null | undefined): boolean {
  return !!p && p.addonRole === 'addon_only';
}
