/**
 * The manager overview's tree: the server's sales (`GET /reports/overview`) joined with
 * the machines list's live state, then searched and filtered.
 *
 * Pure functions only, so the rules a manager relies on — what counts as an alert, what
 * "4" finds — sit in one place and not inside a component.
 */
import { normalizeNavText } from './navigation';
import { registerNumberOf } from './registerNumber';
import type {
  AppReleaseRolloutRow,
  OverviewArea,
  OverviewCompany,
  OverviewMachine,
  OverviewShop,
  PosMachine,
} from './types';

/** The machines page's fallback window, for a payload from a server without `online`. */
const ONLINE_WINDOW_MS = 300 * 1000;

/** The server's `online` when it sent one, else the heartbeat window (as the machines page). */
export function isTillOnline(m: PosMachine | undefined, nowMs: number): boolean {
  if (!m) return false;
  if (typeof m.online === 'boolean') return m.online;
  if (!m.lastHeartbeatAt) return false;
  const ts = new Date(m.lastHeartbeatAt).getTime();
  return Number.isFinite(ts) && nowMs - ts <= ONLINE_WINDOW_MS;
}

/** Update states a manager should hear about; an install in progress is not an alert. */
const UPDATE_PROBLEMS = new Set(['failed', 'declined']);

/**
 * How many alert badges the till shows — the machines page's alerts column (terminal
 * mismatch, the server's flags but the Z backlog, unsent documents, documents with no
 * shift) plus the card terminal in offline mode and a failed or declined app update.
 */
export function tillAlertCount(m: PosMachine | undefined, rollout?: AppReleaseRolloutRow): number {
  if (!m) return 0;
  const flags = m.statusFlags ?? [];
  let n = flags.filter(
    (f) =>
      f !== 'closed_shifts_awaiting_z' &&
      !(f === 'transmission_overdue' && flags.includes('transmission_critical')),
  ).length;
  if (m.terminalStatus === 'mismatch') n++;
  if (m.pendingAsOf && (m.pendingDocuments ?? 0) > 0) n++;
  if ((m.orphanDocuments ?? 0) > 0) n++;
  if (m.terminalOfflineMode) n++;
  if (rollout?.status && UPDATE_PROBLEMS.has(rollout.status)) n++;
  return n;
}

/** Just the part `MachineAlerts` draws, so the page renders it only when it has something. */
export function machinesColumnAlertCount(m: PosMachine): number {
  return tillAlertCount(m) - (m.terminalOfflineMode ? 1 : 0);
}

export type OverviewFilter = 'all' | 'offline' | 'openShift' | 'alerts';

export interface TillNode {
  sales: OverviewMachine;
  /** Absent when the machines list does not carry it (still loading, or beyond its pages). */
  live?: PosMachine;
  rollout?: AppReleaseRolloutRow;
  registerNumber: number | null;
  online: boolean;
  openShift: boolean;
  alerts: number;
}

export interface ShopNode {
  sales: OverviewShop;
  companyId: string;
  tills: TillNode[];
  online: number;
  openShifts: number;
  alerts: number;
}

export interface CompanyNode {
  sales: OverviewCompany;
  shops: ShopNode[];
}

export function buildOverviewTree(
  companies: OverviewCompany[],
  machinesById: Map<string, PosMachine>,
  rolloutById: Map<string, AppReleaseRolloutRow>,
  nowMs: number,
): CompanyNode[] {
  return companies.map((company) => ({
    sales: company,
    shops: company.shops.map((shop) => {
      const tills = shop.machines.map((sales): TillNode => {
        const live = machinesById.get(sales.id);
        const rollout = rolloutById.get(sales.id);
        return {
          sales,
          live,
          rollout,
          registerNumber: registerNumberOf({ shopId: shop.id, posNumber: sales.posNumber }),
          online: isTillOnline(live, nowMs),
          openShift: live ? live.shiftStatus === 'open' : !!sales.openShiftId,
          alerts: tillAlertCount(live, rollout),
        };
      });
      return {
        sales: shop,
        companyId: company.id,
        tills,
        online: tills.filter((t) => t.online).length,
        openShifts: tills.filter((t) => t.openShift).length,
        alerts: tills.filter((t) => t.alerts > 0).length,
      };
    }),
  }));
}

function passesFilter(till: TillNode, filter: OverviewFilter): boolean {
  if (filter === 'offline') return !till.online;
  if (filter === 'openShift') return till.openShift;
  if (filter === 'alerts') return till.alerts > 0;
  return true;
}

/**
 * The query, folded the way the sidebar search folds it (niqqud, geresh/gershayim,
 * case). `number` is set for a bare number ("4") and for "#4"; `hash` tells them apart.
 */
function parseQuery(raw: string): { text: string; number: number | null; hash: boolean } {
  const text = normalizeNavText(raw);
  const digits = /^(#?)\s*(\d+)$/.exec(text);
  return {
    text,
    number: digits ? Number(digits[2]) : null,
    hash: !!digits && digits[1] === '#',
  };
}

/**
 * Search and chip filter over the tree.
 *
 * A company that matches keeps all its shops, a shop that matches keeps all its tills,
 * otherwise only the matching tills stay. What a query matches:
 *
 * * a bare number ("4") — the till with that register number, and nothing else: it is
 *   how a manager says "till 4", and shop 4, company 4 and every name with a 4 in it
 *   would bury that till under noise;
 * * "#4" — the shop or company with that number (the pills read "#4");
 * * any other text — names (till, area, shop, company) by substring (an area that
 *   matches keeps all its tills), and a till's label
 *   ("קופה 4") whole, so "קופה 4" is register 4 and not 4 and 40–49 too; "קופה" alone
 *   still finds every till.
 *
 * The chip filter then applies to the tills that are left, and a shop with none left is
 * dropped (so is a company with no shops).
 */
export function filterOverviewTree(
  tree: CompanyNode[],
  rawQuery: string,
  filter: OverviewFilter,
  registerLabel: (n: number) => string,
): CompanyNode[] {
  const q = parseQuery(rawQuery);
  const searching = q.text.length > 0;
  const textual = searching && q.number === null;
  const has = (value: string | null | undefined) =>
    textual && !!value && normalizeNavText(value).includes(q.text);
  const numbered = (n: number | null | undefined) => q.hash && n != null && n === q.number;

  const tillMatches = (till: TillNode) => {
    if (q.number !== null) return !q.hash && till.registerNumber === q.number;
    if (has(till.sales.name)) return true;
    if (till.registerNumber === null) return false;
    const label = normalizeNavText(registerLabel(till.registerNumber));
    return label === q.text || (!/\d/.test(q.text) && label.includes(q.text));
  };

  const out: CompanyNode[] = [];
  for (const company of tree) {
    const companyHit = searching && (has(company.sales.name) || numbered(company.sales.number));
    const shops: ShopNode[] = [];
    for (const shop of company.shops) {
      const shopHit =
        !searching || companyHit || has(shop.sales.name) || numbered(shop.sales.number);
      const areaNames = new Map((shop.sales.areas ?? []).map((a) => [a.id, a.name]));
      const areaHit = (till: TillNode) =>
        !!till.sales.areaId && has(areaNames.get(till.sales.areaId));
      const tills = shop.tills.filter(
        (till) => (shopHit || areaHit(till) || tillMatches(till)) && passesFilter(till, filter),
      );
      // With nothing narrowing, an empty shop is still a shop (no tills yet); once a
      // search or a chip is on, it is just noise.
      if (tills.length === 0 && (searching || filter !== 'all')) continue;
      shops.push({ ...shop, tills });
    }
    if (shops.length > 0) out.push({ ...company, shops });
  }
  return out;
}

export interface AreaGroup {
  /** Null for the shop's tills that stand in no area. */
  area: OverviewArea | null;
  tills: TillNode[];
}

/**
 * A shop's tills by point of sale: each live area in its order with its tills, then the
 * tills in no area (directly under the shop). An area with no tills left is kept only
 * when `keepEmpty` (nothing narrows the tree); a shop with no areas is one group.
 */
export function groupTillsByArea(shop: ShopNode, keepEmpty: boolean): AreaGroup[] {
  const areas = shop.sales.areas ?? [];
  if (areas.length === 0) return [{ area: null, tills: shop.tills }];
  const known = new Set(areas.map((a) => a.id));
  const groups: AreaGroup[] = areas
    .map((area) => ({ area, tills: shop.tills.filter((t) => t.sales.areaId === area.id) }))
    .filter((g) => keepEmpty || g.tills.length > 0);
  const loose = shop.tills.filter((t) => !t.sales.areaId || !known.has(t.sales.areaId));
  if (loose.length > 0) groups.push({ area: null, tills: loose });
  return groups;
}

/** A till anywhere in the tree, with where it stands; null for none or an unknown id. */
export function findTill(
  tree: CompanyNode[],
  id: string | null,
): { till: TillNode; shopId: string; companyId: string } | null {
  if (!id) return null;
  for (const company of tree) {
    for (const shop of company.shops) {
      const till = shop.tills.find((x) => x.sales.id === id);
      if (till) return { till, shopId: shop.sales.id, companyId: company.sales.id };
    }
  }
  return null;
}
