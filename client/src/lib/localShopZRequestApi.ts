/**
 * "בקש מהקופה הראשית" — pos-server `GET/POST/DELETE /shops/{id}/local-shop-z-request`: in
 * local mode the dashboard asks the shop's main till for the shop Z. The rules are in
 * lib/localShopZ.ts.
 */
import { api } from './api';
import type { LocalShopZState } from './localShopZ';

export const localShopZKey = (shopId: string) => ['local-shop-z-request', shopId] as const;

export async function fetchLocalShopZRequest(shopId: string): Promise<LocalShopZState> {
  const { data } = await api.get<LocalShopZState>(`/shops/${shopId}/local-shop-z-request`);
  return data;
}

/** An open request is answered again, never doubled. 409 `not_local_mode` outside local mode. */
export async function requestLocalShopZ(shopId: string): Promise<LocalShopZState> {
  const { data } = await api.post<LocalShopZState>(`/shops/${shopId}/local-shop-z-request`);
  return data;
}

/** 409 `request_not_pending` when it is no longer open. */
export async function cancelLocalShopZRequest(shopId: string): Promise<LocalShopZState> {
  const { data } = await api.delete<LocalShopZState>(`/shops/${shopId}/local-shop-z-request`);
  return data;
}
