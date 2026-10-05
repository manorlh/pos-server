/**
 * Temporary events ("אירועים") — the shapes of pos-server `/report-events`
 * (app/routers/report_events.py, docs/SPEC_EVENTS.md). Money is in shekels (numbers),
 * times are ISO strings in UTC. Types only, so the pure helpers (eventReport.ts) and
 * their tests can import them without the API client.
 */

export type EventStatus = 'draft' | 'confirmed';
export type InsightLevel = 'alert' | 'warning' | 'info';
export type BucketMinutes = 15 | 30 | 60;

export interface EventThresholds {
  weakTillPct: number;
  highTipPct: number;
  highTipAmount: number | null;
  idleGapMinutes: number;
  minActiveMinutes: number;
}

export interface EventTill {
  id: string;
  name: string;
  posNumber: string | null;
  releasedAt: string | null;
}

export interface ReportEvent {
  id: string;
  name: string;
  shopId: string;
  shopName: string | null;
  companyId: string | null;
  startsAt: string;
  endsAt: string;
  /** Local parts, in `timezone`. */
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  durationMinutes: number;
  status: EventStatus;
  producerName: string | null;
  notes: string | null;
  thresholds: EventThresholds;
  machineIds: string[];
  machines: EventTill[];
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmNote: string | null;
}

export interface EventListItem extends ReportEvent {
  /** From the snapshot of a confirmed event; null on a draft. */
  summary: {
    net: number;
    salesCount: number;
    avgTicket: number;
    tips: number;
    activeTills: number;
    alerts: number;
  } | null;
}

export interface EventFormValues {
  name: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  machineIds: string[];
  producerName: string;
  notes: string;
  thresholds: EventThresholds;
}

export interface EventTillOption {
  id: string;
  name: string;
  posNumber: string | null;
  areaName: string | null;
  lastHeartbeatAt: string | null;
  busy: { eventId: string; eventName: string; startsAt: string; endsAt: string } | null;
}

export interface PeakHour {
  start: string;
  end: string;
  net: number;
  count: number;
  sharePct: number | null;
}

export interface EventKpis {
  gross: number;
  discounts: number;
  sales: number;
  refunds: number;
  refundsCount: number;
  net: number;
  vat: number;
  netExVat: number;
  vatEstimatedCount: number;
  salesCount: number;
  documentsCount: number;
  avgTicket: number;
  itemsSold: number;
  itemsPerSale: number | null;
  discountPct: number | null;
  tips: number;
  tipPct: number | null;
  exceptionsCount: number;
  cash: number;
  card: number;
  other: number;
  exchange: number;
  peakHour: PeakHour | null;
  windowHours: number;
  salesPerHour: number;
  activeHours: number;
  avgPerActiveHour: number;
  tillsCount: number;
  activeTills: number;
  firstSaleAt: string | null;
  lastSaleAt: string | null;
  baselineAvgTicket: number | null;
}

export interface TimelineBucket {
  start: string;
  net: number;
  count: number;
  /** machineId → net; only tills with takings in the bucket. */
  byTill: Record<string, number>;
}

export interface IdleGap {
  kind: 'gap' | 'lateStart' | 'earlyStop';
  from: string;
  to: string;
  minutes: number;
}

export interface EventTillRow {
  machineId: string;
  name: string;
  posNumber: string | null;
  areaName: string | null;
  documentsCount: number;
  salesCount: number;
  sales: number;
  refunds: number;
  refundsCount: number;
  net: number;
  avgTicket: number;
  items: number;
  tips: number;
  tipPct: number | null;
  exceptions: number;
  voids: number;
  cancels: number;
  drawerOpens: number;
  firstSaleAt: string | null;
  lastSaleAt: string | null;
  spanMinutes: number;
  activeMinutes: number;
  salesPerHour: number;
  avgPerActiveHour: number;
  sharePct: number | null;
  idleGaps: IdleGap[];
  idleMinutes: number;
  cash: number;
  card: number;
  other: number;
  exchange: number;
  overCredited: number;
  weak: boolean;
  idle: boolean;
  noSales: boolean;
  weakRatioPct: number | null;
  lastHeartbeatAt: string | null;
  pendingDocuments: number | null;
  pendingCountAt: string | null;
}

export interface EventShiftRow {
  shiftId: string;
  machineId: string;
  machineName: string;
  sequence: number | null;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  openedBy: string | null;
  closedBy: string | null;
  openingCash: number | null;
  expectedCash: number | null;
  countedCash: number | null;
  discrepancy: number | null;
  unattended: boolean;
  openedBeforeWindow: boolean;
  closesAfterWindow: boolean;
  zReportId: string | null;
  zLabel: string | null;
  documentsInWindow: number;
  netInWindow: number;
}

export interface EventItemRow {
  key: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  sold: number;
  refunded: number;
  revenue: number;
  lines: number;
  sharePct: number | null;
  rank: number;
  byTill: Record<string, number>;
}

export interface EventItems {
  totalRevenue: number;
  itemsSold: number;
  rows: EventItemRow[];
  truncated: boolean;
  top: EventItemRow[];
  bottom: EventItemRow[];
  categories: { categoryId: string | null; name: string; quantity: number; revenue: number; items: number; sharePct: number | null }[];
  modifiers: { key: string; name: string; groupName: string | null; kind: string | null; quantity: number; revenue: number }[];
  matrix: { machineIds: string[]; rows: { key: string; name: string; total: number; cells: Record<string, number> }[] };
  singleTill: { key: string; name: string; machineId: string; machineName: string; quantity: number; sharePct: number }[];
}

export interface SegmentRow {
  id: string | null;
  name: string;
  net: number;
  count: number;
  sharePct: number | null;
}

export interface CashierSegment {
  id: string | null;
  name: string | null;
  net: number;
  sales: number;
  salesCount: number;
  refunds: number;
  refundsCount: number;
  tips: number;
  tipPct: number | null;
  avgTicket: number;
  sharePct: number | null;
}

export interface EventSegments {
  byCategory: EventItems['categories'];
  byPayment: { method: 'cash' | 'card' | 'other' | 'exchange'; amount: number; count: number; sharePct: number | null }[];
  byCardBrand: { brand: string; amount: number; count: number }[];
  byHour: { hour: number; net: number; count: number; sharePct: number | null }[];
  byTill: SegmentRow[];
  byCashier: CashierSegment[];
  byArea: SegmentRow[];
}

export interface EventInsight {
  id: string;
  code: string;
  level: InsightLevel;
  text: string;
  params: Record<string, unknown>;
  ref: { kind: string; id: string | null; name: string | null } | null;
}

export interface Figures {
  sales: number;
  refunds: number;
  net: number;
  cash: number;
  card: number;
  other: number;
  exchange: number;
  tips: number;
  count: number;
}

export interface ZRow {
  zReportId: string;
  label: string;
  machineId: string;
  machineName: string;
  inWindow: Figures;
  outsideWindow: Figures;
  z: Figures | null;
  diff: Figures | null;
  diffText: [string, number][];
  status: 'match' | 'mismatch' | 'legacy';
  coversOutside: boolean;
  outsideNet: number;
  lateDocuments: number;
  amendedDocuments: number;
}

export type ReconcileStatus = 'match' | 'mismatch' | 'pending' | 'none';

export interface ZReconciliation {
  status: ReconcileStatus;
  zReports: {
    id: string;
    label: string;
    origin: 'shop' | 'till';
    number: number | null;
    businessDate: string | null;
    closedAt: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    tills: string[];
    otherTills: string[];
    lateDocuments: number;
    amendedDocuments: number;
  }[];
  rows: ZRow[];
  tills: {
    machineId: string;
    name: string;
    eventNet: number;
    inZ: { count: number; net: number };
    pendingZ: { count: number; net: number };
    zLabels: string[];
  }[];
}

export interface TransmissionBatch {
  id: string;
  batchNumber: string | null;
  status: 'success' | 'failed' | 'unknown';
  trigger: string;
  startedAt: string;
  startedAtText: string;
  finishedAt: string | null;
  transactionCount: number | null;
  amount: number | null;
  legsInWindow: number;
  amountInWindow: number;
  level: 'transaction' | 'amounts';
  legsCompared: number | null;
  amountCompared: number | null;
  compare: 'match' | 'mismatch' | 'n/a' | null;
  message: string | null;
}

export interface CountAmount {
  count: number;
  amount: number;
}

export interface TransmissionReconciliation {
  status: ReconcileStatus;
  tills: {
    machineId: string;
    name: string;
    trackingStartedAt: string | null;
    cardLegs: CountAmount;
    transmitted: CountAmount;
    untransmitted: CountAmount & { oldestAt: string | null };
    untracked: CountAmount;
    batches: TransmissionBatch[];
    tillPending: { count: number | null; amount: number | null; reportedAt: string | null };
  }[];
}

export interface ReadinessCheck {
  code: string;
  text: string;
  ref?: string;
}

export interface EventReadiness {
  ended: boolean;
  blocking: ReadinessCheck[];
  warnings: ReadinessCheck[];
  checkedAt: string;
}

export interface EventExceptionRow {
  id: string;
  type: string;
  label: string;
  severity: string;
  occurredAt: string;
  machineId: string | null;
  machineName: string | null;
  posUserName: string | null;
  amount: number | null;
  transactionId: string | null;
  status: string;
}

export interface EventReport {
  event: ReportEvent;
  generatedAt: string;
  frozen: boolean;
  confirmedAt?: string;
  timezone: string;
  thresholds: EventThresholds;
  bucketMinutes: number;
  kpis: EventKpis;
  timeline: TimelineBucket[];
  tills: EventTillRow[];
  shifts: EventShiftRow[];
  items: EventItems;
  segments: EventSegments;
  exceptions: {
    total: number;
    byType: { type: string; label: string; count: number; amount: number; tills: [string, number][] }[];
    rows: EventExceptionRow[];
  };
  reconciliation: { z: ZReconciliation; transmissions: TransmissionReconciliation };
  insights: EventInsight[];
  readiness: EventReadiness;
  medianSalesPerHour: number | null;
}

export interface EventCompareEntry {
  event: ReportEvent;
  frozen: boolean;
  kpis: EventKpis;
  perTill: { avgNet: number; medianSalesPerHour: number | null; avgTicket: number; activeTills: number };
  tills: Pick<EventTillRow, 'machineId' | 'name' | 'net' | 'salesCount' | 'avgTicket' | 'salesPerHour' | 'sharePct' | 'tipPct' | 'weak' | 'idle' | 'noSales'>[];
  topItems: Pick<EventItemRow, 'key' | 'name' | 'quantity' | 'revenue' | 'sharePct'>[];
  byPayment: EventSegments['byPayment'];
  alerts: number;
  warnings: number;
}
