/**
 * "בקש מהקופה הראשית" — pos-server `GET/POST/DELETE /shops/{id}/local-shop-z-request`: in
 * local mode the dashboard asks the shop's main till for the shop Z. The rules are in
 * lib/localShopZ.ts.
 */
import { api } from './api';
import type { LocalShopZState } from './localShopZ';
import type { ZVerification } from './types';

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

/** A local shop Z's verification, re-checked now ("בדוק שוב"). */
export async function recheckLocalShopZ(shopId: string, zId: string): Promise<ZVerification> {
  const { data } = await api.get<ZVerification>(`/shops/${shopId}/local-shop-zs/${zId}/verification`);
  return data;
}

/**
 * "סגירה ע״י התמיכה" — the super admin's: a till part waiting or incomplete closes without
 * its missing documents. 409 `local_shop_z_part_not_pending` (with a Hebrew message) otherwise.
 */
export async function supportCloseLocalShopZTill(
  shopId: string,
  zId: string,
  machineId: string,
  note: string,
  /** The till's "late documents" part rather than its regular one (`?late=true`). */
  late = false,
): Promise<ZVerification> {
  const { data } = await api.post<ZVerification>(
    `/shops/${shopId}/local-shop-zs/${zId}/tills/${machineId}/close`,
    { note },
    late ? { params: { late: true } } : undefined,
  );
  return data;
}

/** 409 `request_not_pending` when it is no longer open. */
export async function cancelLocalShopZRequest(shopId: string): Promise<LocalShopZState> {
  const { data } = await api.delete<LocalShopZState>(`/shops/${shopId}/local-shop-z-request`);
  return data;
}
