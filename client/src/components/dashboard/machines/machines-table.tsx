'use client';

/**
 * The terminals list: rows grouped under `company ▸ shop`.
 *
 * Grouping is done here rather than on the server on purpose — `companies` and `shops`
 * are already in the react-query cache for the scope bar, so the whole hierarchy is a
 * client-side join with no extra request and no new endpoint to keep in step.
 *
 * Three ordering decisions worth stating, because they are what make the page usable at
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
 *
 * Collapsed groups persist per shop in localStorage. The stored value is read while
 * rendering the group rather than pushed in from an effect: the machines query has not
 * resolved at hydration time, so there are no groups on screen yet and the usual
 * server/client markup disagreement cannot arise. Every access is wrapped — private
 * browsing refuses storage outright, and a forgotten collapse is not worth a blank page.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Company, PosMachine, Shop } from '@/lib/types';
import { buildCompanyTree, companyPathLabel } from '@/lib/companyTree';
import { findBySameId } from '@/lib/entityLookup';
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
  'close_pending',
  'day_closed',
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
  canCloseMachine: (m: PosMachine) => boolean;
  selectedMachineIds: Set<string>;
  onToggleSelected: (id: string) => void;
  /** Opens the pairing dialog with this shop's company and shop pre-selected. */
  onAddMachineToShop: (shop: Shop, companyLabel: string) => void;
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
  canCloseMachine,
  selectedMachineIds,
  onToggleSelected,
  onAddMachineToShop,
}: MachinesTableProps) {
  const t = useTranslations('machines');
  // Seeded from storage once, then owned outright — a toggle writes to both, so this
  // map is the only thing render reads.
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(readCollapsedAll);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

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
          tallies: [],
        };
        byKey.set(key, group);
      }
      group.machines.push(m);
    }

    const list = [...byKey.values()];
    for (const group of list) {
      group.machines.sort((a, b) => a.name.localeCompare(b.name, 'he-IL', { sensitivity: 'base' }));
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
  }, [machines, shops, tree, t]);

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
        <span className="sr-only">{t('columns.select')}</span>
        <span>{t('columns.status')}</span>
        <span>{t('columns.terminal')}</span>
        <span>{t('columns.flags')}</span>
        <span>{t('columns.tradingDay')}</span>
        <span>{t('columns.pending')}</span>
        <span>{t('columns.lastSeen')}</span>
        <span className="text-end">{t('columns.actions')}</span>
      </div>

      {groups.map((group) => (
        <section key={group.key}>
          <MachineGroupHeader
            companyLabel={group.companyLabel}
            shopName={group.shopName}
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
                  canCloseMachine={canCloseMachine}
                  selected={selectedMachineIds.has(m.id)}
                  onToggleSelected={onToggleSelected}
                  expanded={expandedRows.has(m.id)}
                  onToggleExpanded={toggleRow}
                />
              ))}
        </section>
      ))}
    </div>
  );
}
