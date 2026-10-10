/**
 * Insights ("תובנות", `/insights/...` — pos-server app/routers/insights.py,
 * docs/SPEC_INSIGHTS.md): the manager's analyses, scoped like the control board.
 *
 * **Every money field is integer agorot** — divide by 100 for display (`agorot()`).
 * Periods are business days (04:00 to 04:00, Israel time): by default the 28 complete
 * days ending yesterday, against the 28 before them.
 */
import { api } from './api';
import { formatCurrency } from './format';

/** Agorot → the shekel string the rest of the dashboard shows. */
export function agorot(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return formatCurrency(value / 100);
}

export interface InsightScopeParams {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
  /** Business days, inclusive; `to` at most today. */
  from?: string;
  to?: string;
  /** Without from/to: the complete days ending yesterday. */
  days?: number;
  /** A report event: its tills, window and days (the period is ignored). */
  eventId?: string;
}

export interface InsightPeriod {
  from: string;
  to: string;
  days: number;
  prevFrom: string;
  prevTo: string;
}

export interface InsightMeta {
  generatedAt: string;
  timezone: string;
  dayStartHour: number;
  today: string;
  period: InsightPeriod;
  historyStart: string | null;
}

export type Severity = 'critical' | 'warning' | 'opportunity' | 'positive' | 'info';

export type InsightSection =
  | 'forecast'
  | 'trends'
  | 'slow'
  | 'stock'
  | 'heatmap'
  | 'menu'
  | 'abc'
  | 'baskets'
  | 'cashiers'
  | 'tables'
  | 'customers'
  | 'anomalies';

export interface InsightCard {
  id: string;
  type: string;
  severity: Severity;
  section: InsightSection;
  score: number;
  /** The template's values: money in agorot, percentages 0–100, weekday 0 = Sunday. */
  params: Record<string, unknown>;
}

export interface KpiBlock {
  net: number;
  gross: number;
  discounts: number;
  refunds: number;
  refundsCount: number;
  sales: number;
  documents: number;
  tips: number;
  avgCheck: number | null;
  itemsPerSale: number | null;
  discountPct: number | null;
  refundPct: number | null;
  tipPct: number | null;
  perDay: number;
}

export interface Kpis {
  current: KpiBlock;
  previous: KpiBlock | null;
}

export interface Availability {
  hasSales: boolean;
  historyDays: number;
  hasCost: boolean;
  costCoveragePct: number | null;
  hasStock: boolean;
  hasTables: boolean;
  shops: number;
}

export interface InsightsFeed extends InsightMeta {
  availability: Availability;
  kpis: Kpis;
  counts: Record<Severity, number>;
  cards: InsightCard[];
  truncated: boolean;
}

export type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog';

export interface MenuItemRow {
  key: string;
  productId: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  group: string;
  units: number;
  net: number;
  menuMix: number;
  popularityThreshold: number | null;
  popIndex: number | null;
  avgPrice: number;
  avgPriceExVat: number;
  cost: number | null;
  margin: number | null;
  foodCostPct: number | null;
  value: number | null;
  valueThreshold: number | null;
  valueIndex: number | null;
  totalMargin: number | null;
  quadrant: Quadrant | null;
}

export interface MenuEngineering extends InsightMeta {
  mode: 'cost' | 'price' | null;
  n: number;
  byCategory: boolean;
  popularityThreshold: number | null;
  valueThreshold: number | null;
  items: MenuItemRow[];
  missingCost: MenuItemRow[];
  counts: Record<Quadrant, number>;
  groups: { group: string; items: number; popularityThreshold: number | null; valueThreshold: number | null }[];
  categories: { id: string; name: string | null; items: number; net: number }[];
  categoryId: string | null;
}

export interface AbcItem {
  key: string;
  productId: string | null;
  name: string;
  categoryName: string | null;
  units: number;
  net: number;
  class: 'A' | 'B' | 'C';
  share: number;
  cumShare: number;
}

export interface AbcReport extends InsightMeta {
  total: number;
  classes: Record<'A' | 'B' | 'C', { count: number; net: number; share: number; itemShare: number }>;
  items: AbcItem[];
  cuts: { A: number; B: number };
}

export interface DeadItem {
  key: string;
  productId: string | null;
  name: string;
  categoryName: string | null;
  daysSinceSale: number | null;
  never: boolean;
  lookbackDays: number;
  lastSold: string | null;
  onHand: number | null;
  stockValue: number | null;
  action: 'dont_reorder' | 'sell_off_dont_reorder';
}

export interface SlowItem {
  key: string;
  productId: string | null;
  name: string;
  categoryName: string | null;
  units: number;
  net: number;
  menuMix: number;
  fairShare: number;
  perWeek: number | null;
  onHand: number | null;
  action: 'order_less' | 'promote_or_remove';
}

export interface DecliningItem {
  key: string;
  productId: string | null;
  name: string;
  categoryName: string | null;
  units: number;
  unitsPrev: number;
  changePct: number | null;
}

export interface SlowReport extends InsightMeta {
  dead: DeadItem[];
  slow: SlowItem[];
  declining: DecliningItem[];
  thresholds: { deadDays: number; newItemDays: number; slowSharePct: number; declinePct: number };
}

export type StockStatus = 'out' | 'critical' | 'low' | 'below_min' | 'dead' | 'overstock' | 'ok';

export interface StockRow {
  key: string;
  productId: string | null;
  name: string;
  shopId: string | null;
  shopName: string | null;
  onHand: number;
  perDay: number;
  daysOfCover: number | null;
  sellThroughPct: number | null;
  status: StockStatus;
  suggestedOrder: number | null;
  reorderMin: number | null;
  reorderMax: number | null;
  stockValue: number | null;
}

export interface StockReport extends InsightMeta {
  hasStock: boolean;
  rows: StockRow[];
  counts?: Partial<Record<StockStatus, number>>;
  params?: { velocityDays: number; leadDays: number; targetDays: number };
}

export interface HeatCell {
  weekday: number;
  hour: number;
  typicalNet: number;
  avgNet: number;
  avgDocs: number;
  open: boolean;
  index: number;
  vsHour: number | null;
}

export interface SlotRange {
  weekday: number;
  fromHour: number;
  toHour: number;
  typicalNet: number;
  usual: number;
  deviationPct: number | null;
  gapPerWeek: number;
  occurrences: number;
}

export interface Heatmap extends InsightMeta {
  occurrences: number[];
  openDays: number;
  closedDays: number;
  hours: number[];
  cells: HeatCell[];
  hourMeans: { hour: number; avgNet: number }[];
  averageDay: number;
  weak: SlotRange[];
  peak: SlotRange[];
  spans: { weekday: number; from: number | null; to: number | null }[];
}

export interface DailyPoint {
  date: string;
  weekday: number;
  net: number;
  docs: number;
  baseline: number | null;
  baselineWeeks: number;
  deviationPct: number | null;
}

export interface WeekOverWeek {
  from: string;
  to: string;
  net: number;
  netPrev: number;
  netChangePct: number | null;
  sales: number;
  salesPrev: number;
  salesChangePct: number | null;
  avgCheck: number;
  avgCheckPrev: number;
  avgCheckChangePct: number | null;
}

export interface ProductTrend {
  key: string;
  productId: string | null;
  name: string;
  categoryName: string | null;
  units: number;
  unitsPrev: number;
  changePct: number;
  net: number;
  netPrev: number;
  netChange: number;
}

export interface Trends extends InsightMeta {
  daily: DailyPoint[];
  weekOverWeek: WeekOverWeek | null;
  products: { rising: ProductTrend[]; falling: ProductTrend[] };
  yesterday: { date: string; weekday: number; net: number; baseline: number; deviationPct: number; weeks: number } | null;
}

export interface ForecastDay {
  date: string;
  weekday: number;
  net: number | null;
  docs: number | null;
  low: number | null;
  high: number | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  basis: string[];
}

export interface Pace {
  date: string;
  weekday: number;
  actual: number;
  expectedSoFar: number;
  lowSoFar: number;
  highSoFar: number;
  expectedFull: number;
  projected: number;
  pacePct: number | null;
  weeks: number;
  judgeable: boolean;
  asOfHour: number;
}

export interface Forecast extends InsightMeta {
  days: ForecastDay[];
  tomorrowHourly: { hour: number; net: number; share: number; docs: number }[];
  nextWeekTotal: number | null;
  lastWeekTotal: number;
  nextWeekChangePct: number | null;
  accuracy: { wape: number | null; accuracy: number | null; days: number };
  pace: Pace | null;
}

export interface BasketPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  together: number;
  support: number;
  confidence: number;
  lift: number;
  excess: number;
}

export interface Baskets extends InsightMeta {
  sales: number;
  avgCheck: number | null;
  itemsPerSale: number | null;
  linesPerSale: number | null;
  sizes: { buckets: { size: string; baskets: number; share: number }[]; baskets: number; singleItemShare: number | null };
  pairs: BasketPair[];
  minCount: number;
}

export type CashierMetric = 'discount' | 'refund' | 'void';

export interface CashierFlag {
  metric: CashierMetric;
  rate: number;
  team: number;
  times: number;
  level: 'elevated' | 'high';
}

export interface CashierRow {
  cashierId: string | null;
  name: string | null;
  sales: number;
  gross: number;
  discounts: number;
  promotions: number;
  refundsCount: number;
  refunds: number;
  voidsCount: number;
  voids: number;
  cancelsCount: number;
  cancels: number;
  discountPct: number | null;
  refundPct: number | null;
  voidPct: number | null;
  flags: CashierFlag[];
}

export interface Cashiers extends InsightMeta {
  team: {
    sales: number;
    gross: number;
    discounts: number;
    promotions: number;
    refunds: number;
    voids: number;
    discountPct: number | null;
    refundPct: number | null;
    voidPct: number | null;
  };
  rows: CashierRow[];
  minSales: number;
  ratio: number;
  floors: Record<CashierMetric, number>;
}

export type OpenTableState = 'occupied' | 'sent' | 'awaiting_payment';

export interface OpenTableRow {
  tableId: string;
  number: number | null;
  name: string | null;
  zoneName: string | null;
  shopId: string | null;
  shopName: string | null;
  guests: number | null;
  total: number;
  openedAt: string | null;
  minutesOpen: number | null;
  state: OpenTableState;
  seats: number | null;
  openedBy: string | null;
  long: boolean;
}

export interface TablesLive extends InsightMeta {
  hasTables: boolean;
  openTables: number;
  guests: number;
  openAmount: number;
  tablesTotal: number;
  seatsTotal: number;
  occupancyPct: number | null;
  seatUsePct: number | null;
  awaitingPayment: number;
  avgMinutesOpen: number | null;
  longest: OpenTableRow | null;
  longAfterMinutes: number;
  longOpen: number;
  byShop: { shopId: string | null; shopName: string | null; openTables: number; guests: number; openAmount: number }[];
  tables: OpenTableRow[];
  usualSeatedMinutes: number | null;
}

export interface TablesPeriodBlock {
  orders: number;
  revenue: number;
  covers: number;
  spendPerCover: number | null;
  avgPerOrder: number | null;
  avgSeatedMinutes: number | null;
  medianSeatedMinutes: number | null;
  turnover: number | null;
  revenuePerSeatDay: number | null;
  revPash: number | null;
  seatOccupancyPct: number | null;
  openHours: number | null;
  guestsRecordedPct: number | null;
  byParty: { party: string; orders: number; avgMinutes: number | null; spendPerCover: number | null }[];
}

export interface TablesPeriod extends InsightMeta {
  hasTables: boolean;
  tablesTotal?: number;
  seatsTotal?: number;
  current?: TablesPeriodBlock;
  previous?: TablesPeriodBlock | null;
}

export interface Customers extends InsightMeta {
  summary: {
    customers: number;
    identifiedDocs: number;
    identifiedPct: number | null;
    repeatCustomers: number;
    repeatPct: number | null;
    repeatNet: number;
    repeatNetPct: number | null;
    visitsPerCustomer: number;
  } | null;
}

const get = <T,>(path: string, params: object) => api.get<T>(path, { params }).then((r) => r.data);

export const fetchInsightsFeed = (p: InsightScopeParams) => get<InsightsFeed>('/insights', p);
export const fetchMenuEngineering = (p: InsightScopeParams & { categoryId?: string; byCategory?: boolean }) =>
  get<MenuEngineering>('/insights/menu-engineering', p);
export const fetchAbc = (p: InsightScopeParams) => get<AbcReport>('/insights/abc', p);
export const fetchSlowProducts = (p: InsightScopeParams & { deadDays?: number }) => get<SlowReport>('/insights/products/slow', p);
export const fetchStockRisk = (p: InsightScopeParams) => get<StockReport>('/insights/stock', p);
export const fetchHeatmap = (p: InsightScopeParams) => get<Heatmap>('/insights/heatmap', p);
export const fetchTrends = (p: InsightScopeParams) => get<Trends>('/insights/trends', p);
export const fetchForecast = (p: InsightScopeParams) => get<Forecast>('/insights/forecast', p);
export const fetchBaskets = (p: InsightScopeParams) => get<Baskets>('/insights/baskets', p);
export const fetchCashierRates = (p: InsightScopeParams) => get<Cashiers>('/insights/cashiers', p);
export const fetchTablesLive = (p: InsightScopeParams) => get<TablesLive>('/insights/tables-live', p);
export const fetchTablesPeriod = (p: InsightScopeParams) => get<TablesPeriod>('/insights/tables', p);
export const fetchCustomers = (p: InsightScopeParams) => get<Customers>('/insights/customers', p);

/** A product's unit cost in shekels, excl. VAT; `null` clears it. Returns agorot. */
export const saveProductCost = (productId: string, cost: number | null) =>
  api.put<{ productId: string; cost: number | null }>(`/insights/product-costs/${productId}`, { cost }).then((r) => r.data);
