/**
 * "עובדים על" — the point of sale in the dashboard's top-bar scope (P:/specs/chain-areas.md §2-§3).
 *
 * Pure rules, so they are tested on their own (areaScope.test.ts):
 * - a manager of points of sale (`access.areaIds`) is held to their points of sale: no "כל הנקודות", no other
 *   shop; a choice outside them moves to their first one;
 * - the scope saved on the server (`preferences.dashboardScope[tenantId]`) is read defensively.
 */
import type { ScopeSelection } from './types';

export interface AreaReachArea {
  id: string;
  name: string;
  shopId: string;
}

export interface AreaReach {
  areaIds?: string[];
  areas?: AreaReachArea[];
}

export type SavedScopes = Record<string, Partial<ScopeSelection>>;

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The user is held to some points of sale. */
export function isAreaNarrowed(reach: AreaReach | null | undefined): boolean {
  return !!reach && Array.isArray(reach.areaIds) && reach.areaIds.length > 0;
}

/**
 * The selection a manager of points of sale may have: theirs as is, else their first point of sale (in the shop
 * already chosen when it holds one). `null` — nothing to change (not narrowed, or already inside).
 */
export function clampToAreaReach(selection: ScopeSelection, reach: AreaReach | null | undefined): ScopeSelection | null {
  if (!isAreaNarrowed(reach)) return null;
  const areas = (reach?.areas ?? []).filter((a) => (reach?.areaIds ?? []).some((id) => same(id, a.id)));
  if (!areas.length) return null;
  const current = areas.find((a) => same(a.id, selection.areaId ?? null));
  if (current && same(current.shopId, selection.shopId)) return null;
  const inShop = areas.find((a) => same(a.shopId, selection.shopId));
  const target = inShop ?? areas[0];
  return {
    companyId: same(target.shopId, selection.shopId) ? selection.companyId : null,
    shopId: target.shopId,
    machineId: null,
    areaId: target.id,
  };
}

/** The points of sale a manager may pick in this shop (all of the shop's for everyone else). */
export function areaOptionsFor<T extends { id: string }>(areas: T[], reach: AreaReach | null | undefined): T[] {
  if (!isAreaNarrowed(reach)) return areas;
  return areas.filter((a) => (reach?.areaIds ?? []).some((id) => same(id, a.id)));
}

/** "כל הנקודות" is offered only to whoever reaches the whole shop. */
export function mayPickWholeShop(reach: AreaReach | null | undefined): boolean {
  return !isAreaNarrowed(reach);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One organization's saved scope (`preferences.dashboardScope[tenantId]`), anything malformed dropped. */
export function savedScopeFor(saved: unknown, tenantId: string | null): ScopeSelection | null {
  if (!tenantId || !saved || typeof saved !== 'object') return null;
  const entry = (saved as Record<string, unknown>)[tenantId] ?? (saved as Record<string, unknown>)[tenantId.toLowerCase()];
  if (!entry || typeof entry !== 'object') return null;
  const pick = (k: string): string | null => {
    const v = (entry as Record<string, unknown>)[k];
    return typeof v === 'string' && UUID_RE.test(v) ? v : null;
  };
  const out: ScopeSelection = {
    companyId: pick('companyId'),
    shopId: pick('shopId'),
    machineId: pick('machineId'),
    areaId: pick('areaId'),
  };
  // A point of sale only with its shop: one on its own says nothing.
  if (!out.shopId) out.areaId = null;
  if (!out.companyId && !out.shopId && !out.machineId) return null;
  return out;
}

/** The patch `PUT /users/me/preferences` takes for one organization's scope (null — forget it). */
export function scopePatch(tenantId: string, selection: ScopeSelection): { dashboardScope: Record<string, Record<string, string> | null> } {
  const entry: Record<string, string> = {};
  if (selection.companyId) entry.companyId = selection.companyId;
  if (selection.shopId) entry.shopId = selection.shopId;
  if (selection.machineId) entry.machineId = selection.machineId;
  if (selection.shopId && selection.areaId) entry.areaId = selection.areaId;
  return { dashboardScope: { [tenantId]: Object.keys(entry).length ? entry : null } };
}

/** "עובדים על: <רשת> › <סניף> › <נקודה>" — the chip's text. */
export function workingOnLabel(parts: Array<string | null | undefined>, allAreasLabel: string, hasAreas: boolean, areaName?: string | null): string {
  const names = parts.filter((p): p is string => !!p && p.trim().length > 0);
  if (hasAreas) names.push(areaName || allAreasLabel);
  return names.join(' › ');
}
