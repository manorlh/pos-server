/**
 * "ניהול קטלוג מהקופה" (pos-server app/services/catalog_admin.py, specs/till-catalog-management.md §6):
 * the dashboard page's pure helpers — the level picker's options, the points of sale with no menu of
 * their own (they show the shop's catalog), and how a level's value reads.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export type CatalogAdminLevel = 'company' | 'shop' | 'area' | 'machine';

export const CATALOG_ADMIN_KEYS = [
  'catalogAdminEnabled',
  'catalogAdminScope',
  'catalogCreateFromTill',
  'catalogWithoutShift',
] as const;
export type CatalogAdminKey = (typeof CATALOG_ADMIN_KEYS)[number];

/** A node of `GET /catalog-menus-targets` (only the fields used here). */
export interface AdminTarget {
  level: string;
  id: string;
  name: string;
  parentId: string | null;
  posNumber?: string | null;
  shopId?: string;
}

export interface AdminAssignment {
  level: string;
  targetId: string;
  menuId: string;
}

export interface LevelOption {
  value: string;
  level: CatalogAdminLevel;
  id: string;
  name: string;
  depth: number;
}

export const levelValue = (level: string, id: string) => `${level}:${id}`;

export function parseLevelValue(value: string): { level: CatalogAdminLevel; id: string } | null {
  const i = value.indexOf(':');
  if (i <= 0) return null;
  const level = value.slice(0, i) as CatalogAdminLevel;
  if (!['company', 'shop', 'area', 'machine'].includes(level)) return null;
  return { level, id: value.slice(i + 1) };
}

/**
 * The picker's options in tree order: each company, then its shops, each shop's points of sale
 * with their tills, then the shop's tills with no point of sale. Device groups are not levels of
 * the till parameters and are left out. `tillLabel(n)` names a till by its number.
 */
export function levelOptions(targets: AdminTarget[], tillLabel: (posNumber: string) => string): LevelOption[] {
  const out: LevelOption[] = [];
  const byParent = (level: string, parentId: string) => targets.filter((t) => t.level === level && t.parentId === parentId);
  const tillName = (t: AdminTarget) => (t.posNumber ? `${tillLabel(t.posNumber)} · ${t.name}` : t.name);
  const companies = targets.filter((t) => t.level === 'company');
  const ids = new Set(companies.map((c) => c.id));
  const seen = new Set<string>();
  const walkCompany = (c: AdminTarget, depth: number) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push({ value: levelValue('company', c.id), level: 'company', id: c.id, name: c.name, depth });
    for (const s of byParent('shop', c.id)) {
      out.push({ value: levelValue('shop', s.id), level: 'shop', id: s.id, name: s.name, depth: depth + 1 });
      for (const a of byParent('area', s.id)) {
        out.push({ value: levelValue('area', a.id), level: 'area', id: a.id, name: a.name, depth: depth + 2 });
        for (const m of byParent('machine', a.id)) {
          out.push({ value: levelValue('machine', m.id), level: 'machine', id: m.id, name: tillName(m), depth: depth + 3 });
        }
      }
      for (const m of byParent('machine', s.id)) {
        out.push({ value: levelValue('machine', m.id), level: 'machine', id: m.id, name: tillName(m), depth: depth + 2 });
      }
    }
    for (const child of byParent('company', c.id)) walkCompany(child, depth + 1);
  };
  for (const c of companies) {
    if (!c.parentId || !ids.has(c.parentId)) walkCompany(c, 0);
  }
  return out;
}

/**
 * The points of sale (under `shopId`, or all) with no catalog menu assigned to them: their tills'
 * catalog screen shows the shop's catalog (§6.4). `activeMenuIds`: when given, an assignment of an
 * inactive menu does not count.
 */
export function areasWithoutMenu(
  targets: AdminTarget[],
  assignments: AdminAssignment[],
  shopId: string | null = null,
  activeMenuIds: Set<string> | null = null,
): AdminTarget[] {
  const withMenu = new Set(
    assignments
      .filter((a) => a.level === 'area' && (!activeMenuIds || activeMenuIds.has(a.menuId)))
      .map((a) => a.targetId),
  );
  return targets.filter((t) => t.level === 'area' && (!shopId || t.parentId === shopId) && !withMenu.has(t.id));
}

/** The shop a level belongs to (itself for a shop), for showing its points of sale; null for a company. */
export function shopOfLevel(targets: AdminTarget[], level: CatalogAdminLevel, id: string): string | null {
  if (level === 'shop') return id;
  if (level === 'company') return null;
  const node = targets.find((t) => t.level === level && t.id === id);
  if (!node) return null;
  if (level === 'area') return node.parentId;
  if (node.shopId) return node.shopId;
  const area = targets.find((t) => t.level === 'area' && t.id === node.parentId);
  return area ? area.parentId : node.parentId;
}

/** The keys a level sets itself — what "שחזר ברירת מחדל" clears there. */
export function ownKeys(own: Record<string, unknown>): string[] {
  return CATALOG_ADMIN_KEYS.filter((k) => own[k] !== undefined && own[k] !== null);
}

/** The editor's text for a value: '' = inherit. */
export function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Back to the value the server takes: null clears the level's own value. */
export function fromText(valueType: string, text: string): unknown {
  if (text === '') return null;
  if (valueType === 'boolean') return text === 'true';
  return text;
}

/** Only the keys whose edited text differs from the level's own value. */
export function changedValues(
  own: Record<string, unknown>,
  edits: Record<string, string>,
  valueTypes: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, text] of Object.entries(edits)) {
    if (text === toText(own[key])) continue;
    out[key] = fromText(valueTypes[key] ?? 'string', text);
  }
  return out;
}
