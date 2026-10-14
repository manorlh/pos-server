/**
 * "תפריט הקופה" — `hiddenMenuItems` (P:/specs/till-menu-hide.md; pos-server app/services/till_menu.py):
 * the till's menu items hidden on a till for everyone, whatever their permissions. One till parameter,
 * comma-separated keys, set per company → shop → point of sale → till (the most specific list wins
 * whole: a lower level hides more or gives items back; [] = everything shows there).
 *
 * The items (§5) are the till's, in its menu's order, with its names, tile colours and glyphs; the
 * list is pinned with the server by the shared golden file
 * server/tests/fixtures/till_menu_items_golden.json. Here: reading and writing the value, the warnings
 * for the critical items, what a level inherits, and the menu as the till will show it. Pure —
 * `npm test` compiles it alone; the calls are in lib/tillMenuApi.ts.
 */

export const HIDDEN_MENU_ITEMS_KEY = 'hiddenMenuItems';

export type MenuGroupId = 'catalog' | 'shopZ' | 'shift' | 'reports' | 'manage' | 'more' | 'outside';

/** The glyph on the item's tile (a lucide icon, as close as it gets to the till's). */
export type MenuIcon =
  | 'pencil'
  | 'receipt'
  | 'calendar'
  | 'calendarX'
  | 'circleCheck'
  | 'banknote'
  | 'coins'
  | 'undo'
  | 'send'
  | 'clock'
  | 'refresh'
  | 'check'
  | 'monitor'
  | 'ticket'
  | 'wallet'
  | 'download'
  | 'history'
  | 'chart'
  | 'user'
  | 'tables'
  | 'settings'
  | 'printer'
  | 'listOrdered'
  | 'layout'
  | 'wrench'
  | 'bell'
  | 'alert'
  | 'lock'
  | 'phone'
  | 'logout'
  | 'training'
  | 'cart';

export interface TillMenuItem {
  key: string;
  /** Its name in the till's menu (§5). */
  label: string;
  /** Hiding it says a warning (§2): no shift close, no Z, settings by technician code only. */
  critical: boolean;
  /** In the menu's "דוחות" folder (§5 18–25). */
  report: boolean;
  group: MenuGroupId;
  icon: MenuIcon;
  /** The tile's colour on the till (iOS system colours, ui/nav/PosNavigation.kt `IosTile`). */
  tile: string;
  /** What the till hides with it — shortcuts and ways in (§5). */
  also?: string;
}

const TILE = {
  blue: '#007AFF',
  green: '#34C759',
  indigo: '#5856D6',
  orange: '#FF9500',
  pink: '#FF2D55',
  purple: '#AF52DE',
  red: '#FF3B30',
  teal: '#30B0C7',
  mint: '#00C7BE',
  cyan: '#32ADE6',
  brown: '#A2845E',
  gray: '#8E8E93',
  graphite: '#636366',
  yellow: '#FF9F0A',
} as const;

const ENTRY_FROM_CLOSED_SHOP = 'כניסה מ"סגירת משמרת ו-Z" במסך "סניף לא פעיל"';

function item(
  key: string,
  label: string,
  group: MenuGroupId,
  icon: MenuIcon,
  tile: string,
  extra: { critical?: boolean; report?: boolean; also?: string } = {},
): TillMenuItem {
  return { key, label, group, icon, tile, critical: !!extra.critical, report: !!extra.report, ...(extra.also ? { also: extra.also } : {}) };
}

/** Every item that may be hidden, in the till's menu order (§5). */
export const TILL_MENU_ITEMS: readonly TillMenuItem[] = [
  item('catalog_admin', 'ניהול קטלוג', 'catalog', 'pencil', TILE.orange, {
    also: '"פתח בניהול קטלוג" מלחיצה ארוכה על מוצר במסך המכירה',
  }),
  item('shop_z', 'סגירת Z סניפי', 'shopZ', 'receipt', TILE.pink, { also: ENTRY_FROM_CLOSED_SHOP }),
  item('shift', 'משמרת (דו״ח X)', 'shift', 'calendar', TILE.blue),
  item('shift_close', 'סגירת משמרת', 'shift', 'calendarX', TILE.graphite, { critical: true, also: ENTRY_FROM_CLOSED_SHOP }),
  item('till_z', 'הפק Z', 'shift', 'circleCheck', TILE.green, {
    critical: true,
    also: 'כפתור "הפק Z" במסך המשמרת; כניסה מ"סגירת משמרת ו-Z"',
  }),
  item('open_cash_drawer', 'פתיחת מגירה', 'shift', 'banknote', TILE.mint),
  item('cash_menu', 'מזומן במגירה (הכנסה, הוצאה, הפקדה, ספירה, יומן)', 'shift', 'coins', TILE.teal),
  item('refund', 'זיכוי', 'shift', 'undo', TILE.red),
  item('transmission', 'פעולות אשראי (שידור)', 'shift', 'send', TILE.orange),
  item('attendance', 'נוכחות', 'shift', 'clock', TILE.indigo),
  item('sync_now', 'סנכרון מול הענן', 'shift', 'refresh', TILE.blue),
  item('ready_orders', 'הזמנות להכנה', 'shift', 'check', TILE.mint),
  item('kiosk_orders', 'הזמנות קיוסק לתשלום', 'shift', 'monitor', TILE.purple),
  item('voucher_station', 'עמדת שובר: יציאה למסך רגיל / חזרה לעמדת שובר', 'shift', 'ticket', TILE.pink),
  item('voucher_balance', 'בירור יתרת שובר', 'shift', 'wallet', TILE.cyan),
  item('app_update', 'עדכון גרסה', 'shift', 'download', TILE.blue, {
    also: 'התקנה אוטומטית ופקודה מהדשבורד ממשיכות לעבוד',
  }),
  item('history', 'היסטוריה', 'reports', 'history', TILE.gray),
  item('recent', '24 השעות האחרונות', 'reports', 'clock', TILE.teal, { report: true, also: 'הכפתור במסך ההיסטוריה' }),
  item('shift_history', 'היסטוריית משמרות', 'reports', 'receipt', TILE.indigo, { report: true }),
  item('till_z_history', 'דוחות Z של הקופה', 'reports', 'receipt', TILE.green, { report: true }),
  item('product_sales', 'מכירות לפי מוצר', 'reports', 'chart', TILE.orange, { report: true }),
  item('workers', 'דוח לפי עובד', 'reports', 'user', TILE.blue, { report: true }),
  item('tips', 'דוח תשר', 'reports', 'banknote', TILE.yellow, { report: true }),
  item('tables_reports', 'דוחות שולחנות', 'reports', 'tables', TILE.brown, { report: true }),
  item('z_reports', 'דוחות Z (מהענן)', 'reports', 'receipt', TILE.gray, { report: true }),
  item('settings', 'הגדרות', 'manage', 'settings', TILE.gray, { critical: true }),
  item('printers', 'מדפסות', 'manage', 'printer', TILE.indigo),
  item('print_queue', 'תור הדפסה', 'manage', 'listOrdered', TILE.red),
  item('screen_edit', 'עריכת מסך', 'manage', 'layout', TILE.teal),
  item('diagnostics', 'אבחון (מסך טכנאי)', 'manage', 'wrench', TILE.graphite),
  item('kiosk_mode', 'חזרה למצב קיוסק / מעבר לקיוסק', 'more', 'monitor', TILE.purple),
  item('alerts', 'התראות', 'more', 'bell', TILE.red, { also: 'הפעמון בסרגל' }),
  item('blocks_now', 'חסומים כעת', 'more', 'alert', TILE.red),
  item('managed_kiosks', 'קיוסקים (קופה שולטת)', 'more', 'monitor', TILE.cyan, { also: '"קיוסקים" מתוך התראה' }),
  item('lock', 'נעילת קופה: יציאה מנעילת קופה / נעילת הקופה מחדש', 'more', 'lock', TILE.graphite),
  item('support', 'תמיכה מרחוק', 'more', 'phone', TILE.green),
  item('switch_user', 'יציאה מהמשתמש (החלפת משתמש)', 'more', 'logout', TILE.red),
  item('tables', 'שולחנות (בסרגל, לא בתפריט)', 'outside', 'tables', TILE.brown, {
    also: 'פתיחה אוטומטית על השולחנות; חזרה לשולחנות אחרי תשלום',
  }),
  item('training', 'מצב הדרכה: "הפק Z" של הדרכה', 'outside', 'training', TILE.orange, {
    also: 'הפס הכתום לא מוסתר. בקופה אין כניסה להדרכה מהתפריט, הענן מדליק אותה',
  }),
  // §5א "מכשיר לשולחנות בלבד": the till opens on its tables; no way to the sale screen but through a table.
  item('quick_order', 'הזמנה מהירה (בסרגל, לא בתפריט)', 'outside', 'cart', TILE.blue, {
    also:
      'הקופה נפתחת על מסך השולחנות; הלשונית "הזמנה מהירה", כל מעבר למסך המכירה שלא דרך שולחן, "מכירה מהירה" במסך השולחנות ו"החזר הזמנה"',
  }),
  // "עובד במכשיר אחד בלבד" v2 §8א: the manager's screen — who is signed in where, and the release.
  item('signed_in_users', 'עובדים מחוברים', 'more', 'user', TILE.indigo, {
    also: 'המסך שממנו מנהל משחרר עובד מחובר; "שחרור באישור מנהל" במסך הכניסה נשאר',
  }),
];

/** The groups of the till's menu, in order; a null title is a group without a heading. */
export const MENU_GROUPS: readonly { id: MenuGroupId; title: string | null }[] = [
  { id: 'catalog', title: null },
  { id: 'shopZ', title: null },
  { id: 'shift', title: 'משמרת' },
  { id: 'reports', title: 'דוחות' },
  { id: 'manage', title: 'ניהול' },
  { id: 'more', title: null },
  { id: 'outside', title: 'מחוץ לתפריט' },
];

export const REPORTS_FOLDER_LABEL = 'דוחות';

const ORDER = new Map(TILL_MENU_ITEMS.map((it, i) => [it.key, i]));
const BY_KEY = new Map(TILL_MENU_ITEMS.map((it) => [it.key, it]));

export function menuItem(key: string): TillMenuItem | undefined {
  return BY_KEY.get(key);
}

// ── The value ──────────────────────────────────────────────────────────────────

/** The keys as given: comma-separated text or a list; trimmed, lower-case, each once. */
function splitKeys(value: unknown): string[] {
  const parts = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const key = part.trim().toLowerCase();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The known keys of a stored value (text or list), in the menu's order — as the server stores them. */
export function parseHidden(value: unknown): string[] {
  return splitKeys(value)
    .filter((k) => ORDER.has(k))
    .sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

/** The keys of a value that are not menu keys (the server drops them). */
export function unknownKeys(value: unknown): string[] {
  return splitKeys(value).filter((k) => !ORDER.has(k));
}

/** As stored and sent to the till: "catalog_admin,till_z"; "" = everything shows. */
export function serializeHidden(keys: readonly string[]): string {
  return parseHidden([...keys]).join(',');
}

/** `keys` with `key` hidden (or shown), in the menu's order. */
export function toggleHidden(keys: readonly string[], key: string, hidden: boolean): string[] {
  const rest = keys.filter((k) => k !== key);
  return parseHidden(hidden ? [...rest, key] : rest);
}

export function sameHidden(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return serializeHidden(a) === serializeHidden(b);
}

/** "ניהול קטלוג · הפק Z", or that everything shows. */
export function hiddenSummary(keys: readonly string[]): string {
  const known = parseHidden([...keys]);
  if (known.length === 0) return 'הכל מוצג';
  return known.map((k) => BY_KEY.get(k)?.label ?? k).join(' · ');
}

export function hiddenCountText(keys: readonly string[]): string {
  const n = parseHidden([...keys]).length;
  if (n === 0) return 'הכל מוצג';
  return n === 1 ? 'פריט אחד מוסתר' : `${n} פריטים מוסתרים`;
}

// ── Warnings (§2) ──────────────────────────────────────────────────────────────

export interface MenuWarning {
  key: string;
  label: string;
  text: string;
  /** `critical`: the till loses a function (a red warning); `note`: how the till behaves (a hint). */
  tone: 'critical' | 'note';
}

export const WARNING_TEXTS: Readonly<Record<string, string>> = {
  shift_close: 'בקופה הזו לא יהיה אפשר לסגור משמרת. ודאו שהמשמרות נסגרות בקופה אחרת או בענן.',
  till_z: 'בקופה הזו לא יהיה אפשר לבצע Z. ודאו ש-Z נעשה בקופה אחרת או בענן.',
  settings: 'בקופה הזו ההגדרות יהיו נגישות רק בקוד טכנאי, דרך "אבחון" (מסך הטכנאי).',
};

/** §5א: "הזמנה מהירה" hidden with no tables to sell through (the server's `till_menu.NO_WAY_TO_SELL`). */
export const NO_WAY_TO_SELL = 'בקופה הזו לא תישאר דרך למכור';

/**
 * Whether hiding `keys` leaves no way to sell (§5א): "הזמנה מהירה" hidden while "שולחנות" is hidden too
 * or the tables are off (`tablesOff`; undefined = not known) — the till then ignores "quick_order".
 */
export function noWayToSell(keys: readonly string[], tablesOff?: boolean | null): 'tablesHidden' | 'tablesOff' | null {
  const hidden = new Set(parseHidden([...keys]));
  if (!hidden.has('quick_order')) return null;
  if (hidden.has('tables')) return 'tablesHidden';
  return tablesOff === true ? 'tablesOff' : null;
}

/**
 * What hiding `keys` means, in the menu's order: the critical items, "no way to sell" (§5א), then how
 * the till keeps its ways in. `tablesOff`: the tables mode where the list applies, when known.
 */
export function menuWarnings(keys: readonly string[], tablesOff?: boolean | null): MenuWarning[] {
  const hidden = parseHidden([...keys]);
  const out: MenuWarning[] = hidden
    .filter((k) => BY_KEY.get(k)?.critical)
    .map((k) => ({ key: k, label: BY_KEY.get(k)!.label, text: WARNING_TEXTS[k] ?? '', tone: 'critical' as const }));
  const selling = noWayToSell(hidden, tablesOff);
  if (selling) {
    const reason = selling === 'tablesHidden' ? 'גם "שולחנות" מוסתר' : 'ניהול השולחנות כבוי';
    out.push({
      key: 'quick_order',
      label: BY_KEY.get('quick_order')!.label,
      text: `${NO_WAY_TO_SELL}: ${reason}. הקופה תתעלם מהסתרת "הזמנה מהירה" ותציג את מסך המכירה, עד שיהיו בה שולחנות.`,
      tone: 'critical',
    });
  } else if (hidden.includes('quick_order')) {
    out.push({
      key: 'quick_order',
      label: BY_KEY.get('quick_order')!.label,
      text:
        tablesOff === false
          ? 'מכשיר לשולחנות בלבד: הקופה תיפתח על מסך השולחנות, ומסך המכירה רק דרך שולחן.'
          : 'מכשיר לשולחנות בלבד: הקופה תיפתח על מסך השולחנות. אם השולחנות כבויים בה, היא תתעלם מזה ותציג את מסך המכירה.',
      tone: 'note',
    });
  }
  if (hidden.includes('settings') && hidden.includes('diagnostics')) {
    out.push({
      key: 'diagnostics',
      label: BY_KEY.get('diagnostics')!.label,
      text: '"אבחון" יישאר בתפריט: כשההגדרות מוסתרות, זו הדרך אליהן בקוד טכנאי.',
      tone: 'note',
    });
  }
  const reports = TILL_MENU_ITEMS.filter((it) => it.report).map((it) => it.key);
  if (reports.every((k) => hidden.includes(k))) {
    out.push({ key: 'reports', label: REPORTS_FOLDER_LABEL, text: 'כל הדוחות מוסתרים, ולכן גם התיקייה "דוחות" לא תוצג.', tone: 'note' });
  }
  return out;
}

// ── One level ──────────────────────────────────────────────────────────────────

export type MenuLevel = 'company' | 'shop' | 'area' | 'machine';

export const LEVEL_LABELS: Readonly<Record<MenuLevel, string>> = {
  company: 'חברה',
  shop: 'סניף',
  area: 'נקודת מכירה',
  machine: 'קופה',
};

/** "החברה", "הסניף"… — the level itself, in a sentence. */
export const THE_LEVEL: Readonly<Record<MenuLevel, string>> = {
  company: 'החברה',
  shop: 'הסניף',
  area: 'נקודת המכירה',
  machine: 'הקופה',
};

/** The editor's choice "this level sets its own list". */
export const OWN_CHOICE: Readonly<Record<MenuLevel, string>> = {
  company: 'קביעה בחברה הזו',
  shop: 'קביעה בסניף הזה',
  area: 'קביעה בנקודת המכירה הזו',
  machine: 'קביעה בקופה הזו',
};

/** "מהחברה", "מהסניף"… — where an inherited list comes from. */
const FROM_LEVEL: Readonly<Record<MenuLevel, string>> = {
  company: 'מהחברה',
  shop: 'מהסניף',
  area: 'מנקודת המכירה',
  machine: 'מהקופה',
};

/** `GET /till-menu-hide` and `GET /till-design/menu-hide` (pos-server app/services/till_menu.py `level_view`). */
export interface MenuHideView {
  key: string;
  level: MenuLevel;
  id: string;
  /** The level's own list; null = it sets none (it inherits). */
  own: string[] | null;
  inherited: string[];
  /** The nearest level above that sets a list; null = the default (nothing hidden). */
  inheritedFrom: { level: MenuLevel; id: string; name: string | null } | null;
  effective: string[];
  warnings: { key: string; label: string; warning: string }[];
  /** `tablesMode` is off where the list applies ("כבוי", the default): "הזמנה מהירה" cannot be hidden there. */
  tablesOff: boolean;
  items: { key: string; label: string; also: string | null; critical: boolean; warning: string | null; report: boolean }[];
  active: boolean;
  canEdit: boolean;
  /** After a write: keys the server dropped as unknown. */
  ignored: string[];
}

/** Where the level's inherited list comes from, in words. */
export function inheritedFromText(view: Pick<MenuHideView, 'inheritedFrom'>): string {
  const from = view.inheritedFrom;
  if (!from) return 'ברירת המחדל';
  const where = FROM_LEVEL[from.level] ?? '';
  return from.name ? `${where} "${from.name}"` : where;
}

/** "עובר בירושה מהסניף "מרכז": 2 פריטים מוסתרים" — what the level gets when it sets nothing. */
export function inheritanceText(view: Pick<MenuHideView, 'inheritedFrom' | 'inherited'>): string {
  const count = hiddenCountText(view.inherited);
  return view.inheritedFrom ? `עובר בירושה ${inheritedFromText(view)}: ${count}` : `ברירת המחדל: ${count}`;
}

/**
 * The editor's draft: the level's own list, or null to inherit. What the till gets with it.
 */
export function effectiveOf(draft: readonly string[] | null, inherited: readonly string[]): string[] {
  return parseHidden([...(draft ?? inherited)]);
}

/** The body of the PUT: the own list in the menu's order, or null to inherit again. */
export function savePayload(draft: readonly string[] | null): { hidden: string[] | null } {
  return { hidden: draft === null ? null : parseHidden([...draft]) };
}

export function isDirty(draft: readonly string[] | null, own: readonly string[] | null): boolean {
  return !sameHidden(draft, own);
}

/** A toast after a save that dropped keys the server does not know. */
export function ignoredText(ignored: readonly string[]): string | null {
  return ignored.length ? `מפתחות שהמערכת לא מכירה לא נשמרו: ${ignored.join(', ')}` : null;
}

// ── The menu as the till will show it ──────────────────────────────────────────

export type PreviewRow =
  | { kind: 'item'; item: TillMenuItem; note?: string }
  | { kind: 'folder'; label: string; items: TillMenuItem[] };

export interface PreviewGroup {
  id: MenuGroupId;
  title: string | null;
  rows: PreviewRow[];
}

/**
 * The till's menu with `hidden` taken out (§5): the reports fold into their "דוחות" folder, which goes
 * when every report is hidden; "אבחון" stays while "הגדרות" is hidden (the way in by technician code);
 * "הזמנה מהירה" stays when there are no tables to sell through (§5א); an empty group goes. Every item is shown as if the till offers it — the till still shows only what
 * the user's permissions and its own setup allow.
 */
export function menuPreview(hidden: readonly string[], tablesOff?: boolean | null): PreviewGroup[] {
  const off = new Set(parseHidden([...hidden]));
  const keepDiagnostics = off.has('settings');
  // §5א: with no tables to sell through, the till ignores "quick_order".
  const keepQuickOrder = noWayToSell([...off], tablesOff) !== null;
  const shows = (it: TillMenuItem) =>
    !off.has(it.key) || (it.key === 'diagnostics' && keepDiagnostics) || (it.key === 'quick_order' && keepQuickOrder);
  const groups: PreviewGroup[] = [];
  for (const g of MENU_GROUPS) {
    const items = TILL_MENU_ITEMS.filter((it) => it.group === g.id);
    const rows: PreviewRow[] = [];
    const folder = items.filter((it) => it.report && shows(it));
    let folderPlaced = false;
    for (const it of items) {
      if (it.report) {
        if (!folderPlaced && folder.length > 0) rows.push({ kind: 'folder', label: REPORTS_FOLDER_LABEL, items: folder });
        folderPlaced = true;
        continue;
      }
      if (!shows(it)) continue;
      rows.push(
        it.key === 'diagnostics' && keepDiagnostics && off.has('diagnostics')
          ? { kind: 'item', item: it, note: 'נשאר: הדרך להגדרות בקוד טכנאי' }
          : it.key === 'quick_order' && keepQuickOrder
            ? { kind: 'item', item: it, note: 'נשאר: אין בקופה שולחנות למכור דרכם' }
            : { kind: 'item', item: it },
      );
    }
    if (rows.length > 0) groups.push({ id: g.id, title: g.title, rows });
  }
  return groups;
}
