/**
 * "מצב דו״ח Z" for a shop or a point of sale — pos-server app/routers/z_mode.py: every till
 * of it switched between the shop's cloud Z and its own ("Z בקופה"), all or nothing.
 */
import { api } from './api';
import type { ZMode } from './types';

export interface ZModeTill {
  machineId: string;
  posNumber: string | null;
  name: string | null;
  areaId: string | null;
  zMode: ZMode;
}

export interface ShopZModeState {
  shopId: string;
  tills: ZModeTill[];
  areas: { id: string; name: string }[];
  /** The super admin's alone to change. */
  canEdit: boolean;
}

export async function fetchShopZMode(shopId: string): Promise<ShopZModeState> {
  const { data } = await api.get<ShopZModeState>(`/shops/${shopId}/z-mode`);
  return data;
}

export async function saveShopZMode(shopId: string, zMode: ZMode, areaId?: string): Promise<ShopZModeState> {
  const { data } = await api.put<ShopZModeState>(`/shops/${shopId}/z-mode`, { zMode, ...(areaId ? { areaId } : {}) });
  return data;
}
