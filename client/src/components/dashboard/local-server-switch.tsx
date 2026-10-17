'use client';

/**
 * "העברת שרת מקומי" (pos-server app/services/local_server_switch.py, P:/specs/local-server-switch.md
 * §2ב): the one way to move a shop's local server (its main till) to another till. A wizard on the
 * main till card:
 *
 * 1. the server now — when the cloud last heard it, its open shift, the documents it said it still
 *    holds; still heard: "כנראה בעיית רשת בין הקופות", and "כפה העברה" for the permitted users only,
 *    with the two-servers warning;
 * 2. the new server — an online Android till of the shop;
 * 3. the old server's open shift ("לסגור את המשמרת הפתוחה בקופה X מהענן?", with a cash count typed
 *    by hand) and, for the super admin, "העבר את הפקת ה-Z עכשיו";
 * 4. the summary, and the confirmation.
 *
 * Also here: "X שינויים מהשרת הקודם" (gap 1) — the old server's table changes the cloud did not
 * apply because the order had changed since the switch, with "סמן כנבדק".
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeftRight } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  EMPTY_SWITCH_FORM,
  eligibleTargets,
  hostOnline,
  lastSwitchKey,
  shiftStep,
  switchBlock,
  switchBody,
  switchSummary,
  tillTakeoverKey,
  type LanTillRef,
  type LocalServerState,
  type LocalServerSwitchForm,
} from '@/lib/lanMode';
import {
  acknowledgeFormerHostChanges,
  fetchLocalServer,
  localServerKey,
  switchLocalServer,
} from '@/lib/localServerApi';
import { refusalOf } from '@/lib/zParticipation';
import { shopZProducerKey, zParticipationKey } from '@/lib/zParticipationApi';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const STEPS = ['server', 'target', 'shift', 'summary'] as const;
type Step = (typeof STEPS)[number];

/** "לפני N דק׳ / שע׳ / ימים", from seconds. */
function useAgo() {
  const t = useTranslations('mainTill.localNetwork.sync');
  const tl = useTranslations('localServer.wizard');
  return (seconds: number | null | undefined) => {
    if (seconds === null || seconds === undefined) return tl('never');
    if (seconds < 60) return t('seconds', { n: String(seconds) });
    if (seconds < 3600) return t('minutes', { n: String(Math.floor(seconds / 60)) });
    if (seconds < 86400) return tl('hours', { n: String(Math.floor(seconds / 3600)) });
    return tl('days', { n: String(Math.floor(seconds / 86400)) });
  };
}

function useTillLabel() {
  const t = useTranslations('mainTill');
  return (ref: LanTillRef | null | undefined) =>
    !ref ? '—' : ref.posNumber ? t('till', { n: ref.posNumber, name: ref.name ?? '' }) : (ref.name ?? '—');
}

/** The card's button: opens the wizard (or nothing, for those who may not switch). */
export function LocalServerSwitchButton({ shopId, canSwitch }: { shopId: string; canSwitch: boolean }) {
  const t = useTranslations('localServer.wizard');
  const [open, setOpen] = useState(false);
  if (!canSwitch) return <p className="text-xs text-muted-foreground">{t('readOnly')}</p>;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ArrowLeftRight className="h-4 w-4" aria-hidden />
        {t('open')}
      </Button>
      {open ? <LocalServerSwitchDialog shopId={shopId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function LocalServerSwitchDialog({ shopId, onClose }: { shopId: string; onClose: () => void }) {
  const t = useTranslations('localServer.wizard');
  const query = useQuery({ queryKey: localServerKey(shopId), queryFn: () => fetchLocalServer(shopId), refetchInterval: 15_000 });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>
        {query.isLoading || !query.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Wizard shopId={shopId} state={query.data} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Wizard({ shopId, state, onClose }: { shopId: string; state: LocalServerState; onClose: () => void }) {
  const t = useTranslations('localServer');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const label = useTillLabel();
  const [step, setStep] = useState<Step>('server');
  const [form, setForm] = useState<LocalServerSwitchForm>(EMPTY_SWITCH_FORM);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<LocalServerSwitchForm>) => setForm((f) => ({ ...f, ...patch }));
  const index = STEPS.indexOf(step);
  const block = switchBlock(state, form);

  const save = useMutation({
    mutationFn: () => switchLocalServer(shopId, switchBody(state, form)),
    onSuccess: (out) => {
      qc.setQueryData(localServerKey(shopId), out.state);
      void qc.invalidateQueries({ queryKey: ['main-till', shopId] });
      void qc.invalidateQueries({ queryKey: shopZProducerKey(shopId) });
      void qc.invalidateQueries({ queryKey: zParticipationKey(shopId) });
      void qc.invalidateQueries({ queryKey: ['kitchen-printers', shopId] });
      void qc.invalidateQueries({ queryKey: ['local-shop-z-request', shopId] });
      toast.success(t('wizard.done', { till: label(out.mainTill) }));
      if (out.closedShift) toast.success(t('wizard.doneClosed', { till: label(out.previous) }));
      onClose();
    },
    onError: (err: unknown) => {
      // 409 {detail: {code, message}}: the server's Hebrew (host_online, till_online, …).
      const refusal = refusalOf(err);
      setError(refusal?.message ?? axiosErrorToToastMessage(err, tc('error')));
      void qc.invalidateQueries({ queryKey: localServerKey(shopId) });
    },
  });

  // Each step says what it needs before "הבא".
  const stepBlock = (s: Step): string | null => {
    if (s === 'server') return hostOnline(state) && !(form.force && state.canForce) ? 'host_online' : null;
    if (s === 'target') return form.targetMachineId ? null : 'no_target';
    if (s === 'shift') {
      const b = switchBlock(state, form);
      return b === 'bad_cash' || b === 'shift_not_closable' || b === 'release_forbidden' ? b : null;
    }
    return block;
  };
  const here = stepBlock(step);

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={`rounded-full border px-2 py-0.5 ${i === index ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'}`}
          >
            {i + 1}. {t(`wizard.steps.${s}`)}
          </li>
        ))}
      </ol>

      {step === 'server' ? <ServerStep state={state} form={form} set={set} /> : null}
      {step === 'target' ? <TargetStep state={state} form={form} set={set} /> : null}
      {step === 'shift' ? <ShiftStep state={state} form={form} set={set} /> : null}
      {step === 'summary' ? (
        <ul className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
          {switchSummary(state, form, label).map((line) => (
            <li key={line.key} className={line.key === 'forced' ? 'font-medium text-destructive' : ''}>
              {t(`summary.${line.key}`, line.values ?? {})}
            </li>
          ))}
        </ul>
      ) : null}

      {here && step !== 'server' ? <p className="text-xs text-amber-700 dark:text-amber-400">{t(`blocked.${here}`)}</p> : null}
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={save.isPending} onClick={onClose}>
          {t('wizard.cancel')}
        </Button>
        {index > 0 ? (
          <Button variant="outline" disabled={save.isPending} onClick={() => { setError(null); setStep(STEPS[index - 1]); }}>
            {t('wizard.back')}
          </Button>
        ) : null}
        {step !== 'summary' ? (
          <Button disabled={!!here} onClick={() => { setError(null); setStep(STEPS[index + 1]); }}>
            {t('wizard.next')}
          </Button>
        ) : (
          <Button
            variant={form.force ? 'destructive' : 'default'}
            disabled={!!block || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('wizard.switching') : t('wizard.confirm')}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

type StepProps = {
  state: LocalServerState;
  form: LocalServerSwitchForm;
  set: (patch: Partial<LocalServerSwitchForm>) => void;
};

function ServerStep({ state, form, set }: StepProps) {
  const t = useTranslations('localServer.wizard');
  const label = useTillLabel();
  const ago = useAgo();
  const s = state.server;
  if (!s) return <p className="text-sm">{t('noServer')}</p>;
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1 rounded-md border p-3">
        <p className="font-medium">{label(s)}</p>
        <p className={s.online ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
          {s.lastHeartbeatAt
            ? t(s.online ? 'online' : 'offline', { ago: ago(s.silentSeconds) })
            : t('neverHeard')}
        </p>
        {s.lastHeartbeatAt ? <p className="text-xs text-muted-foreground">{t('lastHeardAt', { at: formatDateTime(s.lastHeartbeatAt) })}</p> : null}
        {s.deviceRole === 'local_server' ? (
          // A dedicated local server has no shift and no documents (P:/specs/dedicated-local-server.md).
          <p>{t('serverNoShift')}</p>
        ) : (
        <>
        <p>
          {s.openShift
            ? s.openShift.sequenceNumber
              ? t('openShift', { n: String(s.openShift.sequenceNumber), at: formatDateTime(s.openShift.openedAt) })
              : t('openShiftNumberless', { at: formatDateTime(s.openShift.openedAt) })
            : s.reportedOpenShiftId
              ? t('reportedNotInCloud')
              : t('noOpenShift')}
        </p>
        <p>
          {s.pendingDocuments === null || s.pendingDocuments === undefined
            ? t('pendingUnknown')
            : t('pending', { n: s.pendingDocuments })}
          {s.pendingAt ? ` ${t('pendingAt', { at: formatDateTime(s.pendingAt) })}` : ''}
        </p>
        </>
        )}
        {s.lanPending ? <p className="text-amber-700 dark:text-amber-400">{t('lanPending', { n: s.lanPending })}</p> : null}
      </div>
      {state.lastSwitch ? (
        <p className="text-xs text-muted-foreground">
          {t(lastSwitchKey(state.lastSwitch), {
            from: label(state.lastSwitch.from),
            to: label(state.lastSwitch.to),
            at: formatDateTime(state.lastSwitch.at),
            by: state.lastSwitch.approvedBy ?? state.lastSwitch.by,
          })}
        </p>
      ) : null}
      {/* "העברת שרת מקומי מהקופה" (the till parameter `tillServerTakeover`). */}
      <p className="text-xs text-muted-foreground">{t(tillTakeoverKey(state.tillTakeover))}</p>
      {s.online ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t('hostOnline', { till: label(s) })}
          </p>
          {state.canForce ? (
            <label className="flex items-start gap-2 font-medium">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-destructive"
                checked={form.force}
                onChange={(e) => set({ force: e.target.checked, closeOldShift: false })}
              />
              <span>
                {t('forceLabel')}
                <span className="block text-xs font-normal">{t('forceWarning', { till: label(s) })}</span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TargetStep({ state, form, set }: StepProps) {
  const t = useTranslations('localServer');
  const label = useTillLabel();
  const ago = useAgo();
  const eligible = useMemo(() => new Set(eligibleTargets(state).map((c) => c.machineId)), [state]);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted-foreground">{t('wizard.targetHint')}</p>
      {eligible.size === 0 ? <p className="text-amber-700 dark:text-amber-400">{t('wizard.noTargets')}</p> : null}
      <ul className="space-y-1">
        {state.candidates.map((c) => {
          const ok = eligible.has(c.machineId);
          return (
            <li key={c.machineId}>
              <label className={`flex items-start gap-2 rounded-md border p-2 ${ok ? 'cursor-pointer' : 'opacity-60'}`}>
                <input
                  type="radio"
                  name="local-server-target"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  disabled={!ok}
                  checked={form.targetMachineId === c.machineId}
                  onChange={() => set({ targetMachineId: c.machineId })}
                />
                <span>
                  <span className="font-medium">{label(c)}</span>
                  {c.deviceRole === 'local_server' ? (
                    <span className="ms-1 rounded bg-violet-100 px-1 text-[10px] text-violet-900 dark:bg-violet-950 dark:text-violet-200">
                      {t('device.server')}
                    </span>
                  ) : null}
                  <span className="block text-xs text-muted-foreground">
                    {ok
                      ? t('wizard.lastHeardShort', { ago: ago(secondsSince(c.lastHeartbeatAt)) })
                      : c.reason
                        ? t.has(`ineligible.${c.reason}`)
                          ? t(`ineligible.${c.reason}`)
                          : (c.reasonText ?? '')
                        : ''}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function secondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((Date.now() - at) / 1000));
}

function ShiftStep({ state, form, set }: StepProps) {
  const t = useTranslations('localServer.wizard');
  const label = useTillLabel();
  const s = state.server;
  const shift = shiftStep(state);
  const producer = state.shopZ?.producer;
  const zLocalOnOld = producer?.kind === 'local' && !!s && producer.machine?.machineId === s.machineId;
  return (
    <div className="space-y-3 text-sm">
      {s && shift !== 'none' ? (
        <div className="space-y-2 rounded-md border p-3">
          <label className={`flex items-start gap-2 ${shift === 'closable' ? '' : 'opacity-60'}`}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              disabled={shift !== 'closable'}
              checked={form.closeOldShift}
              onChange={(e) => set({ closeOldShift: e.target.checked })}
            />
            <span>
              <span className="font-medium">{t('closeShiftLabel', { till: label(s) })}</span>
              <span className="block text-xs text-muted-foreground">
                {shift === 'closable' ? t('closeShiftHint') : t('closeShiftHeard')}
              </span>
            </span>
          </label>
          {form.closeOldShift ? (
            <div className="space-y-1 ps-6">
              <label htmlFor="switch-counted-cash" className="text-xs font-medium">
                {t('countedCash')}
              </label>
              <Input
                id="switch-counted-cash"
                inputMode="decimal"
                className="w-40"
                value={form.countedCash}
                onChange={(e) => set({ countedCash: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('countedCashHint')}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground">
          {s?.deviceRole === 'local_server' ? t('serverNoShift') : s ? t('noOpenShift') : t('noServer')}
        </p>
      )}
      <div className="space-y-2 rounded-md border p-3">
        <p className="font-medium">{t('zTitle')}</p>
        <p className="text-xs text-muted-foreground">
          {zLocalOnOld ? t('zFrozen', { till: label(s) }) : producer?.kind === 'cloud' ? t('zCloud') : t('zMoves')}
        </p>
        {state.canReleaseShopZ && zLocalOnOld ? (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={form.releaseShopZ}
              onChange={(e) => set({ releaseShopZ: e.target.checked })}
            />
            <span>
              {t('releaseZLabel')}
              <span className="block text-xs text-muted-foreground">{t('releaseZHint')}</span>
            </span>
          </label>
        ) : null}
      </div>
    </div>
  );
}

// ── "X שינויים מהשרת הקודם" ───────────────────────────────────────────────────

/** The old server's table changes the cloud kept aside (gap 1), on the main till card. */
export function FormerHostChanges({ shopId }: { shopId: string }) {
  const t = useTranslations('localServer.changes');
  const tc = useTranslations('common');
  const label = useTillLabel();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: localServerKey(shopId), queryFn: () => fetchLocalServer(shopId) });
  const ack = useMutation({
    mutationFn: () => acknowledgeFormerHostChanges(shopId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: localServerKey(shopId) });
      toast.success(t('checked'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const changes = query.data?.formerHostChanges;
  if (!changes || changes.count === 0) return null;
  const status = (s: string | null | undefined) => (s && t.has(`status.${s}`) ? t(`status.${s}`) : (s ?? '—'));
  const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toFixed(2));
  return (
    <div role="alert" className="space-y-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          {t('title', { n: changes.count })}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
            {open ? t('hide') : t('show')}
          </Button>
          <Button size="sm" variant="outline" disabled={ack.isPending} onClick={() => ack.mutate()}>
            {t('markChecked')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {open ? (
        <ul className="space-y-1.5">
          {changes.items.map((c) => (
            <li key={c.id} className="rounded-md border bg-background p-2 text-xs">
              <p className="font-medium">
                {c.tableLabel || c.tableNumber !== null
                  ? t('table', { n: c.tableLabel || String(c.tableNumber) })
                  : (c.tableName ?? c.orderId)}
                {' · '}
                {t('at', { at: formatDateTime(c.at) })}
              </p>
              <p>{t('till', { till: label(c.machine), status: status(c.till.status), total: money(c.till.total) })}</p>
              <p>{t('cloud', { status: status(c.cloud.status), total: money(c.cloud.total) })}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
