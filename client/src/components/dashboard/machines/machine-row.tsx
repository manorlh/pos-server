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
 *   resolved by `machine_status.py`; nothing here re-derives it. The close-day gate
 *   reads that same definition, and the two drifting apart is how a manager gets told a
 *   till is reachable when it is not.
 * * **Pending documents are a last-known reading, never a live count.** The "as of"
 *   line is not decoration — presenting `pendingDocuments` as current is a bug this
 *   page has already shipped once.
 *
 * Layout: a flex row that wraps onto two lines below `md`, and a fixed grid at `md` and
 * up. The mobile order is set with `max-md:order-*` so it cannot leak into the grid,
 * where `order` would reshuffle the columns.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import {
  CalendarClock,
  ChevronDown,
  Link2,
  ListChecks,
  MoreHorizontal,
  Send,
  Store,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { PosMachine } from '@/lib/types';
import { registerNumberOf } from '@/lib/registerNumber';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MachineHealthPanel } from '@/components/dashboard/machine-health';
import { DeadTillRecovery } from '@/components/dashboard/dead-till-recovery';
import {
  MachineStatusDot,
  MachineStatusFlags,
  MachineStatusLabel,
} from '@/components/dashboard/machine-status';

/**
 * The eight columns, shared with the table's header strip so the two cannot drift.
 * Below `md` the grid is off entirely and the row lays itself out with flex-wrap.
 */
export const MACHINE_ROW_GRID =
  'md:grid md:grid-cols-[auto_minmax(9rem,auto)_minmax(0,2fr)_minmax(0,1.4fr)_auto_auto_auto_auto] md:items-center md:gap-x-3';

/** Everything the row needs to decide what a given operator may do with a terminal. */
export interface MachinePermissions {
  authHydrated: boolean;
  canAssignMachine: boolean;
  canEditAssignedShop: boolean;
  canRemoveMachine: boolean;
  canCloseDay: boolean;
}

/** The dialogs the page owns; the row only asks for them to be opened. */
export interface MachineRowActions {
  onAssign: (m: PosMachine) => void;
  onEditShop: (m: PosMachine) => void;
  onPush: (m: PosMachine) => void;
  onCloseDay: (m: PosMachine) => void;
  onRemove: (m: PosMachine) => void;
}

export interface MachineRowProps {
  m: PosMachine;
  permissions: MachinePermissions;
  actions: MachineRowActions;
  /** Passed down rather than recomputed: the page owns the one online decision. */
  isDeviceOnline: (m: PosMachine) => boolean;
  canCloseMachine: (m: PosMachine) => boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
}

function tradingDayBadgeVariant(m: PosMachine): 'default' | 'secondary' | 'outline' {
  if (m.closeDayPending) return 'secondary';
  if (m.tradingDayStatus === 'open') return 'default';
  return 'outline';
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
 */
export function useMachineLabel(m: PosMachine): { primary: string; secondary: string | null } {
  const t = useTranslations('machines');
  const n = registerNumberOf(m);
  if (n === null) return { primary: m.name, secondary: null };
  const primary = t('registerLabel', { number: n });
  const name = m.name.trim();
  return { primary, secondary: name && name !== primary ? name : null };
}

function MachineRowMenu({
  m,
  permissions,
  actions,
  canCloseMachine,
}: Pick<MachineRowProps, 'm' | 'permissions' | 'actions' | 'canCloseMachine'>) {
  const t = useTranslations('machines');
  const router = useRouter();
  const { authHydrated, canAssignMachine, canEditAssignedShop, canRemoveMachine, canCloseDay } =
    permissions;

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
        <DropdownMenuLabel>{t('rowActions')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {m.pairingStatus === 'paired' && canAssignMachine ? (
          <DropdownMenuItem onClick={() => actions.onAssign(m)}>
            <Link2 aria-hidden /> {t('assignToMerchant')}
          </DropdownMenuItem>
        ) : null}
        {/* Says why the obvious next step is missing, instead of leaving a gap the
            operator reads as a broken menu. */}
        {m.pairingStatus === 'paired' && !canAssignMachine ? (
          <DropdownMenuLabel className="text-amber-700 whitespace-normal dark:text-amber-500">
            {t('assignNoPermission')}
          </DropdownMenuLabel>
        ) : null}
        {m.pairingStatus === 'assigned' && canEditAssignedShop ? (
          <DropdownMenuItem onClick={() => actions.onEditShop(m)}>
            <Store aria-hidden /> {t('changeShop')}
          </DropdownMenuItem>
        ) : null}
        {canCloseDay ? (
          <DropdownMenuItem onClick={() => actions.onCloseDay(m)} disabled={!canCloseMachine(m)}>
            <CalendarClock aria-hidden /> {t('closeDay')}
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
          till invites closing a day out from under a cashier. */}
      {!online && m.pairingStatus === 'assigned' ? (
        <div className="md:col-span-2 xl:col-span-3">
          <DeadTillRecovery m={m} />
        </div>
      ) : null}
    </div>
  );
}

export function MachineRow({
  m,
  permissions,
  actions,
  isDeviceOnline,
  canCloseMachine,
  selected,
  onToggleSelected,
  expanded,
  onToggleExpanded,
}: MachineRowProps) {
  const t = useTranslations('machines');
  const tStatus = useTranslations('machineStatus');
  const detailsId = `machine-details-${m.id}`;
  const selectable = permissions.canCloseDay && m.pairingStatus === 'assigned';
  const hasPending = !!m.pendingAsOf && (m.pendingDocuments ?? 0) > 0;
  const label = useMachineLabel(m);

  return (
    <div className="border-b last:border-b-0">
      <div
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm hover:bg-muted/40 ${MACHINE_ROW_GRID}`}
      >
        <div className="max-md:order-1">
          {selectable ? (
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-primary"
              checked={selected}
              onChange={() => onToggleSelected(m.id)}
              aria-label={label.secondary ? `${label.primary} · ${label.secondary}` : label.primary}
            />
          ) : (
            <span className="block h-4 w-4" aria-hidden />
          )}
        </div>

        {/*
          `MachineStatusLabel` already carries its own dot, so the wide row shows the
          label alone rather than two lights side by side; the narrow row keeps just the
          dot, which is all that fits beside the name.
        */}
        <div className="max-md:order-2">
          <span className="md:hidden">
            <MachineStatusDot m={m} />
          </span>
          <span className="hidden md:inline-flex">
            <MachineStatusLabel m={m} />
          </span>
        </div>

        <div className="min-w-0 max-md:order-3 max-md:flex-1">
          {/* A device is a place you can go into now, not just a row. */}
          <Link
            href={`/dashboard/machines/${m.id}`}
            className="flex min-w-0 items-baseline gap-1.5 hover:underline"
          >
            <span className="shrink-0 font-medium">{label.primary}</span>
            {label.secondary ? (
              <span className="truncate text-xs text-muted-foreground">{label.secondary}</span>
            ) : null}
          </Link>
          <p className="truncate text-xs text-muted-foreground" dir="ltr">
            {m.machineCode}
          </p>
        </div>

        <div className="min-w-0 max-md:order-7">
          <MachineStatusFlags m={m} />
        </div>

        <div className="max-md:hidden">
          <Badge variant={tradingDayBadgeVariant(m)}>
            {m.closeDayPending
              ? t('tradingDayPending')
              : m.tradingDayStatus === 'open'
                ? t('tradingDayOpen')
                : t('tradingDayNone')}
          </Badge>
          {m.tradingDayStatus === 'open' && m.openedAt ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('tradingDayOpenedAt')}{' '}
              {formatDistanceToNow(new Date(m.openedAt), { addSuffix: true, locale: he })}
            </p>
          ) : null}
        </div>

        {/*
          Unsent documents, with the reading's age attached. The count on its own reads
          as live and is not — it is whatever the terminal last managed to report.
        */}
        <div className="text-xs max-md:hidden">
          {hasPending ? (
            <>
              <span className="tabular-nums">
                {tStatus('pendingDocuments', { count: m.pendingDocuments ?? 0 })}
              </span>
              <span className="block text-muted-foreground">
                {t('pendingAsOf', {
                  when: formatDistanceToNow(new Date(m.pendingAsOf!), {
                    addSuffix: true,
                    locale: he,
                  }),
                })}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>

        <div className="text-xs text-muted-foreground max-md:order-6">
          {m.lastHeartbeatAt
            ? formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he })
            : t('neverSeen')}
        </div>

        <div className="flex items-center justify-end gap-1 max-md:order-4">
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
          <MachineRowMenu
            m={m}
            permissions={permissions}
            actions={actions}
            canCloseMachine={canCloseMachine}
          />
        </div>

        {/* Forces the wrap below `md`; on the grid it is not a cell at all. */}
        <div className="basis-full max-md:order-5 md:hidden" aria-hidden />
      </div>

      {expanded ? (
        <div id={detailsId}>
          <MachineRowDetails m={m} isDeviceOnline={isDeviceOnline} />
        </div>
      ) : null}
    </div>
  );
}
