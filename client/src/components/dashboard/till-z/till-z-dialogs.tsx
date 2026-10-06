'use client';

/**
 * The machine-level actions of Z on the till (docs/SHIFTS_API.md §5.1, §5.4):
 *
 * * **"בקש Z מהקופה"** — `POST /machines/{id}/till-z`, for a `till`-mode till. The dialog
 *   confirms, then follows the request until it ends. Closing it cancels nothing: asking
 *   again returns the pending request (the server answers with it), and the row's
 *   details show the latest request too.
 * * **Who produces the Z** — `PUT /machines/{id}` `{zMode}`, by the roles that produce Zs.
 *   The cloud refuses a switch while the till has closed shifts no Z took, or a Z is
 *   being produced for it; those refusals are said in words, with the way out.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FilePlus2, Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { cancelTillZRequest, requestMachineTillZ, setMachineZMode } from '@/lib/api';
import { tillNameForZ, zModeOf, zModeSwitchRefusal } from '@/lib/tillZ';
import { zWizardHref } from '@/lib/zAccess';
import type { PosMachine, TillZRequest, ZMode } from '@/lib/types';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';
import {
  TillZRequestView,
  useRefreshAfterTillZ,
  useTillZRequest,
  ZModeBadge,
} from './till-z-request';
import { ForceCloseOption } from '@/components/dashboard/z-wizard/force-close-option';

/** Whether this till can be asked for its own Z now. */
export function canRequestTillZ(m: PosMachine): boolean {
  return (
    zModeOf(m) === 'till' && m.isActive !== false && m.pairingStatus === 'assigned' && !!m.shopId
  );
}

export function RequestTillZDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('tillZ.request');
  const tc = useTranslations('common');
  const errors = useZErrorText();
  const qc = useQueryClient();
  const refresh = useRefreshAfterTillZ();
  const [created, setCreated] = useState<TillZRequest | null>(null);
  const [force, setForce] = useState(false);

  // A fresh dialog for each opening: the last till's request must not show on the next.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setCreated(null);
      setForce(false);
    }
  }
  const handleOpenChange = (next: boolean) => {
    if (!next) setCreated(null);
    onOpenChange(next);
  };

  const requestId = created?.id ?? null;
  const { data: request, isError: pollFailed, error: pollError, refetch } = useTillZRequest(
    requestId,
    created,
    open,
  );

  const create = useMutation({
    mutationFn: () => requestMachineTillZ(machine!.id, force),
    onSuccess: (next) => {
      qc.setQueryData(['till-z-request', next.id], next);
      setCreated(next);
      toast.success(t('sent'));
      refresh(next.machineId);
    },
    onError: (e) => toast.error(errors.forError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelTillZRequest(requestId!),
    onSuccess: (next) => {
      qc.setQueryData(['till-z-request', next.id], next);
      refresh(next.machineId);
    },
    onError: (e) => {
      toast.error(errors.forError(e));
      void refetch();
    },
  });

  if (!machine) return null;
  const shown = request ?? created;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <p className="text-muted-foreground text-sm">{machine.name}</p>
        </DialogHeader>

        {!shown ? (
          <div className="space-y-2 text-sm">
            <p>{t('confirm')}</p>
            {machine.online === false ? (
              <p className="text-amber-700 dark:text-amber-400">{t('confirmOffline')}</p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('cardHint')}</p>
            <ForceCloseOption checked={force} onChange={setForce} className="pt-1" />
          </div>
        ) : (
          <div className="space-y-2">
            {pollFailed ? (
              <p className="text-xs text-destructive">
                {t('pollFailed', { error: errors.forError(pollError) })}
              </p>
            ) : null}
            <TillZRequestView
              request={shown}
              title={null}
              onCancel={() => cancel.mutate()}
              cancelling={cancel.isPending}
            />
          </div>
        )}

        <DialogFooter>
          {!shown ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {tc('cancel')}
              </Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('submit')}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => handleOpenChange(false)}>
              {t('close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The button that opens the request dialog; for the machine page. */
export function RequestTillZButton({ m, className }: { m: PosMachine; className?: string }) {
  const t = useTranslations('tillZ.request');
  const [open, setOpen] = useState(false);
  if (!canRequestTillZ(m)) return null;
  return (
    <>
      <Button size="sm" className={className} onClick={() => setOpen(true)}>
        <FilePlus2 className="h-4 w-4 me-1" aria-hidden />
        {t('menu')}
      </Button>
      <RequestTillZDialog key={m.id} machine={m} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Switch who produces the till's Z. Says what changes in each direction before anything
 * is sent, and — when refused — why, in words, with the way out.
 */
export function ZModeDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && machine ? (
          <ZModeForm key={machine.id} machine={machine} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ZModeForm({
  machine,
  onOpenChange,
}: {
  machine: PosMachine;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('tillZ.mode');
  const tc = useTranslations('common');
  const errors = useZErrorText();
  const qc = useQueryClient();
  const current = zModeOf(machine);
  const target: ZMode = current === 'till' ? 'cloud' : 'till';
  const awaiting = machine.closedShiftsAwaitingZ ?? 0;
  const till = tillNameForZ({
    posNumber: machine.shopId ? machine.posNumber : null,
    machineName: machine.name,
    machineId: machine.id,
  });

  const save = useMutation({
    mutationFn: () => setMachineZMode(machine.id, target),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      qc.invalidateQueries({ queryKey: ['z-candidates'] });
      toast.success(t('saved'));
      onOpenChange(false);
    },
  });

  // The two refusals the switching rule gives (§5.1) are said here, inline, with the
  // way out; anything else reads as the server's error.
  const refusal = save.isError ? zModeSwitchRefusal(save.error) : null;
  const refusalText = !save.isError
    ? null
    : refusal?.code === 'unreported_shifts'
      ? refusal.count != null
        ? t('unreportedShifts', { count: refusal.count })
        : t('unreportedShiftsNoCount')
      : refusal?.code === 'z_in_progress'
        ? t('zInProgress')
        : refusal?.code === 'till_open'
          ? t('tillOpen')
          : refusal?.code === 'till_offline_zs_unsynced'
            ? refusal.reason === 'not_seen'
              ? t('offlineNotSeen')
              : t('offlineUnsynced', { count: refusal.pending ?? 1 })
            : errors.forError(save.error);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('dialogTitle')}</DialogTitle>
        <p className="text-muted-foreground text-sm">{machine.name}</p>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p>
          {t('current', { mode: t(current) })} —{' '}
          <span className="text-muted-foreground">{current === 'till' ? t('tillHint') : t('cloudHint')}</span>
        </p>
        <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
          <p className="font-medium">{target === 'till' ? t('toTill') : t('toCloud')}</p>
          {target === 'till' ? (
            <ul className="list-disc space-y-1 ps-5 text-xs">
              <li>{t('toTillWhat', { till })}</li>
              <li>{t('toTillCloud')}</li>
              <li>{t('toTillOnline')}</li>
            </ul>
          ) : (
            <ul className="list-disc space-y-1 ps-5 text-xs">
              <li>{t('toCloudWhat')}</li>
              <li>{t('toCloudNumbering')}</li>
            </ul>
          )}
          <p className="text-muted-foreground text-xs">{t('openShiftNote')}</p>
          <p className="text-muted-foreground text-xs">{t('heartbeatNote')}</p>
        </div>
        {/* Said before asking: the cloud will refuse the switch until these are in a Z. */}
        {awaiting > 0 && !save.isError ? (
          <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('awaitingWarning', { count: awaiting })}
          </p>
        ) : null}
        {refusalText ? (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
            <p className="flex gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {refusalText}
            </p>
            {/* Shifts waiting for a Z go into a Z of the mode the till is in now. */}
            {refusal?.code === 'unreported_shifts' && machine.shopId ? (
              current === 'till' ? (
                <RequestTillZButton m={machine} />
              ) : (
                <Link
                  href={zWizardHref(machine.shopId, machine.id)}
                  className={buttonVariants({ size: 'sm', variant: 'outline' })}
                >
                  {t('produceZFirst')}
                </Link>
              )
            ) : null}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {save.isPending ? t('saving') : `${t('confirm')}: ${t(target)}`}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The till's Z mode as a field: the badge, and for the roles that may change it, a
 * pencil that opens the switch. Read-only for everyone else.
 */
export function ZModeField({ machine, canEdit }: { machine: PosMachine; canEdit: boolean }) {
  const t = useTranslations('tillZ.mode');
  const [open, setOpen] = useState(false);
  const mode = zModeOf(machine);
  return (
    <span className="inline-flex items-center gap-1" title={canEdit ? undefined : t('readOnly')}>
      <ZModeBadge mode={mode} />
      {canEdit ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setOpen(true)}
            aria-label={t('change')}
            title={t('change')}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <ZModeDialog machine={machine} open={open} onOpenChange={setOpen} />
        </>
      ) : null}
    </span>
  );
}
