/**
 * "עמדות מזומן" — pos-server app/routers/cash_stations.py (P:/specs/cash-paylink.md §12): the stations, each
 * one's journal, movements, owed items, drawer and the commands to its cash host. The shapes and the pure
 * rules are lib/cashStations.ts.
 *
 * Assigning a kiosk ("משויך לעמדה") is the server's own route: it writes the kiosk's till parameters
 * (`cashEnabled`, `cashStation`) at its level, under the devices section (no super admin needed).
 */
import { api } from './api';
import {
  type EmbeddedHost,
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
  /** Credits for a next order (§11.15א) — absent from a server before stage 2. */
  credits?: CashOwedItem[];
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
 * "משויך לעמדה": `PUT /cash-stations/{id}/clients/{machineId}` `{assigned}` → the station (detail). On: the device's
 * own `cashEnabled` true and `cashStation` this station; off: `cashEnabled` false. 404 `client_not_found` (not an
 * active kiosk / till of the station's shop), 409 `station_inactive`.
 */
export async function setStationClient(stationId: string, machineId: string, assigned: boolean): Promise<CashStation> {
  const { data } = await api.put<CashStation>(`/cash-stations/${stationId}/clients/${machineId}`, { assigned });
  return data;
}

export const embeddedHostKey = (machineId: string) => ['cash-embedded-host', machineId] as const;

/** "מארח עמדת מזומן" (P:/specs/cash-paylink.md §14.1): whether this device runs its cash station(s), and which. */
export async function fetchEmbeddedHost(machineId: string): Promise<EmbeddedHost> {
  const { data } = await api.get<EmbeddedHost>(`/cash-stations/embedded-hosts/${machineId}`);
  return data;
}

/** On / off. 409 `embedded_host_not_allowed` (not a Windows kiosk…) / `host_has_stations` (move them first). */
export async function setEmbeddedHost(machineId: string, embedded: boolean): Promise<EmbeddedHost> {
  const { data } = await api.put<EmbeddedHost>(`/cash-stations/embedded-hosts/${machineId}`, { embedded });
  return data;
}
