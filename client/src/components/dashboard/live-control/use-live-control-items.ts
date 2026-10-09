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

/** What to read: each part only for a user the server lets read it (all, by default). */
export interface LiveControlParts {
  blocks?: boolean;
  devices?: boolean;
  stock?: boolean;
}

export function useLiveControlItems(
  scope: LiveControlScope,
  parts: LiveControlParts = {},
): { items: LiveItem[]; isLoading: boolean } {
  const { blocks: readBlocks = true, devices: readDevices = true, stock: readStock = true } = parts;
  const blocks = useActiveBlocks(scope, undefined, readBlocks);
  const devices = useDevices(scope, readDevices);
  const alerts = useStockAlertsOf(scope, readStock);
  const now = useTick(30_000);
  const items = useMemo(
    () => [...liveItemsFrom(blocks.data ?? [], devices.data ?? [], now), ...lowStockItems(alerts.data ?? [])],
    [blocks.data, devices.data, alerts.data, now],
  );
  // A part not read is not loading (a disabled query stays "pending" forever).
  const loading = (readBlocks && blocks.isPending) || (readDevices && devices.isPending) || (readStock && alerts.isLoading);
  return { items, isLoading: loading };
}
