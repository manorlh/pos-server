/**
 * "מסופונים — מצב לא מקוון" — the server's routes (pos-server app/routers/deferred_terminals.py;
 * P:/specs/nayax-deferred-all.md §9, §10). The shapes and the Hebrew: lib/deferredTerminals.ts.
 */
import { api } from '@/lib/api';
import type { DeferredShopView, DeviceDeferredView, SwitchResult } from '@/lib/deferredTerminals';

export const deferredTerminalsKeys = {
  all: ['deferred-terminals'] as const,
  shop: (shopId: string) => ['deferred-terminals', 'shop', shopId] as const,
  device: (machineId: string) => ['deferred-terminals', 'device', machineId] as const,
};

/** The shop's tills with their terminal, its mode and the last command; the settings and the controllers. */
export async function fetchDeferredTerminals(shopId: string): Promise<DeferredShopView> {
  return (await api.get(`/shops/${shopId}/deferred-terminals`)).data;
}

/** "העבר הכל ללא מקוון" / "החזר הכל למקוון" (no ids), or one till's switch. */
export async function switchDeferred(shopId: string, on: boolean, machineIds?: string[]): Promise<SwitchResult> {
  return (await api.post(`/shops/${shopId}/deferred-terminals/switch`, { on, ...(machineIds ? { machineIds } : {}) })).data;
}

/** "קופה מנהלת מצב לא מקוון": the till in / out of the shop's own `deferredControlTills`. */
export async function setDeferredController(
  shopId: string,
  machineId: string,
  on: boolean,
): Promise<DeferredShopView & { changed: boolean }> {
  return (await api.put(`/shops/${shopId}/deferred-terminals/controllers`, { machineId, on })).data;
}

/** The device page's card: "קופה מנהלת" and the till's own auto-on values (§10). */
export async function fetchDeviceDeferred(machineId: string): Promise<DeviceDeferredView> {
  return (await api.get(`/machines/${machineId}/deferred-settings`)).data;
}

/** The till's own values (null: inherit again). */
export async function saveDeviceDeferred(
  machineId: string,
  values: Record<string, string | number | boolean | null>,
): Promise<DeviceDeferredView & { changed: string[] }> {
  return (await api.put(`/machines/${machineId}/deferred-settings`, { values })).data;
}
