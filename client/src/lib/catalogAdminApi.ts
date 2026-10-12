/**
 * "ניהול קטלוג מהקופה" — the four till parameters at one level (pos-server
 * app/routers/till_parameters.py, super admin only): read, set / clear, and "שחזר ברירת מחדל"
 * (`POST /till-parameters/reset`). The pure helpers are lib/catalogAdmin.ts.
 */
import { api } from './api';
import type { CatalogAdminLevel } from './catalogAdmin';

export interface CatalogAdminParam {
  key: string;
  label: string;
  description: string | null;
  valueType: 'boolean' | 'integer' | 'decimal' | 'string' | 'enum';
  enumOptions: string[] | null;
  defaultValue: unknown;
}

export interface CatalogAdminLevelView {
  scopeType: CatalogAdminLevel;
  scopeId: string;
  /** What this level sets itself. */
  own: Record<string, unknown>;
  /** What it gets from the levels above (or the default). */
  inherited: Record<string, unknown>;
  parameters: CatalogAdminParam[];
}

export async function fetchCatalogAdminLevel(level: CatalogAdminLevel, id: string): Promise<CatalogAdminLevelView> {
  return (await api.get<CatalogAdminLevelView>('/till-parameters/catalog-admin', { params: { level, id } })).data;
}

export async function saveCatalogAdminLevel(
  level: CatalogAdminLevel,
  id: string,
  values: Record<string, unknown>,
): Promise<CatalogAdminLevelView> {
  return (await api.put<CatalogAdminLevelView>('/till-parameters/catalog-admin', { level, id, values })).data;
}

export async function resetTillParameters(level: CatalogAdminLevel, id: string, keys: string[]): Promise<{ cleared: string[] }> {
  return (await api.post<{ cleared: string[] }>('/till-parameters/reset', { level, id, keys })).data;
}
