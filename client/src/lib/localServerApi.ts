/**
 * "העברת שרת מקומי" and "סגירת משמרת מהענן" — pos-server app/routers/local_server.py
 * (P:/specs/local-server-switch.md §8). The rules the wizard shows are in lib/lanMode.ts (pure).
 */
import { api } from './api';
import type { LanTillRef, LocalServerState, LocalServerSwitchBody, LocalServerSwitchRecord, LocalServerTill } from './lanMode';

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

export type { LocalServerSwitchRecord };
