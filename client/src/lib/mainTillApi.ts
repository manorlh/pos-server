/**
 * "תצורת עבודה — קופה ראשית" — pos-server app/routers/main_till.py: the till the shop leans
 * on (tables host, print server, the shop Z), and where the shop Z may come from.
 */
import { api } from './api';
import type { LanHealthRow, LanSyncState } from './lanMode';
import type { TillRef } from './types';

export interface MainTillState {
  shopId: string;
  mainTill: TillRef | null;
  /** The shop's `shopZFrom` — one of `zFromOptions` (the server's Hebrew values). */
  zFrom: string;
  zFromOptions: string[];
  /** The shop's Z mode: a shop Z ("shop") or each till its own ("machine"). */
  zScope: 'shop' | 'machine';
  /** The shop's `tablesMode` (Hebrew value), or null. */
  tablesMode: string | null;
  /** The tables are in «רשת מקומית (קופה ראשית)»: they live on the tables host. */
  tablesLan: boolean;
  /** Who holds each job now — the main till unless another is named for it. */
  tablesHost: TillRef | null;
  printHost: TillRef | null;
  tills: TillRef[];
  /** The super admin's alone to change. */
  canEdit: boolean;
  /** "רשת מקומית" (docs/SPEC_LAN_MODE.md §4): the switch as stored. */
  localNetwork?: boolean;
  /** The switch on and a main till: the main till produces the shop Z on the LAN. */
  localMode?: boolean;
  /** A row per system: what works on the LAN through the main till today. */
  lanHealth?: LanHealthRow[];
  /** "סנכרון רשת מקומית": what the local server holds that the cloud copy lacks. */
  lanSync?: LanSyncState | null;
}

export async function fetchMainTill(shopId: string): Promise<MainTillState> {
  const { data } = await api.get<MainTillState>(`/shops/${shopId}/main-till`);
  return data;
}

export async function saveMainTill(
  shopId: string,
  /** `forceProducerSwitch`: a super admin's switch although the shop Z's producer has not handed over. */
  body: { machineId: string | null; zFrom?: string; forceProducerSwitch?: boolean },
): Promise<MainTillState> {
  const { data } = await api.put<MainTillState>(`/shops/${shopId}/main-till`, body);
  return data;
}
