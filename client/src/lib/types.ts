export type UserRole =
  | 'super_admin'
  | 'distributor'
  | 'merchant_admin'
  | 'company_manager'
  | 'shop_manager'
  | 'cashier';

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  companyId?: string;
  shopId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Company {
  id: string;
  name: string;
  vatNumber?: string;
  address?: string;
  city?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
  tipsEnabled?: boolean;
  cashTipsEnabled?: boolean;
  tipPresets?: number[];
  tipDistribution?: TipDistribution;
  receiptPrinterName?: string;
  drawerPrinterName?: string;
  businessInfo?: Record<string, unknown>;
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
  lastSyncAt?: string;
  lastCatalogChangeAt?: string;
  catalogPullStale?: boolean;
  tradingDayStatus?: 'open' | 'closed' | 'none';
  tradingDayId?: string;
  dayDate?: string;
  openedAt?: string;
  openedBy?: string;
  closeDayPending?: boolean;
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
