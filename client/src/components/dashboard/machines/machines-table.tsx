'use client';

/**
 * The terminals list: rows grouped under `company ▸ shop`.
 *
 * Grouping is done here rather than on the server on purpose — `companies` and `shops`
 * are already in the react-query cache for the scope bar, so the whole hierarchy is a
 * client-side join with no extra request and no new endpoint to keep in step.
 *
 * Four ordering decisions worth stating, because they are what make the page usable at
 * thirty terminals:
 *
 * * Groups sort by company path, then shop name, with Hebrew collation — the label the
 *   operator reads is the thing that sorts, so scanning down the page is alphabetical.
 * * Terminals with no shop collect in one group that always sorts **last** and is
 *   coloured apart. They are not a category, they are a to-do list: a paired till
 *   nobody assigned is invisible to every shop-scoped report until someone fixes it.
 * * A terminal pointing at a shop this caller cannot see still gets its own group
 *   rather than being dropped or silently folded into "unassigned". Hiding a till from
 *   the person responsible for it is the worse failure.
 * * Within a shop, terminals sort by register number — till 1, 2, 3 — which is how the
 *   shop itself refers to them. The few without a number follow, by name.
 * * A shop's screens — KDS kitchen screens and "מוכן / לא מוכן" boards — are not tills
 *   (pos-server docs/SPEC_DEVICE_ROLE_MODEL.md §2.2): they follow the tills in their own
 *   "מסכים" section and are not counted in the shop's tills or status tallies.
 *
 * Collapsed groups persist per shop in localStorage. The stored value is read while
 * rendering the group rather than pushed in from an effect: the machines query has not
 * resolved at hydration time, so there are no groups on screen yet and the usual
 * server/client markup disagreement cannot arise. Every access is wrapped — private
 * browsing refuses storage outright, and a forgotten collapse is not worth a blank page.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Tv } from 'lucide-react';
import type { Company, PosMachine, Shop } from '@/lib/types';
import { splitDisplayDevices } from '@/lib/deviceProfile';
import { buildCompanyTree, companyPathLabel } from '@/lib/companyTree';
import { findBySameId } from '@/lib/entityLookup';
import { compareByRegisterNumber } from '@/lib/registerNumber';
import { machineStatus } from '@/components/dashboard/machine-status';
import {
  MachineGroupHeader,
  type MachineStatusValue,
} from '@/components/dashboard/machines/machine-group-header';
import {
  MACHINE_ROW_GRID,
  MachineRow,
  type MachinePermissions,
  type MachineRowActions,
} from '@/components/dashboard/machines/machine-row';

const COLLAPSE_STORAGE_PREFIX = 'machinesGroupCollapsed:';

/** The unassigned bucket is keyed by a sentinel so it can share the group plumbing. */
const UNASSIGNED_KEY = '__unassigned__';

/** Same precedence the status strip uses: what needs attention is counted first. */
const TALLY_ORDER: MachineStatusValue[] = [
  'offline_with_unsynced',
  'offline',
  'pending_sync',
  'shift_close_pending',
  'no_open_shift',
  'online',
  'not_paired',
  'retired',
];

interface MachineGroup {
  key: string;
  shop: Shop | null;
  companyLabel: string | null;
  shopName: string;
  unassigned: boolean;
  machines: PosMachine[];
  /** KDS screens and boards: not tills — their own section, never in the tallies. */
  screens: PosMachine[];
  tallies: Array<[MachineStatusValue, number]>;
}

export interface MachinesTableProps {
  /** Already narrowed by scope, status filter and search — this component only groups. */
  machines: PosMachine[];
  shops: Shop[];
  companies: Company[];
  permissions: MachinePermissions;
  actions: MachineRowActions;
  isDeviceOnline: (m: PosMachine) => boolean;
  /** Opens the pairing dialog with this shop's company and shop pre-selected. */
  onAddMachineToShop: (shop: Shop, companyLabel: string) => void;
  /** Opens the terminal number dialog for every till of this shop. */
  onTerminalNumberForShop?: (shop: Shop) => void;
}

/**
 * Every remembered collapse, read in one pass at mount.
 *
 * Read here rather than per group per render: the page runs four polling timers, so a
 * shop with thirty branches would otherwise make thirty synchronous storage reads every
 * time any of them ticked. `localStorage` blocks the main thread, and this is the render
 * path.
 */
function readCollapsedAll(): Map<string, boolean> {
  const remembered = new Map<string, boolean>();
  if (typeof window === 'undefined') return remembered;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(COLLAPSE_STORAGE_PREFIX)) {
        remembered.set(key.slice(COLLAPSE_STORAGE_PREFIX.length), true);
      }
    }
  } catch {
    // Private browsing denies storage outright; a group that forgets it was collapsed
    // is not worth failing the page over.
  }
  return remembered;
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSE_STORAGE_PREFIX + key, '1');
    else window.localStorage.removeItem(COLLAPSE_STORAGE_PREFIX + key);
  } catch {
    // As above.
  }
}

export function MachinesTable({
  machines,
  shops,
  companies,
  permissions,
  actions,
  isDeviceOnline,
  onAddMachineToShop,
  onTerminalNumberForShop,
}: MachinesTableProps) {
  const t = useTranslations('machines');
  // Seeded from storage once, then owned outright — a toggle writes to both, so this
  // map is the only thing render reads.
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(readCollapsedAll);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  /** Register numbers run 1, 2, 3 by default; the "קופה" caption flips them. */
  const [registerDesc, setRegisterDesc] = useState(false);

  const tree = useMemo(() => buildCompanyTree(companies), [companies]);

  const groups = useMemo<MachineGroup[]>(() => {
    const byKey = new Map<string, MachineGroup>();

    for (const m of machines) {
      const shop = m.shopId ? findBySameId(shops, m.shopId) ?? null : null;
      const key = shop ? shop.id : m.shopId ? m.shopId : UNASSIGNED_KEY;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          shop,
          companyLabel: shop
            ? companyPathLabel(tree, shop.companyId, t('companyUnknown'))
            : m.shopId
              ? t('companyUnknown')
              : null,
          // A shop id with no shop row means the caller can see the till but not its
          // branch; name it by its id rather than pretending it has no shop.
          shopName: shop ? shop.name : m.shopId ? m.shopId : t('groupUnassigned'),
          unassigned: !m.shopId,
          machines: [],
          screens: [],
          tallies: [],
        };
        byKey.set(key, group);
      }
      group.machines.push(m);
    }

    const list = [...byKey.values()];
    for (const group of list) {
      // Screens apart from the tills (they are not tills), by name.
      const { tills, screens } = splitDisplayDevices(group.machines);
      group.machines = tills;
      group.screens = screens.sort((a, b) => a.name.localeCompare(b.name, 'he-IL', { sensitivity: 'base' }));
      // Register number first — the shop's tills read 1, 2, 3 — then by name for the
      // few without one.
      group.machines.sort((a, b) =>
        registerDesc ? compareByRegisterNumber(b, a) : compareByRegisterNumber(a, b),
      );
      const counts = new Map<MachineStatusValue, number>();
      for (const m of group.machines) {
        const s = machineStatus(m);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      group.tallies = TALLY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => [
        s,
        counts.get(s)!,
      ]);
    }

    list.sort((a, b) => {
      if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
      const byCompany = (a.companyLabel ?? '').localeCompare(b.companyLabel ?? '', 'he-IL', {
        sensitivity: 'base',
      });
      if (byCompany !== 0) return byCompany;
      return a.shopName.localeCompare(b.shopName, 'he-IL', { sensitivity: 'base' });
    });

    return list;
  }, [machines, shops, tree, t, registerDesc]);

  // Groups default to expanded; only what storage explicitly marks comes back collapsed.
  const isCollapsed = (key: string): boolean => collapsed.get(key) ?? false;

  const toggleGroup = (key: string) => {
    const next = !isCollapsed(key);
    writeCollapsed(key, next);
    setCollapsed((prev) => new Map(prev).set(key, next));
  };

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* Column captions only where the columns exist; the stacked mobile row labels
          itself with the values it shows. */}
      <div
        className={`hidden border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground ${MACHINE_ROW_GRID}`}
      >
        <span>{t('columns.status')}</span>
        <button
          type="button"
          onClick={() => setRegisterDesc((d) => !d)}
          className="inline-flex items-center gap-1 justify-self-start hover:text-foreground"
          title={t('columns.sortByRegister')}
          aria-label={t('columns.sortByRegister')}
        >
          {t('columns.terminal')}
          {registerDesc ? (
            <ArrowUp className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden />
          )}
        </button>
        <span>{t('columns.shift')}</span>
        <span>{t('columns.flags')}</span>
        <span>{t('columns.lastSeen')}</span>
        <span className="text-end">{t('columns.actions')}</span>
      </div>

      {groups.map((group) => (
        <section key={group.key}>
          <MachineGroupHeader
            companyLabel={group.companyLabel}
            shopName={group.shopName}
            shopNumber={group.shop?.shopNumber}
            unassigned={group.unassigned}
            count={group.machines.length}
            tallies={group.tallies}
            collapsed={isCollapsed(group.key)}
            onToggle={() => toggleGroup(group.key)}
            onAddMachine={
              group.shop
                ? () => onAddMachineToShop(group.shop!, group.companyLabel ?? '')
                : undefined
            }
            onTerminalNumber={
              group.shop && onTerminalNumberForShop
                ? () => onTerminalNumberForShop(group.shop!)
                : undefined
            }
          />
          {isCollapsed(group.key)
            ? null
            : group.machines.map((m) => (
                <MachineRow
                  key={m.id}
                  m={m}
                  permissions={permissions}
                  actions={actions}
                  isDeviceOnline={isDeviceOnline}
                  expanded={expandedRows.has(m.id)}
                  onToggleExpanded={toggleRow}
                />
              ))}
          {!isCollapsed(group.key) && group.screens.length > 0 ? (
            <div className="border-t border-dashed">
              <div
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-sky-50/60 px-3 py-1.5 text-xs dark:bg-sky-950/30"
                title={t('deviceRole.screensGroupHint')}
              >
                <Tv className="h-3.5 w-3.5 text-sky-700 dark:text-sky-300" aria-hidden />
                <span className="font-medium">{t('deviceRole.screensGroup')}</span>
                <span className="text-muted-foreground">({group.screens.length})</span>
                <span className="text-muted-foreground">· {t('deviceRole.screensGroupHint')}</span>
              </div>
              {group.screens.map((m) => (
                <MachineRow
                  key={m.id}
                  m={m}
                  permissions={permissions}
                  actions={actions}
                  isDeviceOnline={isDeviceOnline}
                  expanded={expandedRows.has(m.id)}
                  onToggleExpanded={toggleRow}
                />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
