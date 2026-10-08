/**
 * The dashboard's navigation map — one description of it, read by both the
 * sidebar and the breadcrumbs.
 *
 * Eighteen flat links used to sit in the sidebar in the order they were written,
 * which meant the reports were interleaved with the org tree and nothing told you
 * which of the five things you were doing. They are grouped into five sections
 * here, and because the breadcrumbs read the same table, the section name in the
 * trail can never drift from the section the link sits under.
 *
 * Role gating stays exactly where it was: an entry names a capability flag and
 * the sidebar hides it unless the flag is true. Nothing here widens access — the
 * flags are the server's own answer from `GET /users/me`, and `branding` is still
 * the super-admin / distributor / company-manager set the settings router
 * enforces.
 */
import type { ElementType } from 'react';
import {
  Activity,
  BadgePercent,
  Banknote,
  BarChart3,
  BellRing,
  BookOpenCheck,
  BookOpenText,
  Boxes,
  Calculator,
  CalendarClock,
  ChefHat,
  ClipboardList,
  Building2,
  CalendarRange,
  Clock,
  Coins,
  CreditCard,
  Download,
  FileBarChart,
  FilePlus2,
  FileText,
  GitCompareArrows,
  ListChecks,
  RadioTower,
  Grid3x3,
  IdCard,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  LayoutTemplate,
  Layers,
  Lightbulb,
  ListFilter,
  ListOrdered,
  Megaphone,
  Monitor,
  MonitorSmartphone,
  Package,
  Package2,
  Palette,
  PartyPopper,
  Percent,
  Printer,
  QrCode,
  Receipt,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  SlidersVertical,
  Sparkles,
  Store,
  Tag,
  Ticket,
  User,
  UserRoundCheck,
  Users,
  UtensilsCrossed,
  Wallet,
  WifiOff,
  Workflow,
  MonitorPlay,
  MessageSquareText,
  HeartHandshake,
  HeartPulse,
  TabletSmartphone,
} from 'lucide-react';

/** Which gate an entry hangs on. `undefined` = visible to anyone signed in. */
export type NavGate =
  | 'canReadUsers'
  | 'canManagePosUsers'
  | 'branding'
  | 'produceZ'
  | 'superAdmin'
  | 'settingsWrite';

export interface NavItem {
  href: string;
  /** Key under the `nav` message namespace. */
  labelKey: string;
  icon: ElementType;
  gate?: NavGate;
  /**
   * Extra path prefixes that should light this entry up — the drill-down routes,
   * so `/dashboard/shops/<id>` still shows "Shops" as the active section.
   */
  matchPrefixes?: string[];
}

export interface NavSection {
  id: string;
  labelKey: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'overview',
    labelKey: 'sections.overview',
    items: [
      { href: '/dashboard', labelKey: 'overview', icon: LayoutDashboard },
      // Per product, what the scope has sold so far, refreshed as it sells.
      { href: '/dashboard/live-items', labelKey: 'liveItems', icon: Activity },
      // Day against day — today vs yesterday, Saturday vs Saturday, any two days.
      { href: '/dashboard/compare', labelKey: 'compareBoard', icon: BarChart3 },
      // What to look at and do: dead items, weak hours, the menu matrix, forecast, outliers.
      { href: '/dashboard/insights', labelKey: 'insights', icon: Lightbulb },
      // "ביצועי קיוסקים": the kiosks' funnel, where customers leave, time to order, upsell
      // and payments. Its own exact href, so it — not "insights" — lights up on its route.
      { href: '/dashboard/insights/kiosks', labelKey: 'kioskInsights', icon: TabletSmartphone },
      // A message every targeted till must acknowledge; the machine-admin roles, which
      // are exactly the settings-write set.
      { href: '/dashboard/till-messages', labelKey: 'tillMessages', icon: Megaphone, gate: 'settingsWrite' },
      // "הודעות": the SMS log (a shop manager reads their shop's), templates and the 019
      // account (company managers and up — the page hides what the role cannot use).
      { href: '/dashboard/notifications', labelKey: 'notifications', icon: MessageSquareText, gate: 'settingsWrite' },
    ],
  },
  {
    id: 'catalog',
    labelKey: 'sections.catalog',
    items: [
      // `/dashboard/products/import` (the menu as a spreadsheet) lights "Products" up too.
      { href: '/dashboard/products', labelKey: 'products', icon: Package, matchPrefixes: ['/dashboard/products/'] },
      { href: '/dashboard/categories', labelKey: 'categories', icon: Tag },
      { href: '/dashboard/vouchers', labelKey: 'vouchers', icon: Ticket },
      // Vouchers worth goods for an event's production team, redeemed at the tills by QR.
      { href: '/dashboard/prepaid-vouchers', labelKey: 'prepaidVouchers', icon: QrCode },
      // Promotions ("מבצעים"): defined here, computed by the tills offline.
      { href: '/dashboard/promotions', labelKey: 'promotions', icon: BadgePercent },
      // The menu layer: modifier groups, note chips and courses; and the till's upsells.
      { href: '/dashboard/modifiers', labelKey: 'modifiers', icon: ChefHat },
      { href: '/dashboard/upsells', labelKey: 'upsells', icon: Sparkles },
      // "תפריטים": sales menus by schedule (בוקר, צהריים, הפי האוור…) and where they apply.
      { href: '/dashboard/menus', labelKey: 'catalogMenus', icon: BookOpenText },
      // Both of these used to live at /dashboard/shops/… while being shown as
      // top-level items, and would now collide with the /dashboard/shops/[id]
      // drill-down. They are top-level routes to match where they appear.
      { href: '/dashboard/assortment', labelKey: 'assortment', icon: ListFilter },
      { href: '/dashboard/stock', labelKey: 'stock', icon: Boxes },
    ],
  },
  {
    id: 'reports',
    labelKey: 'sections.reports',
    items: [
      { href: '/dashboard/transactions', labelKey: 'transactions', icon: Receipt },
      // A shift's X is what a Z is made of, so the three sit together: the shifts,
      // producing a Z from them, and the Zs themselves.
      {
        href: '/dashboard/shifts',
        labelKey: 'shifts',
        icon: Clock,
        matchPrefixes: ['/dashboard/shifts/'],
      },
      {
        href: '/dashboard/z-reports/new',
        labelKey: 'produceZ',
        icon: FilePlus2,
        gate: 'produceZ',
      },
      {
        href: '/dashboard/z-reports',
        labelKey: 'zReports',
        icon: FileBarChart,
        matchPrefixes: ['/dashboard/z-reports/'],
      },
      // Sits next to the closing reports it is made of, so the relationship is
      // obvious: this is a roll-up of those, not a separate kind of document.
      { href: '/dashboard/day-summary', labelKey: 'daySummary', icon: CalendarRange },
      // The report center (docs/SPEC_REPORTS.md): "דוח שמכיל הכל", the reconciliation of
      // documents ↔ Zs ↔ card transmissions, and the transmissions across tills.
      { href: '/dashboard/all-in-one', labelKey: 'allInOne', icon: ListChecks },
      { href: '/dashboard/reconciliation', labelKey: 'reconciliation', icon: GitCompareArrows },
      { href: '/dashboard/transmissions', labelKey: 'transmissions', icon: RadioTower },
      // Temporary events: a shop's tills grouped for a report only, with the producer's
      // report, reconciliations and the confirmation that freezes it (docs/SPEC_EVENTS.md).
      {
        href: '/dashboard/events',
        labelKey: 'events',
        icon: PartyPopper,
        matchPrefixes: ['/dashboard/events/'],
      },
      // Card sales the terminal approved offline, and the ones the acquirer declined after.
      { href: '/dashboard/offline-transactions', labelKey: 'offlineTransactions', icon: WifiOff },
      { href: '/dashboard/product-sales', labelKey: 'productSales', icon: Package2 },
      { href: '/dashboard/cashier-sales', labelKey: 'cashierSales', icon: UserRoundCheck },
      { href: '/dashboard/area-sales', labelKey: 'areaSales', icon: LayoutGrid },
      { href: '/dashboard/tips', labelKey: 'tips', icon: Coins },
      // The reports of docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.3.
      { href: '/dashboard/sales-by-payment', labelKey: 'salesByPayment', icon: Wallet },
      // Card takings per brand (מותג) and acquirer (חברת סליקה): the clearing report.
      { href: '/dashboard/card-brands', labelKey: 'cardBrands', icon: CreditCard },
      // How often each promotion applied and what it took off, by shop, till and day.
      { href: '/dashboard/promotions-report', labelKey: 'promotionsReport', icon: Percent },
      // Modifiers chosen, meals and their components, upsells taken.
      { href: '/dashboard/menu-reports', labelKey: 'menuReports', icon: ClipboardList },
      { href: '/dashboard/hourly-sales', labelKey: 'hourlySales', icon: Grid3x3 },
      { href: '/dashboard/department-sales', labelKey: 'departmentSales', icon: Layers },
      { href: '/dashboard/document-sequence', labelKey: 'documentSequence', icon: ListOrdered },
      { href: '/dashboard/cash-variance', labelKey: 'cashVariance', icon: Scale },
      // Discounts, refunds, cancelled baskets, long orders, high tips… for review.
      { href: '/dashboard/exceptions', labelKey: 'exceptions', icon: ShieldAlert },
      // "יומן חריגות": every detected exception from every source, handled with a note, with its SMS.
      { href: '/dashboard/exceptions-log', labelKey: 'exceptionsLog', icon: ScrollText },
      // "מגירת מזומן": every drawer opening and cash movement, KPIs and a shift's timeline.
      { href: '/dashboard/cash-drawer', labelKey: 'cashDrawer', icon: Banknote },
      { href: '/dashboard/tax-reports', labelKey: 'taxReports', icon: FileText },
      // The books: the same super-admin / distributor / company-manager set the
      // accounting router enforces, which is exactly the `branding` gate's.
      {
        href: '/dashboard/accounting-export',
        labelKey: 'accountingExport',
        icon: BookOpenCheck,
        gate: 'branding',
      },
    ],
  },
  {
    id: 'organization',
    labelKey: 'sections.organization',
    items: [
      {
        href: '/dashboard/companies',
        labelKey: 'companies',
        icon: Building2,
        matchPrefixes: ['/dashboard/companies/'],
      },
      {
        href: '/dashboard/shops',
        labelKey: 'shops',
        icon: Store,
        matchPrefixes: ['/dashboard/shops/'],
      },
      {
        href: '/dashboard/machines',
        labelKey: 'machines',
        icon: Monitor,
        matchPrefixes: ['/dashboard/machines/'],
      },
      // The floor: zones and tables (map or grid), open tables now, the tables report and
      // cancellation reasons — the shop's managers.
      { href: '/dashboard/tables', labelKey: 'tables', icon: UtensilsCrossed, gate: 'settingsWrite' },
      // Customer self-order kiosks: tills turned into kiosks, their status, remote control,
      // and their look and behaviour per company / shop / kiosk — the machine-admin roles.
      { href: '/dashboard/kiosks', labelKey: 'kiosks', icon: MonitorSmartphone, gate: 'settingsWrite' },
      // "עיצוב קופה": the tills' order screens — template per device, layout, menu order,
      // action bar, colours, texts, fields — per company / shop / point of sale / till, with a
      // live preview; the same roles as the kiosks page.
      { href: '/dashboard/till-design', labelKey: 'tillDesign', icon: LayoutTemplate, gate: 'settingsWrite' },
      // "תקינות מכשירים": each kiosk's parts (app, terminal, printer, till link, KDS, media,
      // uploads) live, and its open alerts — the same roles as the kiosks page.
      { href: '/dashboard/kiosks/health', labelKey: 'deviceHealth', icon: HeartPulse, gate: 'settingsWrite' },
      // "נוכחות עובדים": who is on shift, the attendance report, corrections and job titles.
      // Every role but the cashier reads (the server scopes it); managers correct.
      { href: '/dashboard/attendance', labelKey: 'attendance', icon: CalendarClock },
    ],
  },
  {
    id: 'settings',
    labelKey: 'sections.settings',
    items: [
      { href: '/dashboard/users', labelKey: 'users', icon: Users, gate: 'canReadUsers' },
      {
        href: '/dashboard/pos-users',
        labelKey: 'posUsers',
        icon: IdCard,
        gate: 'canManagePosUsers',
      },
      // "תפקידים והרשאות": what each till user may do — roles × permissions (tri-state), the
      // users' roles, the cash drawer's parameters and the audit (docs/SPEC_ROLES_PERMISSIONS.md).
      { href: '/dashboard/till-roles', labelKey: 'tillRoles', icon: KeyRound, gate: 'canManagePosUsers' },
      { href: '/dashboard/branding', labelKey: 'branding', icon: Palette, gate: 'branding' },
      // "מועדון לקוחות": one club per company — the server's CLUB_ADMIN_ROLES, which are
      // exactly the `branding` gate's super-admin / distributor / company-manager set.
      { href: '/dashboard/club', labelKey: 'club', icon: HeartHandshake, gate: 'branding' },
      // Account mapping for the accounting export; same roles as the export itself.
      {
        href: '/dashboard/accounting-settings',
        labelKey: 'accountingSettings',
        icon: Calculator,
        gate: 'branding',
      },
      // Which payment buttons the tills show, per company, shop, point of sale or till.
      // Which exceptions are detected and their thresholds, per level.
      {
        href: '/dashboard/exception-settings',
        labelKey: 'exceptionSettings',
        icon: SlidersVertical,
        gate: 'settingsWrite',
      },
      // "התראות SMS על חריגות": the alert rules per company / shop (dry run unless configured).
      {
        href: '/dashboard/exception-alerts',
        labelKey: 'exceptionAlerts',
        icon: BellRing,
        gate: 'settingsWrite',
      },
      {
        href: '/dashboard/payment-methods',
        labelKey: 'paymentMethods',
        icon: CreditCard,
        gate: 'settingsWrite',
      },
      // Kitchen / bar ticket printers and what prints where — a shop's managers.
      {
        href: '/dashboard/kitchen-printers',
        labelKey: 'kitchenPrinters',
        icon: Printer,
        gate: 'settingsWrite',
      },
      // "תצורת עבודה" (direct sale / order process, targets) per level, and the KDS screens.
      { href: '/dashboard/workflow', labelKey: 'workflowMode', icon: Workflow, gate: 'settingsWrite' },
      { href: '/dashboard/kds', labelKey: 'kds', icon: MonitorPlay, gate: 'settingsWrite' },
      // Global definitions every tenant's tills read; only a super admin sets them.
      {
        href: '/dashboard/till-parameters',
        labelKey: 'tillParameters',
        icon: SlidersHorizontal,
        gate: 'superAdmin',
      },
      // "הרשאות": which entries and device actions each role is denied — the super admin's.
      {
        href: '/dashboard/access-settings',
        labelKey: 'accessSettings',
        icon: ShieldCheck,
        gate: 'superAdmin',
      },
      // Uploading the till app and sending it out is the super admin's alone.
      {
        href: '/dashboard/app-updates',
        labelKey: 'appUpdates',
        icon: Download,
        gate: 'superAdmin',
      },
      { href: '/dashboard/profile', labelKey: 'profile', icon: User },
    ],
  },
];

/**
 * The entry a path belongs to. Exact match wins; otherwise the longest declared
 * prefix. `/dashboard` never prefix-matches, or it would claim every route.
 */
/**
 * "תצוגת מנהל פשוטה": the menu of a manager who runs one place (a shop, an area, an event) —
 * the owner: "לתת יוזר למנהל, בלי מיליון לשוניות". Three groups: הניהול שלי (the cockpit, the
 * home page), a short list of reports, and the settings they may change. Every entry still
 * passes the same gates as the full menu (roles, "הרשאות", "הרשאות דשבורד"); the full menu
 * stays for owners and admins, and behind the profile's switch.
 */
export const SIMPLE_NAV_SECTIONS: NavSection[] = [
  {
    id: 'mine',
    labelKey: 'sections.mine',
    items: [{ href: '/dashboard', labelKey: 'cockpit', icon: LayoutDashboard }],
  },
  {
    id: 'simpleReports',
    labelKey: 'sections.reports',
    items: [
      { href: '/dashboard/transactions', labelKey: 'transactions', icon: Receipt },
      { href: '/dashboard/z-reports', labelKey: 'zReports', icon: FileText },
      { href: '/dashboard/live-items', labelKey: 'liveItems', icon: Activity },
    ],
  },
  {
    id: 'simpleSettings',
    labelKey: 'sections.settings',
    items: [
      { href: '/dashboard/till-messages', labelKey: 'tillMessages', icon: Megaphone, gate: 'settingsWrite' },
      { href: '/dashboard/stock', labelKey: 'stock', icon: Boxes },
      { href: '/dashboard/kiosks', labelKey: 'kiosks', icon: MonitorSmartphone, gate: 'settingsWrite' },
      { href: '/dashboard/profile', labelKey: 'profile', icon: User },
    ],
  },
];

export function findNavEntry(pathname: string | null | undefined): NavItem | undefined {
  if (!pathname) return undefined;
  const all = NAV_SECTIONS.flatMap((section) => section.items);

  const exact = all.find((item) => item.href === pathname);
  if (exact) return exact;

  let best: NavItem | undefined;
  let bestLength = -1;
  for (const item of all) {
    for (const prefix of item.matchPrefixes ?? []) {
      if (pathname.startsWith(prefix) && prefix.length > bestLength) {
        best = item;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * A label folded for the sidebar search: case, niqqud and cantillation marks dropped,
 * and geresh/gershayim (and the ASCII quotes typed in their place) removed, so "דוח"
 * finds "דו״ח" and "z" finds "Z".
 */
export function normalizeNavText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '')
    .replace(/["'`׳״‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The sections a sidebar search shows: an entry whose label contains the query, or
 * every entry of a section whose title does. Sections left empty are dropped. An
 * empty query returns the sections as they are.
 */
export function filterNavSections(
  sections: NavSection[],
  query: string,
  label: (key: string) => string,
): NavSection[] {
  const q = normalizeNavText(query);
  if (!q) return sections;
  return sections
    .map((section) =>
      normalizeNavText(label(section.labelKey)).includes(q)
        ? section
        : { ...section, items: section.items.filter((item) => normalizeNavText(label(item.labelKey)).includes(q)) },
    )
    .filter((section) => section.items.length > 0);
}

/** The section id a path sits in, for keeping that sidebar group open. */
export function findNavSectionId(pathname: string | null | undefined): string | undefined {
  const entry = findNavEntry(pathname);
  if (!entry) return undefined;
  return NAV_SECTIONS.find((section) => section.items.some((item) => item.href === entry.href))?.id;
}
