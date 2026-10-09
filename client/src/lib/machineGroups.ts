/**
 * "קבוצות מכשירים" — named groups of tills across the shops of one company (pos-server
 * app/services/machine_groups.py), a level a catalog menu can be assigned to
 * ("תפריטים › שיוך": קופה › קבוצת מכשירים › נקודת מכירה › סניף › חברה).
 *
 * The rules the dialog needs without the server: which tills a group of a company may hold
 * (active tills of shops under that company — it or one beneath it), a name as the server keeps
 * it, and the server's refusals as codes. Pure: `npm test` runs it (machineGroups.test.ts).
 */

export interface MachineGroupTill {
  id: string;
  name: string;
  posNumber: string | null;
  shopId: string | null;
  shopName: string | null;
  isActive: boolean;
}

export interface MachineGroup {
  id: string;
  companyId: string;
  companyName: string | null;
  name: string;
  sortOrder: number;
  machineIds: string[];
  machines: MachineGroupTill[];
  /** The user may rename it, change its tills or delete it (a catalog writer over its company). */
  canEdit: boolean;
  updatedAt: string | null;
}

export const GROUP_NAME_MAX = 80;

/** The server's refusals the dialog has words for. */
export type MachineGroupErrorCode =
  | 'machine_group_name_taken'
  | 'machine_group_name_empty'
  | 'machine_group_not_found'
  | 'machine_not_in_company';

/** A name as the server keeps it: inner runs of spaces as one, trimmed, at most 80 characters. */
export function cleanGroupName(name: string): string {
  return name.split(/\s+/).filter(Boolean).join(' ').slice(0, GROUP_NAME_MAX);
}

/** Another group of the same company already has this name (the server compares without case). */
export function groupNameTaken(
  groups: readonly Pick<MachineGroup, 'id' | 'companyId' | 'name'>[],
  companyId: string,
  name: string,
  exceptId?: string | null,
): boolean {
  const wanted = cleanGroupName(name).toLowerCase();
  if (!wanted) return false;
  return groups.some(
    (g) => g.companyId === companyId && g.id !== exceptId && cleanGroupName(g.name).toLowerCase() === wanted,
  );
}

/** `companyId` and every company beneath it (a loop in the data stops, never spins). */
export function companySubtree(
  companies: readonly { id: string; parentCompanyId?: string | null }[],
  companyId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of companies) {
    if (!c.parentCompanyId) continue;
    const list = children.get(c.parentCompanyId) ?? [];
    list.push(c.id);
    children.set(c.parentCompanyId, list);
  }
  const out = new Set<string>([companyId]);
  const queue = [companyId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/**
 * The tills a group of `companyId` may hold: tills of shops under that company (it or one
 * beneath it) that are not retired — the server refuses any other (`machine_not_in_company`).
 */
export function eligibleTills<M extends { id: string; shopId?: string | null; status?: string | null }>(
  machines: readonly M[],
  shops: readonly { id: string; companyId: string }[],
  companies: readonly { id: string; parentCompanyId?: string | null }[],
  companyId: string,
): M[] {
  const reach = companySubtree(companies, companyId);
  const shopCompany = new Map(shops.map((s) => [s.id, s.companyId]));
  return machines.filter((m) => {
    if (!m.shopId || m.status === 'retired') return false;
    const company = shopCompany.get(m.shopId);
    return !!company && reach.has(company);
  });
}

/** Members kept in the order the list shows them, a till once. */
export function toggleMember(ids: readonly string[], id: string, on: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

/** The same tills, in any order. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** A refusal's code (`machine_not_in_company:<id>` → `machine_not_in_company`), else null. */
export function machineGroupErrorCode(detail: unknown): MachineGroupErrorCode | null {
  if (typeof detail !== 'string') return null;
  const code = detail.split(':', 1)[0];
  return code === 'machine_group_name_taken' ||
    code === 'machine_group_name_empty' ||
    code === 'machine_group_not_found' ||
    code === 'machine_not_in_company'
    ? code
    : null;
}
