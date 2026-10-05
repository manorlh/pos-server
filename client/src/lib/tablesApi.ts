/**
 * Table management ("ניהול שולחנות", `/tables/...` — pos-server app/routers/tables.py):
 * a shop's zones and tables (map or grid), cancellation reasons, the open tables now,
 * and the tables report.
 */
import { api } from './api';
import type { Sketch } from './tableSketch';

export type ZoneLayout = 'map' | 'grid';
export type TableShape = 'round' | 'square' | 'rect';
export type TableStateCode = 'free' | 'occupied' | 'sent' | 'awaiting_payment' | 'locked';

export interface TableZone {
  id: string;
  shopId: string;
  areaId: string | null;
  areaName?: string | null;
  name: string;
  sortOrder: number;
  layout: ZoneLayout;
  backgroundUrl: string | null;
  canvasWidth: number;
  canvasHeight: number;
  /** The drawn floor plan under the tables (see lib/tableSketch.ts). */
  sketch?: Sketch | null;
  updatedAt: string | null;
}

export interface DiningTable {
  id: string;
  zoneId: string;
  number: number;
  name: string | null;
  seats: number;
  shape: TableShape;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** "לניקוי": paid, and not marked clean since (ISO); null when laid. */
  cleaningSince?: string | null;
}

export interface TablesLayout {
  shopId: string;
  zones: TableZone[];
  tables: DiningTable[];
}

export interface TableOrderSummary {
  id: string;
  tableId: string;
  status: 'open' | 'paid' | 'cancelled' | 'void';
  source: 'synced' | 'local';
  version: number;
  guests: number | null;
  itemCount: number;
  total: number;
  openedAt: string | null;
  openedByName: string | null;
  updatedAt: string | null;
  sentAt: string | null;
  sendCount: number;
  billPrintedAt: string | null;
  /** The table's waiter: its own, else its opener. */
  waiterName?: string | null;
}

export interface TableLock {
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  posUserName: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
}

export interface LiveTable extends DiningTable {
  zoneName: string | null;
  order: TableOrderSummary | null;
  lock: TableLock | null;
  state: TableStateCode;
  minutesOpen?: number | null;
}

export interface TablesLive {
  serverTime: string;
  zones: TableZone[];
  tables: LiveTable[];
  summary: { openTables: number; openTotal: number; guests: number };
}

export interface CancelReason {
  id: string;
  name: string;
  requiresNote: boolean;
  sortOrder: number;
  isActive: boolean;
}

export interface TablesReportRow {
  tableId?: string;
  number?: number | null;
  name?: string | null;
  zoneId?: string | null;
  zoneName: string | null;
  orders: number;
  revenue: number;
  guests: number;
  avgMinutes: number | null;
}

export interface CancelledRow {
  orderId: string;
  closedAt: string | null;
  tableNumber: number | null;
  tableName: string | null;
  zoneName: string | null;
  reason: string;
  reasonText: string | null;
  cancelledBy: string | null;
  approvedBy: string | null;
  total: number;
  items: { name: string; quantity: number; total: number }[];
  source: 'synced' | 'local';
}

/** "דוח מלצרים": one waiter over the range. */
export interface WaiterReportRow {
  waiterId: string | null;
  waiter: string;
  tables: number;
  guests: number;
  revenue: number;
  tips: number;
  avgCheck: number | null;
  avgPerGuest: number | null;
  avgMinutes: number | null;
  cancelled: number;
  cancelledTotal: number;
}

/** "שולחנות למלצר": one table a waiter served (or that was cancelled). */
export interface WaiterTableRow {
  orderId: string;
  waiter: string;
  waiterId: string | null;
  tableNumber: number | null;
  tableName: string | null;
  zoneName: string | null;
  openedAt: string | null;
  closedAt: string | null;
  minutes: number | null;
  guests: number | null;
  total: number;
  tip: number;
  transactionNumber: string | null;
  status: 'paid' | 'cancelled';
}

export interface TablesReport {
  from: string;
  to: string;
  summary: {
    paidOrders: number;
    revenue: number;
    guests: number;
    avgSeatingMinutes: number | null;
    cancelledOrders: number;
    cancelledTotal: number;
    payConflicts: number;
  };
  byTable: TablesReportRow[];
  byZone: TablesReportRow[];
  /** Absent on a server from before the waiters' reports. */
  byWaiter?: WaiterReportRow[];
  waiterTables?: WaiterTableRow[];
  cancellations: {
    byReason: { reason: string; count: number; total: number }[];
    byEmployee: { employee: string; count: number; total: number }[];
    rows: CancelledRow[];
  };
}

export const fetchTablesLayout = (shopId: string) =>
  api.get<TablesLayout>('/tables/layout', { params: { shopId } }).then((r) => r.data);

export const createZone = (body: {
  shopId: string;
  areaId?: string | null;
  name: string;
  layout: ZoneLayout;
  backgroundUrl?: string | null;
  canvasWidth?: number;
  canvasHeight?: number;
}) => api.post<TableZone>('/tables/zones', body).then((r) => r.data);

export const updateZone = (
  zoneId: string,
  body: Partial<
    Pick<TableZone, 'areaId' | 'name' | 'layout' | 'backgroundUrl' | 'canvasWidth' | 'canvasHeight' | 'sortOrder' | 'sketch'>
  >,
) => api.patch<TableZone>(`/tables/zones/${zoneId}`, body).then((r) => r.data);

export const archiveZone = (zoneId: string) => api.post(`/tables/zones/${zoneId}/archive`).then((r) => r.data);

export const bulkAddTables = (zoneId: string, body: { from: number; to: number; seats: number; shape: TableShape }) =>
  api
    .post<{ created: number[]; skipped: number[] }>(`/tables/zones/${zoneId}/bulk`, body)
    .then((r) => r.data);

export const saveTablePositions = (
  zoneId: string,
  items: { id: string; x: number; y: number; width?: number; height?: number; rotation?: number }[],
) => api.put<{ saved: number }>(`/tables/zones/${zoneId}/positions`, { items }).then((r) => r.data);

export const createTable = (body: {
  zoneId: string;
  number: number;
  name?: string | null;
  seats: number;
  shape: TableShape;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}) => api.post<DiningTable>('/tables/tables', body).then((r) => r.data);

export const updateTable = (
  tableId: string,
  body: Partial<Pick<DiningTable, 'zoneId' | 'number' | 'name' | 'seats' | 'shape' | 'x' | 'y' | 'width' | 'height' | 'rotation'>>,
) => api.patch<DiningTable>(`/tables/tables/${tableId}`, body).then((r) => r.data);

export const archiveTable = (tableId: string) => api.post(`/tables/tables/${tableId}/archive`).then((r) => r.data);

export const cancelOpenTable = (tableId: string, body: { reasonId: string; reasonText?: string | null }) =>
  api.post(`/tables/tables/${tableId}/cancel`, body).then((r) => r.data);

export const forceReleaseTable = (tableId: string) =>
  api.post(`/tables/tables/${tableId}/force-release`).then((r) => r.data);

export const fetchCancelReasons = (includeInactive = false) =>
  api.get<CancelReason[]>('/tables/cancel-reasons', { params: { includeInactive } }).then((r) => r.data);

export const createCancelReason = (body: { name: string; requiresNote: boolean }) =>
  api.post<CancelReason>('/tables/cancel-reasons', body).then((r) => r.data);

export const updateCancelReason = (
  reasonId: string,
  body: Partial<Pick<CancelReason, 'name' | 'requiresNote' | 'sortOrder' | 'isActive'>>,
) => api.patch<CancelReason>(`/tables/cancel-reasons/${reasonId}`, body).then((r) => r.data);

export const fetchTablesLive = (shopId: string) =>
  api.get<TablesLive>('/tables/live', { params: { shopId } }).then((r) => r.data);

export const fetchTablesReport = (shopId: string, from: string, to: string) =>
  api.get<TablesReport>('/tables/report', { params: { shopId, from, to } }).then((r) => r.data);

/** The `code` of a 409 `{detail: {code, …}}`, or the detail itself when it is a string. */
export function tablesErrorCode(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'code' in detail) {
    const code = (detail as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

// ── Reservations ("הזמנות") ─────────────────────────────────────────────────

export type ReservationStatus = 'booked' | 'seated' | 'cancelled' | 'no_show';

export interface TableReservation {
  id: string;
  tableId: string | null;
  tableNumber: number | null;
  reservedAt: string;
  durationMinutes: number;
  guests: number | null;
  customerName: string;
  phone: string | null;
  notes: string | null;
  status: ReservationStatus;
  createdByName: string | null;
}

export interface ReservationInput {
  tableId?: string | null;
  reservedAt: string;
  durationMinutes?: number;
  guests?: number | null;
  customerName: string;
  phone?: string | null;
  notes?: string | null;
}

export const fetchReservations = (shopId: string, date: string) =>
  api.get<TableReservation[]>('/tables/reservations', { params: { shopId, date } }).then((r) => r.data);

export const createReservation = (shopId: string, body: ReservationInput) =>
  api.post<TableReservation>('/tables/reservations', { ...body, shopId }).then((r) => r.data);

export const updateReservation = (
  shopId: string,
  id: string,
  body: Partial<ReservationInput> & { status?: ReservationStatus },
) => api.patch<TableReservation>(`/tables/reservations/${id}`, body, { params: { shopId } }).then((r) => r.data);
