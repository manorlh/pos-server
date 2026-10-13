/**
 * "העברת שרת מקומי" and "סגירת משמרת מהענן" — pos-server app/routers/local_server.py
 * (P:/specs/local-server-switch.md §8). The rules the wizard shows are in lib/lanMode.ts (pure).
 */
import { api } from './api';
import type {
  LanTillRef,
  LocalServerCardData,
  LocalServerFailover,
  LocalServerState,
  LocalServerSwitchBody,
  LocalServerSwitchRecord,
  LocalServerTill,
  ServerAction,
} from './lanMode';

export const localServerKey = (shopId: string) => ['local-server', shopId] as const;

export async function fetchLocalServer(shopId: string): Promise<LocalServerState> {
  const { data } = await api.get<LocalServerState>(`/shops/${shopId}/local-server`);
  return data;
}

export interface CloudClosedShift {
  shiftId: string;
  closedShiftIds: string[];
  closedAt: string | null;
  closedBy: string;
  label: string;
  documentsOnCloud: number | null;
  lastReportedPendingDocuments: number | null;
  expectedCash: string | null;
  countedCash: string | null;
  discrepancy: string | null;
  totalSales: string | null;
  machine: LanTillRef | null;
}

export interface LocalServerSwitchResult {
  switchedAt: string;
  switchedBy: string;
  /** Always `cloud` here (`till`: the till's own take-over, where `tillServerTakeover` allows it). */
  source?: 'cloud' | 'till';
  approvedBy?: string | null;
  mainTill: LanTillRef | null;
  previous: LanTillRef | null;
  moved: string[];
  forced: boolean;
  closedShift: CloudClosedShift | null;
  releasedShopZ: boolean;
  shopZHandover: { reason?: string; message?: string } | null;
  state: LocalServerState;
}

export async function switchLocalServer(shopId: string, body: LocalServerSwitchBody): Promise<LocalServerSwitchResult> {
  const { data } = await api.post<LocalServerSwitchResult>(`/shops/${shopId}/local-server/switch`, body);
  return data;
}

export async function acknowledgeFormerHostChanges(
  shopId: string,
  ids?: string[],
): Promise<{ acknowledged: number; formerHostChanges: LocalServerState['formerHostChanges'] }> {
  const { data } = await api.post(`/shops/${shopId}/local-server/former-host-changes/ack`, ids ? { ids } : {});
  return data;
}

/** The till as the "סגירת משמרת מהענן" dialog shows it. */
export interface CloseFromCloudState extends LocalServerTill {
  closeFromCloudAfterSeconds: number;
  label: string;
}

export async function fetchCloseFromCloud(machineId: string): Promise<CloseFromCloudState> {
  const { data } = await api.get<CloseFromCloudState>(`/machines/${machineId}/shifts/close-from-cloud`);
  return data;
}

export async function closeShiftFromCloud(
  machineId: string,
  body: { countedCash?: number | null; reason?: string | null },
): Promise<CloudClosedShift> {
  const { data } = await api.post<CloudClosedShift>(`/machines/${machineId}/shifts/close-from-cloud`, body);
  return data;
}

// ── "שרת מקומי ייעודי" (P:/specs/dedicated-local-server.md §11) ───────────────────

export const localServerFailoverKey = (shopId: string) => ['local-server-failover', shopId] as const;
export const localServerCardKey = (machineId: string) => ['local-server-card', machineId] as const;

/** "גיבוי אוטומטי לשרת המקומי": the setting (off by default), its target, what it would do now. */
export async function fetchLocalServerFailover(shopId: string): Promise<LocalServerFailover> {
  const { data } = await api.get<LocalServerFailover>(`/shops/${shopId}/local-server/failover`);
  return data;
}

export async function saveLocalServerFailover(
  shopId: string,
  body: { enabled: boolean; targetMachineId: string | null; minutes: number },
): Promise<LocalServerFailover> {
  const { data } = await api.put<LocalServerFailover>(`/shops/${shopId}/local-server/failover`, body);
  return data;
}

/** The device page's "שרת מקומי" card. */
export async function fetchLocalServerCard(machineId: string): Promise<LocalServerCardData> {
  const { data } = await api.get<LocalServerCardData>(`/machines/${machineId}/local-server`);
  return data;
}

/** A remote command to the server: restart, logs, a test page, clearing the queue (confirmed). */
export async function sendLocalServerCommand(
  machineId: string,
  body: { action: ServerAction; params?: Record<string, unknown>; confirm?: boolean },
): Promise<{ id: string; action: string; status: string }> {
  const { data } = await api.post(`/machines/${machineId}/local-server/commands`, body);
  return data;
}

export type { LocalServerSwitchRecord };
