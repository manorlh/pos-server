'use client';

/**
 * "שרת מקומי ייעודי" on the dashboard (pos-server P:/specs/dedicated-local-server.md §7, §11):
 *
 * - `LocalServerDeviceCard` — the device page's "שרת מקומי" card: what it serves, its tills, open
 *   orders, print queue, printers, the cloud mirror's lag, and its remote commands (restart the
 *   service, send logs, a test page per printer, clearing a stuck queue — confirmed first).
 * - `LocalServerShopCard` — the shop page: the shop's servers, and "גיבוי אוטומטי לשרת המקומי",
 *   off by default, changed by the super admin or a holder of "העברת שרת מקומי".
 *
 * The rules are pure, in lib/lanMode.ts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Server, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  NO_PRINT_HOST,
  SERVER_ACTIONS,
  SERVER_ROLES,
  roleChoices,
  rolesBody,
  rolesDraftError,
  rolesDraftOf,
  failoverBody,
  failoverDraftError,
  failoverDraftOf,
  failoverTone,
  hostingRoles,
  printQueueTone,
  printerStateOf,
  printerTone,
  serverCommandBody,
  serverCommandNeedsConfirm,
  syncTone,
  type FailoverDraft,
  type LocalServerFailover,
  type LocalServerRolesView,
  type RolesDraft,
  type ServerAction,
  type Tone,
} from '@/lib/lanMode';
import {
  fetchLocalServer,
  fetchLocalServerCard,
  fetchLocalServerFailover,
  fetchLocalServerRoles,
  localServerCardKey,
  localServerFailoverKey,
  localServerKey,
  localServerRolesKey,
  saveLocalServerFailover,
  saveLocalServerRoles,
  sendLocalServerCommand,
} from '@/lib/localServerApi';
import { refusalOf } from '@/lib/zParticipation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

function ago(ms: number | null | undefined, t: (k: string, v?: Record<string, string>) => string): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return s < 120 ? t('agoSeconds', { n: String(s) }) : t('agoMinutes', { n: String(Math.round(s / 60)) });
}

// ── The device page ──────────────────────────────────────────────────────────

export function LocalServerDeviceCard({ machineId }: { machineId: string }) {
  const t = useTranslations('localServer.device');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: localServerCardKey(machineId),
    queryFn: () => fetchLocalServerCard(machineId),
    refetchInterval: 30_000,
  });
  const [confirmClear, setConfirmClear] = useState(false);
  const send = useMutation({
    mutationFn: (args: { action: ServerAction; printerId?: string | null; confirmed?: boolean }) =>
      sendLocalServerCommand(machineId, serverCommandBody(args.action, { printerId: args.printerId, scope: 'all', confirmed: args.confirmed })),
    onSuccess: () => {
      setConfirmClear(false);
      toast.success(t('sent'));
      void qc.invalidateQueries({ queryKey: localServerCardKey(machineId) });
    },
    onError: (err: unknown) => toast.error(refusalOf(err)?.message ?? axiosErrorToToastMessage(err, tc('error'))),
  });
  const d = query.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Server className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {query.isLoading || !d ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={d.online ? 'secondary' : 'destructive'}>{d.online ? t('online') : t('offline')}</Badge>
              {d.isHost ? (
                hostingRoles(d.hosting).map((r) => (
                  <Badge key={r} variant="outline">{t(`roles.${r}`)}</Badge>
                ))
              ) : (
                <Badge variant="outline">{t('standby')}</Badge>
              )}
              <span className="text-xs text-muted-foreground">{t('notTillLicense')}</span>
            </div>
            {!d.fresh && d.reportedAt ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('asOf', { at: formatDateTime(d.reportedAt) })}</p>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">{t('tills')}</dt>
                <dd className="font-medium">{d.connectedTills ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('openOrders')}</dt>
                <dd className="font-medium">{d.openOrders ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('printQueue')}</dt>
                <dd className={`font-medium ${TONE_CLASS[printQueueTone(d.printQueue)]}`}>
                  {t('queueValue', { pending: String(d.printQueue?.pending ?? '—'), failed: String(d.printQueue?.failed ?? '—') })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('mirror')}</dt>
                <dd className={`font-medium ${TONE_CLASS[syncTone(d.mirror)]}`}>
                  {d.mirror.state === 'synced' ? t('mirrorSynced') : d.mirror.pending ? t('mirrorPending', { n: String(d.mirror.pending) }) : t('mirrorUnknown')}
                </dd>
              </div>
            </dl>
            {d.tills.length ? (
              <p className="text-xs text-muted-foreground">
                {d.tills.map((till) => `${till.name ?? till.machineId} (${ago(till.ageMs, t)})`).join(' · ')}
              </p>
            ) : null}
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('printers')}</p>
              {d.printers.length ? (
                <ul className="space-y-1">
                  {d.printers.map((p, i) => (
                    <li key={p.printerId ?? `p-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1">
                      <span>
                        {p.name ?? '—'}{' '}
                        <span className={TONE_CLASS[printerTone(p.state)]}>{t(`printerStates.${printerStateOf(p.state)}`)}</span>
                        {p.message ? <span className="text-xs text-muted-foreground"> · {p.message}</span> : null}
                      </span>
                      {p.printerId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={send.isPending}
                          onClick={() => send.mutate({ action: 'print_test_page', printerId: p.printerId })}
                        >
                          {t('actions.print_test_page')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t('none')}</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {[d.appVersion, d.serialNumber, d.lanIp].filter(Boolean).join(' · ')}
            </p>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t('commands')}</p>
              <div className="flex flex-wrap gap-2">
                {SERVER_ACTIONS.filter((a) => a !== 'print_test_page').map((action) =>
                  serverCommandNeedsConfirm(action) ? (
                    <Button
                      key={action}
                      size="sm"
                      variant={confirmClear ? 'destructive' : 'outline'}
                      disabled={send.isPending}
                      onClick={() => (confirmClear ? send.mutate({ action, confirmed: true }) : setConfirmClear(true))}
                    >
                      {confirmClear ? t('confirmClear') : t(`actions.${action}`)}
                    </Button>
                  ) : (
                    <Button key={action} size="sm" variant="outline" disabled={send.isPending} onClick={() => send.mutate({ action })}>
                      {t(`actions.${action}`)}
                    </Button>
                  ),
                )}
              </div>
              {confirmClear ? <p className="text-xs text-destructive">{t('confirmClearHint')}</p> : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── The shop page ────────────────────────────────────────────────────────────

export function LocalServerShopCard({ shopId }: { shopId: string }) {
  const t = useTranslations('localServer');
  const state = useQuery({ queryKey: localServerKey(shopId), queryFn: () => fetchLocalServer(shopId) });
  const failover = useQuery({ queryKey: localServerFailoverKey(shopId), queryFn: () => fetchLocalServerFailover(shopId) });
  const roles = useQuery({ queryKey: localServerRolesKey(shopId), queryFn: () => fetchLocalServerRoles(shopId) });
  const servers = state.data?.servers ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Server className="h-4 w-4" aria-hidden />
          {t('device.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {state.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : servers.length ? (
          <ul className="space-y-1">
            {servers.map((s) => (
              <li key={s.machineId} className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1">
                <span className="font-medium">{s.name}</span>
                <Badge variant={s.online ? 'secondary' : 'destructive'}>{s.online ? t('device.online') : t('device.offline')}</Badge>
                {s.isHost ? (
                  hostingRoles(s.hosting).map((r) => <Badge key={r} variant="outline">{t(`device.roles.${r}`)}</Badge>)
                ) : (
                  <Badge variant="outline">{t('device.standby')}</Badge>
                )}
                <span className={`text-xs ${TONE_CLASS[syncTone(s.mirror)]}`}>
                  {s.mirror.state === 'synced' ? t('device.mirrorSynced') : s.mirror.pending ? t('device.mirrorPending', { n: String(s.mirror.pending) }) : t('device.mirrorUnknown')}
                </span>
                {s.printQueue ? (
                  <span className={`text-xs ${TONE_CLASS[printQueueTone(s.printQueue)]}`}>
                    {t('device.queueValue', { pending: String(s.printQueue.pending ?? '—'), failed: String(s.printQueue.failed ?? '—') })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('device.noServers')}</p>
        )}
        {roles.data?.applies ? <RolesSettings key={JSON.stringify(rolesDraftOf(roles.data))} shopId={shopId} data={roles.data} /> : null}
        {failover.data ? (
          <FailoverSettings shopId={shopId} data={failover.data} candidates={state.data?.candidates ?? []} server={state.data?.server ?? null} />
        ) : failover.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * "תפקידי השרת המקומי" (§11.9): which roles the dedicated server holds — the tables, the printing
 * (or no print server at all), the shop Z — each one it is not given held by a till.
 */
function RolesSettings({ shopId, data }: { shopId: string; data: LocalServerRolesView }) {
  const t = useTranslations('localServer.roles');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<RolesDraft>(() => rolesDraftOf(data));
  const error = rolesDraftError(draft, data);
  const save = useMutation({
    mutationFn: () => saveLocalServerRoles(shopId, rolesBody(draft, data.localMode)),
    onSuccess: (out) => {
      qc.setQueryData(localServerRolesKey(shopId), out);
      void qc.invalidateQueries({ queryKey: localServerKey(shopId) });
      void qc.invalidateQueries({ queryKey: ['main-till', shopId] });
      void qc.invalidateQueries({ queryKey: ['kitchen-printers', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(refusalOf(err)?.message ?? axiosErrorToToastMessage(err, tc('error'))),
  });
  const dirty = JSON.stringify(rolesBody(draft, data.localMode)) !== JSON.stringify(rolesBody(rolesDraftOf(data), data.localMode));
  const label = (c: { machineId: string; posNumber?: string | null; name?: string | null; deviceRole?: string | null }) =>
    c.deviceRole === 'local_server' ? `${t('server')} (${c.name ?? '—'})` : c.posNumber ? `${c.posNumber} · ${c.name ?? ''}` : c.name ?? '—';
  const roles = SERVER_ROLES.filter((r) => r !== 'shopZ' || data.localMode);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="font-medium">{t('title')}</p>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {roles.map((role) => (
          <label key={role} className="space-y-1">
            <span className="block text-xs font-medium">{t(role)}</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={draft[role]}
              disabled={!data.canEdit || save.isPending}
              onChange={(e) => setDraft({ ...draft, [role]: e.target.value })}
            >
              <option value="" disabled>{t('pick')}</option>
              {roleChoices(data, draft[role]).map((c) => (
                <option key={c.machineId} value={c.machineId}>
                  {label(c)}
                </option>
              ))}
              {role === 'print' && data.noPrintHostSupported && (data.noPrintHostAllowed || draft.print === NO_PRINT_HOST) ? (
                <option value={NO_PRINT_HOST}>{t('none')}</option>
              ) : null}
            </select>
          </label>
        ))}
      </div>
      {!data.localMode ? <p className="text-xs text-muted-foreground">{t('notLocal')}</p> : null}
      {draft.print === NO_PRINT_HOST ? <p className="text-xs text-muted-foreground">{t('noneHint')}</p> : null}
      {error === 'printNone' || (!data.noPrintHostAllowed && data.noPrintHostSupported) ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('noneRemote')}</p>
      ) : null}
      {data.canEdit ? (
        <Button size="sm" disabled={!!error || !dirty || save.isPending} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
      )}
    </div>
  );
}

function FailoverSettings({
  shopId,
  data,
  candidates,
  server,
}: {
  shopId: string;
  data: LocalServerFailover;
  candidates: { machineId: string; posNumber?: string | null; name?: string | null; deviceRole?: string | null; reason?: string | null }[];
  server: { machineId: string; posNumber?: string | null; name?: string | null } | null;
}) {
  const t = useTranslations('localServer.failover');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<FailoverDraft>(() => failoverDraftOf(data));
  const error = failoverDraftError(draft, data);
  const save = useMutation({
    mutationFn: () => saveLocalServerFailover(shopId, failoverBody(draft)),
    onSuccess: (out) => {
      qc.setQueryData(localServerFailoverKey(shopId), out);
      void qc.invalidateQueries({ queryKey: localServerKey(shopId) });
      setDraft(failoverDraftOf(out));
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(refusalOf(err)?.message ?? axiosErrorToToastMessage(err, tc('error'))),
  });
  // Every device that may take the server, online or not now (the wizard's list), never the server itself.
  const options = candidates.filter(
    (c) => (!c.reason || c.reason === 'offline') && (!server || c.machineId !== server.machineId),
  );
  const label = (c: { posNumber?: string | null; name?: string | null; deviceRole?: string | null }) =>
    `${c.posNumber ? t('till', { n: c.posNumber }) : c.name ?? '—'}${c.deviceRole === 'local_server' ? ` (${t('server')})` : ''}`;
  const dirty = JSON.stringify(failoverBody(draft)) !== JSON.stringify(failoverBody(failoverDraftOf(data)));
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden />
        {t('title')}
      </p>
      <p className="text-xs text-muted-foreground">{t('offByDefault')}</p>
      <p className={`text-xs ${TONE_CLASS[failoverTone(data)]}`}>{data.status.message}</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={draft.enabled}
          disabled={!data.canEdit || save.isPending}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        {t('enabled')}
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-xs font-medium">{t('target')}</span>
          <select
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={draft.targetMachineId}
            disabled={!data.canEdit || save.isPending}
            onChange={(e) => setDraft({ ...draft, targetMachineId: e.target.value })}
          >
            <option value="">{t('noTarget')}</option>
            {data.target && !options.some((c) => c.machineId === data.target?.machineId) ? (
              <option value={data.target.machineId}>{label(data.target)}</option>
            ) : null}
            {options.map((c) => (
              <option key={c.machineId} value={c.machineId}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs font-medium">{t('minutes')}</span>
          <Input
            inputMode="numeric"
            className="w-24"
            value={draft.minutes}
            disabled={!data.canEdit || save.isPending}
            onChange={(e) => setDraft({ ...draft, minutes: e.target.value })}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('rules', { min: String(data.minMinutes), max: String(data.maxMinutes) })}</p>
      {error === 'target' ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('targetRequired')}</p> : null}
      {error === 'minutes' ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('minutesInvalid', { min: String(data.minMinutes), max: String(data.maxMinutes) })}</p>
      ) : null}
      {data.lastFired ? (
        <p className="text-xs text-muted-foreground">
          {t('lastFired', {
            at: formatDateTime(data.lastFired.at),
            from: data.lastFired.from ? label(data.lastFired.from) : '—',
            to: data.lastFired.to ? label(data.lastFired.to) : '—',
          })}
        </p>
      ) : null}
      {data.canEdit ? (
        <Button size="sm" disabled={!!error || !dirty || save.isPending} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
      )}
    </div>
  );
}
