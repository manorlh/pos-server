/**
 * The requests of "ביצועי קיוסקים" and "תקינות מכשירים" (pos-server app/routers/kiosk_insights.py).
 * The types and the pure rules are in lib/kioskInsights.ts (compiled alone by `npm test`).
 */
import { api } from './api';
import type { KioskHealthDetail, KioskInsightsParams, KioskInsightsReport, KiosksHealth } from './kioskInsights';

/** `GET /insights/kiosks` — the insights' scope and period, `kioskId` for one kiosk. */
export const fetchKioskInsights = (params: KioskInsightsParams) =>
  api.get<KioskInsightsReport>('/insights/kiosks', { params }).then((r) => r.data);

/** `GET /kiosks/health` — every kiosk in scope (as `GET /kiosks`), its parts and alerts. */
export async function fetchKiosksHealth(params: { companyId?: string | null; shopId?: string | null } = {}): Promise<KiosksHealth> {
  const { data } = await api.get<KiosksHealth>('/kiosks/health', {
    params: {
      ...(params.companyId ? { companyId: params.companyId } : {}),
      ...(params.shopId ? { shopId: params.shopId } : {}),
    },
  });
  return data;
}

/** `GET /kiosks/{id}/health` — one kiosk with its last events and sessions. */
export const fetchKioskHealth = (machineId: string) =>
  api.get<KioskHealthDetail>(`/kiosks/${encodeURIComponent(machineId)}/health`).then((r) => r.data);
