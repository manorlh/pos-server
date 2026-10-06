/**
 * "קופות בזד הסניפי" — pos-server `GET/PUT /shops/{id}/z-participation`: which tills are in
 * the shop's Z and which are independent tills, and the shop's main till. The rules the
 * card applies are in lib/zParticipation.ts.
 */
import { api } from './api';
import type { ZParticipationBody, ZParticipationState } from './zParticipation';

export const zParticipationKey = (shopId: string) => ['z-participation', shopId] as const;

export async function fetchZParticipation(shopId: string): Promise<ZParticipationState> {
  const { data } = await api.get<ZParticipationState>(`/shops/${shopId}/z-participation`);
  return data;
}

/** All or nothing; answers with the same body as the GET. */
export async function saveZParticipation(shopId: string, body: ZParticipationBody): Promise<ZParticipationState> {
  const { data } = await api.put<ZParticipationState>(`/shops/${shopId}/z-participation`, body);
  return data;
}
