/**
 * "חסימות מהקופה" and "חסימה מהירה" — the server's routes (pos-server app/routers/item_blocks.py;
 * P:/specs/item-block-control.md). The rules and the Hebrew: lib/itemBlockControl.ts.
 */
import { api } from '@/lib/api';
import type {
  ControlLevel,
  ControlView,
  ItemBlocksSettings,
  ManagingPick,
  QuickItem,
  QuickList,
  QuickState,
  QuickDefaults,
} from '@/lib/itemBlockControl';
import { managingBody } from '@/lib/itemBlockControl';

export const itemBlockControlKeys = {
  all: ['item-block-control'] as const,
  level: (level: ControlLevel, id: string) => ['item-block-control', level, id] as const,
  quick: (shopId: string, q: string) => ['item-blocks', 'quick', shopId, q] as const,
};

export async function fetchControl(level: ControlLevel, id: string): Promise<ControlView> {
  return (await api.get('/item-blocks/control', { params: { level, id } })).data;
}

/** The level's own `itemBlocks`, the whole of it (null: inherit everything). */
export async function saveControl(level: ControlLevel, id: string, values: ItemBlocksSettings | null): Promise<ControlView> {
  return (await api.put('/item-blocks/control', { level, id, values })).data;
}

/** "קופה מנהלת": several tills or all of them, for a shop or one of its points of sale. */
export async function saveManaging(shopId: string, areaId: string | null, pick: ManagingPick): Promise<ControlView> {
  return (await api.put('/item-blocks/control/managing', managingBody(shopId, areaId, pick))).data;
}

/** The till card's switch "קופה מנהלת לחסימות". */
export async function setMachineManaging(machineId: string, managing: boolean): Promise<ControlView> {
  return (await api.post(`/item-blocks/control/machines/${machineId}/managing`, { managing })).data;
}

export async function fetchQuick(shopId: string, q: string): Promise<QuickList> {
  return (await api.get('/item-blocks/quick', { params: { shopId, q: q || undefined } })).data;
}

export async function postQuick(body: { productId: string; shopId: string; state: QuickState }): Promise<{
  item: QuickItem | null;
  quickDefaults: QuickDefaults;
}> {
  return (await api.post('/item-blocks/quick', body)).data;
}
