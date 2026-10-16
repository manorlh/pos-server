/**
 * "הסתרת פריטים בתפריט הקופה" on the Windows till — the Android till's domain/MenuHide.kt (P:/specs/till-menu-hide.md
 * §1, §2, §5): the till parameter `hiddenMenuItems` names the menu items a business does not want on this till. The
 * keys are the Android till's, pinned by its golden `till_menu_items_golden.json` (a byte copy in test/fixtures, checked
 * by test/tillParity.test.ts).
 *
 *  - `catalog_admin,till_z` or `["catalog_admin","till_z"]`: case and spaces do not matter, an unknown key is skipped
 *    (a newer dashboard's entry this build does not have), blank — nothing hidden;
 *  - hiding only hides: the engine's rules and rights are untouched (a hidden "הפק Z" moves the Z elsewhere — another
 *    till or the cloud — it never changes how a Z is made);
 *  - the safety rules of the Android till: "settings" hidden stays reachable through the technician's code (here: the
 *    manager's corner, "ניהול הקיוסק" → technician); `quick_order` is a tables-only device's — the Windows till has no
 *    tables, so it is ignored (a till must never be left with no way to sell).
 *
 * Pure.
 */

/** The till parameter. */
export const HIDDEN_MENU_PARAM = 'hiddenMenuItems';

/** Every key the Android till knows, in its menu's order (till_menu_items_golden.json). */
export const MENU_ITEM_KEYS = [
  'catalog_admin',
  'shop_z',
  'shift',
  'shift_close',
  'till_z',
  'open_cash_drawer',
  'cash_menu',
  'refund',
  'transmission',
  'attendance',
  'sync_now',
  'ready_orders',
  'kiosk_orders',
  'voucher_station',
  'voucher_balance',
  'app_update',
  'history',
  'recent',
  'shift_history',
  'till_z_history',
  'product_sales',
  'workers',
  'tips',
  'tables_reports',
  'z_reports',
  'settings',
  'printers',
  'print_queue',
  'screen_edit',
  'diagnostics',
  'kiosk_mode',
  'alerts',
  'blocks_now',
  'managed_kiosks',
  'lock',
  'support',
  'switch_user',
  'tables',
  'training',
  'quick_order',
  'signed_in_users',
  'shop_x',
] as const;

export type MenuItemKey = (typeof MENU_ITEM_KEYS)[number];

const KNOWN: ReadonlySet<string> = new Set(MENU_ITEM_KEYS);

/** The hidden keys of a parameter value (a string — CSV or a JSON array — or an array), known keys only, in menu order. */
export function parseHiddenMenu(raw: unknown): MenuItemKey[] {
  let items: string[];
  if (Array.isArray(raw)) items = raw.map((x) => String(x));
  else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    items = s
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(/[,;\n]/);
  } else return [];
  const wanted = new Set(items.map((x) => x.trim().replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase()).filter((x) => x.length > 0 && KNOWN.has(x)));
  // `quick_order` belongs to a device that sells through its tables: the Windows till has none (§5א) — never hidden here.
  wanted.delete('quick_order');
  return MENU_ITEM_KEYS.filter((k) => wanted.has(k));
}
