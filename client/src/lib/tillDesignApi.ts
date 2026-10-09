/**
 * "עיצוב קופה" — pos-server app/routers/till_design.py, the dashboard side: the defaults and
 * the vocabularies, one level's layer (company → shop → point of sale → till) with what it
 * inherits and the till parameters' "auto" values, the save (422 `invalid_till_design`), the
 * shop's points of sale and tills for the level pickers, and what a till sells (the menu editor
 * and the live preview).
 */
import { api } from './api';
import { dietaryTagsOf } from './kioskConfig';
import type { KioskSourceCatalog, KioskSourceCategory } from './kioskApi';
import type { TillDesignConfig, TillDesignIssue, TillDesignLayer, TillDesignLegacy } from './tillDesign';

export type TillDesignLevel = 'company' | 'shop' | 'area' | 'machine';

export interface TillDesignDefaults {
  defaults: TillDesignConfig;
  /** `till_design.catalog()`: templates, profiles, the template table, actions, labels, vocabularies. */
  catalog: Record<string, unknown>;
}

export interface TillDesignSettings {
  level: TillDesignLevel;
  id: string;
  /** This level's own layer, as stored (sanitised). */
  overrides: TillDesignLayer;
  /** DEFAULTS ⊕ the layers above this level. */
  inherited: TillDesignConfig;
  /** The layers above, merged over nothing: only what they set explicitly. */
  inheritedLayers: TillDesignLayer;
  /** What this level has now: inherited ⊕ overrides. */
  effective: TillDesignConfig;
  configVersion: string;
  /** The "auto" values as the till parameters set them at this level. */
  legacy: TillDesignLegacy;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByUserId: string | null;
}

export interface TillDesignTargets {
  areas: Array<{ id: string; name: string }>;
  machines: Array<{ id: string; name: string; areaId: string | null; areaName: string | null; deviceModel: string | null }>;
}

export async function fetchTillDesignDefaults(): Promise<TillDesignDefaults> {
  const { data } = await api.get<TillDesignDefaults>('/till-design/defaults');
  return data;
}

export async function fetchTillDesignSettings(level: TillDesignLevel, id: string): Promise<TillDesignSettings> {
  const { data } = await api.get<TillDesignSettings>('/till-design/settings', { params: { level, id } });
  return data;
}

/** Replaces the level's layer with `overrides` (the minimal one: what differs from what it inherits). */
export async function saveTillDesignSettings(level: TillDesignLevel, id: string, overrides: TillDesignLayer): Promise<TillDesignSettings> {
  const { data } = await api.put<TillDesignSettings>('/till-design/settings', { overrides }, { params: { level, id } });
  return data;
}

export async function fetchTillDesignTargets(shopId: string): Promise<TillDesignTargets> {
  const { data } = await api.get<TillDesignTargets>('/till-design/targets', { params: { shopId } });
  return {
    areas: Array.isArray(data?.areas) ? data.areas : [],
    machines: Array.isArray(data?.machines) ? data.machines : [],
  };
}

/** A refused save's errors: `422 { detail: { code: "invalid_till_design", errors: [{path, code, message}] } }`. */
export function tillDesignErrors(err: unknown): TillDesignIssue[] | null {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  const detail = res?.data?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const d = detail as { code?: unknown; errors?: unknown };
  if (d.code !== 'invalid_till_design' || !Array.isArray(d.errors)) return null;
  return d.errors
    .filter((x): x is { path?: unknown; code?: unknown; message?: unknown } => !!x && typeof x === 'object')
    .map((x) => ({ path: String(x.path ?? ''), code: String(x.code ?? ''), message: String(x.message ?? '') }));
}

/**
 * What a till sells (`GET /machines/{id}/catalog`, the same call as the kiosk editor's
 * fetchKioskSourceCatalog): the products on its sell screen — "קיוסק בלבד" left out, as the
 * till leaves it out (the kiosk's call leaves out "קופות בלבד" instead) — and the categories, in
 * the till's own order. The menu editor orders and hides on top of it; the preview renders it.
 */
export async function fetchTillCatalog(machineId: string): Promise<KioskSourceCatalog> {
  const { data } = await api.get<{
    machineId: string;
    machineName: string;
    products?: Array<{
      productId: string;
      name: string;
      price: number;
      categoryId: string | null;
      imageUrl: string | null;
      available: boolean;
      onTill: boolean;
      salesChannel?: string;
      description?: string | null;
      dietaryTags?: unknown;
    }>;
    categories?: KioskSourceCategory[];
  }>(`/machines/${machineId}/catalog`);
  const categories = (data.categories ?? [])
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'he'));
  return {
    machineId: String(data.machineId),
    machineName: data.machineName,
    categories: categories.map((c) => ({ id: String(c.id), name: c.name, sortOrder: c.sortOrder ?? 0 })),
    products: (data.products ?? [])
      .filter((p) => p.onTill !== false && p.salesChannel !== 'kiosk_only')
      .map((p) => ({
        id: String(p.productId),
        name: p.name,
        price: Number(p.price) || 0,
        categoryId: p.categoryId ? String(p.categoryId) : null,
        imageUrl: p.imageUrl ?? null,
        available: p.available !== false,
        description: typeof p.description === 'string' && p.description.trim() ? p.description : null,
        dietaryTags: dietaryTagsOf(p.dietaryTags),
      })),
  };
}
