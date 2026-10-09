/**
 * "קופות בזד הסניפי" — pos-server `GET/PUT /shops/{id}/z-participation`: which tills are in
 * the shop's Z and which are independent tills, and the shop's main till. And the shop Z's
 * one producer — `GET /shops/{id}/shop-z-producer`, the super admin's forced handover and
 * the conflicts support settles. The rules the cards apply are in lib/zParticipation.ts.
 */
import { api } from './api';
import type { ShopZProducerState, ZParticipationBody, ZParticipationState } from './zParticipation';

export const zParticipationKey = (shopId: string) => ['z-participation', shopId] as const;
export const shopZProducerKey = (shopId: string) => ['shop-z-producer', shopId] as const;

export async function fetchZParticipation(shopId: string): Promise<ZParticipationState> {
  const { data } = await api.get<ZParticipationState>(`/shops/${shopId}/z-participation`);
  return data;
}

/** All or nothing; answers with the same body as the GET. */
export async function saveZParticipation(shopId: string, body: ZParticipationBody): Promise<ZParticipationState> {
  const { data } = await api.put<ZParticipationState>(`/shops/${shopId}/z-participation`, body);
  return data;
}

export async function fetchShopZProducer(shopId: string): Promise<ShopZProducerState> {
  const { data } = await api.get<ShopZProducerState>(`/shops/${shopId}/shop-z-producer`);
  return data;
}

/** "העבר את הפקת ה-Z עכשיו" — the super admin's alone. */
export async function forceShopZHandover(shopId: string): Promise<ShopZProducerState> {
  const { data } = await api.post<ShopZProducerState>(`/shops/${shopId}/shop-z-producer/handover`);
  return data;
}

/** "סמן כטופל" — the Z stays as printed; its number does not change. */
export async function resolveShopZConflict(shopId: string, zId: string, note?: string): Promise<ShopZProducerState> {
  const { data } = await api.post<ShopZProducerState>(
    `/shops/${shopId}/shop-z-conflicts/${zId}/resolve`,
    note?.trim() ? { note: note.trim() } : {},
  );
  return data;
}
