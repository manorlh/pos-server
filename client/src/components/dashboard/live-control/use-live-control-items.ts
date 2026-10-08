'use client';

/**
 * The Manager Cockpit's attention feed for "שליטה חיה": blocks in force ("אזל" / "חסום"), locked
 * tills, and remote commands refused / failed / still waiting — each with its actions
 * (`actionId` + `context`, run by the cockpit through the sheets or the API).
 * Low stock joins it with the stock locations (Saturday).
 */
import { useMemo } from 'react';
import { liveItemsFrom, type LiveItem } from '@/lib/liveControl';
import { useActiveBlocks, useTick } from './active-blocks';
import { useDevices } from './device-control-sheet';
import type { LiveControlScope } from './types';

export function useLiveControlItems(scope: LiveControlScope): { items: LiveItem[]; isLoading: boolean } {
  const blocks = useActiveBlocks(scope);
  const devices = useDevices(scope);
  const now = useTick(30_000);
  const items = useMemo(
    () => liveItemsFrom(blocks.data ?? [], devices.data ?? [], now),
    [blocks.data, devices.data, now],
  );
  return { items, isLoading: blocks.isPending || devices.isPending };
}
