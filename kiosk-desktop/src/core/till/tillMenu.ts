/**
 * "תפריט" — the Windows till's ☰ menu, built as the Android till's drawer (pos-android ui/nav/PosNavigation.kt
 * `PosDrawerSheet`, ShiftMenu.kt, MenuHideNav.kt, DeniedMenu.kt; P:/specs/windows-till-menu-parity.md): the same groups
 * in the same order ("משמרת" — "הקופה" on a Z-only till —, "דוחות" with its folder, "ניהול", then the device's rows),
 * the same words, the same tile colours and glyphs, and the same rules for what is shown:
 *
 *  - `hiddenMenuItems` (core/till/menuHide.ts, the Android MenuHide keys): a hidden row is not there for anyone;
 *    "אבחון" stays while "הגדרות" is hidden (the way to the settings, MenuHide.diagnosticsShown); "הפק Z" in training
 *    goes with `training` too (the Windows till has no training mode: nothing to add);
 *  - "כשאין הרשאה" = "להסתיר" (the engine's `session.hidden`): "סגירת משמרת" (SHIFT_CLOSE), "הפק Z" (Z), "זיכוי"
 *    (REFUND — "סיום זיכוי" never), the report folder (VIEW_REPORTS), "דוח X סניפי" (SHOP_X_REPORT);
 *  - a closed till (no shift open): no shift rows, no drawer, no refund, no "ניהול" — the reports, "פעולות אשראי",
 *    the sync and the device's rows stay (Android "קופה סגורה");
 *  - a Z-only till ("קופה עצמאית", no shifts in the UI): "דו״ח X" and "הפק Z", the section "הקופה".
 *
 * A row is here only when this till can carry it out — never a button that does nothing. Phase 2 (P:/specs/windows-till-
 * menu-parity.md §7) added the catalog's management, the shop's Z, attendance, the ready orders, the kiosks' orders, the
 * voucher station and balance, the cloud's Zs, printers, editing the screen and alerts, each by its module's own facts;
 * tables stay out until their module exists (phase 3). Pure: the screen draws what this returns (test/tillMenu.test.ts).
 */

import type { MenuItemKey } from './menuHide';

/** iOS's system colours, as the Android menu's tiles (PosNavigation.kt `IosTile`). */
export const MENU_TILE = {
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

export type MenuTile = keyof typeof MENU_TILE;

/** The glyph in a row's tile (the Android row's icon; drawn by the screen). */
export type MenuGlyph =
  | 'calendar'
  | 'lock'
  | 'check'
  | 'money'
  | 'return'
  | 'send'
  | 'refresh'
  | 'download'
  | 'list'
  | 'chart'
  | 'clock'
  | 'receipt'
  | 'person'
  | 'printer'
  | 'gear'
  | 'build'
  | 'phone'
  | 'exit'
  | 'warning'
  | 'kiosk'
  | 'cart'
  | 'edit'
  | 'done'
  | 'bell';

/** Where a row leads: a screen of the till, or an action the screen carries out. */
export type MenuTarget =
  | 'shift'
  | 'shiftClose'
  | 'tillZ'
  | 'drawerOpen'
  | 'drawerRemote'
  | 'cashMenu'
  | 'owed'
  | 'refund'
  | 'refundEnd'
  | 'transmission'
  | 'sync'
  | 'update'
  | 'history'
  | 'recent'
  | 'shiftHistory'
  | 'tillZHistory'
  | 'productSales'
  | 'workers'
  | 'tips'
  | 'shopx'
  | 'settings'
  | 'printQueue'
  | 'diagnostics'
  | 'workMode'
  | 'blocks'
  | 'users'
  | 'kiosks'
  | 'support'
  | 'signOut'
  | 'catalogAdmin'
  | 'shopZ'
  | 'attendance'
  | 'readyOrders'
  | 'kioskOrders'
  | 'voucherStation'
  | 'voucherBalance'
  | 'cloudZ'
  | 'printers'
  | 'screenEdit'
  | 'alerts'
  | 'deviceCash';

export interface MenuRow {
  /** The Android MenuHide key (null: a row of the Windows till's own, "עודף חייב ללקוח"). */
  key: MenuItemKey | null;
  target: MenuTarget;
  label: string;
  sub?: string | null;
  /** The second line in red (a sync that failed). */
  subError?: boolean;
  tile: MenuTile;
  glyph: MenuGlyph;
  /** The screen on show now: the row is tinted. */
  selected?: boolean;
  /** Red words, no chevron ("יציאה מהמשתמש"). */
  danger?: boolean;
  /** No chevron: an action in place (the sync), not a screen. */
  inPlace?: boolean;
  /** A red count on the row ("תור הדפסה": tickets that did not print). */
  badge?: number;
  /** In progress (the sync): the tile shows it. */
  busy?: boolean;
}

export interface MenuGroup {
  id: 'top' | 'shift' | 'reports' | 'manage' | 'device';
  /** The small grey title above the card (null: none). */
  title: string | null;
  rows: MenuRow[];
  /**
   * "דוחות": the reports fold into one row that opens them (Android: folded, unless the screen on show is one of them
   * or the till is closed). Empty: no folder row.
   */
  folder?: MenuRow[];
}

/** The Android strings (res/values/strings.xml), word for word. */
export const MENU_TEXT = {
  sectionShift: 'משמרת',
  sectionTill: 'הקופה',
  sectionReports: 'דוחות',
  sectionManage: 'ניהול',
  shift: 'משמרת (דו״ח X)',
  xReport: 'דו״ח X',
  shiftClose: 'סגירת משמרת',
  tillZ: 'הפק Z',
  openDrawer: 'פתיחת מגירה',
  openRemote: (label: string) => `פתיחת מגירה ב${label}`,
  openRemoteAny: 'פתיחת מגירה בקופה אחרת',
  cashMenu: 'מזומן במגירה',
  owed: 'עודף חייב ללקוח',
  refund: 'זיכוי',
  refundEnd: 'סיום זיכוי',
  transmission: 'פעולות אשראי',
  sync: 'סנכרון מול הענן',
  syncing: 'מסנכרן…',
  syncLast: (at: string) => `סנכרון אחרון: ${at}`,
  syncFailed: (why: string) => `הסנכרון נכשל: ${why}`,
  syncWaiting: (n: number) => `${n} פעולות ממתינות לשליחה`,
  update: (version: string) => `עדכון גרסה ${version}`,
  updateDownloading: 'מוריד את העדכון…',
  updateReady: 'מוכן להתקנה — הקשה להתקנה',
  updateInstalling: 'מתקין…',
  updateFailed: (why: string) => `העדכון נכשל: ${why}`,
  history: 'היסטוריה',
  recent: '24 השעות האחרונות',
  shiftHistory: 'היסטוריית משמרות',
  zOnlyXHistory: 'היסטוריית דו״חות X',
  tillZHistory: 'דוחות Z',
  productSales: 'מכירות לפי מוצר',
  workers: 'דוח לפי עובד',
  tips: 'דוח תשר',
  shopX: 'דוח X סניפי',
  settings: 'הגדרות',
  printQueue: 'תור הדפסה',
  diagnostics: 'אבחון',
  blocks: 'חסומים כעת',
  users: 'עובדים מחוברים',
  kiosks: 'קיוסקים',
  kiosksSub: (n: number) => `${n} בשליטת הקופה`,
  support: 'תמיכה מרחוק',
  signOut: 'יציאה מהמשתמש',
  toKiosk: 'מעבר לקיוסק',
  backToKiosk: 'חזרה למצב קיוסק',
  workModeSub: 'המכשיר יחזור להזמנה עצמית ללקוחות',
  close: 'סגור תפריט',
  // Phase 2 (Android strings.xml): the rows the modules brought.
  catalogAdmin: 'ניהול קטלוג',
  shopZ: 'סגירת Z סניפי',
  attendance: 'נוכחות',
  readyOrders: 'הזמנות להכנה',
  kioskOrders: 'הזמנות קיוסק לתשלום',
  kioskOrdersSub: (n: number) => `${n} ממתינות`,
  voucherBalance: 'בירור יתרת שובר',
  cloudZ: 'דוחות Z',
  printers: 'מדפסות',
  screenEdit: 'עריכת מסך',
  alerts: 'התראות',
  deviceCash: 'מכשיר מזומן',
  deviceCashUnresolved: (n: number) => `${n} ממתינים לבירור`,
} as const;

/** What the menu is built from: the engine's state and what the host can do. */
export interface TillMenuFacts {
  /** A shift is open (or the till has no shifts: a Z-only till is never "closed"). */
  shiftOpen: boolean;
  /** "קופה עצמאית — Z בלבד": no shifts in the UI. */
  zOnly: boolean;
  /** zMode = till: this till makes its own Z. */
  tillZMode: boolean;
  /** `hiddenMenuItems` (menuHide.ts keys). */
  hidden: readonly string[];
  /** The codes "להסתיר" leaves out for this operator (`session.hidden`). */
  denied: readonly string[];
  /** A refund is under way ("סיום זיכוי"). */
  refundMode: boolean;
  /** The drawer's rows the engine offers (absent: no drawer facts — none shown). */
  drawer?: { open: boolean; remote: boolean; cashIn: boolean; cashOut: boolean; deposit: boolean; count: boolean; walletDeposit: boolean; log: boolean } | null;
  /** The other tills whose drawer may be opened from here. */
  drawerHosts?: ReadonlyArray<{ id: string; label: string }>;
  /** "עודף חייב ללקוח": debts the cloud routes to this till. */
  owedCount?: number;
  /**
   * "מכשיר מזומן" (main/till/tillDeviceCash.ts — Android's CashMag screen, `CASH_DRAWER.APPROVE_OPEN`): a cash device on this
   * till, or a payment of it waiting for "טופל". Absent: none.
   */
  deviceCash?: { name: string; unresolved: number } | null;
  /** The engine can sync on demand ("סנכרון מול הענן") and how the last went. */
  sync?: { running: boolean; lastAt: string | null; error: string | null; waiting: number } | null;
  /** A release the cloud assigned this till (null: none — no row). */
  update?: { version: string; phase: 'available' | 'downloading' | 'ready' | 'installing' | 'failed'; message: string | null } | null;
  /** "דוחות Z": the till makes its Zs or holds some (Android `tillZMode || tillZCount > 0`). */
  showTillZHistory: boolean;
  /** The engine has the local reports (24 hours, shifts, Zs, products, workers, tips). */
  localReports: boolean;
  /** "דוח X סניפי" put on this till (`shopXTills`). */
  shopX: boolean;
  /** The host opens the shell's settings ("ניהול הקיוסק"). */
  settings: boolean;
  /** "תור הדפסה": the tickets that did not print. */
  printQueueCount: number;
  /** The engine has the print queue / the blocks (a real engine; the demo has neither). */
  printQueue: boolean;
  blocks: boolean;
  /** "עובדים מחוברים" offered (the one-device rule on here). */
  signedInUsers: boolean;
  /** The work mode's row: "מעבר לקיוסק" (a till by role) / "חזרה למצב קיוסק" (a kiosk working as a till); null — none. */
  workMode?: { label: string } | null;
  /** "קיוסקים": the kiosks this till controls (0: no row — Android `rememberKioskControlEntry`). */
  kiosks?: number;
  /** "תמיכה מרחוק" (TeamViewer QuickSupport on Windows). */
  support: boolean;
  /** The screen on show now (the row is tinted; the report folder opens on it). */
  current?: MenuTarget | null;
  /* ── phase 2: what each module says of its row (absent: no row) ── */
  /** "ניהול קטלוג": `catalogAdmin.entryShown` (enabled, the shift / manager rule, CATALOG_VIEW not hidden). */
  catalogAdmin?: boolean;
  /** "סגירת Z סניפי": this till is the shop's Z master (cloud Z mode, not independent — tillShopZ.menuShown). */
  shopZ?: boolean;
  /** "נוכחות": on (`attendanceEnabled`), with its second line. */
  attendance?: { line: string | null } | null;
  /** "הזמנות להכנה": the KDS workflow offers it. */
  readyOrders?: boolean;
  /** "הזמנות קיוסק לתשלום": how many wait (0: no row). */
  kioskOrders?: number;
  /** "עמדת שובר": the row's words ("יציאה למסך רגיל" / "חזרה לעמדת שובר"); null — no row. */
  voucherStation?: { label: string } | null;
  /** "בירור יתרת שובר": `voucherBalanceCheckEnabled`. */
  voucherBalance?: boolean;
  /** "דוחות Z" from the cloud (an older cloud: none). */
  cloudZ?: boolean;
  /** "מדפסות": the engine has the screen. */
  printers?: boolean;
  /** "עריכת מסך": `screenEditEnabled`, CATALOG_WRITE not hidden. */
  screenEdit?: boolean;
  /** "התראות": the list, with its second line ("אין התראות פתוחות" / "N פתוחות"). */
  alerts?: { line: string | null } | null;
}

const has = (list: readonly string[], v: string) => list.includes(v);

/** The menu's groups, in the Android order, less what is hidden, denied, or not on this till. */
export function buildTillMenu(f: TillMenuFacts): MenuGroup[] {
  const shown = (key: MenuItemKey) => !has(f.hidden, key);
  const permitted = (code: string) => !has(f.denied, code);
  const tillClosed = !f.shiftOpen && !f.zOnly;
  const sel = (t: MenuTarget) => (f.current === t ? { selected: true } : {});
  const groups: MenuGroup[] = [];

  /* ── the top (no title): "ניהול קטלוג", "סגירת Z סניפי" — open till or closed, as their modules say ── */
  const top: MenuRow[] = [];
  if (f.catalogAdmin && shown('catalog_admin')) top.push({ key: 'catalog_admin', target: 'catalogAdmin', label: MENU_TEXT.catalogAdmin, tile: 'orange', glyph: 'edit', ...sel('catalogAdmin') });
  if (f.shopZ && shown('shop_z')) top.push({ key: 'shop_z', target: 'shopZ', label: MENU_TEXT.shopZ, tile: 'pink', glyph: 'receipt', ...sel('shopZ') });
  if (top.length > 0) groups.push({ id: 'top', title: null, rows: top });

  /* ── "משמרת" / "הקופה" ── */
  const shift: MenuRow[] = [];
  if (!tillClosed) {
    // ShiftMenu.kt shiftMenuDestinations: the X, "סגירת משמרת", "הפק Z" (till mode); a Z-only till: the X and the Z.
    if (shown('shift')) shift.push({ key: 'shift', target: 'shift', label: f.zOnly ? MENU_TEXT.xReport : MENU_TEXT.shift, tile: 'blue', glyph: 'calendar', ...sel('shift') });
    if (!f.zOnly && shown('shift_close') && permitted('SHIFT_CLOSE')) shift.push({ key: 'shift_close', target: 'shiftClose', label: MENU_TEXT.shiftClose, tile: 'graphite', glyph: 'lock', ...sel('shiftClose') });
    if ((f.zOnly || f.tillZMode) && shown('till_z') && permitted('Z')) shift.push({ key: 'till_z', target: 'tillZ', label: MENU_TEXT.tillZ, tile: 'green', glyph: 'check', ...sel('tillZ') });
    const d = f.drawer;
    if (d) {
      if (shown('open_cash_drawer') && d.open) shift.push({ key: 'open_cash_drawer', target: 'drawerOpen', label: MENU_TEXT.openDrawer, tile: 'mint', glyph: 'money' });
      // "פתיחת מגירה ב<קופה>": a device with no drawer of its own opens another till's (one: named; more: "בקופה אחרת").
      if (!d.open && d.remote && (f.drawerHosts?.length ?? 0) > 0) {
        const one = f.drawerHosts!.length === 1 ? f.drawerHosts![0] : null;
        shift.push({ key: null, target: 'drawerRemote', label: one ? MENU_TEXT.openRemote(one.label) : MENU_TEXT.openRemoteAny, tile: 'mint', glyph: 'money' });
      }
      if (shown('cash_menu') && (d.cashIn || d.cashOut || d.deposit || d.count || d.walletDeposit || d.log)) {
        shift.push({ key: 'cash_menu', target: 'cashMenu', label: MENU_TEXT.cashMenu, tile: 'teal', glyph: 'money' });
      }
    }
    // The Windows till's own: the change owed to a customer the cloud routes here (Android: its alerts list).
    if ((f.owedCount ?? 0) > 0) shift.push({ key: null, target: 'owed', label: MENU_TEXT.owed, sub: String(f.owedCount), tile: 'orange', glyph: 'money', ...sel('owed') });
    if (f.deviceCash && permitted('CASH_DRAWER.APPROVE_OPEN')) {
      const u = f.deviceCash.unresolved;
      shift.push({ key: null, target: 'deviceCash', label: MENU_TEXT.deviceCash, sub: u > 0 ? MENU_TEXT.deviceCashUnresolved(u) : f.deviceCash.name || null, ...(u > 0 ? { subError: true } : {}), tile: 'teal', glyph: 'money', ...sel('deviceCash') });
    }
    if (shown('refund') && (f.refundMode || permitted('REFUND'))) {
      shift.push({ key: 'refund', target: f.refundMode ? 'refundEnd' : 'refund', label: f.refundMode ? MENU_TEXT.refundEnd : MENU_TEXT.refund, tile: 'red', glyph: 'return', ...(f.refundMode ? { selected: true } : {}) });
    }
  }
  // Open till or closed: the batch is the terminal's, not a shift's.
  if (shown('transmission')) shift.push({ key: 'transmission', target: 'transmission', label: MENU_TEXT.transmission, tile: 'orange', glyph: 'send', ...sel('transmission') });
  // "נוכחות" (attendanceEnabled), open till or closed, with the employee's state on its second line.
  if (f.attendance && shown('attendance')) shift.push({ key: 'attendance', target: 'attendance', label: MENU_TEXT.attendance, sub: f.attendance.line, tile: 'indigo', glyph: 'person', ...sel('attendance') });
  if (f.sync && shown('sync_now')) {
    const s = f.sync;
    const sub = s.running ? null : s.error ? MENU_TEXT.syncFailed(s.error) : s.waiting > 0 ? MENU_TEXT.syncWaiting(s.waiting) : s.lastAt ? MENU_TEXT.syncLast(s.lastAt) : null;
    shift.push({ key: 'sync_now', target: 'sync', label: s.running ? MENU_TEXT.syncing : MENU_TEXT.sync, sub, ...(s.error && !s.running ? { subError: true } : {}), tile: 'cyan', glyph: 'refresh', inPlace: true, ...(s.running ? { busy: true } : {}) });
  }
  // "הזמנות להכנה", "הזמנות קיוסק לתשלום" (an open till); the voucher station and the balance check.
  if (!tillClosed && f.readyOrders && shown('ready_orders')) shift.push({ key: 'ready_orders', target: 'readyOrders', label: MENU_TEXT.readyOrders, tile: 'mint', glyph: 'done', ...sel('readyOrders') });
  if (!tillClosed && (f.kioskOrders ?? 0) > 0 && shown('kiosk_orders')) {
    shift.push({ key: 'kiosk_orders', target: 'kioskOrders', label: MENU_TEXT.kioskOrders, sub: MENU_TEXT.kioskOrdersSub(f.kioskOrders!), tile: 'orange', glyph: 'money' });
  }
  if (f.voucherStation && shown('voucher_station')) shift.push({ key: 'voucher_station', target: 'voucherStation', label: f.voucherStation.label, tile: 'graphite', glyph: 'receipt' });
  if (f.voucherBalance && shown('voucher_balance')) shift.push({ key: 'voucher_balance', target: 'voucherBalance', label: MENU_TEXT.voucherBalance, tile: 'green', glyph: 'receipt', ...sel('voucherBalance') });
  // Only while the cloud has a release for this till.
  if (!tillClosed && f.update && shown('app_update')) {
    const u = f.update;
    const sub =
      u.phase === 'installing' ? MENU_TEXT.updateInstalling : u.phase === 'downloading' ? MENU_TEXT.updateDownloading : u.phase === 'ready' ? MENU_TEXT.updateReady : u.phase === 'failed' ? MENU_TEXT.updateFailed(u.message ?? '') : null;
    shift.push({ key: 'app_update', target: 'update', label: MENU_TEXT.update(u.version), sub, tile: 'blue', glyph: 'download' });
  }
  groups.push({ id: 'shift', title: f.zOnly ? MENU_TEXT.sectionTill : MENU_TEXT.sectionShift, rows: shift });

  /* ── "דוחות": the history, then the folder (VIEW_REPORTS — hidden with it denied and hidden), then the shop X ── */
  const reports: MenuRow[] = [];
  if (shown('history')) reports.push({ key: 'history', target: 'history', label: MENU_TEXT.history, tile: 'gray', glyph: 'list', ...sel('history') });
  const folder: MenuRow[] = [];
  if (f.localReports && permitted('VIEW_REPORTS')) {
    const add = (key: MenuItemKey, target: MenuTarget, label: string, tile: MenuTile, glyph: MenuGlyph) => shown(key) && folder.push({ key, target, label, tile, glyph, ...sel(target) });
    add('recent', 'recent', MENU_TEXT.recent, 'teal', 'clock');
    add('shift_history', 'shiftHistory', f.zOnly ? MENU_TEXT.zOnlyXHistory : MENU_TEXT.shiftHistory, 'indigo', 'receipt');
    if (f.showTillZHistory) add('till_z_history', 'tillZHistory', MENU_TEXT.tillZHistory, 'green', 'receipt');
    add('product_sales', 'productSales', MENU_TEXT.productSales, 'orange', 'chart');
    add('workers', 'workers', MENU_TEXT.workers, 'blue', 'person');
    add('tips', 'tips', MENU_TEXT.tips, 'yellow', 'money');
    // "דוחות Z" from the cloud (Android reportDestinations: after the tips; tables' reports are not on Windows).
    if (f.cloudZ) add('z_reports', 'cloudZ', MENU_TEXT.cloudZ, 'gray', 'receipt');
  }
  if (f.shopX && shown('shop_x') && permitted('SHOP_X_REPORT')) folder.push({ key: 'shop_x', target: 'shopx', label: MENU_TEXT.shopX, tile: 'cyan', glyph: 'chart', ...sel('shopx') });
  groups.push({ id: 'reports', title: MENU_TEXT.sectionReports, rows: reports, folder });

  /* ── "ניהול" (an open till): the settings, the print queue, "אבחון" ── */
  if (!tillClosed) {
    const manage: MenuRow[] = [];
    if (f.settings && shown('settings')) manage.push({ key: 'settings', target: 'settings', label: MENU_TEXT.settings, tile: 'gray', glyph: 'gear' });
    if (f.printers && shown('printers')) manage.push({ key: 'printers', target: 'printers', label: MENU_TEXT.printers, tile: 'indigo', glyph: 'printer', ...sel('printers') });
    if (f.printQueue && shown('print_queue')) {
      manage.push({ key: 'print_queue', target: 'printQueue', label: MENU_TEXT.printQueue, tile: 'red', glyph: 'printer', ...(f.printQueueCount > 0 ? { badge: f.printQueueCount } : {}), ...sel('printQueue') });
    }
    if (f.screenEdit && shown('screen_edit')) manage.push({ key: 'screen_edit', target: 'screenEdit', label: MENU_TEXT.screenEdit, tile: 'teal', glyph: 'edit' });
    // MenuHide.diagnosticsShown: kept while the settings are hidden — the technician's way in.
    if (shown('diagnostics') || has(f.hidden, 'settings')) manage.push({ key: 'diagnostics', target: 'diagnostics', label: MENU_TEXT.diagnostics, tile: 'graphite', glyph: 'build', ...sel('diagnostics') });
    groups.push({ id: 'manage', title: MENU_TEXT.sectionManage, rows: manage });
  }

  /* ── the device's rows, open till or closed: the work mode, the blocks, who is signed in, support, sign out ── */
  const device: MenuRow[] = [];
  if (f.workMode && shown('kiosk_mode')) device.push({ key: 'kiosk_mode', target: 'workMode', label: f.workMode.label, sub: MENU_TEXT.workModeSub, tile: 'graphite', glyph: 'kiosk' });
  if (f.alerts && shown('alerts')) device.push({ key: 'alerts', target: 'alerts', label: MENU_TEXT.alerts, sub: f.alerts.line, tile: 'orange', glyph: 'bell', ...sel('alerts') });
  if (f.blocks && shown('blocks_now')) device.push({ key: 'blocks_now', target: 'blocks', label: MENU_TEXT.blocks, tile: 'red', glyph: 'warning', ...sel('blocks') });
  if (f.signedInUsers && shown('signed_in_users')) device.push({ key: 'signed_in_users', target: 'users', label: MENU_TEXT.users, tile: 'indigo', glyph: 'person', ...sel('users') });
  if ((f.kiosks ?? 0) > 0 && shown('managed_kiosks')) device.push({ key: 'managed_kiosks', target: 'kiosks', label: MENU_TEXT.kiosks, sub: MENU_TEXT.kiosksSub(f.kiosks!), tile: 'graphite', glyph: 'cart', ...sel('kiosks') });
  if (f.support && shown('support')) device.push({ key: 'support', target: 'support', label: MENU_TEXT.support, tile: 'green', glyph: 'phone' });
  if (shown('switch_user')) device.push({ key: 'switch_user', target: 'signOut', label: MENU_TEXT.signOut, tile: 'red', glyph: 'exit', danger: true });
  groups.push({ id: 'device', title: null, rows: device });

  return groups.filter((g) => g.rows.length > 0 || (g.folder?.length ?? 0) > 0);
}

/** The report folder opens by itself on one of its screens, and on a closed till (Android `reportsOpen`'s start). */
export function folderOpenAtStart(groups: readonly MenuGroup[], current: MenuTarget | null | undefined, shiftOpen: boolean, zOnly: boolean): boolean {
  const folder = groups.find((g) => g.id === 'reports')?.folder ?? [];
  return (!!current && folder.some((r) => r.target === current)) || (!shiftOpen && !zOnly);
}

/** Two initials for the profile card's circle (PosNavigation.kt `initialsOf`). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length >= 2) return `${[...parts[0]][0]}${[...parts[1]][0]}`.toUpperCase();
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toUpperCase();
  return '?';
}

/** "מנהל/ת חנות · סניף מרכז · קופה 3": the profile card's second line (the parts the till knows). */
export function profileLine(roleName: string | null, shopName: string | null, posNumber: string | null): string {
  return [roleName, shopName, posNumber ? `קופה ${posNumber}` : null].filter((x): x is string => !!x && x.trim().length > 0).join(' · ');
}
