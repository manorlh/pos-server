/**
 * "עמדות מזומן" — pos-server app/routers/cash_stations.py (P:/specs/cash-paylink.md §12): the stations, each
 * one's journal, movements, owed items, drawer and the commands to its cash host. The shapes and the pure
 * rules are lib/cashStations.ts.
 *
 * Kiosk assignment is two machine-level till parameters (`cashEnabled`, `cashStation`), written through the
 * till parameters' values API (`PUT /till-parameters/{id}/values`, the super admin's).
 */
import { api, fetchTillParameters, setTillParameterValue } from './api';
import {
  assignmentValues,
  type CashCommandRecord,
  type CashDrawer,
  type CashMovement,
  type CashOwedItem,
  type CashStation,
  type CashTx,
  type CommandOp,
  type Page,
  type ResolveChoice,
} from './cashStations';

export interface StationsScope {
  companyId?: string | null;
  shopId?: string | null;
  includeInactive?: boolean;
}

export const cashStationsKey = (p: StationsScope) =>
  ['cash-stations', p.companyId ?? null, p.shopId ?? null, p.includeInactive ?? false] as const;
export const cashStationKey = (id: string) => ['cash-station', id] as const;

export async function fetchCashStations(p: StationsScope = {}): Promise<CashStation[]> {
  const { data } = await api.get<{ stations: CashStation[] }>('/cash-stations', {
    params: {
      ...(p.shopId ? { shopId: p.shopId } : p.companyId ? { companyId: p.companyId } : {}),
      ...(p.includeInactive ? { includeInactive: true } : {}),
    },
  });
  return Array.isArray(data?.stations) ? data.stations : [];
}

export async function fetchCashStation(id: string): Promise<CashStation> {
  const { data } = await api.get<CashStation>(`/cash-stations/${id}`);
  return data;
}

export interface StationBody {
  shopId?: string;
  name?: string;
  location?: string | null;
  serial?: string;
  hostMachineId?: string | null;
  settings?: Record<string, unknown> | null;
  isActive?: boolean;
}

/** 409 `not_a_cash_host` / `serial_taken`, 422 `name_required` / `shop_required` / `invalid_setting`. */
export async function createCashStation(body: StationBody): Promise<CashStation> {
  const { data } = await api.post<CashStation>('/cash-stations', body);
  return data;
}

/** Partial: only the fields sent change (`settings` replaces the station's overrides). */
export async function updateCashStation(id: string, body: StationBody): Promise<CashStation> {
  const { data } = await api.put<CashStation>(`/cash-stations/${id}`, body);
  return data;
}

/** Taken out of use (its journal and drawer stay). */
export async function deactivateCashStation(id: string): Promise<{ ok: boolean; stationId: string; isActive: boolean }> {
  const { data } = await api.delete(`/cash-stations/${id}`);
  return data;
}

export async function fetchCashJournal(id: string, params: Record<string, string | number>): Promise<Page<CashTx>> {
  const { data } = await api.get<Page<CashTx>>(`/cash-stations/${id}/journal`, { params });
  return data;
}

export async function fetchCashMovements(id: string, params: Record<string, string | number>): Promise<Page<CashMovement>> {
  const { data } = await api.get<Page<CashMovement>>(`/cash-stations/${id}/movements`, { params });
  return data;
}

export interface OwedAnswer {
  items: CashOwedItem[];
  changeOwed: CashOwedItem[];
  heldCredit: CashOwedItem[];
}

export async function fetchCashOwed(id: string, status: 'open' | 'resolved' | 'all'): Promise<OwedAnswer> {
  const { data } = await api.get<OwedAnswer>(`/cash-stations/${id}/owed`, { params: { status } });
  return data;
}

/** 409 `already_resolved` (someone closed it first). */
export async function resolveCashOwed(
  id: string,
  txId: string,
  body: { resolution: ResolveChoice; note?: string | null },
): Promise<{ ok: boolean; item: CashOwedItem }> {
  const { data } = await api.post(`/cash-stations/${id}/owed/${txId}/resolve`, body);
  return data;
}

/** 409 `station_has_no_host` / `station_inactive`; 422 `invalid_op` / `invalid_args`. */
export async function sendCashCommand(id: string, body: { op: CommandOp; args: Record<string, unknown> }): Promise<CashCommandRecord> {
  const { data } = await api.post<CashCommandRecord>(`/cash-stations/${id}/commands`, body);
  return data;
}

export async function fetchCashDrawer(id: string, params: Record<string, string>): Promise<CashDrawer> {
  const { data } = await api.get<CashDrawer>(`/cash-stations/${id}/drawer`, { params });
  return data;
}

/**
 * "משויך לעמדה": writes the kiosk's own `cashEnabled` (and, on, `cashStation`) — the till parameters API,
 * which only the super admin may call (the server refuses anyone else).
 */
export async function setKioskStation(machineId: string, stationId: string, on: boolean): Promise<void> {
  const params = await fetchTillParameters();
  const byKey = new Map(params.map((p) => [p.key, p.id]));
  for (const { key, value } of assignmentValues(on, stationId)) {
    const id = byKey.get(key);
    if (!id) throw new Error(`till parameter ${key} is missing`);
    await setTillParameterValue(id, { scopeType: 'machine', scopeId: machineId, value });
  }
}
