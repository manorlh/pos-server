/**
 * "דוח X סניפי" (P:/specs/shop-x-report.md): the shop's interim X — the cloud's report and the 80 mm
 * print document the till prints (`GET /shops/{id}/shop-x`, server app/routers/till_shop_x.py).
 */
import { api } from './api';
import type { ShopXResponse } from './shopXPrint';

export * from './shopXPrint';

/** The shop's interim X now; `refresh`: the shop's online tills are asked to send first (up to `shopXRefreshSec`). */
export async function fetchShopXReport(shopId: string, refresh = false): Promise<ShopXResponse> {
  const { data } = await api.get<ShopXResponse>(`/shops/${shopId}/shop-x`, { params: refresh ? { refresh: true } : {} });
  return data;
}
