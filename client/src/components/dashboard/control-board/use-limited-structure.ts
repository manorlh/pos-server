'use client';

/**
 * The board's tree for a user without "דוחות": company › shop › point of sale › till from
 * the look-ups the scope provider already holds (lib/boardStructure.ts), money at zero (and
 * hidden by the board). Empty when not needed — the overview is the structure then.
 */

import { useMemo } from 'react';
import { useScope } from '@/lib/scope';
import { structureTree } from '@/lib/boardStructure';
import type { OverviewCompany } from '@/lib/types';

const NONE: OverviewCompany[] = [];

export function useLimitedStructure(
  enabled: boolean,
  shopId: string | null,
  machineId: string | null,
  areas: { id: string; name: string }[],
): OverviewCompany[] {
  const { companies, shops, machines, shopOptions } = useScope();
  return useMemo(
    () =>
      enabled
        ? (structureTree({
            companies,
            shops,
            machines,
            shopIds: shopId ? [shopId] : shopOptions.map((s) => s.id),
            machineId,
            areas: shopId ? { shopId, list: areas } : null,
          }) as OverviewCompany[])
        : NONE,
    [areas, companies, enabled, machineId, machines, shopId, shopOptions, shops],
  );
}
