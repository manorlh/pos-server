/**
 * "דוח X סניפי" (P:/specs/shop-x-report.md): the shop's interim X — the cloud's report and the 80 mm
 * print document the till prints (`GET /shops/{id}/shop-x`, server app/routers/till_shop_x.py).
 */
import { api } from './api';
import type { ShopXResponse } from './shopXPrint';

export * from './shopXPrint';

/**
 * The shop's interim X now; `refresh`: the shop's online tills are asked to send first (up to `shopXRefreshSec`).
 * `areaId`: one point of sale's tills only ("X לנקודת מכירה", P:/specs/chain-areas.md §11.2 d) — a manager of
 * points of sale must send it.
 */
export async function fetchShopXReport(shopId: string, refresh = false, areaId: string | null = null): Promise<ShopXResponse> {
  const params: Record<string, string | boolean> = {};
  if (refresh) params.refresh = true;
  if (areaId) params.areaId = areaId;
  const { data } = await api.get<ShopXResponse>(`/shops/${shopId}/shop-x`, { params });
  return data;
}
