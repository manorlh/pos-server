/**
 * "שליטה חיה" API calls (pos-server app/routers/item_blocks.py, device_commands.py, kiosk_live.py).
 */
import { api } from '@/lib/api';
import type { BlockKind, BlockScope, DeviceAction, DeviceRow, DurationChoice, ItemBlock } from '@/lib/liveControl';

export interface BlockTargets {
  company: { id: string; name: string } | null;
  shop: { id: string; name: string };
  areas: { id: string; name: string }[];
  tills: { id: string; name: string; posNumber?: string | null; areaId?: string | null }[];
  kiosks: { id: string; name: string; posNumber?: string | null; areaId?: string | null }[];
  events: { id: string; name: string; startsAt: string; endsAt: string }[];
  groupsAvailable: boolean;
  /** Device groups with a till in the shop that this user may target (app/services/device_groups.py). */
  groups: { id: string; name: string; machines?: number; acrossShops?: boolean }[];
  timezone: string;
  businessDayStart: string;
  presets: number[];
  extendBy: number[];
}

export interface BlockScopeIds {
  companyId?: string | null;
  shopId?: string | null;
  productId?: string | null;
}

export const liveKeys = {
  blocks: (s: BlockScopeIds) => ['item-blocks', s.companyId ?? null, s.shopId ?? null, s.productId ?? null] as const,
  targets: (shopId: string) => ['item-blocks', 'targets', shopId] as const,
  devices: (s: { companyId?: string | null; shopId?: string | null }) => ['device-commands', 'devices', s.companyId ?? null, s.shopId ?? null] as const,
  kiosks: (s: { companyId?: string | null; shopId?: string | null }) => ['kiosks', 'live', s.companyId ?? null, s.shopId ?? null] as const,
};

export async function fetchBlocks(s: BlockScopeIds, includeEnded = false): Promise<ItemBlock[]> {
  const params: Record<string, string> = {};
  if (s.companyId) params.companyId = s.companyId;
  if (s.shopId) params.shopId = s.shopId;
  if (s.productId) params.productId = s.productId;
  if (includeEnded) params.includeEnded = 'true';
  return (await api.get('/item-blocks', { params })).data;
}

export async function fetchBlockTargets(shopId: string): Promise<BlockTargets> {
  return (await api.get('/item-blocks/targets', { params: { shopId } })).data;
}

export async function previewEnd(choice: DurationChoice, shopId?: string | null): Promise<{ until: string | null; rolled: boolean }> {
  return (await api.post('/item-blocks/end-preview', { ...choice, shopId: shopId ?? undefined })).data;
}

export async function createBlocks(body: {
  productId: string;
  kind: BlockKind;
  note?: string;
  targets: { scope: BlockScope; scopeId: string }[];
  duration: DurationChoice;
}): Promise<{ blocks: ItemBlock[]; until: string | null; rolled: boolean }> {
  return (await api.post('/item-blocks', body)).data;
}

export async function extendBlock(id: string, minutes: number): Promise<ItemBlock> {
  return (await api.post(`/item-blocks/${id}/extend`, { minutes })).data;
}

export async function clearBlock(id: string): Promise<ItemBlock> {
  return (await api.delete(`/item-blocks/${id}`)).data;
}

export async function clearProductBlocks(productId: string, shopId?: string | null): Promise<{ cleared: number }> {
  return (await api.post('/item-blocks/clear', { productId, shopId: shopId ?? undefined })).data;
}

// ── Devices ──────────────────────────────────────────────────────────────────

/** What of remote control is on (`remoteTillZ`: the server's REMOTE_TILL_Z_ENABLED). */
export async function fetchDeviceFeatures(): Promise<{ remoteTillZ: boolean }> {
  return (await api.get('/device-commands/features')).data;
}

/** "סגירת משמרת / הפקת Z מרחוק": what the manager confirms (lib/remoteTillZ.ts). */
export async function fetchClosePreview(machineId: string): Promise<import('@/lib/remoteTillZ').RemoteClosePreview> {
  return (await api.get(`/device-commands/${machineId}/close-preview`)).data;
}

/** The confirmed close / Z: refused (409 totals_changed) when the till's totals moved since. */
export async function requestRemoteClose(machineId: string, totalsKey: string) {
  return (await api.post('/device-commands/close', { machineId, totalsKey })).data as { kind: string; created: boolean };
}

/** "סגירת יום סניפית": the shop by its configuration, the run under way (lib/remoteShopClose.ts). */
export async function fetchShopClosePreview(shopId: string, areaId?: string | null): Promise<import('@/lib/remoteShopClose').ShopClosePreview> {
  return (await api.get('/device-commands/shop-close-preview', { params: areaId ? { shopId, areaId } : { shopId } })).data;
}

/** The points of sale this user may close: all for the shop's manager, their own for an area's manager. */
export async function fetchAreaCloseList(shopId: string): Promise<import('@/lib/remoteShopClose').AreaCloseList> {
  return (await api.get('/device-commands/area-close-list', { params: { shopId } })).data;
}

/** "סגירת משמרות לנקודת מכירה": each till of the area as its own remote close shows it. */
export async function fetchAreaShiftPreview(shopId: string, areaId: string): Promise<import('@/lib/remoteShopClose').AreaShiftPreview> {
  return (await api.get('/device-commands/area-shift-close-preview', { params: { shopId, areaId } })).data;
}

/** Each confirmed till its own remote shift close; per-till results (one failing never stops the others). */
export async function requestAreaShiftClose(body: { shopId: string; areaId: string; totalsKeys: Record<string, string> }) {
  return (await api.post('/device-commands/area-shift-close', body)).data as {
    results: { machineId: string; ok: boolean; code?: string; message?: string }[];
  };
}

/** The confirmed day close: sent at once — each till closes at rest; progress in the preview. */
export async function requestShopClose(body: {
  shopId: string;
  totalsKey: string;
  confirmOpenTills?: boolean;
  confirmCloudData?: boolean;
  /** A super admin starting past tills in "מצב לא ידוע". */
  forceReason?: string;
  /** A super admin starting past cloud card refunds whose credit note the Z would go without. */
  forceCloudRefundReason?: string;
  /** "סגירת יום לנקודת מכירה": that point of sale's area Z. */
  areaId?: string;
}) {
  return (await api.post('/device-commands/shop-close', body)).data as import('@/lib/remoteShopClose').ShopCloseRun;
}

/** One day close's progress / outcome ("הושלם — Z סניפי מס' 42"), after it left the preview. */
export async function fetchShopCloseRun(runId: string) {
  return (await api.get(`/device-commands/shop-close/${runId}`)).data as import('@/lib/remoteShopClose').ShopCloseRun;
}

export async function cancelShopClose(runId: string) {
  return (await api.post(`/device-commands/shop-close/${runId}/cancel`)).data as import('@/lib/remoteShopClose').ShopCloseRun;
}

/** "בנה בלי": the existing build-without, refused where the configuration needs every till. */
export async function proceedShopClose(runId: string, excludeMachineIds: string[]) {
  return (await api.post(`/device-commands/shop-close/${runId}/proceed`, { excludeMachineIds })).data as import('@/lib/remoteShopClose').ShopCloseRun;
}

/** Support's force past "חסימת Z כשיש משמרות פתוחות": a super admin, a typed reason (403 / 422 otherwise). */
export async function forceShopClose(runId: string, excludeMachineIds: string[], reason: string) {
  return (await api.post(`/device-commands/shop-close/${runId}/force`, { excludeMachineIds, reason })).data as import('@/lib/remoteShopClose').ShopCloseRun;
}

/** Support's force past "זיכוי באשראי מהענן — חובה לפני ה-Z הבא" while the day close waits (a typed reason). */
export async function forceShopCloseCloudRefunds(runId: string, reason: string) {
  return (await api.post(`/device-commands/shop-close/${runId}/force-cloud-refunds`, { reason })).data as import('@/lib/remoteShopClose').ShopCloseRun;
}

/** "סגור והשאר מושהות" (pos-server held_sales_close.py): the shop's parameter, or support with a reason. */
export async function keepHeldSales(body: { machineId: string; runId?: string; reason?: string }) {
  return (await api.post('/device-commands/keep-held-sales', body)).data;
}

/** "בטל מכירות מושהות וסגור": exactly the listed sales, with a reason. */
export async function cancelHeldSales(body: { machineId: string; runId?: string; saleIds: string[]; reason: string }) {
  return (await api.post('/device-commands/cancel-held-sales', body)).data;
}

export async function fetchDevices(s: { companyId?: string | null; shopId?: string | null; machineIds?: string[] }): Promise<DeviceRow[]> {
  const params = new URLSearchParams();
  if (s.companyId) params.set('companyId', s.companyId);
  if (s.shopId) params.set('shopId', s.shopId);
  for (const id of s.machineIds ?? []) params.append('machineIds', id);
  return (await api.get(`/device-commands/devices?${params.toString()}`)).data;
}

export async function sendDeviceCommand(body: {
  action: DeviceAction;
  message?: string;
  machineIds?: string[];
  shopId?: string;
}): Promise<{ id: string; machineId: string; status: string }[]> {
  return (await api.post('/device-commands', body)).data;
}

export async function cancelDeviceCommand(id: string) {
  return (await api.post(`/device-commands/${id}/cancel`)).data;
}

// ── Kiosks ───────────────────────────────────────────────────────────────────

export interface KioskLiveRow {
  machineId: string;
  name: string;
  shopId: string | null;
  shopName: string | null;
  online: boolean;
  enabled: boolean;
  paused: boolean;
  pauseMessage: string | null;
  pausedUntil: string | null;
  pausedBy: string | null;
  flowState: string | null;
  ordersToday: number;
  salesTodayAgorot: number;
  lastSeenAt: string | null;
  banner: { message: string; until: string | null; by: string | null; since: string | null } | null;
}

export interface KioskHide {
  id: string;
  shopId: string;
  kind: 'product' | 'category';
  itemId: string;
  itemName: string | null;
  until: string | null;
  secondsLeft: number | null;
  note: string | null;
  by: string | null;
}

export async function fetchKioskLive(s: { companyId?: string | null; shopId?: string | null }): Promise<{ kiosks: KioskLiveRow[]; hides: KioskHide[] }> {
  const params: Record<string, string> = {};
  if (s.companyId) params.companyId = s.companyId;
  if (s.shopId) params.shopId = s.shopId;
  return (await api.get('/kiosks/live', { params })).data;
}

export async function kioskCommand(machineId: string, body: { action: 'pause' | 'resume'; message?: string; untilMode?: string; untilTime?: string; minutes?: number }) {
  return (await api.post(`/kiosks/${machineId}/commands`, body)).data;
}

export async function setKioskBanner(machineId: string, message: string, duration: DurationChoice) {
  return (await api.put(`/kiosks/${machineId}/banner`, { message, duration })).data;
}

export async function clearKioskBanner(machineId: string) {
  return (await api.delete(`/kiosks/${machineId}/banner`)).data;
}

export async function createKioskHide(body: { shopId: string; kind: 'product' | 'category'; itemId: string; duration: DurationChoice; note?: string }) {
  return (await api.post('/kiosks/live/hides', body)).data as KioskHide & { rolled: boolean };
}

export async function extendKioskHide(id: string, minutes: number) {
  return (await api.post(`/kiosks/live/hides/${id}/extend`, { minutes })).data as KioskHide;
}

export async function clearKioskHide(id: string) {
  return (await api.delete(`/kiosks/live/hides/${id}`)).data as KioskHide;
}
