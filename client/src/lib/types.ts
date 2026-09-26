/**
 * Listed most senior first, matching the server's `ROLE_LEVEL`, so a reader does
 * not have to guess where a role sits relative to its neighbours.
 *
 * `shift_supervisor` (אחמ"ש) is the odd one: it outranks a cashier only at a
 * till, where it may authorise a refund, a discount or the close of the day. It
 * administers nothing from the dashboard, which is why none of the dashboard's
 * role gates grew to include it.
 */
export type UserRole =
  | 'super_admin'
  | 'distributor'
  | 'merchant_admin'
  | 'company_manager'
  | 'shop_manager'
  | 'shift_supervisor'
  | 'cashier';

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  companyId?: string;
  shopId?: string;
  isActive: boolean;
  /**
   * Whether this person holds a till PIN — the credential that lets them authorise
   * an action at a terminal without signing into the dashboard. Never the PIN or
   * its hash, only whether one exists.
   */
  hasTillPin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the server will actually let the caller do, as reported by `GET /users/me`.
 *
 * These are not re-derived in the dashboard on purpose: the role→permission rules
 * live in the users router, and a UI that guesses them offers authority the caller
 * does not have and then blames them for the 403.
 */
export interface UserCapabilities {
  /** Exactly the roles this caller may assign, highest first. Empty = none. */
  creatableRoles: UserRole[];
  /** May read the staff list at all. False for a dashboard cashier. */
  canReadUsers: boolean;
  /** May create / edit / deactivate staff. */
  canManageUsers: boolean;
  /** May manage till operators (קופאים). */
  canManagePosUsers: boolean;
  /**
   * What this caller could authorise at a till once they set a PIN. Empty means a
   * PIN would buy them nothing, so the profile page says so instead of offering it.
   */
  tillScopes?: string[];
}

/** `GET /users/me` — the caller's own record plus its capabilities. */
export interface CurrentUser extends User, UserCapabilities {}

export interface Company {
  id: string;
  name: string;
  vatNumber?: string;
  address?: string;
  city?: string;
  /**
   * Parent company, for tenants that nest their legal entities. Nullable on the
   * wire and `undefined` on a server that predates the column, so treat both as
   * "this company is a root" — see `buildCompanyTree`, which never drops a row
   * whose parent it cannot resolve.
   */
  parentCompanyId?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Dashboard scope (organization ▸ company ▸ shop ▸ device) ───────────────────

/**
 * How deep the dashboard's shared scope currently points.
 *
 * The tenant is always in scope (it is the `X-Tenant-Id` header); the three
 * deeper levels are the shared selection every page reads instead of carrying its
 * own pickers. Ordered shallow → deep; compare with `SCOPE_LEVEL_ORDER`.
 */
export type ScopeLevel = 'tenant' | 'company' | 'shop' | 'machine';

/** The scope as it lives in the URL query and in localStorage. */
export interface ScopeSelection {
  companyId: string | null;
  shopId: string | null;
  machineId: string | null;
}

/**
 * One company plus its position in the tenant's company tree.
 *
 * `depth` is how far to indent. `parentMissing` marks a company whose
 * `parentCompanyId` points at something the caller cannot see (a parent in
 * another tenant, or one filtered out by role scoping): the row is still shown,
 * as a root, flagged — dropping it would hide a real company.
 */
export interface CompanyTreeNode {
  company: Company;
  depth: number;
  children: CompanyTreeNode[];
  parentMissing: boolean;
}

/** Flat, depth-first render list plus the lookups the UI needs. */
export interface CompanyTree {
  roots: CompanyTreeNode[];
  /** Depth-first order — render this directly for an indented list. */
  flat: CompanyTreeNode[];
  byId: Map<string, CompanyTreeNode>;
  /** False when no company has a parent — the common case; render it flat. */
  nested: boolean;
}

// ── Category ordering ─────────────────────────────────────────────────────────

/** One row of `PUT /categories/reorder`. */
export interface CategoryReorderEntry {
  id: string;
  sortOrder: number;
}

/** `PUT /categories/reorder` → how many rows the server actually moved. */
export interface CategoryReorderResponse {
  updated: number;
}

export interface PairingSessionCreateResponse {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  mobileUrl: string;
  sessionExpireHours: number;
}

export interface PairingSessionSummary {
  id: string;
  expiresAt: string;
  machinesPairedCount: number;
  createdAt: string;
}

export interface MobileContextResponse {
  sessionExpiresAt: string;
  sessionExpireHours: number;
  machinesPairedCount: number;
  defaultCompanyId?: string | null;
  defaultShopId?: string | null;
  companies: Array<{ id: string; name: string }>;
  shops: Array<{ id: string; name: string; companyId: string }>;
}

export interface MobileClaimResponse {
  ok: boolean;
  machineId: string;
  machineCode: string;
  companyName: string;
  shopName: string;
}

export interface Shop {
  id: string;
  companyId: string;
  name: string;
  branchId?: string;
  address?: string;
  city?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OutOfStockPolicy = 'block' | 'warn' | 'allow';
export type TipDistribution = 'direct' | 'equal_pool' | 'by_sales';

/** POS till settings v1 (camelCase keys match server JSONB). */
export interface PosSettingsV1 {
  globalTaxRate?: number;
  hideOutOfStockProducts?: boolean;
  language?: 'he' | 'en';
  nayaxEnabled?: boolean;
  nayaxDeviceHost?: string;
  nayaxDevicePort?: string;
  nayaxSpicyPath?: string;
  outOfStockPolicy?: OutOfStockPolicy;
  /**
   * Legacy tip switches. The server still reads them as the fallback for the
   * per-option `pay*Tips` keys below, so they stay in the type, but the
   * dashboard no longer writes them.
   */
  tipsEnabled?: boolean;
  cashTipsEnabled?: boolean;
  // Which payment buttons the till shows, and whether each asks for a tip.
  // What each option is lives in lib/paymentOptions.ts.
  payFastCashEnabled?: boolean;
  payFastCashTips?: boolean;
  payCashEnabled?: boolean;
  payCashTips?: boolean;
  payFastCardEnabled?: boolean;
  payFastCardTips?: boolean;
  payCardEnabled?: boolean;
  payCardTips?: boolean;
  payManualCardEnabled?: boolean;
  payManualCardTips?: boolean;
  tipPresets?: number[];
  tipDistribution?: TipDistribution;
  receiptPrinterName?: string;
  drawerPrinterName?: string;
  businessInfo?: Record<string, unknown>;
  /** White label: logo the till shows in its own UI. '' = deliberately no logo. */
  brandLogoUrl?: string;
  /** White label: full-screen image the till shows for ~2s while it starts up. */
  brandHeroUrl?: string;
}

export type PaymentOptionSettingKey =
  | 'payFastCashEnabled'
  | 'payFastCashTips'
  | 'payCashEnabled'
  | 'payCashTips'
  | 'payFastCardEnabled'
  | 'payFastCardTips'
  | 'payCardEnabled'
  | 'payCardTips'
  | 'payManualCardEnabled'
  | 'payManualCardTips';

/**
 * PATCH body for POS settings. Branding keys accept an explicit `null`, which
 * unsets them at that level so the level above is inherited again — distinct
 * from `''`, which is stored and means "deliberately no image here".
 *
 * The payment-option keys take `null` for the same reason: a switch has no
 * empty state, so without it a layer that once overrode a key could never go
 * back to inheriting it.
 */
export type PosSettingsPatch = Partial<
  Omit<PosSettingsV1, 'brandLogoUrl' | 'brandHeroUrl' | PaymentOptionSettingKey>
> & {
  brandLogoUrl?: string | null;
  brandHeroUrl?: string | null;
} & {
  [K in PaymentOptionSettingKey]?: boolean | null;
};

export type BrandingImageKind = 'logo' | 'hero';

export interface BrandingUploadResult {
  url: string;
  publicId: string;
  width: number;
  height: number;
  bytes: number;
}

export interface EntitySettingsResponse {
  settings: PosSettingsV1;
  settingsUpdatedAt: string;
}

export interface ShopSettingsResponse extends EntitySettingsResponse {
  effective?: PosSettingsV1;
}

/** Global product row with optional shop override (GET /shops/{id}/product-overrides). */
export interface ShopProductCatalogRow {
  globalProductId: string;
  name: string;
  sku: string;
  categoryId: string;
  globalPrice: number;
  overridePrice?: number | null;
  isListed: boolean;
  /** Per-shop: allow adding to cart on POS (default true when added to assortment). */
  isAvailable: boolean;
}

/** Global product not yet in shop assortment (GET .../product-catalog-candidates). */
export interface ShopProductCatalogCandidate {
  globalProductId: string;
  name: string;
  sku: string;
  categoryId: string;
  globalPrice: number;
}

export interface PosMachine {
  id: string;
  name: string;
  machineCode: string;
  tenantId?: string;
  shopId?: string;
  pairingStatus: 'unpaired' | 'paired' | 'assigned';
  mqttClientId?: string;
  deviceInfo?: Record<string, unknown>;
  isActive: boolean;
  lastHeartbeatAt?: string;
  mqttConnected?: boolean | null;
  lastSyncAt?: string;
  lastCatalogChangeAt?: string;
  catalogPullStale?: boolean;
  tradingDayStatus?: 'open' | 'closed' | 'none';
  tradingDayId?: string;
  dayDate?: string;
  openedAt?: string;
  openedBy?: string;
  closeDayPending?: boolean;
  /**
   * The terminal's resolved status, decided server-side.
   *
   * A single value with strict precedence, not a set of independent lights — see
   * `app/services/machine_status.py`. The dashboard renders it; it must not re-derive
   * it, because the close-day gate reads the same definition and the two drifting apart
   * is how a manager is told a till is reachable when it is not.
   */
  status?:
    | 'not_paired'
    | 'retired'
    | 'offline_with_unsynced'
    | 'day_closed'
    | 'offline'
    | 'pending_sync'
    | 'close_pending'
    | 'online';
  online?: boolean;
  /** Secondary conditions. Shown beside the status, never instead of it. */
  statusFlags?: Array<
    'day_open_past_its_date' | 'catalog_behind' | 'clock_skewed' | 'low_battery' | 'realtime_down'
  >;
  /** Undelivered sales as last reported. Null means never reported, which is not zero. */
  pendingDocuments?: number | null;
  /** When that reading was taken — the UI must say "as of", not present it as live. */
  pendingAsOf?: string | null;
  /** Hardware serial the till reports on its heartbeat (or at pairing). */
  serialNumber?: string | null;
  /**
   * 0..100, or `null` when the device could not read the battery at all.
   * `null` is NOT zero — render it as unknown, never as a flat battery.
   */
  batteryPercent?: number | null;
  batteryStatus?: 'charging' | 'discharging' | 'full' | 'not_charging' | 'unknown' | null;
  /** Signed. Negative = the device clock is BEHIND the server. Can be huge. */
  clockSkewMs?: number | null;
  /** Null on a till that has never sent a health report. */
  lastHealthReportAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CatalogLevel = 'global' | 'local';

export interface Category {
  id: string;
  companyId?: string;
  shopId?: string;
  catalogLevel: CatalogLevel;
  name: string;
  description?: string;
  color?: string;
  imageUrl?: string;
  parentId?: string;
  voucherId?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  companyId?: string;
  shopId?: string;
  categoryId: string;
  catalogLevel: CatalogLevel;
  isLocalOverride: boolean;
  name: string;
  description?: string;
  price: number;
  sku: string;
  globalSku?: string;
  skuAutoAssigned?: boolean;
  imageUrl?: string;
  inStock: boolean;
  /** Global row: informational only; shop POS uses assortment `isAvailable` on overrides. */
  isAvailable?: boolean;
  stockQuantity: number;
  barcode?: string;
  taxRate?: number;
  voucherId?: string;
  trackStock?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StockLevel {
  productId: string;
  productName?: string;
  sku?: string;
  quantity: number;
  reorderMin?: number | null;
  reorderMax?: number | null;
  reorderOpt?: number | null;
  updatedAt: string;
}

export interface TipCashierRow {
  cashierId?: string | null;
  cashierName?: string | null;
  workerNumber?: string | null;
  tipsCollected: number;
  cashTips: number;
  cardTips: number;
  salesTotal: number;
  transactionCount: number;
  amountOwed: number;
}

export interface TipsReport {
  shopId: string;
  distribution: TipDistribution;
  fromDate?: string | null;
  toDate?: string | null;
  totalTips: number;
  totalCashTips: number;
  totalCardTips: number;
  totalSales: number;
  cashiers: TipCashierRow[];
}

export interface TaxOpenFormatPreview {
  transactionCount: number;
  recordCounts: Record<string, number>;
  businessInfo: {
    vatNumber?: string;
    companyName?: string;
    companyCity?: string;
    branchId?: string;
  };
  globalTaxRate: number;
  dateRange: { year?: number; from?: string; to?: string };
}

export type ValueDisplayMode = 'product_price' | 'fixed' | 'none';

export interface Voucher {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  title?: string;
  subtitle?: string;
  bodyText?: string;
  footerText?: string;
  validityDays?: number;
  validFrom?: string;
  validUntil?: string;
  valueDisplayMode: ValueDisplayMode;
  displayValue?: number;
  printBarcode: boolean;
  printQr: boolean;
  language?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssuedVoucher {
  id: string;
  tenantId?: string;
  shopId?: string;
  machineId?: string;
  transactionId: string;
  transactionItemId?: string;
  voucherId?: string;
  productId?: string;
  productName?: string;
  quantity: number;
  unitValue?: number;
  faceValue?: number;
  issuedAt: string;
  expiresAt?: string;
  status: 'issued' | 'voided' | 'redeemed';
  reprintCount: number;
  lastPrintedAt?: string;
}

export interface PaginatedResponse<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export type ProductListResponse = PaginatedResponse<Product>;
export type ShopProductCatalogRowListResponse = PaginatedResponse<ShopProductCatalogRow>;
export type ShopProductCatalogCandidateListResponse = PaginatedResponse<ShopProductCatalogCandidate>;

export interface PairingCode {
  id: string;
  code: string;
  expiresAt: string;
  isUsed: boolean;
  usedAt?: string;
  createdAt: string;
}

export interface SyncLog {
  id: string;
  machineId: string;
  direction: 'server_to_pos' | 'pos_to_server';
  entityType: 'products' | 'categories' | 'transactions' | 'z_report';
  action: 'create' | 'update' | 'delete' | 'full_sync';
  status: 'success' | 'failed' | 'conflict_resolved';
  conflictNote?: string;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: string;
  user: User;
}

// ── Transactions / Z-reports ───────────────────────────────────────────────────

export type TransactionStatus =
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'partial_refund';

export interface TransactionItem {
  id: string;
  productId?: string;
  productName?: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discount?: number;
  discountType?: string;
  transactionType?: number;
  lineDiscount?: number;
  notes?: string;
}

export interface Transaction {
  id: string;
  machineId: string;
  shopId?: string;
  tradingDayId?: string;
  transactionNumber: string;
  status: TransactionStatus;
  documentType?: number;
  documentProductionDate?: string;
  paymentMethod?: string;
  amountTendered?: number;
  changeAmount?: number;
  totalAmount: number;
  totalDiscount?: number;
  documentDiscount?: number;
  whtDeduction?: number;
  customerId?: string;
  cashierId?: string;
  branchId?: string;
  notes?: string;
  refundOfTransactionId?: string;
  nayaxMeta?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  serverReceivedAt: string;
  items?: TransactionItem[];
}

export interface TransactionListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: Transaction[];
}

export interface TradingDay {
  id: string;
  machineId: string;
  shopId?: string;
  dayDate: string;
  openedAt: string;
  closedAt?: string;
  openingCash?: number;
  closingCash?: number;
  expectedCash?: number;
  actualCash?: number;
  discrepancy?: number;
  openedBy?: string;
  closedBy?: string;
  status: 'open' | 'closed';
}

export interface ZReport {
  id: string;
  tradingDayId: string;
  machineId: string;
  shopId?: string;
  dayDate: string;
  totalSales?: number;
  totalRefunds?: number;
  totalCashSales?: number;
  totalCardSales?: number;
  transactionsCount?: number;
  openingCash?: number;
  closingCash?: number;
  expectedCash?: number;
  actualCash?: number;
  discrepancy?: number;
  payload?: Record<string, unknown> | null;
  closedAt: string;
  createdAt: string;
  /**
   * The shop's Z number — 1, 2, 3 … across every till in the shop.
   *
   * Assigned by the server at close, so it is what a bookkeeper quotes. Null on a Z
   * from a terminal with no shop, and on closes that predate the column.
   */
  shopSequenceNumber?: number | null;
  /**
   * Built by the cloud for a day whose terminal could not close it, rather than issued
   * and printed by the terminal. Always shown: a reader must never have to guess which
   * kind of document they are looking at.
   */
  reconstructed?: boolean;
  reconstructedBy?: string | null;
  reconstructionBasis?: Record<string, unknown> | null;
  /** Filled in by GET /z-reports so the history table can name the terminal. */
  machineName?: string | null;
  /** Filled in by GET /z-reports; null on the single-report read. */
  shopName?: string | null;
}

export interface ZReportListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: ZReport[];
}

export interface CloseDayRequestItem {
  id: string;
  machineId: string;
  machineName?: string;
  tradingDayId?: string;
  zReportId?: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: string;
  receivedAt?: string;
  completedAt?: string;
  failedAt?: string;
}

export interface CloseDayRequest {
  id: string;
  requestId?: string;
  status: string;
  shopId?: string;
  createdAt?: string;
  updatedAt?: string;
  items: CloseDayRequestItem[];
}

export interface CloseDayCreateResponse {
  requestId: string;
  status: string;
  items: CloseDayRequestItem[];
}

export interface DashboardStats {
  grossRevenue: number;
  netRevenue: number;
  transactionsCount: number;
  averageBasket: number;
  itemsSold: number;
  refundsCount: number;
  refundsAmount: number;
  tipsCash: number;
  tipsCard: number;
  paymentCash: number;
  paymentCard: number;
  from: string;
  to: string;
  generatedAt: string;
}

export interface DashboardBreakdownRow {
  id: string;
  name: string;
  grossRevenue: number;
  netRevenue: number;
  transactionsCount: number;
}

export interface DashboardBreakdown {
  groupBy: 'company' | 'shop';
  rows: DashboardBreakdownRow[];
  from: string;
  to: string;
}

// ── POS users (per-shop till operators) ────────────────────────────────────────

export type PosUserRole = 'cashier' | 'shop_manager';

export interface PosUser {
  id: string;
  shopId: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  workerNumber?: string | null;
  role: PosUserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PosUserCreate {
  username: string;
  firstName?: string;
  lastName?: string;
  workerNumber?: string;
  role: PosUserRole;
  pin: string;
}

export interface PosUserUpdate {
  firstName?: string;
  lastName?: string;
  workerNumber?: string | null;
  role?: PosUserRole;
  isActive?: boolean;
  pin?: string;
}

// ── Operational reports (GET /reports/products, /reports/cashiers, /reports/tips) ──

/**
 * The window the server actually used, echoed on every report response.
 *
 * `from`/`to` are calendar days in `timezone`; `fromHour`/`toHour` (when present)
 * narrow every one of those days to the same hour band — `fromHour` inclusive,
 * `toHour` exclusive, `fromHour > toHour` wrapping past midnight. Both are null
 * when no hour filter applied. `windowStart`/`windowEnd` are the absolute UTC
 * bounds of the outer day range (end exclusive); with an hour filter the covered
 * set is a subset of that span, not the whole of it.
 *
 * The timezone is resolved server-side (tz param → tenant → Asia/Jerusalem), so
 * the UI must display it rather than assume the reader's own zone.
 */
export interface ReportWindowOut {
  from: string;
  to: string;
  fromHour?: number | null;
  toHour?: number | null;
  timezone: string;
  windowStart: string;
  windowEnd: string;
}

export interface ProductSalesRow {
  productId?: string | null;
  productName?: string | null;
  sku?: string | null;
  unitsSold: number;
  unitsRefunded: number;
  /** unitsSold - unitsRefunded. What actually left the shop. */
  unitsNet: number;
  gross: number;
  discounts: number;
  /** Always >= 0 and SUBTRACTS from net; a credit note never adds to takings. */
  refunds: number;
  /** gross - discounts - refunds */
  net: number;
  linesSold: number;
  linesRefunded: number;
}

export interface ProductSalesTotals {
  unitsSold: number;
  unitsRefunded: number;
  unitsNet: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  productCount: number;
}

export interface ProductSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  /** True when the row cap trimmed the tail. `totals` still cover every row. */
  truncated: boolean;
  rowLimit: number;
  totals: ProductSalesTotals;
  rows: ProductSalesRow[];
}

export interface CashierSalesRow {
  /** Null for documents with no cashier, or a cashier that is not a pos_user. */
  cashierId?: string | null;
  cashierName?: string | null;
  workerNumber?: string | null;
  documentCount: number;
  salesCount: number;
  refundsCount: number;
  gross: number;
  discounts: number;
  refunds: number;
  /** gross - discounts - refunds */
  net: number;
  averageBasket: number;
  /** cashNet + cardNet + otherNet === net. */
  cashNet: number;
  cardNet: number;
  otherNet: number;
  tips: number;
}

export interface CashierSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  /** Same shape as a row; the per-cashier identity fields are null on it. */
  totals: CashierSalesRow;
  rows: CashierSalesRow[];
}

export type TipMethod = 'cash' | 'card' | 'other';

export interface TipMethodRow {
  method: TipMethod;
  amount: number;
  documentCount: number;
}

export interface TipsByCashierRow {
  cashierId?: string | null;
  cashierName?: string | null;
  workerNumber?: string | null;
  tipsTotal: number;
  tipsCash: number;
  tipsCard: number;
  tipsOther: number;
  /** Documents that carried a non-zero tip. */
  tippedDocumentCount: number;
  /** Net takings by this cashier over the window, for a tips-to-sales ratio. */
  salesNet: number;
}

/**
 * GET /reports/tips — "how much tip money came in, on what tender, when".
 * Distinct from the per-shop `TipsReport`, which answers "who is owed what"
 * under the shop's tip-distribution policy.
 */
export interface TipsRangeReport {
  window: ReportWindowOut;
  generatedAt: string;
  tipsTotal: number;
  tipsCash: number;
  tipsCard: number;
  tipsOther: number;
  byMethod: TipMethodRow[];
  byCashier: TipsByCashierRow[];
}

// ── Day summary (סיכום יומי) ────────────────────────────────────────────────
//
// Several tills' Z reports rolled into one figure per trading day. Not a Z: it
// closes nothing, it is not a fiscal document, and it is deliberately not
// printable.

/**
 * One day's takings across every contributing terminal.
 *
 * `vat` and `variance` are `null` when they could not be computed for *every*
 * contributing Z — see the count beside each. The UI must render those as "not
 * available" rather than falling back to 0, because both nulls are load-bearing: a
 * day containing an unattended close has no counted cash, and showing it as balanced
 * is the exact claim the server refuses to make.
 */
export interface DaySummaryTotals {
  sales: number;
  refunds: number;
  /** `sales - refunds`, precomputed server-side so nobody subtracts differently. */
  net: number;
  cashSales: number;
  cardSales: number;
  transactionsCount: number;
  tips: number;
  cashTips: number;
  cardTips: number;
  openingCash: number;
  expectedCash: number;
  /** Null unless every contributing Z declared its VAT. */
  vat: number | null;
  vatMissingCount: number;
  /** Null unless every contributing Z was actually counted. */
  actualCash: number | null;
  variance: number | null;
  uncountedCount: number;
}

/** One Z report behind a day's figures. `zReportId` is the drill-down target. */
export interface DaySummaryContributor {
  zReportId: string;
  /** This till's day was closed from the cloud, not by the terminal. */
  reconstructed?: boolean;
  /** The shop's Z number. Null on a Z from a terminal with no shop. */
  shopSequenceNumber?: number | null;
  machineId: string;
  machineName?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  closedAt?: string | null;
  unattended: boolean;
  /** True when this Z has no counted cash, i.e. it is why `variance` is null. */
  uncounted: boolean;
  sales: number;
  refunds: number;
  net: number;
  cashSales: number;
  cardSales: number;
  tips: number;
  transactionsCount: number;
  expectedCash: number;
  actualCash: number | null;
  discrepancy: number | null;
}

export interface DaySummaryRow {
  dayDate: string;
  /** Distinct terminals, not Z reports — a till running two shifts files two. */
  machineCount: number;
  zReportCount: number;
  totals: DaySummaryTotals;
  contributors: DaySummaryContributor[];
}

export interface DaySummaryReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: DaySummaryTotals;
  /** Newest first. A day nobody closed is absent, not a zero row. */
  days: DaySummaryRow[];
}


/** One candidate parent for a company, with the reason it cannot be chosen. */
export interface ParentOption {
  id: string;
  name: string;
  /** Edges above it, so the picker can indent rather than show a flat list. */
  depth: number;
  allowed: boolean;
  /** Present only when `allowed` is false. */
  reason?: string | null;
}

export interface ParentOptions {
  options: ParentOption[];
  /** What a move would carry. All zero for a company being created. */
  movesShops: number;
  movesMachines: number;
  movesCompanies: number;
  mayDetach: boolean;
}
