/**
 * "תחזית ואיוש" — the API call (pos-server app/routers/forecast_staffing.py). Types and pure
 * rules live in `lib/staffing.ts`.
 */
import { api } from './api';
import type { StaffingReport } from './staffing';

export interface StaffingScope {
  companyId?: string | null;
  shopId?: string | null;
  areaId?: string | null;
  machineId?: string | null;
}

export async function fetchStaffing(scope: StaffingScope): Promise<StaffingReport> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(scope)) if (v) params[k] = v;
  const { data } = await api.get<StaffingReport>('/insights/staffing', { params });
  return data;
}
