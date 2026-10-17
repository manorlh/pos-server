/**
 * One settings layer below the organization (company, shop, point of sale, till): its own
 * settings and what it inherits (`includeEffective`), and its PATCH — what the preset discounts
 * page and the till design's preset picker read.
 */
import {
  fetchAreaSettings,
  fetchCompanySettings,
  fetchMachineSettings,
  fetchShopSettings,
  patchAreaSettings,
  patchCompanySettings,
  patchMachineSettings,
  patchShopSettings,
} from '@/lib/api';
import { readButtons, readPresets, resolveButtonIds, type PresetDiscount } from '@/lib/presetDiscounts';
import type { EffectiveSources, PosSettingsPatch, PosSettingsV1, SettingsLevel } from '@/lib/types';

export type LayerLevel = Exclude<SettingsLevel, 'tenant'>;

export interface LoadedLayer {
  settings: PosSettingsV1;
  settingsUpdatedAt?: string | null;
  effective?: PosSettingsV1;
  effectiveSources?: EffectiveSources | null;
}

export async function loadLayer(level: LayerLevel, id: string): Promise<LoadedLayer> {
  if (level === 'company') return fetchCompanySettings(id, true);
  if (level === 'shop') return fetchShopSettings(id, true);
  if (level === 'area') return fetchAreaSettings(id, true);
  return fetchMachineSettings(id, true);
}

export async function saveLayer(level: LayerLevel, id: string, patch: PosSettingsPatch) {
  if (level === 'company') return patchCompanySettings(id, patch);
  if (level === 'shop') return patchShopSettings(id, patch);
  if (level === 'area') return patchAreaSettings(id, patch);
  return patchMachineSettings(id, patch);
}

/** The presets in force at a layer (its own list, else the one it inherits) and the direct buttons' ids. */
export function presetsInForce(layer: LoadedLayer | undefined): { presets: PresetDiscount[]; buttonIds: string[] } {
  const presets = readPresets(layer?.settings?.presetDiscounts) ?? readPresets(layer?.effective?.presetDiscounts) ?? [];
  const buttons = readButtons(layer?.settings?.presetDiscountButtons) ?? readButtons(layer?.effective?.presetDiscountButtons);
  return { presets, buttonIds: resolveButtonIds(presets, buttons) };
}
