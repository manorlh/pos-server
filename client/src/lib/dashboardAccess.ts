/**
 * "הרשאות דשבורד" — per dashboard user: which sections ("לשוניות") they may open, at view or
 * edit. The server's catalogue is pos-server app/services/dashboard_sections.py (a server test
 * keeps the ids and pages here equal to it); the server enforces every API route by it, this
 * module only decides what the menu shows and which pages say "אין לך הרשאה".
 *
 * Not "תפקידים והרשאות בקופה" (till users at the register) — a different thing.
 *
 * Kept free of React and Next so the rules can be tested on their own (dashboardAccess.test.ts).
 */

export type AccessLevel = 'view' | 'edit';

export type SectionId =
  | 'reports'
  | 'z'
  | 'products'
  | 'digital_menu'
  | 'online_ordering'
  | 'cockpit'
  | 'quick_actions'
  | 'item_blocks'
  | 'device_control'
  | 'terminals_offline'
  | 'live_event'
  | 'alerts'
  | 'stock'
  | 'vouchers'
  | 'prepaid_vouchers'
  | 'prepaid_voucher_prices'
  | 'voucher_discount_override'
  | 'prepaid_voucher_settlement'
  | 'prepaid_voucher_redeem'
  | 'prepaid_voucher_controls'
  | 'promotions'
  | 'customers'
  | 'business_cards'
  | 'notifications'
  | 'till_messages'
  | 'exception_alerts'
  | 'organization'
  | 'devices'
  | 'local_server_switch'
  | 'tables'
  | 'tables_manage'
  | 'tables_layout'
  | 'kiosks'
  | 'till_design'
  | 'kds'
  | 'printers'
  | 'till_settings'
  | 'pos_users'
  | 'user_sessions_release'
  | 'attendance'
  | 'users'
  | 'branding'
  | 'accounting'
  | 'approvals'
  | 'approval_settings';

export interface DashboardSection {
  id: SectionId;
  /** The dashboard pages this section opens (their drill-downs follow them). */
  pages: string[];
  /** Pages that only act (producing a Z): shown with edit, not with view alone. */
  editPages?: string[];
}

/** Same order and pages as the server's `SECTIONS`. Labels: messages `dashboardAccess.sections`. */
export const DASHBOARD_SECTIONS: DashboardSection[] = [
  {
    id: 'reports',
    pages: [
      '/dashboard', '/dashboard/live-items', '/dashboard/compare', '/dashboard/insights',
      '/dashboard/insights/kiosks', '/dashboard/transactions', '/dashboard/day-summary',
      '/dashboard/all-in-one', '/dashboard/reconciliation', '/dashboard/zcredit-reconciliation',
      '/dashboard/transmissions',
      '/dashboard/events', '/dashboard/offline-transactions', '/dashboard/product-sales',
      '/dashboard/cashier-sales', '/dashboard/area-sales', '/dashboard/tips',
      '/dashboard/sales-by-payment', '/dashboard/card-brands', '/dashboard/promotions-report',
      '/dashboard/menu-reports', '/dashboard/hourly-sales', '/dashboard/department-sales',
      '/dashboard/document-sequence', '/dashboard/cash-variance', '/dashboard/exceptions',
      '/dashboard/exceptions-log', '/dashboard/cash-drawer', '/dashboard/tax-reports', '/dashboard/targets',
      // "בעיות" (P:/specs/manager-problems.md §3).
      '/dashboard/problems',
    ],
  },
  { id: 'z', pages: ['/dashboard/shifts', '/dashboard/z-reports/new', '/dashboard/z-reports'], editPages: ['/dashboard/z-reports/new'] },
  {
    id: 'products',
    pages: [
      '/dashboard/products', '/dashboard/categories', '/dashboard/modifiers', '/dashboard/upsells',
      '/dashboard/menus', '/dashboard/assortment', '/dashboard/display-order',
      // "ניהול קטלוג מהקופה": filed with the catalog, still the super admin's alone (its menu gate,
      // the page's role check, and its API `/till-parameters/catalog-admin` is SUPER_ADMIN).
      '/dashboard/catalog-admin',
    ],
  },
  // "תפריט דיגיטלי" / "הזמנות אונליין" (ערוצים דיגיטליים): their profiles, each its own section.
  { id: 'digital_menu', pages: ['/dashboard/digital-menu'] },
  { id: 'online_ordering', pages: ['/dashboard/online-ordering'] },
  // The manager's own ("הניהול שלי"): they gate what the cockpit (the home page) offers.
  { id: 'cockpit', pages: [] },
  // "פעולות מהירות": no page of its own — the quick message / promotion / happy hour sheets.
  { id: 'quick_actions', pages: [] },
  // "חסימות ואזל": blocks are set from the stock, products and control-board screens.
  { id: 'item_blocks', pages: [] },
  // "שליטה מרחוק בקופות וקיוסקים": tabs of the machines and kiosks pages, the cockpit's sheet.
  { id: 'device_control', pages: [] },
  // "מסופונים — מצב לא מקוון" (P:/specs/nayax-deferred-all.md §9): the shop's card terminals to deferred and back.
  { id: 'terminals_offline', pages: ['/dashboard/deferred-terminals'] },
  // "מצב אירוע חי" and "התראות" (the phone alerts' history) — their pages are feat/event-live's.
  { id: 'live_event', pages: ['/dashboard/live-event'] },
  { id: 'alerts', pages: ['/dashboard/alerts'] },
  { id: 'stock', pages: ['/dashboard/stock'] },
  { id: 'vouchers', pages: ['/dashboard/vouchers'] },
  { id: 'prepaid_vouchers', pages: ['/dashboard/prepaid-vouchers'] },
  // No page of its own: the production price inside the prepaid vouchers pages.
  { id: 'prepaid_voucher_prices', pages: [] },
  // No page of its own: setting an override policy in the voucher type / batch forms.
  { id: 'voucher_discount_override', pages: [] },
  // No page of its own: the "התחשבנות" tab and the commercial reports inside the prepaid vouchers page.
  { id: 'prepaid_voucher_settlement', pages: [] },
  // No page of its own: "מימוש ידני מהענן" inside the prepaid vouchers page (or edit on prepaid_vouchers).
  { id: 'prepaid_voucher_redeem', pages: [] },
  // No page of its own: pauses, quotas, test batches and replacement vouchers inside the prepaid vouchers page.
  { id: 'prepaid_voucher_controls', pages: [] },
  { id: 'promotions', pages: ['/dashboard/promotions'] },
  { id: 'customers', pages: ['/dashboard/club'] },
  { id: 'business_cards', pages: ['/dashboard/business-cards'] },
  { id: 'notifications', pages: ['/dashboard/notifications'] },
  { id: 'till_messages', pages: ['/dashboard/till-messages'] },
  { id: 'exception_alerts', pages: ['/dashboard/exception-alerts'] },
  { id: 'organization', pages: ['/dashboard/companies', '/dashboard/shops'] },
  { id: 'devices', pages: ['/dashboard/machines'] },
  // "העברת שרת מקומי": no page of its own — the wizard on the shop page's main till card. Only the
  // super admin grants it, and full access does not include it (the server says `canSwitch`).
  { id: 'local_server_switch', pages: [] },
  { id: 'tables', pages: ['/dashboard/tables'] },
  // "ביטול והחלפת מלצר" in the table card (P:/specs/live-tables-cloud.md §2): besides `tables` at edit. No page of its own.
  { id: 'tables_manage', pages: [] },
  // "עריכת מפה ושולחנות": zones, tables, the sketch, table types — the tables page's editor, and the till
  // design's "שולחנות ומפה" tab (TABLES_LAYOUT_SECTION). No page of its own; viewing stays `tables`.
  { id: 'tables_layout', pages: [] },
  { id: 'kiosks', pages: ['/dashboard/kiosks', '/dashboard/kiosks/health'] },
  { id: 'till_design', pages: ['/dashboard/till-design'] },
  { id: 'kds', pages: ['/dashboard/kds', '/dashboard/workflow'] },
  { id: 'printers', pages: ['/dashboard/kitchen-printers'] },
  { id: 'till_settings', pages: ['/dashboard/payment-methods', '/dashboard/exception-settings', '/dashboard/customer-display'] },
  { id: 'pos_users', pages: ['/dashboard/pos-users', '/dashboard/till-roles'] },
  // "שחרור עובד מחובר במכשיר" (exclusive login v2 §2): "מחוברים כעת במכשירים" on the employees page and the
  // cockpit (the phone) — view sees it, edit releases. No page of its own (lib/userSessions.ts).
  { id: 'user_sessions_release', pages: [] },
  { id: 'attendance', pages: ['/dashboard/attendance'] },
  { id: 'users', pages: ['/dashboard/users'] },
  { id: 'branding', pages: ['/dashboard/branding'] },
  { id: 'accounting', pages: ['/dashboard/accounting-export', '/dashboard/accounting-settings'] },
  // "בקשות אישור" (P:\specs\manager-approval-mobile.md §4): view = sees the requests, edit = decides
  // them (the template "מאשר" is this section alone). Its settings per level are a section of their own.
  { id: 'approvals', pages: ['/dashboard/approvals'] },
  { id: 'approval_settings', pages: ['/dashboard/approval-settings'] },
];

export const SECTION_IDS: SectionId[] = DASHBOARD_SECTIONS.map((s) => s.id);

/** The floor's editing (pos-server `TABLES_LAYOUT_SECTION`): what any page that edits the map checks. */
export const TABLES_LAYOUT_SECTION: SectionId = 'tables_layout';

/** May edit the map and the tables (zones, tables, sketch, types): `tables_layout` at edit. */
export function canEditTablesLayout(access: DashboardAccess): boolean {
  return canAccess(access, TABLES_LAYOUT_SECTION, 'edit');
}

/**
 * Pages another section opens too, besides the one they sit under: "חסימה מהירה" is a stock page and
 * "חסימות ואזל"'s (P:/specs/item-block-control.md §4: "מדור המלאי או שליטה חיה"). Only `pageAccess`
 * and `navHrefAllowed` read it; `sectionForPath` stays the page's own section.
 */
export const PAGES_ALSO_OPENED_BY: Readonly<Record<string, readonly SectionId[]>> = {
  '/dashboard/stock/quick-block': ['item_blocks'],
};

function alsoOpened(access: DashboardAccess, pathname: string): boolean {
  const raw = pathname.split('?')[0];
  const path = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const level = levelForPath(path);
  return Object.entries(PAGES_ALSO_OPENED_BY).some(
    ([page, sections]) => (path === page || path.startsWith(`${page}/`)) && sections.some((s) => canAccess(access, s, level)),
  );
}

/** "מנהל סניף / אירוע" and "מנהל אזור" — they run a place from the cockpit (server `MANAGER_TEMPLATES`). */
export const MANAGER_TEMPLATES = ['branch_manager', 'area_manager'] as const;

/** "מנהל ארגון" — what a new user gets until the super admin opens more (server `ORG_MANAGER_SECTIONS`). */
export const ORG_MANAGER_SECTIONS: Partial<Record<SectionId, AccessLevel>> = {
  reports: 'view',
  products: 'edit',
  z: 'view',
};

/** `GET /users/me` → `dashboardAccess`. `restricted` false = everything the role allows. */
export interface DashboardAccess {
  restricted: boolean;
  sections: Partial<Record<SectionId, AccessLevel>>;
  orgWide?: boolean;
  companyIds?: string[];
  shopIds?: string[];
  template?: string | null;
}

/** Nothing narrowed: the super admin, a full-access user, or a server that predates profiles. */
export const UNRESTRICTED: DashboardAccess = { restricted: false, sections: {} };

/** Read the server's answer defensively: an unknown section or level is dropped. */
export function parseDashboardAccess(raw: unknown): DashboardAccess {
  if (!raw || typeof raw !== 'object') return UNRESTRICTED;
  const value = raw as Record<string, unknown>;
  if (value.restricted !== true) return UNRESTRICTED;
  const sections: Partial<Record<SectionId, AccessLevel>> = {};
  const rawSections = value.sections;
  if (rawSections && typeof rawSections === 'object') {
    for (const [key, level] of Object.entries(rawSections as Record<string, unknown>)) {
      if ((SECTION_IDS as string[]).includes(key) && (level === 'view' || level === 'edit')) {
        sections[key as SectionId] = level;
      }
    }
  }
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    restricted: true,
    sections,
    orgWide: value.orgWide === true,
    companyIds: ids(value.companyIds),
    shopIds: ids(value.shopIds),
    template: typeof value.template === 'string' ? value.template : null,
  };
}

/** Edit includes view. */
export function levelAllows(granted: AccessLevel | undefined, needed: AccessLevel): boolean {
  if (granted === 'edit') return true;
  return granted === 'view' && needed === 'view';
}

export function canAccess(access: DashboardAccess, section: SectionId, level: AccessLevel = 'view'): boolean {
  if (!access.restricted) return true;
  return levelAllows(access.sections[section], level);
}

/**
 * The section a dashboard path belongs to, or undefined (a page outside every section: the
 * profile, the super admin's pages). The longest page that is the path or a parent of it
 * wins; `/dashboard` itself only matches exactly, or it would claim every route.
 */
export function sectionForPath(pathname: string | null | undefined): SectionId | undefined {
  if (!pathname) return undefined;
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  let best: SectionId | undefined;
  let bestLength = -1;
  for (const section of DASHBOARD_SECTIONS) {
    for (const page of section.pages) {
      const hit = page === '/dashboard' ? path === page : path === page || path.startsWith(`${page}/`);
      if (hit && page.length > bestLength) {
        best = section.id;
        bestLength = page.length;
      }
    }
  }
  return best;
}

/** The level a page needs: edit for a page that only acts (`editPages`), else view. */
export function levelForPath(pathname: string | null | undefined): AccessLevel {
  if (!pathname) return 'view';
  const editPages = DASHBOARD_SECTIONS.flatMap((s) => s.editPages ?? []);
  return editPages.some((page) => pathname === page || pathname.startsWith(`${page}/`)) ? 'edit' : 'view';
}

/**
 * The home page — the control board — is everyone's: every sign-in lands on it, and a user
 * without "דוחות" sees on it what they may see (the tills' state) instead of the figures.
 */
export const HOME_PATH = '/dashboard';

export function isHomePath(pathname: string | null | undefined): boolean {
  return pathname === HOME_PATH || pathname === `${HOME_PATH}/`;
}

/**
 * Whether the board may show sales figures (the overview, the comparisons): "דוחות" — or "הניהול
 * שלי" (the cockpit), whose routes the server opens to it as well — at view.
 */
export function canSeeSales(access: DashboardAccess): boolean {
  return canAccess(access, 'reports', 'view') || canAccess(access, 'cockpit', 'view');
}

/** Whether a menu entry (by its href) is shown: its section must be granted at the page's level. */
export function navHrefAllowed(access: DashboardAccess, href: string): boolean {
  if (!access.restricted || isHomePath(href)) return true;
  const section = sectionForPath(href);
  return section === undefined || canAccess(access, section, levelForPath(href)) || alsoOpened(access, href);
}

/** The menu's groups with the entries this user may not open left out (and empty groups dropped). */
export function filterNavByAccess<S extends { items: { href: string }[] }>(sections: S[], access: DashboardAccess): S[] {
  if (!access.restricted) return sections;
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => navHrefAllowed(access, item.href)) }))
    .filter((section) => section.items.length > 0);
}

/**
 * What a page shows: the page, or "אין לך הרשאה" for a section not granted. The home page is
 * always shown — the board itself leaves out what the user may not see (`canSeeSales`).
 */
export type PageAccess = 'ok' | 'denied';

export function pageAccess(access: DashboardAccess, pathname: string | null | undefined): PageAccess {
  if (!access.restricted || isHomePath(pathname)) return 'ok';
  const section = sectionForPath(pathname);
  if (section === undefined || canAccess(access, section, levelForPath(pathname))) return 'ok';
  if (pathname && alsoOpened(access, pathname)) return 'ok';
  return 'denied';
}

/** The first page this user may open — where the summary card's links lead. */
export function grantedSections(access: DashboardAccess): SectionId[] {
  if (!access.restricted) return [...SECTION_IDS];
  return SECTION_IDS.filter((id) => canAccess(access, id, 'view'));
}

/** A section's first page that is not the home page (the summary's link target). */
export function sectionHome(section: SectionId): string {
  const pages = DASHBOARD_SECTIONS.find((s) => s.id === section)?.pages ?? [];
  return pages.find((p) => p !== '/dashboard') ?? '/dashboard';
}

/**
 * The permissions dialog's checklist: toggling view off drops edit too; toggling edit on
 * brings view with it. Returns a new map.
 */
export function toggleSection(
  sections: Partial<Record<SectionId, AccessLevel>>,
  section: SectionId,
  level: AccessLevel,
  on: boolean,
): Partial<Record<SectionId, AccessLevel>> {
  const next = { ...sections };
  if (level === 'view') {
    if (on) next[section] = next[section] ?? 'view';
    else delete next[section];
  } else if (on) {
    next[section] = 'edit';
  } else if (next[section] === 'edit') {
    next[section] = 'view';
  }
  return next;
}
