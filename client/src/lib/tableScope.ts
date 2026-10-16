/**
 * "תחום שולחנות" (P:/specs/table-scope.md §2, §3, §4, §14.9): the dashboard's pure pieces of a device's and an
 * employee's table scope — what the picker holds, its toggles in the tree (a zone, and in it its tables), what a
 * scope covers on the floor, the ids still there, and whether two scopes share a table (the employee card's
 * "התחום של המכשיר והתחום של העובד לא חופפים").
 *
 * A scope is `{zoneIds, tableIds}`; `null` is "כל השולחנות" (no scope, the default). A zone in it covers its
 * tables, those added later too; an empty scope sees nothing (§14.1).
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export interface TableScope {
  zoneIds: string[];
  tableIds: string[];
}

/** A table of the picker's tree (`GET /machines/{id}/table-scope`, `…/pos-users/table-scope-tree`). */
export interface ScopeTreeTable {
  id: string;
  number: number;
  label?: string | null;
  name?: string | null;
  /** "12", "3B · VIP", "ש-12" — the server's `table_title`. */
  title: string;
}

/** A zone of the tree, with its tables in the natural order. */
export interface ScopeTreeZone {
  id: string;
  name: string;
  areaId: string | null;
  areaName: string | null;
  tables: ScopeTreeTable[];
}

const ids = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
};

/** A served scope as the picker holds it: `{zoneIds, tableIds}`, or null (every table). */
export function scopeOf(value: unknown): TableScope | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { zoneIds?: unknown; tableIds?: unknown };
  return { zoneIds: ids(v.zoneIds), tableIds: ids(v.tableIds) };
}

/**
 * Only what the tree still has: an archived zone or table (or one the device no longer sees) is dropped — the
 * server refuses it on save (422 `table_scope_invalid`). null stays null.
 */
export function liveScope(scope: TableScope | null, zones: readonly ScopeTreeZone[]): TableScope | null {
  if (scope === null) return null;
  const zoneIds = new Set(zones.map((z) => z.id));
  const tableIds = new Set(zones.flatMap((z) => z.tables.map((t) => t.id)));
  return {
    zoneIds: scope.zoneIds.filter((id) => zoneIds.has(id)),
    tableIds: scope.tableIds.filter((id) => tableIds.has(id)),
  };
}

/** A zone checked (with every table of it, now and later) or unchecked; its single tables are folded in. */
export function toggleZone(scope: TableScope, zone: ScopeTreeZone, on: boolean): TableScope {
  const own = new Set(zone.tables.map((t) => t.id));
  const tableIds = scope.tableIds.filter((id) => !own.has(id));
  const zoneIds = scope.zoneIds.filter((id) => id !== zone.id);
  return { zoneIds: on ? [...zoneIds, zone.id] : zoneIds, tableIds };
}

/** A single table checked or unchecked. */
export function toggleTable(scope: TableScope, tableId: string, on: boolean): TableScope {
  const tableIds = scope.tableIds.filter((id) => id !== tableId);
  return { zoneIds: scope.zoneIds, tableIds: on ? [...tableIds, tableId] : tableIds };
}

/** The tables of the floor a scope covers: its zones' tables and its single tables. */
export function coveredTables(scope: TableScope, zones: readonly ScopeTreeZone[]): Set<string> {
  const zoneIds = new Set(scope.zoneIds);
  const single = new Set(scope.tableIds);
  const out = new Set<string>();
  for (const z of zones) {
    for (const t of z.tables) if (zoneIds.has(z.id) || single.has(t.id)) out.add(t.id);
  }
  return out;
}

/**
 * Do two scopes leave anything in common? A zone in both (its tables to come too), or a table of the floor
 * both cover. No scope on either side: everything is in common.
 */
export function sharesTables(a: TableScope | null, b: TableScope | null, zones: readonly ScopeTreeZone[]): boolean {
  if (a === null || b === null) return true;
  const zonesB = new Set(b.zoneIds);
  if (a.zoneIds.some((id) => zonesB.has(id))) return true;
  const coveredB = coveredTables(b, zones);
  for (const id of coveredTables(a, zones)) if (coveredB.has(id)) return true;
  return false;
}

/** The devices (with a scope of their own) on which an employee of [scope] would see no table at all. */
export function devicesWithoutOverlap<D extends { tableScope: TableScope | null }>(
  scope: TableScope | null,
  devices: readonly D[],
  zones: readonly ScopeTreeZone[],
): D[] {
  if (scope === null) return [];
  return devices.filter((d) => d.tableScope !== null && !sharesTables(scope, d.tableScope, zones));
}

/** The same scope (the order of the ids aside); null is only null. */
export function sameScope(a: TableScope | null, b: TableScope | null): boolean {
  if (a === null || b === null) return a === b;
  const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join('\n') === [...y].sort().join('\n');
  return same(a.zoneIds, b.zoneIds) && same(a.tableIds, b.tableIds);
}

/** "2 אזורים ו-5 שולחנות": what is picked — whole zones, and single tables outside them. */
export function scopeCounts(scope: TableScope, zones: readonly ScopeTreeZone[]): { zones: number; tables: number; covered: number } {
  const live = liveScope(scope, zones) as TableScope;
  return { zones: live.zoneIds.length, tables: live.tableIds.length, covered: coveredTables(live, zones).size };
}
