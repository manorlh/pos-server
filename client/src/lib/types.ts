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
  /** The register number the claimed till was given in that shop. */
  posNumber?: string | null;
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
  // Optional tools on the till's sell screen. Unset = shown; see lib/sellScreen.ts.
  sellSearchEnabled?: boolean;
  sellScanEnabled?: boolean;
  sellCalculatorEnabled?: boolean;
  tipPresets?: number[];
  tipDistribution?: TipDistribution;
  receiptPrinterName?: string;
  drawerPrinterName?: string;
  businessInfo?: Record<string, unknown>;
  /** White label: logo the till shows in its own UI. '' = deliberately no logo. */
  brandLogoUrl?: string;
  /** White label: full-screen image the till shows for ~2s while it starts up. */
  brandHeroUrl?: string;
  /**
   * Tenant level only: how Z reports are produced. `shop` (default) = one Z per shop
   * over all its tills; `machine` = one till per Z. Not sent to tills.
   */
  zScope?: 'shop' | 'machine';
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

export type SellScreenSettingKey =
  | 'sellSearchEnabled'
  | 'sellScanEnabled'
  | 'sellCalculatorEnabled';

/** Switch keys whose PATCH accepts `null` (= unset this layer, inherit again). */
export type ResettableSwitchKey = PaymentOptionSettingKey | SellScreenSettingKey;

/**
 * PATCH body for POS settings. Branding keys accept an explicit `null`, which
 * unsets them at that level so the level above is inherited again — distinct
 * from `''`, which is stored and means "deliberately no image here".
 *
 * The payment-option and sell-screen keys take `null` for the same reason: a
 * switch has no empty state, so without it a layer that once overrode a key could
 * never go back to inheriting it.
 */
export type PosSettingsPatch = Partial<
  Omit<PosSettingsV1, 'brandLogoUrl' | 'brandHeroUrl' | ResettableSwitchKey>
> & {
  brandLogoUrl?: string | null;
  brandHeroUrl?: string | null;
} & {
  [K in ResettableSwitchKey]?: boolean | null;
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
  /** This shop's own availability level: null = not set (inherits the company, then the product). */
  isAvailable: boolean | null;
  /** What the shop would get if it set nothing — resolved on the server. */
  inheritedAvailable: boolean;
  /** What this shop's tills get when the till itself sets nothing — resolved on the server. */
  effectiveAvailable: boolean;
  /** The company's built-in general item: it cannot be hidden in or removed from a shop. */
  isGeneral?: boolean;
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
  /**
   * Register number in its shop ("קופה 2"), allocated by the server from the shop's own
   * run and never reused. Text on the wire because documents copy it verbatim; always a
   * plain integer when set. Null when the machine has no shop. Read it through
   * `registerNumberOf`, which never yields 0.
   */
  posNumber?: string | null;
  /**
   * The area of its shop the till is in now (bar, terrace …), or null when unassigned.
   * Current membership only — history (shifts, Zs, reports) carries its own stamp.
   */
  areaId?: string | null;
  areaName?: string | null;
  pairingStatus: 'unpaired' | 'paired' | 'assigned';
  mqttClientId?: string;
  deviceInfo?: Record<string, unknown>;
  isActive: boolean;
  lastHeartbeatAt?: string;
  mqttConnected?: boolean | null;
  lastSyncAt?: string;
  lastCatalogChangeAt?: string;
  catalogPullStale?: boolean;
  /** `open` when the cloud holds an open shift for this till, else `none`. */
  shiftStatus?: 'open' | 'none';
  openShiftId?: string;
  /** The open shift's per-till number ("משמרת #N"); null if none open or unnumbered. */
  openShiftSequence?: number | null;
  /** The open shift's business date (the till's local date it opened). */
  businessDate?: string;
  openedAt?: string;
  /** Display name of whoever opened the shift. */
  openedBy?: string;
  /** A Z run or a remote close has asked this till to close its shift and waits for it. */
  closeShiftPending?: boolean;
  /**
   * Which of the two is waiting: `z_run` (close it through that run, not a second
   * request) or `request` (a standalone remote close). Null when none is, or from a
   * server that does not say.
   */
  pendingCloseSource?: 'z_run' | 'request' | null;
  /** The Z run waiting for this till's close, when `pendingCloseSource` is `z_run`. */
  pendingZRunId?: string | null;
  /** Closed shifts of this till that no Z has taken yet. */
  closedShiftsAwaitingZ?: number | null;
  /** Documents of this till that named no shift. No Z takes them. */
  orphanDocuments?: number | null;
  /** The shift the till says it has open (heartbeat); the cloud may not have seen it yet. */
  reportedOpenShiftId?: string | null;
  /**
   * The terminal's resolved status, decided server-side.
   *
   * A single value with strict precedence, not a set of independent lights — see
   * `app/services/machine_status.py`. The dashboard renders it; it must not re-derive
   * it, because the Z wizard reads the same definition and the two drifting apart is
   * how a manager is told a till is reachable when it is not.
   */
  status?:
    | 'not_paired'
    | 'retired'
    | 'offline_with_unsynced'
    | 'no_open_shift'
    | 'offline'
    | 'pending_sync'
    | 'shift_close_pending'
    | 'online';
  online?: boolean;
  /** Secondary conditions. Shown beside the status, never instead of it. */
  statusFlags?: Array<
    | 'shift_open_past_its_date'
    | 'closed_shifts_awaiting_z'
    | 'catalog_behind'
    | 'clock_skewed'
    | 'low_battery'
    | 'realtime_down'
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
  /**
   * The company's built-in general item ("פריט כללי"), which the till's calculator
   * sells through. Every company has exactly one; it cannot be deleted, and whether it
   * is open price, its VAT and where it is sold are fixed by the server.
   */
  isGeneral?: boolean;
  /**
   * Where a global product is sold. `null` for a product managed by hand from the
   * assortment page (every product created before this existed). For `shops` mode the
   * list itself comes from `GET /products/{id}/shops`.
   */
  shopScope?: ShopScope | null;
  createdAt: string;
  updatedAt: string;
}

export type ShopScopeMode = 'company' | 'shops';

export interface ShopScope {
  mode: ShopScopeMode;
  companyId?: string | null;
  includeSubcompanies?: boolean;
}

/** Body of `shopScope` on product create/update. */
export type ShopScopeInput =
  | { mode: 'company'; companyId: string; includeSubcompanies: boolean }
  | { mode: 'shops'; shopIds: string[] };

/** Body of `shopPrices` on product create/update. `price: null` = the base price. */
export interface ShopPriceInput {
  shopId: string;
  price: number | null;
}

/** One row of `GET /products/{id}/shops`. */
export interface ProductShopRow {
  shopId: string;
  shopName: string;
  companyId: string;
  companyName?: string | null;
  /** The shop's own price, or null when it sells at the base price. */
  price: number | null;
  effectivePrice: number;
  isListed: boolean;
  assignedByRule: boolean;
}

/**
 * Where a product may be sold — `GET /products/{id}/availability`.
 *
 * Every value here is resolved on the server (app/services/product_availability.py):
 * `value` is the level's own setting (null = not set), `inherited` what it would get
 * without one, `effective` what it gets, and `source` the level that decided it.
 */
export type AvailabilityLevel = 'product' | 'company' | 'shop' | 'machine';

export interface AvailabilityNode {
  value: boolean | null;
  inherited: boolean;
  effective: boolean;
  source: AvailabilityLevel;
  canEdit: boolean;
}

export interface MachineAvailability extends AvailabilityNode {
  machineId: string;
  name: string;
  posNumber?: string | null;
  /** The till's own catalog: its whole shop's, or a whitelist. */
  catalogMode?: MachineCatalogMode;
  /** False when the till's own list leaves this product out: not shown there at all. */
  inCatalog?: boolean;
}

// ── A till's own catalog (server: app/services/machine_catalog.py) ─────────────

export type MachineCatalogMode = 'all' | 'selected';

export interface MachineCatalogProduct {
  productId: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  price: number;
  categoryId?: string | null;
  categoryName?: string | null;
  imageUrl?: string | null;
  /** On this till's list. Kept in "all" mode too, so switching back restores it. */
  included: boolean;
  /** Delisted from the shop: on none of its tills, whatever the list says. */
  shopListed: boolean;
  /** Availability at this till; false shows locked. */
  available: boolean;
  /** Shown on the till right now, with the mode and the listing applied. */
  onTill: boolean;
}

export interface MachineCatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MachineCatalog {
  machineId: string;
  machineName: string;
  posNumber?: string | null;
  shopId: string;
  shopName: string;
  mode: MachineCatalogMode;
  modeUpdatedAt?: string | null;
  canEdit: boolean;
  selectedCount: number;
  totalCount: number;
  products: MachineCatalogProduct[];
  categories: MachineCatalogCategory[];
}

export interface ShopAvailability extends AvailabilityNode {
  shopId: string;
  shopName: string;
  isListed: boolean;
  machines: MachineAvailability[];
}

export interface CompanyAvailability extends AvailabilityNode {
  companyId: string;
  companyName?: string | null;
  shops: ShopAvailability[];
}

export interface ProductAvailability {
  productId: string;
  productAvailable: boolean;
  companies: CompanyAvailability[];
}

/** `POST /products/shop-scope/preview`. */
export interface ShopScopePreview {
  shopCount: number;
  machineCount: number;
  shops: { id: string; name: string; companyId: string }[];
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
  shiftId?: string;
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

// ── Shifts (משמרות), X and Z ─────────────────────────────────────────────────
//
// The wire contract is pos-server `docs/SHIFTS_API.md`. Two rules run through
// every type below:
//
// * **Money arrives as a decimal string** ("123.40") — that is how the server's
//   Decimal serialises. It is displayed, never added up in the browser.
// * **`null` means unknown / not counted / not applicable, never zero.** An
//   uncounted drawer has `countedCash: null`, and must read "לא נספר", not ₪0.

/** A money amount as the shift and Z endpoints send it. */
export type Money = string | number;

/** The X figures of a shift, recomputed by the server from its documents (§3.2). */
export interface ShiftTotals {
  /** Net of document discounts — the money collected. Tips excluded. */
  totalSales?: Money | null;
  /** Σ totalAmount of the sales, before document discounts (the till's `totalSales`). */
  grossSales?: Money | null;
  /** Σ documentDiscount of the sales (the till's `totalDiscounts`). */
  discountsTotal?: Money | null;
  totalRefunds?: Money | null;
  totalCash?: Money | null;
  totalCard?: Money | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  /** Null when any document of the shift carries no VAT figure. */
  vatTotal?: Money | null;
  transactionsCount?: number | null;
  firstTransactionNumber?: string | null;
  lastTransactionNumber?: string | null;
}

export type ShiftStatus = 'open' | 'closed';

export interface Shift {
  id: string;
  tenantId?: string | null;
  machineId: string;
  shopId?: string | null;
  businessDate: string;
  /** Per-till counter. Null only on shifts from tills that predate it. */
  sequenceNumber?: number | null;
  status: ShiftStatus;
  openedAt: string;
  openingCash?: Money | null;
  openedByUserId?: string | null;
  openedByName?: string | null;
  closedAt?: string | null;
  /** When the cloud accepted the close with every document present. */
  closeAcceptedAt?: string | null;
  closedByUserId?: string | null;
  closedByName?: string | null;
  /** Closed remotely with nobody at the drawer (always uncounted). */
  unattended: boolean;
  /** Null = not counted. Never read as zero. */
  countedCash?: Money | null;
  expectedCash?: Money | null;
  /** counted − expected; null when uncounted. */
  discrepancy?: Money | null;
  /** Null while the shift is open. */
  serverTotals?: ShiftTotals | null;
  /** The till's own X, as it sent it (audit only). Absent on summaries. */
  tillTotals?: Record<string, unknown> | null;
  /** The till's X disagreed with the server's by more than a cent. */
  totalsMismatch: boolean;
  /** Documents that reached the cloud after the shift was closed. */
  lateDocuments?: number;
  /** Closed from the cloud for a dead till, from the documents the cloud held. */
  reconstructed: boolean;
  reconstructionBasis?: Record<string, unknown> | null;
  zReportId?: string | null;
  zNumber?: number | null;
  machineName?: string | null;
  shopName?: string | null;
  /**
   * The area the till was in when the cloud created this shift. Stamped, never
   * updated: moving the till later does not move its past shifts.
   */
  areaId?: string | null;
  areaName?: string | null;
  /** Detail read only: tender → amount, from the documents. */
  paymentBreakdown?: Record<string, Money> | null;
}

export interface ShiftListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: Shift[];
}

export type ZRunStatus = 'waiting' | 'building' | 'completed' | 'failed' | 'cancelled' | 'expired';

export type ZRunItemStatus =
  | 'waiting_close'
  | 'closing'
  | 'ready'
  | 'excluded'
  | 'failed'
  | 'expired';

/** One till of a shop, as the Z wizard sees it (`GET /shops/{id}/z-candidates`). */
export interface ZCandidateMachine {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  online: boolean;
  status?: PosMachine['status'] | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  openShift?: Shift | null;
  /** From the heartbeat — the till may have opened a shift the cloud has not heard of. */
  tillReportedOpenShiftId?: string | null;
  /** Closed and not in a Z, oldest first. A Z always takes a prefix of these. */
  closedShifts: Shift[];
  activeRun?: { runId: string; itemStatus: ZRunItemStatus } | null;
  /** Documents of this till stored with no shift. No Z takes them. */
  orphanDocuments?: number;
}

export interface ZCandidates {
  shopId: string;
  shopName?: string | null;
  /** `machine` = the tenant's accountant wants one till per Z. */
  zScope: 'shop' | 'machine';
  machines: ZCandidateMachine[];
}

export interface ZRunMachineSelection {
  machineId: string;
  /** Omitted = every closed un-Z'd shift of this till. */
  throughShiftId?: string | null;
  includeOpenShift?: boolean;
}

export interface ZRunItem {
  id: string;
  machineId: string;
  machineName?: string | null;
  throughShiftId?: string | null;
  closeShiftId?: string | null;
  status: ZRunItemStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  readyAt?: string | null;
  updatedAt?: string | null;
  /** The till's last reported reading — not a live count. */
  online?: boolean | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  /** While waiting for the till's close: documents of that shift the cloud holds. */
  documentsOnCloud?: number | null;
}

export interface ZRun {
  id: string;
  shopId: string;
  status: ZRunStatus;
  businessDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  createdByUserId?: string | null;
  zReportId?: string | null;
  zNumber?: number | null;
  /** Set when the run was started for one area of the shop. */
  areaId?: string | null;
  areaName?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  items: ZRunItem[];
}

export type ShiftCloseRequestStatus =
  | 'waiting_close'
  | 'closing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** A remote shift close without a Z (`POST /machines/{id}/close-shift`). */
export interface ShiftCloseRequest {
  id: string;
  machineId: string;
  machineName?: string | null;
  shopId?: string | null;
  shiftId?: string | null;
  status: ShiftCloseRequestStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  completedAt?: string | null;
  /** The till's last reported reading — not a live count. */
  online?: boolean | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  /** While pending: documents of the shift the cloud holds. */
  documentsOnCloud?: number | null;
  /** The shift being closed (its X once completed); null if the cloud has not seen it. */
  shift?: Shift | null;
}

export interface ZReport {
  id: string;
  tenantId?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  /**
   * The shop's Z number — 1, 2, 3 … per shop, gapless.
   *
   * What a bookkeeper quotes. Null only on a legacy Z from a terminal with no shop.
   */
  shopSequenceNumber?: number | null;
  /**
   * The area this Z was run for, or null for a whole-shop / hand-picked Z. The number
   * above is still the shop's — an area has no sequence of its own.
   */
  areaId?: string | null;
  areaName?: string | null;
  businessDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  shiftCount?: number | null;
  machineCount?: number | null;
  zRunId?: string | null;
  createdByUserId?: string | null;
  closedAt: string;
  createdAt: string;
  /** After document discounts, before refunds. */
  totalSales?: Money | null;
  /** Before document discounts (= totalSales + discountsTotal). Absent on older servers. */
  grossSales?: Money | null;
  /** totalSales − totalRefunds. Absent on older servers. */
  netSales?: Money | null;
  totalRefunds?: Money | null;
  discountsTotal?: Money | null;
  totalCashSales?: Money | null;
  totalCardSales?: Money | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  vatTotal?: Money | null;
  transactionsCount?: number | null;
  paymentBreakdown?: Record<string, Money> | null;
  openingCash?: Money | null;
  expectedCash?: Money | null;
  /** Null when any included shift was not counted. */
  actualCash?: Money | null;
  discrepancy?: Money | null;
  /**
   * Σ of the tills' cash put into / taken out of the drawer between shifts (part of
   * expectedCash). Null on a Z built before it existed.
   */
  betweenShiftAdjustments?: Money | null;
  /** Any included shift was closed unattended. */
  unattended?: boolean;
  /** Any included shift was reconstructed for a dead till. */
  reconstructed?: boolean;
  /** Documents of its shifts that reached the cloud after it was built (not in its figures). */
  lateDocuments?: number;
  /** A pre-shift Z issued by one till: `machineId` set, no per-till sections. */
  legacy?: boolean;
  machineId?: string | null;
  machineName?: string | null;
  /** Legacy rows only: the till's own Z blob. */
  payload?: Record<string, unknown> | null;
  /** Legacy rows only. */
  reconstructionBasis?: Record<string, unknown> | null;
}

/** One register's section of a Z (§3.6) — what the regulation ties a Z to. */
export interface ZReportMachineSection {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  shiftIds?: string[];
  shiftCount?: number | null;
  firstShiftSequence?: number | null;
  lastShiftSequence?: number | null;
  firstDocumentNumber?: string | null;
  lastDocumentNumber?: string | null;
  transactionsCount?: number | null;
  salesCount?: number | null;
  creditNotesCount?: number | null;
  nonSaleDocumentsCount?: number | null;
  totalSales?: Money | null;
  grossSales?: Money | null;
  netSales?: Money | null;
  totalRefunds?: Money | null;
  discountsTotal?: Money | null;
  vatTotal?: Money | null;
  vatMissingCount?: number | null;
  totalCash?: Money | null;
  totalCard?: Money | null;
  paymentBreakdown?: Record<string, Money> | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  openingCash?: Money | null;
  expectedCash?: Money | null;
  /** Null when any of this till's shifts is uncounted. */
  countedCash?: Money | null;
  overShort?: Money | null;
  /** Cash put into (+) / taken out of (−) the drawer between its shifts; part of expectedCash. */
  betweenShiftAdjustments?: Money | null;
  uncountedShiftCount?: number | null;
  reconstructedShiftCount?: number | null;
  unattendedShiftCount?: number | null;
}

/** Who issued the Z, frozen when it was built — never live settings. */
export interface ZReportBusiness {
  businessName?: string | null;
  vatNumber?: string | null;
  companyRegNumber?: string | null;
  companyId?: string | null;
  address?: string | null;
  addressNumber?: string | null;
  city?: string | null;
  zip?: string | null;
  branchId?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  /** Frozen with the header: the area's name as it was when the Z was built. */
  areaId?: string | null;
  areaName?: string | null;
  capturedAt?: string | null;
}

export interface ZReportDetail extends ZReport {
  perMachine: ZReportMachineSection[];
  shifts: Shift[];
  business?: ZReportBusiness | null;
}

export interface ZReportListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: ZReport[];
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
// Z reports rolled into one figure per business date (the Z's). Not a Z: it
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
  /** This till's section of the Z includes a shift closed from the cloud (dead till). */
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
  /** The Zs' business date (the field keeps its old name on the wire). */
  dayDate: string;
  /** Distinct tills across the day's Zs' per-till sections, not Z reports. */
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

/**
 * The status values an area's roll-up counts: the machine status light's own values
 * (`app/services/machine_status.py`), minus `retired` and `not_paired`.
 */
export type AreaStatusValue = Exclude<
  NonNullable<PosMachine['status']>,
  'retired' | 'not_paired'
>;

/**
 * An area's status roll-up, resolved server-side (`ROLLUP_SEVERITY`). Rendered as is —
 * the dashboard never re-derives `worst` from `counts`.
 */
export interface AreaStatusRollup {
  /** The most severe status among the area's active tills; null for an empty area. */
  worst: string | null;
  /** Status value → how many of the area's active tills have it. */
  counts: Record<string, number>;
}

/** A till as listed on an area after its membership was set. */
export interface ShopAreaMachine {
  id: string;
  name?: string | null;
  posNumber?: string | null;
}

/** An area of one shop: a group of its tills (docs/AREAS_API.md). */
export interface ShopArea {
  id: string;
  shopId: string;
  name: string;
  sortOrder: number;
  /** Archived, never deleted: old shifts, Zs and reports keep pointing at it. */
  archivedAt?: string | null;
  /** Active tills currently in the area. */
  machineCount: number;
  status?: AreaStatusRollup | null;
  /** Present on the answer to `PUT /areas/{id}/machines`. */
  machines?: ShopAreaMachine[];
}

/** One row of `GET /reports/sales-by-area`. `areaId` null = the unassigned row. */
export interface SalesByAreaRow {
  areaId: string | null;
  areaName?: string | null;
  archived?: boolean;
  transactionsCount: number;
  gross: Money;
  discounts: Money;
  net: Money;
  refunds: Money;
  cash: Money;
  card: Money;
  other: Money;
  tips: Money;
}

export type SalesByAreaTotals = Omit<SalesByAreaRow, 'areaId' | 'areaName' | 'archived'> &
  Partial<Pick<SalesByAreaRow, 'areaId' | 'areaName' | 'archived'>>;

export interface SalesByAreaReport {
  shopId?: string;
  dateFrom?: string;
  dateTo?: string;
  rows: SalesByAreaRow[];
  totals: SalesByAreaTotals;
  generatedAt?: string | null;
}
