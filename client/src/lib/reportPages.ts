/**
 * Every page of the dashboard, sorted into the reports — each with its "ייצוא" (designed PDF,
 * Excel, CSV; P:\specs\reports-designed-pdf.md §2, §4) — and the pages that are not reports,
 * each with the reason. `reportPages.test.ts` walks `app/dashboard/**\/page.tsx`: a new page
 * fails the test until it is listed here, and a report listed here fails it until its files
 * render an export control with a report type.
 *
 * Pure data: no React, no path aliases.
 */

export interface ReportPageEntry {
  /** The route under `/dashboard` (`''` = the home page; `[id]` as in the folder). */
  route: string;
  /** Files under `src/` that render the page's export bar(s). */
  files: string[];
  /** The `reportKey` of each export on the page (saved columns, company export defaults). */
  reportKeys: string[];
}

export interface PageExclusion {
  route: string;
  reason: string;
}

/** The reports: each has an export. */
export const REPORT_PAGES: ReportPageEntry[] = [
  // ── Sales and money ──
  { route: 'day-summary', files: ['app/dashboard/day-summary/page.tsx'], reportKeys: ['day-summary'] },
  { route: 'product-sales', files: ['app/dashboard/product-sales/page.tsx'], reportKeys: ['product-sales'] },
  { route: 'department-sales', files: ['app/dashboard/department-sales/page.tsx'], reportKeys: ['department-sales'] },
  { route: 'cashier-sales', files: ['app/dashboard/cashier-sales/page.tsx'], reportKeys: ['cashier-sales'] },
  { route: 'area-sales', files: ['app/dashboard/area-sales/page.tsx'], reportKeys: ['area-sales'] },
  { route: 'sales-by-payment', files: ['app/dashboard/sales-by-payment/page.tsx'], reportKeys: ['sales-by-payment'] },
  { route: 'card-brands', files: ['app/dashboard/card-brands/page.tsx'], reportKeys: ['card-brands'] },
  { route: 'hourly-sales', files: ['app/dashboard/hourly-sales/page.tsx'], reportKeys: ['hourly-sales'] },
  { route: 'tips', files: ['app/dashboard/tips/page.tsx'], reportKeys: ['tips'] },
  { route: 'promotions-report', files: ['app/dashboard/promotions-report/page.tsx'], reportKeys: ['promotions-report'] },
  { route: 'menu-reports', files: ['app/dashboard/menu-reports/page.tsx'], reportKeys: ['menu-reports'] },
  { route: 'all-in-one', files: ['app/dashboard/all-in-one/page.tsx'], reportKeys: ['all-in-one'] },
  { route: 'transactions', files: ['app/dashboard/transactions/page.tsx'], reportKeys: ['transactions'] },
  { route: 'offline-transactions', files: ['app/dashboard/offline-transactions/page.tsx'], reportKeys: ['offline-transactions'] },
  { route: 'document-sequence', files: ['app/dashboard/document-sequence/page.tsx'], reportKeys: ['document-sequence'] },
  // ── Shifts, Z, cash ──
  { route: 'shifts', files: ['app/dashboard/shifts/page.tsx'], reportKeys: ['shifts'] },
  { route: 'shifts/[id]', files: ['app/dashboard/shifts/[id]/page.tsx'], reportKeys: [] },
  { route: 'z-reports', files: ['app/dashboard/z-reports/page.tsx'], reportKeys: ['z-reports'] },
  { route: 'z-reports/[id]', files: ['app/dashboard/z-reports/[id]/page.tsx'], reportKeys: [] },
  { route: 'cash-variance', files: ['app/dashboard/cash-variance/page.tsx'], reportKeys: ['cash-variance'] },
  { route: 'cash-drawer', files: ['app/dashboard/cash-drawer/page.tsx'], reportKeys: ['cash-drawer'] },
  { route: 'reconciliation', files: ['app/dashboard/reconciliation/page.tsx'], reportKeys: ['reconciliation'] },
  { route: 'zcredit-reconciliation', files: ['app/dashboard/zcredit-reconciliation/page.tsx'], reportKeys: ['zcredit-reconciliation'] },
  { route: 'transmissions', files: ['app/dashboard/transmissions/page.tsx'], reportKeys: ['transmissions'] },
  // ── Exceptions and risk ──
  { route: 'exceptions', files: ['app/dashboard/exceptions/page.tsx'], reportKeys: ['exceptions'] },
  { route: 'exceptions-log', files: ['app/dashboard/exceptions-log/page.tsx'], reportKeys: ['exceptions-log'] },
  // ── Overview ──
  { route: '', files: ['app/dashboard/page.tsx'], reportKeys: [] },
  { route: 'live-items', files: ['app/dashboard/live-items/page.tsx'], reportKeys: [] },
  { route: 'insights', files: ['app/dashboard/insights/page.tsx'], reportKeys: [] },
  { route: 'insights/kiosks', files: ['app/dashboard/insights/kiosks/page.tsx'], reportKeys: [] },
  { route: 'targets', files: ['app/dashboard/targets/page.tsx'], reportKeys: [] },
  { route: 'approvals', files: ['app/dashboard/approvals/page.tsx'], reportKeys: [] },
  { route: 'problems', files: ['app/dashboard/problems/page.tsx'], reportKeys: [] },
  { route: 'alerts', files: ['app/dashboard/alerts/page.tsx'], reportKeys: [] },
  // ── Events ──
  { route: 'events', files: ['app/dashboard/events/page.tsx'], reportKeys: [] },
  { route: 'events/[id]', files: ['app/dashboard/events/[id]/page.tsx'], reportKeys: [] },
  { route: 'events/compare', files: ['app/dashboard/events/compare/page.tsx'], reportKeys: [] },
  { route: 'live-event', files: ['app/dashboard/live-event/page.tsx'], reportKeys: [] },
  { route: 'live-event/[id]', files: ['app/dashboard/live-event/[id]/page.tsx'], reportKeys: [] },
  { route: 'producer/[id]', files: ['app/dashboard/producer/[id]/page.tsx'], reportKeys: [] },
  // ── Catalog reports ──
  { route: 'vouchers', files: ['app/dashboard/vouchers/page.tsx'], reportKeys: [] },
  { route: 'upsells', files: ['app/dashboard/upsells/page.tsx'], reportKeys: [] },
  { route: 'menus', files: ['components/dashboard/catalog-menus/report-tab.tsx'], reportKeys: [] },
  { route: 'promotions', files: ['components/dashboard/discounts/oth-club-report.tsx'], reportKeys: [] },
  { route: 'stock', files: ['components/dashboard/stock/quick-stock-tab.tsx', 'components/dashboard/stock/leftover-tab.tsx'], reportKeys: [] },
  {
    route: 'prepaid-vouchers',
    files: [
      'components/dashboard/prepaid-vouchers/all-vouchers.tsx',
      'components/dashboard/prepaid-vouchers/batch-report.tsx',
      'components/dashboard/prepaid-vouchers/tills-report.tsx',
      'components/dashboard/prepaid-vouchers/extras/extra-reports.tsx',
      'components/dashboard/prepaid-vouchers/batch-groups.tsx',
      'components/dashboard/prepaid-vouchers/settlement/agreement-detail.tsx',
    ],
    reportKeys: [],
  },
  // ── Organization ──
  { route: 'tables', files: ['components/dashboard/tables/tables-report.tsx', 'components/dashboard/tables/meals-report.tsx'], reportKeys: [] },
  { route: 'machines/[id]', files: ['components/dashboard/machines/card-transmission.tsx'], reportKeys: [] },
  { route: 'kiosks', files: ['app/dashboard/kiosks/page.tsx'], reportKeys: [] },
  { route: 'kiosks/health', files: ['app/dashboard/kiosks/health/page.tsx'], reportKeys: [] },
  {
    route: 'attendance',
    files: ['components/dashboard/attendance/attendance-report.tsx', 'components/dashboard/attendance/corrections.tsx'],
    reportKeys: [],
  },
  { route: 'device-logs', files: ['app/dashboard/device-logs/page.tsx'], reportKeys: [] },
];

/** Pages that are not reports: settings, editors, flows. Each says why it has no export. */
export const NOT_REPORT_PAGES: PageExclusion[] = [
  { route: 'access-settings', reason: "settings: who may open which dashboard section" },
  { route: 'accounting-settings', reason: "settings: the accounting software's account mapping" },
  { route: 'app-updates', reason: "device management: till app releases and their assignment" },
  { route: 'approval-settings', reason: "settings: which till actions ask a manager" },
  { route: 'approvals/[id]', reason: "one approval request to answer (the list /approvals has the export)" },
  { route: 'assortment', reason: "catalog editing: which products each shop sells" },
  { route: 'branding', reason: "settings: logo and colours (the designed PDF reads them)" },
  { route: 'business-cards', reason: "digital business cards editor" },
  { route: 'business-cards/[id]', reason: "one business card editor" },
  { route: 'business-cards/enquiries', reason: "an inbox of leads from the digital cards, answered one by one, not a sales report" },
  { route: 'catalog-admin', reason: "super-admin catalog maintenance tools" },
  { route: 'categories', reason: "catalog editing: departments" },
  { route: 'club', reason: "settings: the customer club" },
  { route: 'companies', reason: "organization management: companies" },
  { route: 'companies/[id]', reason: "organization management: one company" },
  { route: 'compare', reason: "redirects to the home page's comparisons (/dashboard?view=compare), which export" },
  { route: 'customer-display', reason: "settings: the customer-facing screen" },
  { route: 'demo-company', reason: "creates a demo company" },
  { route: 'digital-menu', reason: "settings: the QR digital menu" },
  { route: 'display-order', reason: "catalog editing: display order" },
  { route: 'exception-alerts', reason: "settings: which exceptions alert whom" },
  { route: 'exception-settings', reason: "settings: exception thresholds" },
  { route: 'kds', reason: "settings: kitchen display layouts" },
  { route: 'kitchen-printers', reason: "settings: kitchen printers and routing" },
  { route: 'machines', reason: "device management: tills and kiosks (their card transmissions export on /machines/[id])" },
  { route: 'modifiers', reason: "catalog editing: modifier groups, notes and courses" },
  { route: 'notifications', reason: "SMS templates, account and send log - messaging settings, not a report" },
  { route: 'online-ordering', reason: "settings: online ordering" },
  { route: 'payment-methods', reason: "settings: payment methods" },
  { route: 'pos-users', reason: "settings: till users" },
  { route: 'producer', reason: "a producer's list of events that opens the one event (producer/[id] exports)" },
  { route: 'products', reason: "catalog editing: products" },
  { route: 'products/broadcast', reason: "sends catalog changes to the tills" },
  { route: 'products/channels', reason: "catalog editing: sales channels" },
  { route: 'products/import', reason: "imports the menu from a spreadsheet" },
  { route: 'products/wizard', reason: "the new-product wizard" },
  { route: 'profile', reason: "the signed-in user's profile" },
  { route: 'shops', reason: "organization management: shops" },
  { route: 'shops/[id]', reason: "organization management: one shop" },
  { route: 'start', reason: "the landing redirect to the user's opening page" },
  { route: 'stock/quick-block', reason: "a live control: blocks items on the tills now" },
  { route: 'till-design', reason: "settings: the till's look" },
  { route: 'till-messages', reason: "sends messages the tills must acknowledge" },
  { route: 'till-parameters', reason: "settings: till parameters" },
  { route: 'till-roles', reason: "settings: till roles and permissions" },
  { route: 'users', reason: "settings: dashboard users" },
  { route: 'workflow', reason: "settings: work mode (restaurant, counter)" },
  { route: 'z-reports/new', reason: "the flow that produces a Z, not a report (the Z itself exports on /z-reports/[id])" },
];
