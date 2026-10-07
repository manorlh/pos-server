/**
 * "תצורת עבודה למכשיר" — pos-server app/routers/work_config.py (docs/SPEC_DEVICE_WORK_CONFIG.md).
 * The rules and the Hebrew are lib/workConfig.ts.
 */
import { api } from './api';
import type { WorkConfigView } from './workConfig';

export const machineWorkConfigKey = (machineId: string) => ['work-config', 'machine', machineId] as const;
export const shopWorkConfigKey = (shopId: string, role: string, platform: string) =>
  ['work-config', 'shop', shopId, role, platform] as const;

export async function fetchMachineWorkConfig(machineId: string): Promise<WorkConfigView> {
  const { data } = await api.get<WorkConfigView>(`/machines/${machineId}/work-config`);
  return data;
}

/** What a new device of this role gets in the shop, and the presets — the add-device step. */
export async function fetchShopWorkConfig(shopId: string, role: string, platform: string): Promise<WorkConfigView> {
  const { data } = await api.get<WorkConfigView>(`/shops/${shopId}/work-config`, { params: { role, platform } });
  return data;
}

export async function saveMachineWorkConfig(
  machineId: string,
  plan: Record<string, unknown>,
  forceProducerSwitch = false,
): Promise<WorkConfigView> {
  const { data } = await api.put<WorkConfigView>(`/machines/${machineId}/work-config`, {
    ...plan,
    ...(forceProducerSwitch ? { forceProducerSwitch: true } : {}),
  });
  return data;
}
