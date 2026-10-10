/**
 * "שעת סיום יום עסקי" of a scope and its business "today" — server `GET /reports/business-day`
 * (app/routers/reports.py, app/services/business_day.py). The rule itself is lib/businessDay.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface BusinessDayInfo {
  /** 0–12: a sale before this hour belongs to the day before. */
  endHour: number;
  /** The business day it is now, "YYYY-MM-DD". */
  today: string;
  timezone: string;
}

export interface BusinessDayScope {
  companyId?: string;
  shopId?: string;
  areaId?: string;
  machineId?: string;
}

export async function fetchBusinessDay(scope: BusinessDayScope): Promise<BusinessDayInfo> {
  const { data } = await api.get<BusinessDayInfo>('/reports/business-day', { params: scope });
  return data;
}

/** The scope's end hour and today — cached a few minutes; the hour rarely changes. */
export function useBusinessDay(scope: BusinessDayScope) {
  return useQuery<BusinessDayInfo>({
    queryKey: ['business-day', scope.companyId ?? null, scope.shopId ?? null, scope.areaId ?? null, scope.machineId ?? null],
    queryFn: () => fetchBusinessDay(scope),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
