/**
 * "סוג עוסק" — the year's turnover of a company against the exempt dealer's ceiling, and
 * the ceiling itself, a platform setting (docs/SPEC_BUSINESS_TYPE.md). The company's own
 * type travels on the company row (`dealerType`, `PUT /companies/{id}`).
 *
 * The shapes and the rules on them live in lib/dealerType.ts.
 */
import { api } from './api';
import type { DealerTurnover, DealerTypeSettings } from './dealerType';

export type { DealerTurnover, DealerTypeSettings } from './dealerType';

export async function fetchDealerTurnover(companyId: string, year?: number): Promise<DealerTurnover> {
  const { data } = await api.get<DealerTurnover>(`/companies/${companyId}/dealer-turnover`, {
    params: year ? { year } : undefined,
  });
  return data;
}

export async function fetchDealerTypeSettings(): Promise<DealerTypeSettings> {
  const { data } = await api.get<DealerTypeSettings>('/system/dealer-types');
  return data;
}

/** The super admin's only. */
export async function saveDealerTypeSettings(body: DealerTypeSettings): Promise<DealerTypeSettings> {
  const { data } = await api.put<DealerTypeSettings>('/system/dealer-types', body);
  return data;
}
