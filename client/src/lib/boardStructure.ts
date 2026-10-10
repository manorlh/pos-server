/**
 * The control board's company › shop › point of sale › till tree without the overview — for
 * a user who may not read sales figures ("דוחות"), who still lands on the board and sees the
 * tills' state. Built from the look-ups every signed-in user reads (`/companies`, `/shops`,
 * `/machines`, `/shops/{id}/areas` — "reference" routes), with zero figures that the board
 * does not show (the tree hides money for such a user).
 *
 * Shaped like `GET /reports/overview`'s companies, so the board's tree, filters and alerts
 * run on it unchanged. No React, no path aliases: `npm test` compiles this file on its own.
 */

export interface ZeroSales {
  salesToday: number;
  gross: number;
  discounts: number;
  refunds: number;
  documentsToday: number;
  salesCount: number;
  refundsCount: number;
  cash: number;
  card: number;
  other: number;
  tips: number;
}

export const ZERO_SALES: ZeroSales = {
  salesToday: 0, gross: 0, discounts: 0, refunds: 0, documentsToday: 0, salesCount: 0,
  refundsCount: 0, cash: 0, card: 0, other: 0, tips: 0,
};

export interface StructureMachine extends ZeroSales {
  id: string;
  posNumber?: string | null;
  name: string;
  areaId?: string | null;
}

export interface StructureArea extends ZeroSales {
  id: string;
  name: string;
  sortOrder: number;
  machineIds: string[];
}

export interface StructureShop extends ZeroSales {
  id: string;
  number?: number | null;
  name: string;
  machines: StructureMachine[];
  areas?: StructureArea[];
}

export interface StructureCompany extends ZeroSales {
  id: string;
  number?: number | null;
  name: string;
  parentCompanyId?: string | null;
  shops: StructureShop[];
}

interface CompanyIn {
  id: string;
  name: string;
  companyNumber?: number | null;
  parentCompanyId?: string | null;
}
interface ShopIn {
  id: string;
  companyId: string;
  name: string;
  shopNumber?: number | null;
}
interface MachineIn {
  id: string;
  name: string;
  shopId?: string | null;
  posNumber?: string | null;
  areaId?: string | null;
  isActive?: boolean;
  /** False for a display device (a KDS, the board): not a till. */
  fiscal?: boolean;
}

function registerKey(posNumber: string | null | undefined, name: string): [number, number, string] {
  const raw = (posNumber ?? '').trim();
  const n = /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  return [n === null ? 1 : 0, n ?? 0, name.toLowerCase()];
}

function byKey<T>(key: (x: T) => [number, number, string]) {
  return (a: T, b: T) => {
    const x = key(a);
    const y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  };
}

/**
 * The tree for the scope: the shops in `shopIds` (the scope's, already narrowed by company),
 * each with its active tills (only `machineId` when one is chosen), under their companies;
 * the chosen shop's points of sale when given.
 */
export function structureTree(input: {
  companies: CompanyIn[];
  shops: ShopIn[];
  machines: MachineIn[];
  shopIds: string[];
  machineId?: string | null;
  areas?: { shopId: string; list: { id: string; name: string }[] } | null;
}): StructureCompany[] {
  const wanted = new Set(input.shopIds);
  const shops = input.shops.filter((s) => wanted.has(s.id));
  const tills = input.machines.filter(
    (m) =>
      m.shopId &&
      wanted.has(m.shopId) &&
      m.isActive !== false &&
      m.fiscal !== false &&
      (!input.machineId || m.id === input.machineId),
  );
  const keepShops = input.machineId ? new Set(tills.map((m) => m.shopId as string)) : null;
  const companyIds = new Set(shops.map((s) => s.companyId));
  return input.companies
    .filter((c) => companyIds.has(c.id))
    .sort(byKey((c: CompanyIn) => [c.companyNumber == null ? 1 : 0, c.companyNumber ?? 0, c.name.toLowerCase()]))
    .map((c) => ({
      ...ZERO_SALES,
      id: c.id,
      number: c.companyNumber ?? null,
      name: c.name,
      parentCompanyId: c.parentCompanyId ?? null,
      shops: shops
        .filter((s) => s.companyId === c.id && (!keepShops || keepShops.has(s.id)))
        .sort(byKey((s: ShopIn) => [s.shopNumber == null ? 1 : 0, s.shopNumber ?? 0, s.name.toLowerCase()]))
        .map((s) => {
          const machines = tills
            .filter((m) => m.shopId === s.id)
            .sort(byKey((m: MachineIn) => registerKey(m.posNumber, m.name)))
            .map((m) => ({ ...ZERO_SALES, id: m.id, posNumber: m.posNumber ?? null, name: m.name, areaId: m.areaId ?? null }));
          const areas =
            input.areas && input.areas.shopId === s.id
              ? input.areas.list.map((a, i) => ({
                  ...ZERO_SALES,
                  id: a.id,
                  name: a.name,
                  sortOrder: i,
                  machineIds: machines.filter((m) => m.areaId === a.id).map((m) => m.id),
                }))
              : [];
          return { ...ZERO_SALES, id: s.id, number: s.shopNumber ?? null, name: s.name, machines, areas };
        }),
    }))
    .filter((c) => c.shops.length > 0);
}

/** Only the event's tills, and the shops and companies they stand in. */
export function narrowToTills<T extends { shops: { machines: { id: string }[] }[] }>(tree: T[], tillIds: string[]): T[] {
  const keep = new Set(tillIds);
  return tree
    .map(
      (c) =>
        ({
          ...c,
          shops: c.shops
            .map((s) => ({ ...s, machines: s.machines.filter((m) => keep.has(m.id)) }))
            .filter((s) => s.machines.length > 0),
        }) as T,
    )
    .filter((c) => c.shops.length > 0);
}
