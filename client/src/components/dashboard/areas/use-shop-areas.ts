'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchShopAreas } from '@/lib/api';
import type { ShopArea } from '@/lib/types';

/**
 * A shop's areas. Keyed `['shop-areas', shopId, includeArchived]`, so invalidating
 * `['shop-areas', shopId]` refreshes both the live list and the one with archived areas.
 */
export function useShopAreas(shopId: string | null | undefined, includeArchived = false) {
  return useQuery<ShopArea[]>({
    queryKey: ['shop-areas', shopId ?? null, includeArchived],
    queryFn: () => fetchShopAreas(shopId!, includeArchived),
    enabled: !!shopId,
    // Areas change rarely; the lists and filters that read them do not need a refetch
    // on every mount.
    staleTime: 30_000,
  });
}
