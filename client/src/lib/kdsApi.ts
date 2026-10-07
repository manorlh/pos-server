/**
 * KDS and "תצורת עבודה" — pos-server app/routers/kds.py, docs/SPEC_KDS.md §8.
 *
 * The workflow card reads and writes one level at a time (company / shop / point of
 * sale / till); the save refuses a contradictory configuration with 422
 * `{code: 'workflow_invalid', errors, warnings}` (read it with `workflowRejection` in
 * lib/workflowMode.ts). The KDS endpoints are per shop: screens (a till as a KDS),
 * station settings, routing overrides, the public pickup screen's token and the live
 * board.
 */
import { api } from './api';
import type { BoardDisplay } from './kdsScreenTypes';
import type { WorkflowLevelView, WorkflowScopeType, WorkflowValues } from './workflowMode';

// ── Workflow configuration ──────────────────────────────────────────────────────

export interface WorkflowValuesBody {
  scopeType: WorkflowScopeType;
  scopeId: string;
  values: WorkflowValues;
}

export async function getWorkflow(scopeType: WorkflowScopeType, scopeId: string): Promise<WorkflowLevelView> {
  const { data } = await api.get<WorkflowLevelView>('/workflow/config', { params: { scopeType, scopeId } });
  return data;
}

/** The effective configuration and its validation with `values` applied — nothing saved. */
export async function previewWorkflow(body: WorkflowValuesBody): Promise<WorkflowLevelView> {
  const { data } = await api.post<WorkflowLevelView>('/workflow/config/preview', body);
  return data;
}

/** Saves `values` at the level (null removes = inherit). 422 `workflow_invalid` when refused. */
export async function saveWorkflow(body: WorkflowValuesBody): Promise<WorkflowLevelView> {
  const { data } = await api.put<WorkflowLevelView>('/workflow/config', body);
  return data;
}

// ── KDS: a shop ─────────────────────────────────────────────────────────────────

export type KdsRole = 'station' | 'expo' | 'pickup' | 'manager';
export const KDS_ROLES: KdsRole[] = ['station', 'expo', 'pickup', 'manager'];
export type KdsTargetKind = 'prep' | 'view';

export interface KdsStation {
  id: string;
  name: string;
  /** prep — its tasks are required for "ready"; view — shown only, never blocking. */
  targetKind: KdsTargetKind;
  warnMinutes: number;
  lateMinutes: number;
  /** An active station screen covers it. */
  hasDevice: boolean;
  printerIds: string[];
}

export interface KdsDevice {
  id: string;
  machineId: string | null;
  shopId: string;
  name: string;
  role: KdsRole;
  stations: { id: string; name: string }[];
  isActive: boolean;
  lastSeenAt: string | null;
  /** The board's look (a pickup screen; null = the defaults — docs/SPEC_KDS.md §13). */
  display?: BoardDisplay | null;
}

export interface KdsShopMachine {
  id: string;
  name: string;
  posNumber: string | null;
  /**
   * False for a display device (pos-server app/services/display_devices.py). A till chosen
   * as a screen for the first time becomes one: no longer a till (the dialog warns).
   */
  fiscal?: boolean;
  /** "web": a browser screen (`/kds`, `/board` on this site). */
  platform?: 'android' | 'windows' | 'web' | null;
}

export interface KdsRouteOverride {
  id: string;
  targetType: 'category' | 'product';
  targetId: string;
  stationId: string | null;
  areaId: string | null;
  serviceType: 'eat_in' | 'take_away' | null;
}

/** `GET /kds/shops/{shop}` (`shop_overview`). */
export interface KdsShopOverview {
  shopId: string;
  stations: KdsStation[];
  devices: KdsDevice[];
  machines: KdsShopMachine[];
  overrides: KdsRouteOverride[];
  pickupToken: string | null;
  openOrders: number;
  unroutedTasks: number;
  version: number;
  canEdit: boolean;
}

export interface KdsDeviceInput {
  name?: string | null;
  role: KdsRole;
  stationIds: string[];
  isActive: boolean;
  /** A pickup screen's look; omitted keeps what the screen has. */
  display?: BoardDisplay;
}

export interface KdsStationInput {
  targetKind: KdsTargetKind;
  warnMinutes: number;
  lateMinutes: number;
}

export interface KdsRouteOverrideInput {
  targetType: 'category' | 'product';
  targetId: string;
  stationId?: string | null;
  areaId?: string | null;
  serviceType?: 'eat_in' | 'take_away' | null;
}

export async function getKdsShop(shopId: string): Promise<KdsShopOverview> {
  const { data } = await api.get<KdsShopOverview>(`/kds/shops/${shopId}`);
  return data;
}

/** A till of the shop as a KDS screen (creates or updates). A station screen needs ≥ 1 station. */
export async function saveDevice(shopId: string, machineId: string, body: KdsDeviceInput): Promise<KdsDevice> {
  const { data } = await api.put<KdsDevice>(`/kds/shops/${shopId}/devices/${machineId}`, body);
  return data;
}

export async function deleteDevice(shopId: string, machineId: string): Promise<void> {
  await api.delete(`/kds/shops/${shopId}/devices/${machineId}`);
}

/** Returns the shop's overview again. */
export async function saveStation(shopId: string, stationId: string, body: KdsStationInput): Promise<KdsShopOverview> {
  const { data } = await api.put<KdsShopOverview>(`/kds/shops/${shopId}/stations/${stationId}`, body);
  return data;
}

export async function addOverride(shopId: string, body: KdsRouteOverrideInput): Promise<{ id: string }> {
  const { data } = await api.post<{ id: string }>(`/kds/shops/${shopId}/overrides`, body);
  return data;
}

export async function deleteOverride(shopId: string, overrideId: string): Promise<void> {
  await api.delete(`/kds/shops/${shopId}/overrides/${overrideId}`);
}

/** A new opaque token for the public pickup screen — the old link stops working. */
export async function rotatePickupToken(shopId: string): Promise<string> {
  const { data } = await api.post<{ pickupToken: string }>(`/kds/shops/${shopId}/pickup-token`);
  return data.pickupToken;
}

/** The TV page of the public pickup screen (no login): `${API}/public/kds/pickup/<token>/screen`. */
export function pickupScreenUrl(token: string): string {
  const base = (api.defaults.baseURL ?? '').replace(/\/+$/, '');
  return `${base}/public/kds/pickup/${encodeURIComponent(token)}/screen`;
}

// ── KDS: the live board ─────────────────────────────────────────────────────────

export type KdsPrepState = 'queued' | 'preparing' | 'ready';
export type KdsGroupState = 'waiting' | 'ready_for_pickup' | 'handed_over' | 'cancelled';
export type KdsSource = 'table' | 'quick' | 'kiosk' | 'external';

export interface KdsTask {
  id: string;
  orderId: string;
  roundNo: number;
  stationId: string | null;
  stationName: string | null;
  targetKind: KdsTargetKind | null;
  required: boolean;
  lineKey: string;
  name: string;
  mods: string[];
  removals: string[];
  notes: string | null;
  allergies: string[];
  important: boolean;
  orderedQty: number;
  cancelledQty: number;
  preparedQty: number;
  activeQty: number;
  release: 'hold' | 'released';
  state: KdsPrepState;
  fallbackPrinted: boolean;
  fallbackResolved: boolean;
  releasedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
}

export interface KdsOrder {
  id: string;
  source: KdsSource;
  sourceRef: string;
  displayRef: string | null;
  tableRef: string | null;
  zoneName: string | null;
  serviceType: 'eat_in' | 'take_away' | null;
  guests: number | null;
  waiterName: string | null;
  pickupName: string | null;
  orderNote: string | null;
  pickupNumber: number | null;
  workflowMode: 'DIRECT_SALE' | 'ORDER_PROCESS';
  configVersion: string | null;
  paid: boolean;
  status: string;
  priority: number | null;
  groupState: KdsGroupState | null;
  readyAt: string | null;
  allReady: boolean;
  requireExpo: boolean;
  viewOnly: boolean;
  firstReleasedAt: string | null;
  createdAt: string | null;
  rounds: { roundNo: number; releasedAt: string | null; isAddition: boolean }[];
  tasks: KdsTask[];
}

export interface KdsPickupNumber {
  number: string;
  since: string | null;
}

/** `GET /kds/shops/{shop}/board` — the Expo's view, read only. */
export interface KdsShopBoard {
  serverTime: string;
  orders: KdsOrder[];
  pickup: { preparing: KdsPickupNumber[]; ready: KdsPickupNumber[] };
}

export async function getKdsBoard(shopId: string): Promise<KdsShopBoard> {
  const { data } = await api.get<KdsShopBoard>(`/kds/shops/${shopId}/board`);
  return data;
}
