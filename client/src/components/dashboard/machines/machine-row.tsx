'use client';

/**
 * One terminal, as a single dense row.
 *
 * This replaced a ~500px card per terminal. The card carried five stacked panels and
 * still never said which shop the till belonged to, which is the one thing an operator
 * looking at thirty terminals actually needs. So the row carries the eight facts that
 * are scannable side by side, and everything else moves behind the expander, where it
 * costs nothing until it is asked for.
 *
 * Two rules the row inherits rather than re-implements:
 *
 * * **The status light is the server's.** `MachineStatusLabel` renders `m.status` as
 *   resolved by `machine_status.py`; nothing here re-derives it. The Z wizard
 *   reads that same definition, and the two drifting apart is how a manager gets told a
 *   till is reachable when it is not.
 * * **Pending documents are a last-known reading, never a live count.** The "as of"
 *   line is not decoration — presenting `pendingDocuments` as current is a bug this
 *   page has already shipped once.
 *
 * Layout: a flex row that wraps onto two lines below `md`, and a fixed grid at `md` and
 * up. The mobile order is set with `max-md:order-*` so it cannot leak into the grid,
 * where `order` would reshuffle the columns. Every cell is start-aligned and vertically
 * centred, so a header caption sits over its values. The area is not a column (most
 * tills have none, and an empty column of dashes cost the row its width): it rides
 * under the name. Clicking the row anywhere but a link, button or the menu opens the
 * details.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import {
  BatteryLow,
  CalendarClock,
  ChevronDown,
  ClockAlert,
  Cpu,
  CreditCard,
  FileCog,
  FilePlus2,
  FileWarning,
  LayoutGrid,
  Link2,
  ListChecks,
  MoreHorizontal,
  Power,
  PrinterX,
  RadioTower,
  RefreshCwOff,
  Settings2,
  Send,
  Store,
  Trash2,
  TriangleAlert,
  Unplug,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { formatCurrency, formatHashNumber } from '@/lib/format';
import type { PosMachine } from '@/lib/types';
import { registerNumberOf } from '@/lib/registerNumber';
import { zWizardHref } from '@/lib/zAccess';
import { zModeOf } from '@/lib/tillZ';
import { canCloseShiftRemotely } from '@/components/dashboard/machines/remote-shift-close';
import {
  canTransmitRemotely,
  TransmissionSummary,
} from '@/components/dashboard/machines/card-transmission';
import { TerminalSummary } from '@/components/dashboard/machines/card-terminal';
import { DeviceModelBadge } from '@/components/dashboard/machines/device-model';
import { canRequestTillZ } from '@/components/dashboard/till-z/till-z-dialogs';
import { LatestTillZRequest, ZModeBadge } from '@/components/dashboard/till-z/till-z-request';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MachineHealthPanel } from '@/components/dashboard/machine-health';
import { DeadTillRecovery } from '@/components/dashboard/dead-till-recovery';
import { MachineStatusDot, machineStatus } from '@/components/dashboard/machine-status';
import { LicenseBadge, useIsSuperAdmin } from '@/components/dashboard/license-fields';

/**
 * The six columns — status, till, shift, alerts, last seen, actions — shared with the
 * table's header strip so the two cannot drift. Fixed widths at the edges and
 * proportional ones between, so no column's width depends on what one row holds.
 * Below `md` the grid is off entirely and the row lays itself out with flex-wrap.
 */
export const MACHINE_ROW_GRID =
  'md:grid md:grid-cols-[10rem_minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_7.5rem_4.5rem] md:items-center md:gap-x-4';

/** Everything the row needs to decide what a given operator may do with a terminal. */
export interface MachinePermissions {
  authHydrated: boolean;
  canAssignMachine: boolean;
  canEditAssignedShop: boolean;
  canRemoveMachine: boolean;
  /** May produce a Z, and close a till's shift remotely (the same server role set). */
  canProduceZ: boolean;
}

/** The dialogs the page owns; the row only asks for them to be opened. */
export interface MachineRowActions {
  onAssign: (m: PosMachine) => void;
  onEditShop: (m: PosMachine) => void;
  onPush: (m: PosMachine) => void;
  onRemove: (m: PosMachine) => void;
  /** Ask the till to close its open shift, without a Z. */
  onCloseShift: (m: PosMachine) => void;
  /** Move the till into an area of its shop, or out of one. */
  onEditArea?: (m: PosMachine) => void;
  /** Ask the till to transmit its card batch to Shva now. */
  onTransmit?: (m: PosMachine) => void;
  /** This till's own POS settings — the last layer, under its shop (tips and the rest). */
  onEditSettings?: (m: PosMachine) => void;
  /** Set (and optionally force into Agamento) this till's card terminal number. */
  onTerminalNumber?: (m: PosMachine) => void;
  /** Which hardware the till is: a 55F (prints) or a Modo (does not). */
  onEditDeviceModel?: (m: PosMachine) => void;
  /** Ask a `till`-mode till to produce its own Z. */
  onRequestTillZ?: (m: PosMachine) => void;
  /** Switch who produces the till's Z (the cloud or the till). */
  onEditZMode?: (m: PosMachine) => void;
}

export interface MachineRowProps {
  m: PosMachine;
  permissions: MachinePermissions;
  actions: MachineRowActions;
  /** Passed down rather than recomputed: the page owns the one online decision. */
  isDeviceOnline: (m: PosMachine) => boolean;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
}

function shiftBadgeVariant(m: PosMachine): 'default' | 'secondary' | 'outline' {
  if (m.closeShiftPending) return 'secondary';
  if (m.shiftStatus === 'open') return 'default';
  return 'outline';
}

/**
 * The till's shift, as the row shows it: open since when and by whom, a remote close
 * in flight, and how many closed shifts still wait for a Z.
 */
export function MachineShiftSummary({ m }: { m: PosMachine }) {
  const t = useTranslations('machines');
  const awaiting = m.closedShiftsAwaitingZ ?? 0;
  const orphans = m.orphanDocuments ?? 0;
  return (
    <div className="space-y-0.5">
      <Badge variant={shiftBadgeVariant(m)}>
        {m.closeShiftPending
          ? t('shift.closePending')
          : m.shiftStatus === 'open'
            ? m.openShiftSequence != null
              ? t('shift.openNumbered', { number: formatHashNumber(m.openShiftSequence) })
              : t('shift.open')
            : t('shift.none')}
      </Badge>
      {/* A Z run is what waits for this close: it is followed (and cancelled) there. */}
      {m.closeShiftPending && m.pendingCloseSource === 'z_run' && m.pendingZRunId ? (
        <Link
          href={`/dashboard/z-reports/new?runs=${m.pendingZRunId}`}
          className="block text-xs text-primary hover:underline"
        >
          {t('shift.pendingZRun')}
        </Link>
      ) : null}
      {m.shiftStatus === 'open' && m.openedAt ? (
        <p className="text-xs text-muted-foreground">
          {t('shift.openedAgo', {
            ago: formatDistanceToNow(new Date(m.openedAt), { addSuffix: true, locale: he }),
          })}
          {m.openedBy ? ` · ${t('shift.openedBy', { name: m.openedBy })}` : ''}
        </p>
      ) : null}
      {awaiting > 0 ? (
        <Link
          href={`/dashboard/shifts?awaitingZ=1&machine=${m.id}`}
          className="block text-xs text-amber-700 hover:underline dark:text-amber-400"
        >
          {t('shift.awaitingZ', { count: awaiting })}
        </Link>
      ) : null}
      {/* Documents the till sent without a shift: stored, but no Z will ever take
          them, so they are said out loud rather than left to be found by an audit. */}
      {orphans > 0 ? (
        <p className="text-xs text-destructive" title={t('shift.orphansHint')}>
          {t('shift.orphans', { count: orphans })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * MQTT is reported as three states, not two: a terminal that is offline is simply
 * disconnected, and `mqttConnected === null` on a reachable till means the broker has
 * not said either way — which is not the same as "disconnected" and must not be drawn
 * as one.
 */
function mqttState(m: PosMachine, online: boolean): boolean | null {
  if (!online) return false;
  if (m.mqttConnected === true) return true;
  if (m.mqttConnected === false) return false;
  return null;
}

/**
 * What the row calls a terminal: "קופה 2" when it has a register number, with the
 * free-text name kept beside it only when the name says something the number does not
 * (a name typed as "קופה 2" is not repeated). Without a number — no shop — the name
 * alone, exactly as before; never "קופה 0".
 *
 * `nameMismatch`: the name reads as another register ("קופה 3" on register 4) — a till
 * renamed by hand, or one that changed shop. The number is the truth; the hint says so.
 */
export function useMachineLabel(m: PosMachine): {
  primary: string;
  secondary: string | null;
  number: number | null;
  nameMismatch: boolean;
} {
  const t = useTranslations('machines');
  const n = registerNumberOf(m);
  if (n === null) return { primary: m.name, secondary: null, number: null, nameMismatch: false };
  const primary = t('registerLabel', { number: n });
  const name = m.name.trim();
  // The label's own wording with any number in it, so no Hebrew is spelled out here.
  const [before, after] = t('registerLabel', { number: 0 }).split('0');
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(
    `^${escape(before.trim())}\\s*#?(\\d+)\\s*${escape((after ?? '').trim())}$`,
  ).exec(name);
  return {
    primary,
    secondary: name && name !== primary ? name : null,
    number: n,
    nameMismatch: named !== null && Number(named[1]) !== n,
  };
}

/** The hint below, for a page that has the machine but not the row's label. */
export function MachineNameMismatchHint({ m }: { m: PosMachine }) {
  return useMachineLabel(m).nameMismatch ? <RegisterNameMismatch /> : null;
}

/** "השם אינו תואם את מספר הקופה", small and amber, beside the name it is about. */
export function RegisterNameMismatch({ className = '' }: { className?: string }) {
  const t = useTranslations('machines');
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400 ${className}`}
      title={t('nameMismatchHint')}
    >
      <TriangleAlert className="h-3 w-3" aria-hidden />
      {t('nameMismatch')}
    </span>
  );
}

function MachineRowMenu({
  m,
  permissions,
  actions,
}: Pick<MachineRowProps, 'm' | 'permissions' | 'actions'>) {
  const t = useTranslations('machines');
  const tZ = useTranslations('tillZ');
  const router = useRouter();
  const { authHydrated, canAssignMachine, canEditAssignedShop, canRemoveMachine, canProduceZ } =
    permissions;
  const isSuperAdmin = useIsSuperAdmin();
  const tillMode = zModeOf(m) === 'till';

  // Until the session has hydrated we do not know the role, and a menu that offers
  // everything and then removes half of it is worse than one that waits a beat.
  if (!authHydrated) return <Skeleton className="h-8 w-8 rounded-md" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t('rowActions')}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent className="w-56" align="end">
        {/* A label outside a group throws in Base UI, and takes the page down with it. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('rowActions')}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {m.pairingStatus === 'paired' && canAssignMachine ? (
          <DropdownMenuItem onClick={() => actions.onAssign(m)}>
            <Link2 aria-hidden /> {t('assignToMerchant')}
          </DropdownMenuItem>
        ) : null}
        {/* Says why the obvious next step is missing, instead of leaving a gap the
            operator reads as a broken menu. */}
        {m.pairingStatus === 'paired' && !canAssignMachine ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-amber-700 whitespace-normal dark:text-amber-500">
              {t('assignNoPermission')}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : null}
        {m.pairingStatus === 'assigned' && canEditAssignedShop ? (
          <DropdownMenuItem onClick={() => actions.onEditShop(m)}>
            <Store aria-hidden /> {t('changeShop')}
          </DropdownMenuItem>
        ) : null}
        {/* Same role set as `PUT /machines/{id}` (the machine admins, who also produce Zs). */}
        {canProduceZ && actions.onEditArea && m.shopId && m.pairingStatus === 'assigned' ? (
          <DropdownMenuItem onClick={() => actions.onEditArea?.(m)}>
            <LayoutGrid aria-hidden /> {t('changeArea')}
          </DropdownMenuItem>
        ) : null}
        {/* Same role set as `PATCH /machines/{id}/settings` (the machine admins). */}
        {canProduceZ && actions.onEditSettings && m.shopId ? (
          <DropdownMenuItem onClick={() => actions.onEditSettings?.(m)}>
            <Settings2 aria-hidden /> {t('tillSettings')}
          </DropdownMenuItem>
        ) : null}
        {/* `PUT /machines/{id}`, the machine admins' — the same set that produces a Z. */}
        {canProduceZ && actions.onEditDeviceModel ? (
          <DropdownMenuItem onClick={() => actions.onEditDeviceModel?.(m)}>
            <Cpu aria-hidden /> {t('deviceModel.change')}
          </DropdownMenuItem>
        ) : null}
        {/* Writes the till's settings layer, so the same role set as the item above. */}
        {canProduceZ && actions.onTerminalNumber && m.shopId ? (
          <DropdownMenuItem onClick={() => actions.onTerminalNumber?.(m)}>
            <CreditCard aria-hidden /> {t('updateTerminalNumber')}
          </DropdownMenuItem>
        ) : null}
        {/* Two separate actions. Closing the shift remotely only closes it (the X is
            filed, the shift waits for a Z); producing a Z is the wizard, which may also
            close an open shift as part of the run. */}
        {canProduceZ && canCloseShiftRemotely(m) ? (
          <DropdownMenuItem onClick={() => actions.onCloseShift(m)}>
            <Power aria-hidden /> {t('closeShiftRemotely')}
          </DropdownMenuItem>
        ) : null}
        {/* Same role set as a remote shift close (docs/SHIFTS_API.md §4.4). */}
        {canProduceZ && actions.onTransmit && canTransmitRemotely(m) ? (
          <DropdownMenuItem onClick={() => actions.onTransmit?.(m)}>
            <RadioTower aria-hidden /> {t('transmitNow')}
          </DropdownMenuItem>
        ) : null}
        {/* A till that produces its own Z is asked for it; the cloud never builds one
            for it, so the wizard's cloud Z is not offered for it here. */}
        {canProduceZ && tillMode && actions.onRequestTillZ ? (
          <DropdownMenuItem
            onClick={() => actions.onRequestTillZ?.(m)}
            disabled={!canRequestTillZ(m)}
          >
            <FilePlus2 aria-hidden /> {tZ('request.menu')}
          </DropdownMenuItem>
        ) : canProduceZ ? (
          <DropdownMenuItem
            onClick={() => router.push(zWizardHref(m.shopId, m.id))}
            disabled={m.pairingStatus !== 'assigned' || !m.shopId}
          >
            <FilePlus2 aria-hidden /> {t('produceZForTill')}
          </DropdownMenuItem>
        ) : null}
        {/* `PUT /machines/{id}` {zMode}: the roles that produce Zs (docs/SHIFTS_API.md §5.1). */}
        {/* The owner's rule: the super admin alone switches a till's Z mode. */}
        {isSuperAdmin && actions.onEditZMode && m.pairingStatus === 'assigned' && m.isActive !== false ? (
          <DropdownMenuItem onClick={() => actions.onEditZMode?.(m)}>
            <FileCog aria-hidden /> {tZ('mode.menu')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onClick={() => actions.onPush(m)}
          disabled={m.pairingStatus !== 'assigned'}
        >
          <Send aria-hidden /> {t('pushCatalog')}
        </DropdownMenuItem>
        {/* The till's own list lives on its page, where there is room for a checklist. */}
        <DropdownMenuItem
          onClick={() => router.push(`/dashboard/machines/${m.id}#catalog`)}
          disabled={!m.shopId}
        >
          <ListChecks aria-hidden /> {t('machineCatalog')}
        </DropdownMenuItem>
        {canRemoveMachine ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.onRemove(m)}>
              <Trash2 aria-hidden /> {t('remove')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The panels the card used to stack, revealed only for the row being looked at. */
function MachineRowDetails({
  m,
  isDeviceOnline,
}: Pick<MachineRowProps, 'm' | 'isDeviceOnline'>) {
  const t = useTranslations('machines');
  const tTerminal = useTranslations('cardTerminal');
  const tZ = useTranslations('tillZ');
  const online = isDeviceOnline(m);
  const mqtt = mqttState(m, online);

  return (
    <div className="grid gap-3 border-t bg-muted/20 px-3 py-3 md:grid-cols-2 xl:grid-cols-3">
      <MachineHealthPanel machine={m} />

      <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('statusLabel')}</span>
          <Badge
            variant={
              m.pairingStatus === 'assigned'
                ? 'default'
                : m.pairingStatus === 'paired'
                  ? 'secondary'
                  : 'outline'
            }
          >
            {m.pairingStatus === 'unpaired'
              ? t('pairingStatusLabels.unpaired')
              : m.pairingStatus === 'paired'
                ? t('pairingStatusLabels.paired')
                : m.pairingStatus === 'assigned'
                  ? t('pairingStatusLabels.assigned')
                  : m.pairingStatus}
          </Badge>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('deviceModel.label')}</span>
          <span className="text-xs">
            {m.deviceModel ? t(`deviceModel.${m.deviceModel}`) : t('deviceModel.unknown')}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('mqttStatus')}</span>
          <Badge variant={mqtt === true ? 'default' : mqtt === false ? 'outline' : 'secondary'}>
            {mqtt === true ? t('mqttOnline') : mqtt === false ? t('mqttOffline') : t('mqttUnknown')}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {m.lastHeartbeatAt ? (
            <>
              <Wifi className={`h-3.5 w-3.5 ${online ? 'text-green-500' : ''}`} aria-hidden />
              {t('lastSeen')}{' '}
              {formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he })}
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5" aria-hidden /> {t('neverSeen')}
            </>
          )}
        </div>
      </div>

      <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('syncPullStatus')}</span>
          <Badge variant={m.lastSyncAt ? 'secondary' : 'outline'}>
            {m.lastSyncAt ? t('synced') : t('neverSynced')}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {m.lastSyncAt ? (
            <>
              <Wifi className="h-3.5 w-3.5 text-green-500" aria-hidden />
              {t('lastSync')}{' '}
              {formatDistanceToNow(new Date(m.lastSyncAt), { addSuffix: true, locale: he })}
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5" aria-hidden /> {t('neverSynced')}
            </>
          )}
        </div>
      </div>

      <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="text-muted-foreground">{t('transmissionColumn')}</div>
        <TransmissionSummary m={m} />
      </div>

      {m.terminalStatus ? (
        <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="text-muted-foreground">{tTerminal('title')}</div>
          <TerminalSummary m={m} />
        </div>
      ) : null}
      {/* Who produces this till's Z, and — for a till that makes its own — the last
          time the dashboard asked it for one and how that went. */}
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{tZ('mode.label')}</span>
          <ZModeBadge mode={zModeOf(m)} />
        </div>
        <p className="text-xs text-muted-foreground">
          {zModeOf(m) === 'till' ? tZ('mode.tillHint') : tZ('mode.cloudHint')}
        </p>
        {zModeOf(m) === 'till' && m.shopId ? (
          <LatestTillZRequest machineId={m.id} shopId={m.shopId} />
        ) : null}
      </div>

      {m.lastCatalogChangeAt ? (
        <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{t('catalogFreshness')}</span>
            <Badge variant={m.catalogPullStale ? 'outline' : 'default'}>
              {m.catalogPullStale ? t('catalogStale') : t('catalogUpToDate')}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            {t('lastCloudChange')}{' '}
            {formatDistanceToNow(new Date(m.lastCatalogChangeAt), { addSuffix: true, locale: he })}
          </div>
        </div>
      ) : null}

      {/* Only for a terminal that is actually unreachable — offering it on a healthy
          till invites closing a shift out from under a cashier. */}
      {!online && m.pairingStatus === 'assigned' && m.isActive !== false ? (
        <div className="md:col-span-2 xl:col-span-3">
          <DeadTillRecovery m={m} />
        </div>
      ) : null}
    </div>
  );
}

/** "45 ד׳", "3 ש׳", "2 ימ׳" — how long a shift has been open, short enough for a chip. */
function useShortDuration() {
  const t = useTranslations('machines.shift.duration');
  return (iso: string): string | null => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return t('minutes', { n: Math.max(1, minutes) });
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return t('hours', { n: hours });
    return t('days', { n: Math.floor(hours / 24) });
  };
}

/**
 * The shift column: one chip ("#3 פתוחה · 3 ש׳", no shift, a close on its way), and
 * beside it the closed shifts still waiting for a Z as a small amber count. Who opened
 * it and when, in full, are the chip's title and in the details.
 */
export function MachineShiftChip({ m }: { m: PosMachine }) {
  const t = useTranslations('machines');
  const duration = useShortDuration();
  const awaiting = m.closedShiftsAwaitingZ ?? 0;

  let chip: React.ReactNode;
  if (m.closeShiftPending) {
    const badge = <Badge variant="secondary">{t('shift.closePending')}</Badge>;
    // A Z run is what waits for this close: it is followed (and cancelled) there.
    chip =
      m.pendingCloseSource === 'z_run' && m.pendingZRunId ? (
        <Link href={`/dashboard/z-reports/new?runs=${m.pendingZRunId}`} title={t('shift.pendingZRun')}>
          {badge}
        </Link>
      ) : (
        badge
      );
  } else if (m.shiftStatus === 'open') {
    const label =
      m.openShiftSequence != null
        ? t('shift.chipOpenNumbered', { number: m.openShiftSequence })
        : t('shift.chipOpen');
    const since = m.openedAt ? duration(m.openedAt) : null;
    const title = m.openedAt
      ? `${t('shift.openedAgo', {
          ago: formatDistanceToNow(new Date(m.openedAt), { addSuffix: true, locale: he }),
        })}${m.openedBy ? ` · ${t('shift.openedBy', { name: m.openedBy })}` : ''}`
      : undefined;
    chip = (
      <Badge variant="default" title={title} className="tabular-nums">
        {since ? t('shift.chipWithDuration', { label, duration: since }) : label}
      </Badge>
    );
  } else {
    chip = <Badge variant="outline">{t('shift.none')}</Badge>;
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {chip}
      {awaiting > 0 ? (
        <Link
          href={`/dashboard/shifts?awaitingZ=1&machine=${m.id}`}
          title={t('shift.awaitingZ', { count: awaiting })}
          className="rounded border border-amber-400/60 bg-amber-50 px-1.5 py-0.5 text-[11px] tabular-nums text-amber-800 hover:underline dark:bg-amber-950/30 dark:text-amber-300"
        >
          {t('shift.awaitingZShort', { count: awaiting })}
        </Link>
      ) : null}
    </span>
  );
}

/** An icon per status flag; the flag's words are its title (and for screen readers). */
const FLAG_ICON: Record<string, LucideIcon> = {
  shift_open_past_its_date: CalendarClock,
  catalog_behind: RefreshCwOff,
  clock_skewed: ClockAlert,
  low_battery: BatteryLow,
  realtime_down: Unplug,
  printer_problem: PrinterX,
};

const ALERT_BASE =
  'inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11px] leading-none tabular-nums';
const ALERT_MUTED = `${ALERT_BASE} border-muted-foreground/30 text-muted-foreground`;
const ALERT_AMBER = `${ALERT_BASE} border-amber-400/60 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300`;
const ALERT_RED = `${ALERT_BASE} border-destructive/50 bg-destructive/5 text-destructive`;

/**
 * The alerts column, as icons and short badges: everything the server flagged (but the
 * shifts awaiting a Z, which the shift column counts), a till on the wrong card terminal,
 * unsent documents with their age, and documents with no shift. The light stays the
 * server's; none of this changes it.
 */
export function MachineAlerts({ m }: { m: PosMachine }) {
  const t = useTranslations('machines');
  const tStatus = useTranslations('machineStatus');
  const tTerminal = useTranslations('cardTerminal');
  const tTx = useTranslations('transmission');
  const allFlags = m.statusFlags ?? [];
  const flags = allFlags.filter(
    (f) =>
      f !== 'closed_shifts_awaiting_z' &&
      // The critical one says it all when both are set.
      !(f === 'transmission_overdue' && allFlags.includes('transmission_critical')),
  );
  const pendingDocs = m.pendingAsOf && (m.pendingDocuments ?? 0) > 0 ? m.pendingDocuments! : 0;
  const orphans = m.orphanDocuments ?? 0;
  const txCount = m.pendingTransmissionCount ?? 0;
  const txSummary =
    txCount > 0
      ? tTx('pendingSummary', { count: txCount, amount: formatCurrency(m.pendingTransmissionAmount) })
      : null;
  const hasTxFlag = flags.some((f) => f.startsWith('transmission_'));

  const items: React.ReactNode[] = [];
  if (m.terminalStatus === 'mismatch') {
    items.push(
      <span
        key="terminal"
        className={ALERT_RED}
        title={tTerminal('mismatchDetail', {
          reported: m.terminalNumber ?? tTerminal('none'),
          expected: m.expectedTerminalNumber ?? tTerminal('none'),
        })}
      >
        <CreditCard className="h-3 w-3" aria-hidden />
        {t('alerts.terminal')}
      </span>,
    );
  }
  for (const f of flags) {
    const text = tStatus.has(`flag.${f}`) ? tStatus(`flag.${f}`) : f;
    if (f === 'transmission_overdue' || f === 'transmission_critical') {
      // Card sales the till has not transmitted: money at stake, in its colours.
      items.push(
        <Link
          key={f}
          href={`/dashboard/machines/${m.id}#transmission`}
          className={`${f === 'transmission_critical' ? ALERT_RED : ALERT_AMBER} hover:underline`}
          title={txSummary ? `${text} · ${txSummary}` : text}
        >
          <RadioTower className="h-3 w-3" aria-hidden />
          {txCount > 0 ? txCount : null}
          <span className="sr-only">{text}</span>
        </Link>,
      );
      continue;
    }
    const Icon = FLAG_ICON[f];
    items.push(
      Icon ? (
        <span key={f} className={f === 'printer_problem' ? ALERT_RED : ALERT_MUTED} title={text}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{text}</span>
        </span>
      ) : (
        <span key={f} className={ALERT_MUTED}>
          {text}
        </span>
      ),
    );
  }
  // Card sales waiting with nothing late yet: a quiet count, not an alarm.
  if (txSummary && !hasTxFlag) {
    items.push(
      <span key="tx" className={ALERT_MUTED} title={txSummary}>
        <RadioTower className="h-3 w-3" aria-hidden />
        {txCount}
      </span>,
    );
  }
  // A last-known reading, never a live count: its age is in the title.
  if (pendingDocs > 0) {
    items.push(
      <span
        key="pending"
        className={ALERT_AMBER}
        title={t('alerts.pendingDocsTitle', {
          count: pendingDocs,
          when: formatDistanceToNow(new Date(m.pendingAsOf!), { addSuffix: true, locale: he }),
        })}
      >
        <Send className="h-3 w-3" aria-hidden />
        {t('alerts.pendingDocs', { count: pendingDocs })}
      </span>,
    );
  }
  // Stored, but no Z will ever take them: said out loud rather than left to an audit.
  if (orphans > 0) {
    items.push(
      <span key="orphans" className={ALERT_RED} title={t('shift.orphansHint')}>
        <FileWarning className="h-3 w-3" aria-hidden />
        {t('alerts.orphans', { count: orphans })}
      </span>,
    );
  }

  if (items.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return <span className="flex min-w-0 flex-wrap items-center gap-1">{items}</span>;
}

/** Clicks on these do what they are, not open the row's details. */
const INTERACTIVE = 'a, button, input, select, textarea, [role="menuitem"], [role="menu"]';

export function MachineRow({
  m,
  permissions,
  actions,
  isDeviceOnline,
  expanded,
  onToggleExpanded,
}: MachineRowProps) {
  const t = useTranslations('machines');
  const tStatus = useTranslations('machineStatus');
  const detailsId = `machine-details-${m.id}`;
  const label = useMachineLabel(m);
  const statusText = tStatus(`status.${machineStatus(m)}`);

  const onRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    // Selecting text to copy a code is not a request to expand.
    if (window.getSelection()?.toString()) return;
    onToggleExpanded(m.id);
  };

  return (
    <div className="border-b last:border-b-0">
      <div
        onClick={onRowClick}
        className={`flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 text-sm hover:bg-muted/40 md:min-h-12 ${
          expanded ? 'bg-muted/30' : ''
        } ${MACHINE_ROW_GRID}`}
      >
        {/* The narrow row keeps just the dot, which is all that fits beside the name. */}
        <div className="flex min-w-0 items-center gap-2 max-md:order-1" title={statusText}>
          <MachineStatusDot m={m} />
          <span className="truncate text-xs max-md:hidden">{statusText}</span>
        </div>

        <div className="min-w-0 max-md:order-2 max-md:flex-1">
          {/* A device is a place you can go into now, not just a row. */}
          {/* The register number is how the shop names a till, so it leads; the free-text
              name follows only when it says something the number does not. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              href={`/dashboard/machines/${m.id}`}
              className={`shrink-0 hover:underline ${label.number !== null ? 'font-semibold' : 'font-medium'}`}
            >
              {label.primary}
            </Link>
            {label.secondary ? (
              <span className="truncate text-xs text-muted-foreground">{label.secondary}</span>
            ) : null}
            {label.nameMismatch ? <RegisterNameMismatch /> : null}
            <LicenseBadge value={m} className="shrink-0" />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate" dir="ltr">
              {m.machineCode}
            </span>
            <DeviceModelBadge m={m} />
            {/* Only the exception is marked: most tills are on the shop's cloud Z. */}
            {zModeOf(m) === 'till' ? (
              <ZModeBadge mode="till" className="h-4 shrink-0 px-1 text-[10px]" />
            ) : null}
            {m.areaName ? <span className="truncate">· {m.areaName}</span> : null}
          </div>
        </div>

        <div className="min-w-0 max-md:order-5">
          <MachineShiftChip m={m} />
        </div>

        <div className="min-w-0 max-md:order-6">
          <MachineAlerts m={m} />
        </div>

        <div className="truncate text-xs text-muted-foreground max-md:order-7">
          {m.lastHeartbeatAt
            ? formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he })
            : t('neverSeen')}
        </div>

        {/* Stops here so a menu item (in a portal, but bubbling through React) never
            also toggles the row. */}
        <div
          className="flex items-center justify-end gap-1 max-md:order-3"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => onToggleExpanded(m.id)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={t('rowToggle')}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </Button>
          <MachineRowMenu m={m} permissions={permissions} actions={actions} />
        </div>

        {/* Forces the wrap below `md`; on the grid it is not a cell at all. */}
        <div className="basis-full max-md:order-4 md:hidden" aria-hidden />
      </div>

      {expanded ? (
        <div id={detailsId}>
          <MachineRowDetails m={m} isDeviceOnline={isDeviceOnline} />
        </div>
      ) : null}
    </div>
  );
}
