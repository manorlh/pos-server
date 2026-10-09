'use client';

/**
 * The Manager Cockpit's attention feed for "שליטה חיה": blocks in force ("אזל" / "חסום"), locked
 * tills, remote commands refused / failed / still waiting, and open low-stock alerts (transfer the
 * suggestion, update, block) — each with its actions (`actionId` + `context`, run by the cockpit
 * through the sheets or the API).
 */
import { useMemo } from 'react';
import { liveItemsFrom, type LiveItem } from '@/lib/liveControl';
import { lowStockItems } from '@/lib/stockLive';
import { useActiveBlocks, useTick } from './active-blocks';
import { useDevices } from './device-control-sheet';
import { useStockAlertsOf } from './board-strip';
import type { LiveControlScope } from './types';

export function useLiveControlItems(scope: LiveControlScope): { items: LiveItem[]; isLoading: boolean } {
  const blocks = useActiveBlocks(scope);
  const devices = useDevices(scope);
  const alerts = useStockAlertsOf(scope);
  const now = useTick(30_000);
  const items = useMemo(
    () => [...liveItemsFrom(blocks.data ?? [], devices.data ?? [], now), ...lowStockItems(alerts.data ?? [])],
    [blocks.data, devices.data, alerts.data, now],
  );
  return { items, isLoading: blocks.isPending || devices.isPending || alerts.isLoading };
}
