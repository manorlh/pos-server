'use client';

/**
 * One kiosk, remotely: pause (with a message) / resume, its shift or its Z by its Z mode
 * ("סגירת משמרת" in the shop Z, "הפקת Z" with its own — kiosk-z-actions.tsx), its name /
 * on-off / controlling tills, today's orders and the recent commands. Bon states are shown
 * as reported: "sent" is never shown as "printed".
 *
 * Commands are fire-and-forget ("פקודות שנשלחו", lib/deviceCommandsStore.ts): the POST answers
 * at once, the answer is followed in the background (the tray, the kiosk's chip), and nothing
 * here waits for the kiosk — only the clicked button is busy during its own HTTP call, so
 * more commands can be sent meanwhile.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Settings2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';
import { DeviceCommandChip } from '@/components/dashboard/device-commands/command-chip';
import { phaseOfKiosk } from '@/lib/deviceCommands';
import { trackCommand } from '@/lib/deviceCommandsStore';
import { cn } from '@/lib/utils';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime, formatTime } from '@/lib/format';
import { useTenantTimeZone } from '@/lib/auth';
import { agorotToShekels, isoDayInZone, kioskConnection } from '@/lib/kioskConfig';
import { pickupDateText } from '@/lib/kioskPickupSearch';
import {
  deleteKiosk,
  fetchKioskCommands,
  fetchKioskOrders,
  sendKioskCommand,
  updateKiosk,
  type KioskBonStatus,
  type KioskCommandAction,
  type KioskCommandIn,
  type KioskCommandOut,
  type KioskSummary,
} from '@/lib/kioskApi';
import type { PosMachine, Shop } from '@/lib/types';
import { agoText, ConnectionBadge, ModeBadge, StateBadges } from './kiosk-list';
import { controllerOptions } from './convert-dialog';
import { KioskLockControls, KioskScheduleControls } from './kiosk-lock-schedule';
import { KioskOpsNotes, KioskTerminalIdentityNote } from './kiosk-ops-notes';
import { KioskZActions, KioskZBadge, KioskZModeSwitch } from './kiosk-z-actions';
import { KioskWorkModeCard } from './kiosk-work-mode';

const BON_TONE: Record<KioskBonStatus, string> = {
  printed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  sent: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  queued: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  none: 'border text-muted-foreground',
};

/** [value] once it has stayed the same for [ms] (the order search asks the server after the typing stops). */
function useDebouncedText(value: string, ms = 350): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function timeIn(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return formatTime(iso, { timeZone });
}

/** A command on its way: what was sent, and to which kiosk (fixed at the click). */
interface KioskSend {
  body: KioskCommandIn;
  target: { machineId: string; name: string };
}

const KIOSK_COMMAND_KEY = ['kiosk-command'] as const;

/** "פקודות שנשלחו" names for the actions the shared label table does not know. */
const TRACK_LABEL: Partial<Record<KioskCommandAction, string>> = { schedule: 'פתיחה אוטומטית' };

/**
 * Follow a command the server took — applied at once ("בוצע"), or requested from the kiosk (a
 * close / Z it runs; the tray reads its outcome in the background). `machineId` is the kiosk's
 * machine id, the one in /kiosks/{id}/commands that the tray reads.
 */
function followKioskCommand(res: KioskCommandOut, { body, target }: KioskSend) {
  const action = res.action ?? body.action;
  const p = phaseOfKiosk(res.status, res.detail);
  trackCommand({
    kind: 'kiosk',
    id: res.id,
    action,
    label: TRACK_LABEL[action],
    machineId: target.machineId,
    machineName: target.name,
    phase: p.phase,
    detail: p.detail,
  });
}

/** The actions of this kiosk whose POST is still on its way — the HTTP call only, never the kiosk. */
function useSendingActions(machineId: string): KioskCommandAction[] {
  const sends = useMutationState({
    filters: { mutationKey: KIOSK_COMMAND_KEY, status: 'pending' },
    select: (m) => m.state.variables as KioskSend | undefined,
  });
  return sends.filter((s): s is KioskSend => !!s && s.target.machineId === machineId).map((s) => s.body.action);
}

function DetailsForm({
  kiosk,
  options,
  canWrite,
}: {
  kiosk: KioskSummary;
  options: { id: string; label: string; hint?: string | null }[];
  canWrite: boolean;
}) {
  const t = useTranslations('kiosks.detail');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [name, setName] = useState(kiosk.name);
  const [enabled, setEnabled] = useState(kiosk.enabled);
  const [controllers, setControllers] = useState<string[]>(kiosk.controllerMachineIds ?? []);
  const dirty =
    name.trim() !== kiosk.name ||
    enabled !== kiosk.enabled ||
    JSON.stringify([...controllers].sort()) !== JSON.stringify([...(kiosk.controllerMachineIds ?? [])].sort());

  const save = useMutation({
    mutationFn: () => updateKiosk(kiosk.machineId, { name: name.trim(), enabled, controllerMachineIds: controllers }),
    onSuccess: () => {
      toast.success(t('saved'));
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
    },
    onError: (err) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      toast.error(
        typeof detail === 'string' && detail.startsWith('invalid_controller')
          ? t('invalidController')
          : axiosErrorToToastMessage(err, tc('error')),
      );
    },
  });

  return (
    <section className="space-y-3 rounded-2xl border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">{t('rename')}</span>
          <Input value={name} disabled={!canWrite} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
          <span>
            <span className="block text-sm font-medium">{t('enabled')}</span>
            <span className="block text-xs text-muted-foreground">{t('enabledHint')}</span>
          </span>
          <Switch checked={enabled} disabled={!canWrite} onCheckedChange={(v) => setEnabled(!!v)} aria-label={t('enabled')} />
        </div>
      </div>
      <div className="space-y-1">
        <EntityMultiSelect
          label={t('controllers')}
          options={options}
          selected={controllers}
          onChange={setControllers}
          allLabel={t('controllersNone')}
          clearLabel={t('controllersClear')}
          emptyLabel={t('controllersEmpty')}
          disabled={!canWrite}
        />
        <p className="text-xs text-muted-foreground">{t('controllersHint')}</p>
      </div>
      {canWrite ? (
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || !name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            {t('saveDetails')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function KioskDetailDialog({
  kiosk,
  open,
  onOpenChange,
  canWrite,
  shops,
  machines,
  kiosks,
  nowMs,
  onOpenSettings,
}: {
  kiosk: KioskSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
  shops: Shop[];
  machines: PosMachine[];
  kiosks: KioskSummary[];
  nowMs: number;
  onOpenSettings: (k: KioskSummary) => void;
}) {
  const t = useTranslations('kiosks.detail');
  const tk = useTranslations('kiosks');
  const to = useTranslations('kiosks.orders');
  const tcmd = useTranslations('kiosks.command');
  const zErrors = useZErrorText();
  const qc = useQueryClient();
  const timeZone = useTenantTimeZone();

  const machineId = kiosk?.machineId ?? '';
  const today = isoDayInZone(new Date(nowMs), timeZone);
  // "חיפוש הזמנה": a pickup number ("17", "A17", "A-17") or a document number, over 30 days.
  const [orderQuery, setOrderQuery] = useState('');
  const searchOrders = useDebouncedText(orderQuery.trim());
  const searching = searchOrders.length > 0;
  const orders = useQuery({
    queryKey: ['kiosk-orders', machineId, today, searchOrders],
    queryFn: () => fetchKioskOrders(machineId, today, searchOrders || undefined),
    enabled: open && !!machineId,
    refetchInterval: 20_000,
  });
  const commands = useQuery({
    queryKey: ['kiosk-commands', machineId],
    queryFn: () => fetchKioskCommands(machineId, 20),
    enabled: open && !!machineId,
    refetchInterval: 15_000,
  });

  const kioskIds = useMemo(() => new Set(kiosks.map((k) => k.machineId)), [kiosks]);
  const options = useMemo(
    () => (kiosk ? controllerOptions(kiosk.shopId, kiosk.machineId, shops, machines, kioskIds) : []),
    [kiosk, shops, machines, kioskIds],
  );

  // Fire-and-forget: each click is its own mutation (several may be on their way at once); the
  // answer is tracked in "פקודות שנשלחו" (which pops its own small notice), a refusal or a failed
  // call is an error toast. Nothing waits for the kiosk.
  const command = useMutation({
    mutationKey: KIOSK_COMMAND_KEY,
    mutationFn: ({ body, target }: KioskSend) => sendKioskCommand(target.machineId, body),
    onSuccess: (res: KioskCommandOut, sent) => {
      if (res.status === 'refused') toast.error(res.detail || tcmd('status.refused'));
      else followKioskCommand(res, sent);
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      void qc.invalidateQueries({ queryKey: ['kiosk-commands', sent.target.machineId] });
    },
    onError: (err, sent) => {
      toast.error(zErrors.forError(err));
      void qc.invalidateQueries({ queryKey: ['kiosk-commands', sent.target.machineId] });
    },
  });
  const sending = useSendingActions(machineId);

  const revert = useMutation({
    mutationFn: () => deleteKiosk(machineId),
    onSuccess: () => {
      toast.success(tk('revert.done'));
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      void qc.invalidateQueries({ queryKey: ['kiosk-candidates'] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(zErrors.forError(err)),
  });

  if (!kiosk) return null;
  const connection = kioskConnection(kiosk, nowMs);
  const send = (body: KioskCommandIn) => command.mutate({ body, target: { machineId: kiosk.machineId, name: kiosk.name } });
  /** Only the button whose own POST is on its way is busy; every other action stays available. */
  const busy = (...actions: KioskCommandAction[]) => actions.some((a) => sending.includes(a));
  const list = orders.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {kiosk.name} <ModeBadge k={kiosk} /> <KioskZBadge k={kiosk} />
          </DialogTitle>
          <DialogDescription>
            {[kiosk.shopName, kiosk.machineName !== kiosk.name ? kiosk.machineName : null].filter(Boolean).join(' · ')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <ConnectionBadge k={kiosk} nowMs={nowMs} />
          <StateBadges k={kiosk} />
          {/* The last command sent to this kiosk and where it stands ("פקודות שנשלחו"). */}
          <DeviceCommandChip machineId={kiosk.machineId} />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: t('statSales'), value: formatCurrency(agorotToShekels(kiosk.salesTodayAgorot) ?? 0) },
            { label: t('statOrders'), value: String(kiosk.ordersToday ?? '—') },
            { label: t('statUnprinted'), value: String(kiosk.unprintedBons ?? 0), alert: (kiosk.unprintedBons ?? 0) > 0 },
            { label: t('statLastOrder'), value: agoText(kiosk.lastOrderAt, nowMs) ?? '—' },
          ].map((s) => (
            <div key={s.label} className={cn('rounded-2xl bg-muted/60 p-3', s.alert && 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300')}>
              <div className="text-[11px] text-muted-foreground">{s.label}</div>
              <div className="text-lg font-bold tabular-nums">{s.value}</div>
            </div>
          ))}
        </div>
        {connection !== 'online' ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('staleStats')}</p> : null}
        {/* "התראות לקופות" open now, and the last "סגירה יחד עם ה-Z הסניפי" */}
        <KioskOpsNotes k={kiosk} />
        <KioskTerminalIdentityNote k={kiosk} />

        {/* Remote actions */}
        <section className="space-y-3 rounded-2xl border p-4">
          <h3 className="font-semibold">{t('actions')}</h3>
          {!canWrite ? <p className="text-sm text-muted-foreground">{t('noWrite')}</p> : null}
          {connection !== 'online' && canWrite ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('offlineNote')}</p> : null}

          {/* "נעילה למכירה" and "פתיחה אוטומטית" (docs/SPEC_KIOSK.md §15) */}
          <KioskLockControls kiosk={kiosk} canWrite={canWrite} busy={busy('pause', 'resume')} send={send} />
          <KioskScheduleControls kiosk={kiosk} canWrite={canWrite} busy={busy('schedule')} send={send} />

          {/* "מצב עבודה: קיוסק / קופה" — only where the owner allowed it (kiosk-work-mode.tsx). */}
          <KioskWorkModeCard kiosk={kiosk} canWrite={canWrite} busy={busy('enter_till', 'return_kiosk')} send={send} />

          {/* The shift / Z by the kiosk's Z mode — "סגירת משמרת" in the shop Z, "הפקת Z" with its
              own, never both — and its own "Z עצמאי" switch (kiosk-z-actions.tsx). */}
          <div className="grid gap-3 sm:grid-cols-2">
            <KioskZActions kiosk={kiosk} canWrite={canWrite} busy={busy('close_shift', 'till_z')} send={send} />
            <KioskZModeSwitch kiosk={kiosk} />
          </div>
        </section>

        <DetailsForm key={`${kiosk.machineId}:${kiosk.name}:${kiosk.enabled}:${(kiosk.controllerMachineIds ?? []).join(',')}`} kiosk={kiosk} options={options} canWrite={canWrite} />

        {/* Today's orders — or, searching, the orders of that number over the last 30 days */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{searching ? to('searchTitle') : t('orders')}</h3>
            <Input
              value={orderQuery}
              onChange={(e) => setOrderQuery(e.target.value)}
              placeholder={to('searchPlaceholder')}
              aria-label={to('searchPlaceholder')}
              className="h-8 w-full sm:w-64"
            />
          </div>
          {connection !== 'online' ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('ordersStale')}</p> : null}
          {orders.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{searching ? to('searchEmpty') : t('ordersEmpty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{to('columns.pickup')}</TableHead>
                    {searching ? <TableHead>{to('columns.date')}</TableHead> : null}
                    <TableHead>{to('columns.time')}</TableHead>
                    <TableHead>{to('columns.service')}</TableHead>
                    <TableHead>{to('columns.total')}</TableHead>
                    <TableHead>{to('columns.bon')}</TableHead>
                    <TableHead>{to('columns.receipt')}</TableHead>
                    <TableHead>{to('columns.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-bold tabular-nums">
                        <bdi dir="ltr">{o.pickupLabel}</bdi>
                        {searching && o.matchedBy?.length ? (
                          <span className="block text-[11px] font-normal text-muted-foreground">
                            {o.matchedBy.map((m) => to(`matchedBy.${m}`)).join(' · ')}
                          </span>
                        ) : null}
                        {searching && o.transactionNumber ? (
                          <span className="block text-[11px] font-normal text-muted-foreground" dir="ltr">{String(o.transactionNumber)}</span>
                        ) : null}
                      </TableCell>
                      {searching ? <TableCell className="tabular-nums">{pickupDateText(o.businessDate)}</TableCell> : null}
                      <TableCell className="tabular-nums">{timeIn(o.paidAt, timeZone)}</TableCell>
                      <TableCell className="text-sm">
                        {o.serviceType ? to(`service.${o.serviceType}`) : <span className="text-muted-foreground">—</span>}
                        {o.tableRef ? <span className="text-xs text-muted-foreground"> · {to('table', { ref: o.tableRef })}</span> : null}
                        {o.customerName ? <span className="block text-xs text-muted-foreground">{o.customerName}</span> : null}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {formatCurrency(agorotToShekels(o.totalAgorot) ?? 0)}
                        <span className="block text-xs text-muted-foreground">
                          {to('items', { n: o.itemCount })}
                          {o.tipAgorot > 0 ? ` · ${to('tip', { amount: formatCurrency(agorotToShekels(o.tipAgorot) ?? 0) })}` : ''}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', BON_TONE[o.bonStatus] ?? BON_TONE.none)}
                          title={o.bonDetail ?? undefined}
                        >
                          {to.has(`bon.${o.bonStatus}`) ? to(`bon.${o.bonStatus}`) : o.bonStatus}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">{to.has(`receipt.${o.receiptStatus}`) ? to(`receipt.${o.receiptStatus}`) : o.receiptStatus}</TableCell>
                      <TableCell>
                        <Badge variant={o.status === 'paid' ? 'secondary' : 'destructive'}>
                          {to.has(`status.${o.status}`) ? to(`status.${o.status}`) : o.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {/* Recent commands */}
        <section className="space-y-2">
          <h3 className="font-semibold">{t('commands')}</h3>
          {(commands.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('commandsEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-2xl border">
              {(commands.data ?? []).map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="font-medium">{tcmd.has(`action.${c.action}`) ? tcmd(`action.${c.action}`) : c.action}</span>
                  <Badge variant={c.status === 'refused' ? 'destructive' : c.status === 'applied' ? 'secondary' : 'outline'}>
                    {tcmd.has(`status.${c.status}`) ? tcmd(`status.${c.status}`) : c.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {[c.requestedByName, tcmd.has(`source.${c.source}`) ? tcmd(`source.${c.source}`) : c.source].filter(Boolean).join(' · ')}
                  </span>
                  {c.detail ? <span className="w-full text-xs text-muted-foreground">{c.detail}</span> : null}
                  <span className="ms-auto text-xs text-muted-foreground tabular-nums">{formatDateTime(c.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenSettings(kiosk)}>
            <Settings2 /> {t('openSettings')}
          </Button>
          {canWrite ? (
            <Button
              variant="destructive"
              disabled={revert.isPending}
              onClick={() => {
                if (window.confirm(tk('revert.confirm', { name: kiosk.name }))) revert.mutate();
              }}
            >
              <Undo2 /> {tk('revert.button')}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
