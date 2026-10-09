'use client';

/**
 * The server features some cockpit entries depend on (`CockpitAction.feature`): stock locations
 * (`GET /stock/features`, STOCK_LOCATIONS_ENABLED — default off, feat/live-control). Asked only by a
 * user who may read the stock (the route's section); off until it answers, and off on any error.
 * Its own module: the registry's slots and the cockpit both read it, without an import cycle.
 */

import { useQuery } from '@tanstack/react-query';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { fetchStockFeatures } from '@/lib/stockLiveApi';
import type { CockpitFeature } from './types';

export function useCockpitFeatures(): Record<CockpitFeature, boolean> {
  const access = useDashboardAccess();
  const mayAsk = canAccess(access, 'stock', 'view');
  const stock = useQuery({
    queryKey: ['stock', 'features'],
    queryFn: fetchStockFeatures,
    enabled: mayAsk,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { stockLocations: mayAsk && stock.data?.locations === true };
}
