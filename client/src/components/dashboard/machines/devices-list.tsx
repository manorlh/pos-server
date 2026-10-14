'use client';

/**
 * The devices list (app/dashboard/machines): a dense, sortable table at desktop width and cards
 * on a phone — or on a desktop that asks for them. The same rows and the same actions either way;
 * which rows, in which order, is lib/devicesView.ts's (the page hands them in already searched,
 * filtered and sorted).
 *
 * * **Every row says its serial** — monospaced, with a copy button and where it came from
 *   ("SUNMI", "Feitian SDK"), or "לא דווח" — and its model, role, platform and app version
 *   ("ישנה" when below the newest in view on its platform), and "פתיחה אוטומטית" when it reported
 *   it (components/dashboard/machines/auto-start.tsx; nothing for an older APK).
 * * **Sorted by shop (the default), the rows sit under their shop's header** — company ▸ shop, the
 *   tills' count and status dots, "הוסף מכשיר" and the shop's terminal number — collapsible, the
 *   collapse remembered per shop in localStorage (wrapped: private browsing refuses storage, and a
 *   forgotten collapse is not worth a blank page). Sorted by anything else the list is flat and
 *   the shop is a column.
 * * **Nothing moved out of reach** — the row's "⋯" menu (components/dashboard/machines/machine-row.tsx)
 *   carries every action it did, and a click on the row (not on a link, a button or the menu)
 *   opens the details panel, as before. "שייך לאירוע" puts a checkbox on each till (never a
 *   screen), a "the shop's tills" one under each shop header, and an "all shown" one in the
 *   table's header.
 */

import { Fragment, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, Copy, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type { Company, CompanyTree, PosMachine, Shop } from '@/lib/types';
import { buildCompanyTree, companyPathLabel } from '@/lib/companyTree';
import { findBySameId } from '@/lib/entityLookup';
import { isDisplayDevice } from '@/lib/deviceProfile';
import { formatDateTime } from '@/lib/format';
import { zModeOf } from '@/lib/tillZ';
import {
  STATUS_ORDER,
  platformOf,
  serialOf,
  shortAppVersion,
  versionStateOf,
  type DevicePlatformKey,
  type DeviceSort,
  type DevicesLayout,
  type SortKey,
} from '@/lib/devicesView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MachineStatusDot, machineStatus } from '@/components/dashboard/machine-status';
import { LicenseBadge } from '@/components/dashboard/license-fields';
import { DeviceCommandChip } from '@/components/dashboard/device-commands/command-chip';
import { IndependentTillBadge } from '@/components/dashboard/independent-till-badge';
import { ZModeBadge } from '@/components/dashboard/till-z/till-z-request';
import { TrainingBadge } from '@/components/dashboard/training-badge';
import { DeviceModelBadge } from '@/components/dashboard/machines/device-model';
import { SyncCell } from '@/components/dashboard/machines/sync-status';
import type { DeviceSyncStatus } from '@/lib/syncStatus';
import { DevicePlatformBadge, DeviceRoleBadge } from '@/components/dashboard/machines/device-role';
import { AutoStartBadge } from '@/components/dashboard/machines/auto-start';
import {
  MachineGroupHeader,
  type MachineStatusValue,
} from '@/components/dashboard/machines/machine-group-header';
import {
  IntegrationBadge,
  MachineAlerts,
  MachineRowDetails,
  MachineRowMenu,
  MachineShiftChip,
  RegisterNameMismatch,
  useMachineLabel,
  type MachinePermissions,
  type MachineRowActions,
} from '@/components/dashboard/machines/machine-row';

const COLLAPSE_STORAGE_PREFIX = 'machinesGroupCollapsed:';
const UNASSIGNED_KEY = '__unassigned__';

/** Clicks on these do what they are, not open the row's details. */
const INTERACTIVE = 'a, button, input, select, textarea, label, [role="menuitem"], [role="menu"]';

export interface DevicesListProps {
  /** Already searched, filtered and sorted (lib/devicesView.ts) — this component only lays them out. */
  machines: PosMachine[];
  layout: DevicesLayout;
  sort: DeviceSort;
  onSort: (key: SortKey) => void;
  shops: Shop[];
  companies: Company[];
  /** The newest app version in view per platform: the "ישנה" yardstick. */
  newest: Map<DevicePlatformKey, number[]>;
  permissions: MachinePermissions;
  actions: MachineRowActions;
  isDeviceOnline: (m: PosMachine) => boolean;
  /** Opens the pairing dialog with this shop's company and shop pre-selected. */
  onAddMachineToShop: (shop: Shop, companyLabel: string) => void;
  /** Opens the terminal number dialog for every till of this shop. */
  onTerminalNumberForShop?: (shop: Shop) => void;
  /** "שייך לאירוע": while set, each till (never a screen) gets a checkbox. */
  selection?: {
    selected: ReadonlySet<string>;
    onToggle: (ids: string[], on: boolean) => void;
  };
  /** "סנכרון" (P:/specs/device-sync-status.md §3): each device's sync state, by id — read apart. */
  syncByMachine?: ReadonlyMap<string, DeviceSyncStatus>;
  /** "סנכרן את כל הסניף" on the shop's header; absent where not allowed. */
  onSyncShop?: (shop: Shop) => void;
}

interface DeviceGroup {
  key: string;
  shop: Shop | null;
  companyLabel: string | null;
  shopName: string;
  unassigned: boolean;
  rows: PosMachine[];
  /** The tills (and kiosks): what the header counts and the shop's checkbox selects. */
  tills: PosMachine[];
  screens: number;
  tallies: Array<[MachineStatusValue, number]>;
}

/** Every remembered collapse, read once at mount (storage blocks; the page polls). */
function readCollapsedAll(): Map<string, boolean> {
  const remembered = new Map<string, boolean>();
  if (typeof window === 'undefined') return remembered;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(COLLAPSE_STORAGE_PREFIX)) remembered.set(key.slice(COLLAPSE_STORAGE_PREFIX.length), true);
    }
  } catch {
    // Private browsing denies storage outright.
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

/** The rows under their shops, in the order they came (sorted by shop, a shop's rows are together). */
function groupByShop(
  rows: PosMachine[],
  shops: Shop[],
  tree: CompanyTree,
  t: (key: string) => string,
): DeviceGroup[] {
  const byKey = new Map<string, DeviceGroup>();
  for (const m of rows) {
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
        // A shop the caller cannot see still gets its own group, named by its id.
        shopName: shop ? shop.name : m.shopId ? m.shopId : t('groupUnassigned'),
        unassigned: !m.shopId,
        rows: [],
        tills: [],
        screens: 0,
        tallies: [],
      };
      byKey.set(key, group);
    }
    group.rows.push(m);
    if (isDisplayDevice(m)) group.screens += 1;
    else group.tills.push(m);
  }
  for (const group of byKey.values()) {
    const counts = new Map<MachineStatusValue, number>();
    for (const m of group.tills) {
      const s = machineStatus(m);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    group.tallies = (STATUS_ORDER as readonly MachineStatusValue[])
      .filter((s) => (counts.get(s) ?? 0) > 0)
      .map((s) => [s, counts.get(s)!]);
  }
  return [...byKey.values()];
}

const WIDE_QUERY = '(min-width: 1024px)';

function subscribeWide(onChange: () => void): () => void {
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/**
 * `lg` and up: wide enough for the table. Below it the list is cards — a phone never gets a
 * table that scrolls sideways. False while rendering on the server.
 */
export function useIsWideScreen(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/** Whether a row can be picked for an event: a till with a shop (a screen is not a till). */
const selectable = (m: PosMachine) => !!m.shopId && !isDisplayDevice(m);

// ── Cells ────────────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const t = useTranslations('machines.devicesView');
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={t('copySerial')}
      title={t('copySerial')}
      onClick={(e) => {
        e.stopPropagation();
        if (!navigator.clipboard) {
          toast.error(t('copyFailed'));
          return;
        }
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            toast.success(t('copied'));
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error(t('copyFailed')),
        );
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * The serial, monospaced and whole (never cut: it is read off the label and compared), with a
 * copy button and its source; "לא דווח" when the device never said. `stacked`: the source on a
 * line of its own (the table's narrow column).
 */
export function DeviceSerial({
  m,
  stacked = false,
}: {
  m: Pick<PosMachine, 'serialNumber' | 'serialSource'>;
  stacked?: boolean;
}) {
  const t = useTranslations('machines.devicesView');
  const s = serialOf(m);
  if (!s) return <span className="text-xs text-muted-foreground">{t('serialMissing')}</span>;
  const source = s.source ? (
    <span
      className="w-fit shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground"
      title={t('serialSource', { source: s.source })}
    >
      {s.source}
    </span>
  ) : null;
  return (
    <span className={stacked ? 'flex flex-col items-start' : 'flex flex-wrap items-center gap-x-1'}>
      <span className="flex items-center gap-0.5">
        <span dir="ltr" className="font-mono text-xs whitespace-nowrap select-all">
          {s.serial}
        </span>
        <CopyButton value={s.serial} />
      </span>
      {source}
    </span>
  );
}

/** "0.1.248", and "ישנה" when below the newest in view on its platform. */
function DeviceVersion({ m, newest }: { m: PosMachine; newest: Map<DevicePlatformKey, number[]> }) {
  const t = useTranslations('machines.devicesView');
  const short = shortAppVersion(m.appVersion);
  if (!short) return <span className="text-xs text-muted-foreground">—</span>;
  const best = newest.get(platformOf(m));
  const old = versionStateOf(m, newest) === 'old';
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span dir="ltr" className="font-mono text-xs" title={m.appVersion ?? undefined}>
        {short}
      </span>
      {old && best ? (
        <Badge
          variant="outline"
          className="h-4 border-amber-400/60 px-1 text-[10px] font-normal text-amber-800 dark:text-amber-300"
          title={t('versionOldHint', { newest: best.join('.') })}
        >
          {t('versionOld')}
        </Badge>
      ) : null}
    </span>
  );
}

/** Its shop in training, locked from "שליטה מרחוק", its shop switched off. */
function DeviceFlagBadges({ m }: { m: PosMachine }) {
  const t = useTranslations('machines.devicesView');
  return (
    <>
      <TrainingBadge shop={m} className="h-4 px-1.5 text-[10px]" />
      {m.remoteLocked ? (
        <Badge variant="destructive" className="h-4 shrink-0 gap-0.5 px-1 text-[10px]" title={t('flag.locked')}>
          <Lock className="h-2.5 w-2.5" aria-hidden />
          {t('badge.locked')}
        </Badge>
      ) : null}
      {m.shopId && m.shopActive === false ? (
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] font-normal text-muted-foreground">
          {t('badge.inactiveShop')}
        </Badge>
      ) : null}
    </>
  );
}

/** "קופה 2", the free-text name when it says more, and the marks that belong beside the name. */
function DeviceName({ m }: { m: PosMachine }) {
  const label = useMachineLabel(m);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Link
        href={`/dashboard/machines/${m.id}`}
        className={`shrink-0 hover:underline ${label.number !== null ? 'font-semibold' : 'font-medium'}`}
      >
        {label.primary}
      </Link>
      {label.secondary ? <span className="min-w-0 truncate text-xs text-muted-foreground">{label.secondary}</span> : null}
      {label.nameMismatch ? <RegisterNameMismatch /> : null}
      <LicenseBadge value={m} className="shrink-0" />
      <DeviceFlagBadges m={m} />
    </div>
  );
}

/** The device code and the marks of how it works (card integration, its own Z). */
function DeviceCodeLine({ m }: { m: PosMachine }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate" dir="ltr">
        {m.machineCode}
      </span>
      <IntegrationBadge m={m} />
      {/* Only the exception is marked: most tills are on the shop's cloud Z. */}
      {m.independentTill ? (
        <IndependentTillBadge machine={m} className="h-4 px-1 text-[10px]" />
      ) : zModeOf(m) === 'till' ? (
        <ZModeBadge mode="till" className="h-4 shrink-0 px-1 text-[10px]" />
      ) : null}
    </div>
  );
}

function LastSeen({ m }: { m: PosMachine }) {
  const t = useTranslations('machines');
  if (!m.lastHeartbeatAt) return <span className="text-xs text-muted-foreground">{t('neverSeen')}</span>;
  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground" title={formatDateTime(m.lastHeartbeatAt)}>
      {formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he })}
    </span>
  );
}

function RowActions({
  m,
  permissions,
  actions,
  expanded,
  detailsId,
  onToggle,
}: {
  m: PosMachine;
  permissions: MachinePermissions;
  actions: MachineRowActions;
  expanded: boolean;
  detailsId: string;
  onToggle: () => void;
}) {
  const t = useTranslations('machines');
  // Stops here so a menu item (in a portal, but bubbling through React) never also toggles the row.
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={t('rowToggle')}
        title={t('rowToggle')}
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
      </Button>
      <MachineRowMenu m={m} permissions={permissions} actions={actions} />
    </div>
  );
}

function rowClickToggles(e: React.MouseEvent<HTMLElement>): boolean {
  if ((e.target as HTMLElement).closest(INTERACTIVE)) return false;
  // Selecting text to copy a code is not a request to expand.
  if (window.getSelection()?.toString()) return false;
  return true;
}

function SelectBox({
  m,
  selection,
}: {
  m: PosMachine;
  selection: NonNullable<DevicesListProps['selection']>;
}) {
  if (!selectable(m)) return null;
  return (
    <input
      type="checkbox"
      className="h-4 w-4 accent-[#007AFF]"
      aria-label={m.name}
      checked={selection.selected.has(m.id)}
      onChange={(e) => selection.onToggle([m.id], e.target.checked)}
    />
  );
}

// ── The list ─────────────────────────────────────────────────────────────────

export function DevicesList({
  machines,
  layout,
  sort,
  onSort,
  shops,
  companies,
  newest,
  permissions,
  actions,
  isDeviceOnline,
  onAddMachineToShop,
  onTerminalNumberForShop,
  selection,
  syncByMachine,
  onSyncShop,
}: DevicesListProps) {
  const t = useTranslations('machines');
  const tv = useTranslations('machines.devicesView');
  const tStatus = useTranslations('machineStatus');
  const tEvent = useTranslations('eventTills.assign');
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(readCollapsedAll);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildCompanyTree(companies), [companies]);

  const grouped = sort.key === 'shop';
  const groups = useMemo(
    () => (grouped ? groupByShop(machines, shops, tree, (k) => t(k)) : null),
    [grouped, machines, shops, tree, t],
  );
  const multiShop = useMemo(() => new Set(machines.map((m) => m.shopId ?? '')).size > 1, [machines]);
  const anyArea = machines.some((m) => !!m.areaName);
  // Under shop headers the shop is said already: the column is the area's, if any till has one.
  const placeShowsShop = !grouped && multiShop;
  const showPlace = placeShowsShop || anyArea;

  const isCollapsed = (key: string) => collapsed.get(key) ?? false;
  const toggleGroup = (key: string) => {
    const next = !isCollapsed(key);
    writeCollapsed(key, next);
    setCollapsed((prev) => new Map(prev).set(key, next));
  };
  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const shopNameOf = (m: PosMachine) =>
    m.shopId ? findBySameId(shops, m.shopId)?.name ?? m.shopId : t('groupUnassigned');

  const place = (m: PosMachine) =>
    placeShowsShop ? (
      <div className="min-w-0">
        <div className="truncate text-xs">{shopNameOf(m)}</div>
        {m.areaName ? <div className="truncate text-xs text-muted-foreground">{m.areaName}</div> : null}
      </div>
    ) : (
      <span className="truncate text-xs text-muted-foreground">{m.areaName ?? '—'}</span>
    );

  const groupHeader = (group: DeviceGroup) => (
    <MachineGroupHeader
      companyLabel={group.companyLabel}
      shopName={group.shopName}
      shopNumber={group.shop?.shopNumber}
      unassigned={group.unassigned}
      count={group.tills.length}
      screens={group.screens}
      tallies={group.tallies}
      collapsed={isCollapsed(group.key)}
      onToggle={() => toggleGroup(group.key)}
      onAddMachine={group.shop ? () => onAddMachineToShop(group.shop!, group.companyLabel ?? '') : undefined}
      onTerminalNumber={
        group.shop && onTerminalNumberForShop ? () => onTerminalNumberForShop(group.shop!) : undefined
      }
      onSyncShop={group.shop && onSyncShop && group.tills.length > 0 ? () => onSyncShop(group.shop!) : undefined}
    />
  );

  const shopSelect = (group: DeviceGroup) => {
    const pick = group.tills.filter(selectable);
    if (!selection || isCollapsed(group.key) || !group.shop || pick.length === 0) return null;
    return (
      <label className="flex cursor-pointer items-center gap-2 border-b bg-[#007AFF]/5 px-3 py-1.5 text-xs">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[#007AFF]"
          checked={pick.every((m) => selection.selected.has(m.id))}
          onChange={(e) => selection.onToggle(pick.map((m) => m.id), e.target.checked)}
        />
        {tEvent('selectShop')} ({pick.length})
      </label>
    );
  };

  const sections: Array<{ group: DeviceGroup | null; rows: PosMachine[] }> = groups
    ? groups.map((g) => ({ group: g, rows: isCollapsed(g.key) ? [] : g.rows }))
    : [{ group: null, rows: machines }];

  // ── Cards ──
  if (layout === 'cards') {
    const card = (m: PosMachine) => {
      const open = expanded.has(m.id);
      const detailsId = `device-details-${m.id}`;
      const statusText = tStatus(`status.${machineStatus(m)}`);
      return (
        <article
          key={m.id}
          onClick={(e) => (rowClickToggles(e) ? toggleRow(m.id) : undefined)}
          className={`min-w-0 cursor-pointer overflow-hidden rounded-lg border bg-card text-sm shadow-xs ${
            open ? 'md:col-span-2 xl:col-span-3' : ''
          }`}
        >
          <div className="space-y-2 p-3">
            <div className="flex items-start gap-2">
              {selection && selectable(m) ? (
                <span className="pt-0.5">
                  <SelectBox m={m} selection={selection} />
                </span>
              ) : null}
              <MachineStatusDot m={m} className="mt-1.5" />
              <div className="min-w-0 flex-1">
                <DeviceName m={m} />
                <div className="truncate text-xs text-muted-foreground">
                  {statusText}
                  {!grouped && m.shopId ? ` · ${shopNameOf(m)}` : ''}
                  {m.areaName ? ` · ${m.areaName}` : ''}
                </div>
              </div>
              <RowActions
                m={m}
                permissions={permissions}
                actions={actions}
                expanded={open}
                detailsId={detailsId}
                onToggle={() => toggleRow(m.id)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <DeviceRoleBadge m={m} showTill />
              <DevicePlatformBadge m={m} showAndroid />
              <DeviceModelBadge m={m} />
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{tv('columns.serial')}</dt>
              <dd className="min-w-0">
                <DeviceSerial m={m} />
              </dd>
              <dt className="text-muted-foreground">{tv('columns.version')}</dt>
              <dd className="min-w-0">
                <DeviceVersion m={m} newest={newest} />
              </dd>
              <dt className="text-muted-foreground">{tv('columns.lastSeen')}</dt>
              <dd className="min-w-0">
                <LastSeen m={m} />
              </dd>
              {m.autoStart ? (
                <>
                  <dt className="text-muted-foreground">{tv('columns.autoStart')}</dt>
                  <dd className="min-w-0">
                    <AutoStartBadge status={m.autoStart} />
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">סנכרון</dt>
              <dd className="min-w-0">
                <SyncCell status={syncByMachine?.get(m.id)} />
              </dd>
            </dl>
            <DeviceCodeLine m={m} />
            <div className="flex flex-wrap items-center gap-1">
              {isDisplayDevice(m) ? null : <MachineShiftChip m={m} />}
              <DeviceCommandChip machineId={m.id} />
              <MachineAlerts
                m={m}
                quietWhenNone
                onPinpadAddress={
                  permissions.canProduceZ && actions.onEditSettings && m.shopId ? actions.onEditSettings : undefined
                }
              />
            </div>
          </div>
          {open ? (
            <div id={detailsId}>
              <MachineRowDetails m={m} isDeviceOnline={isDeviceOnline} />
            </div>
          ) : null}
        </article>
      );
    };
    return (
      <div className="space-y-4">
        {sections.map(({ group, rows }) => (
          <section key={group?.key ?? 'all'} className="space-y-2">
            {group ? (
              <div className="overflow-hidden rounded-lg border">
                {groupHeader(group)}
                {shopSelect(group)}
              </div>
            ) : null}
            {rows.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map(card)}</div>
            ) : null}
          </section>
        ))}
      </div>
    );
  }

  // ── Table ──
  const pickable = machines.filter(selectable);
  const colCount = (selection ? 1 : 0) + (showPlace ? 1 : 0) + 10;

  const sortHeader = (key: SortKey, label: string, className = '') => {
    const active = sort.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`px-2 py-2 text-start font-medium ${className}`}
      >
        <button
          type="button"
          onClick={() => onSort(key)}
          className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground ${active ? 'text-foreground' : ''}`}
          title={tv('sortBy', { column: label })}
        >
          {label}
          {active ? (
            sort.dir === 'asc' ? (
              <ArrowUp className="h-3 w-3" aria-hidden />
            ) : (
              <ArrowDown className="h-3 w-3" aria-hidden />
            )
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
          )}
        </button>
      </th>
    );
  };

  const tableRow = (m: PosMachine) => {
    const open = expanded.has(m.id);
    const detailsId = `device-details-${m.id}`;
    const statusText = tStatus(`status.${machineStatus(m)}`);
    return (
      <Fragment key={m.id}>
        <tr
          onClick={(e) => (rowClickToggles(e) ? toggleRow(m.id) : undefined)}
          className={`cursor-pointer border-b align-top hover:bg-muted/40 ${open ? 'bg-muted/30' : ''}`}
        >
          {selection ? (
            <td className="w-8 px-2 py-2.5">
              <SelectBox m={m} selection={selection} />
            </td>
          ) : null}
          <td className="px-2 py-2">
            <div className="flex min-w-0 items-center gap-1.5" title={statusText}>
              <MachineStatusDot m={m} />
              <span className="max-w-[9rem] truncate text-xs">{statusText}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {isDisplayDevice(m) ? null : <MachineShiftChip m={m} />}
              <DeviceCommandChip machineId={m.id} />
            </div>
          </td>
          <td className="min-w-[12rem] px-2 py-2">
            <DeviceName m={m} />
            <DeviceCodeLine m={m} />
          </td>
          {showPlace ? <td className="max-w-[11rem] px-2 py-2">{place(m)}</td> : null}
          <td className="px-2 py-2">
            <div className="flex flex-wrap items-center gap-1">
              <DeviceRoleBadge m={m} showTill />
              <DevicePlatformBadge m={m} showAndroid={isDisplayDevice(m)} />
            </div>
          </td>
          <td className="px-2 py-2">
            {m.deviceModel ? <DeviceModelBadge m={m} /> : <span className="text-xs text-muted-foreground">—</span>}
          </td>
          <td className="px-2 py-1.5">
            <DeviceSerial m={m} stacked />
          </td>
          <td className="px-2 py-2">
            <DeviceVersion m={m} newest={newest} />
          </td>
          <td className="px-2 py-2">
            <AutoStartBadge status={m.autoStart} />
          </td>
          <td className="min-w-[7rem] px-2 py-2">
            <MachineAlerts
              m={m}
              onPinpadAddress={
                permissions.canProduceZ && actions.onEditSettings && m.shopId ? actions.onEditSettings : undefined
              }
            />
          </td>
          <td className="px-2 py-2">
            <SyncCell status={syncByMachine?.get(m.id)} />
          </td>
          <td className="px-2 py-2">
            <LastSeen m={m} />
          </td>
          <td className="px-1 py-1">
            <RowActions
              m={m}
              permissions={permissions}
              actions={actions}
              expanded={open}
              detailsId={detailsId}
              onToggle={() => toggleRow(m.id)}
            />
          </td>
        </tr>
        {open ? (
          <tr id={detailsId} className="border-b">
            <td colSpan={colCount} className="p-0">
              <MachineRowDetails m={m} isDeviceOnline={isDeviceOnline} />
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  };

  return (
    // The table scrolls inside its frame when the window is narrow; the page never does.
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
          <tr>
            {selection ? (
              <th scope="col" className="w-8 px-2 py-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#007AFF]"
                  aria-label={tv('selectAllShown')}
                  title={tv('selectAllShown')}
                  disabled={pickable.length === 0}
                  checked={pickable.length > 0 && pickable.every((m) => selection.selected.has(m.id))}
                  onChange={(e) => selection.onToggle(pickable.map((m) => m.id), e.target.checked)}
                />
              </th>
            ) : null}
            {sortHeader('status', tv('columns.status'))}
            {sortHeader('name', tv('columns.device'))}
            {showPlace ? sortHeader('shop', placeShowsShop ? tv('columns.place') : tv('columns.area')) : null}
            {sortHeader('role', tv('columns.role'))}
            {sortHeader('model', tv('columns.model'))}
            {sortHeader('serial', tv('columns.serial'))}
            {sortHeader('version', tv('columns.version'))}
            <th scope="col" className="px-2 py-2 text-start font-medium whitespace-nowrap">
              {tv('columns.autoStart')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-medium">
              {tv('columns.alerts')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-medium">
              סנכרון
            </th>
            {sortHeader('lastSeen', tv('columns.lastSeen'))}
            <th scope="col" className="px-2 py-2 text-end font-medium">
              <span className="sr-only">{tv('columns.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sections.map(({ group, rows }) => (
            <Fragment key={group?.key ?? 'all'}>
              {group ? (
                <tr>
                  <td colSpan={colCount} className="p-0">
                    {groupHeader(group)}
                    {shopSelect(group)}
                  </td>
                </tr>
              ) : null}
              {rows.map(tableRow)}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
