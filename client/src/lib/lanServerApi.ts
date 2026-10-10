/**
 * The shop's local network — pos-server app/routers/lan_server.py (docs/SPEC_LAN_MODE.md §3–4):
 * a device's "לא משמש כשרת מקומי" and the shop's switch "רשת מקומית". The rules are in
 * lib/lanMode.ts.
 */
import { api } from './api';
import type { MainTillState } from './mainTillApi';
import type { MachineLanServer } from './lanMode';

export const machineLanServerKey = (machineId: string) => ['machine-lan-server', machineId] as const;

export async function fetchMachineLanServer(machineId: string): Promise<MachineLanServer> {
  const { data } = await api.get<MachineLanServer>(`/machines/${machineId}/lan-server`);
  return data;
}

export async function saveMachineLanServer(
  machineId: string,
  body: { excluded: boolean; forceProducerSwitch?: boolean },
): Promise<MachineLanServer> {
  const { data } = await api.put<MachineLanServer>(`/machines/${machineId}/lan-server`, body);
  return data;
}

/** "רשת מקומית" on or off; answers with the main till card's state. */
export async function saveLocalNetwork(
  shopId: string,
  body: { enabled: boolean; forceProducerSwitch?: boolean },
): Promise<MainTillState> {
  const { data } = await api.put<MainTillState>(`/shops/${shopId}/local-network`, body);
  return data;
}
