'use client';

/**
 * "סגור משמרת מרחוק": ask one till to close its open shift, without producing a Z.
 *
 * `POST /machines/{id}/close-shift` sends the till the same close-shift instruction a Z
 * run would, and the till closes unattended (no cash count). The request completes only
 * when the cloud has accepted the close with every document of the shift; the closed
 * shift then waits for the shop's next Z like any other. Producing the Z stays a separate
 * action (the wizard), offered here once the shift is closed.
 *
 * The dialog polls `GET /shift-close-requests/{id}` while the till has not answered.
 * Closing the dialog does not cancel anything: the row keeps showing the close as
 * pending, and asking again returns the same request (the server answers 200 with it),
 * which is how the progress is picked up again.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  cancelShiftCloseRequest,
  fetchShiftCloseRequest,
  requestShiftClose,
} from '@/lib/api';
import { formatCurrency } from '@/lib/format';
import { zWizardHref } from '@/lib/zAccess';
import type { PosMachine, ShiftCloseRequest, ShiftCloseRequestStatus } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TillCloseProgress } from '@/components/dashboard/close-progress';
import { useShiftLabel } from '@/components/dashboard/shifts/shift-parts';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';

const PENDING = new Set<ShiftCloseRequestStatus>(['waiting_close', 'closing']);

/**
 * Whether this till has a shift the cloud can be asked to close — one rule for the devices
 * page and the shifts page (lib/shiftsPage.ts): not while a Z run already waits for that close.
 */
export { canCloseShiftRemotely } from '@/lib/shiftsPage';

/** The HTTP status of a failed request, if it has one. */
function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

function statusVariant(s: ShiftCloseRequestStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'completed') return 'default';
  if (s === 'failed' || s === 'expired') return 'destructive';
  if (s === 'cancelled') return 'outline';
  return 'secondary';
}

export function RemoteShiftCloseDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('machines.remoteClose');
  const tc = useTranslations('common');
  const errors = useZErrorText();
  const shiftLabel = useShiftLabel();
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(null);

  // A fresh dialog for each opening: the last till's request must not show on the next.
  // The parent keys the dialog by till; reopening for the same till starts over too
  // (asking again returns the pending request, so nothing is lost).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRequestId(null);
  }
  const handleOpenChange = (next: boolean) => {
    if (!next) setRequestId(null);
    onOpenChange(next);
  };

  const {
    data: request,
    isError: pollFailed,
    error: pollError,
    refetch,
  } = useQuery<ShiftCloseRequest>({
    queryKey: ['shift-close-request', requestId],
    queryFn: () => fetchShiftCloseRequest(requestId!),
    enabled: open && !!requestId,
    refetchInterval: (q) => {
      // Gone or not ours: asking every 2 s will not change that.
      const code = httpStatus(q.state.error);
      if (code === 403 || code === 404) return false;
      return q.state.data && !PENDING.has(q.state.data.status) ? false : 2000;
    },
  });

  const settle = (next: ShiftCloseRequest) => {
    qc.setQueryData(['shift-close-request', next.id], next);
    setRequestId(next.id);
  };

  const create = useMutation({
    mutationFn: () => requestShiftClose(machine!.id),
    onSuccess: (next) => {
      settle(next);
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', next.machineId] });
    },
    onError: (e) => toast.error(errors.forError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelShiftCloseRequest(requestId!),
    onSuccess: settle,
    onError: (e) => {
      toast.error(errors.forError(e));
      // A refused cancel usually means the request moved on (closed, expired): show
      // where it is now rather than the state the cancel was pressed on.
      void refetch();
    },
  });

  // Once it has ended, every list that showed the shift as open is stale — including
  // the shift's own page, which may be open behind this dialog.
  const ended = request ? !PENDING.has(request.status) : false;
  const endedShiftId = ended ? (request?.shift?.id ?? request?.shiftId ?? null) : null;
  useEffect(() => {
    if (!ended) return;
    for (const key of ['machines', 'machine', 'shifts', 'z-candidates', 'z-reports', 'dashboard-stats']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
    if (endedShiftId) qc.invalidateQueries({ queryKey: ['shift', endedShiftId] });
  }, [ended, endedShiftId, qc]);

  if (!machine) return null;

  const shiftName = shiftLabel({ sequenceNumber: machine.openShiftSequence ?? null });
  const busy = create.isPending || cancel.isPending;
  const why = request ? errors.forItem(request.errorCode, request.errorMessage) : null;
  const closedShift = request?.status === 'completed' ? request.shift : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <p className="text-muted-foreground text-sm">{machine.name}</p>
        </DialogHeader>

        {!request ? (
          <div className="space-y-2 text-sm">
            <p>{t('confirm', { shift: shiftName })}</p>
            {machine.online === false ? (
              <p className="text-amber-700 dark:text-amber-400">{t('confirmOffline')}</p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('cardHint')}</p>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {pollFailed ? (
              <p className="text-xs text-destructive">
                {t('pollFailed', { error: errors.forError(pollError) })}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {request.shift ? shiftLabel(request.shift) : shiftName}
              </span>
              <Badge variant={statusVariant(request.status)}>
                {PENDING.has(request.status) ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t(`status.${request.status}`)}
              </Badge>
            </div>
            <p
              className={`flex items-start gap-1 text-xs ${
                request.status === 'failed' || request.status === 'expired'
                  ? 'text-destructive'
                  : 'text-muted-foreground'
              }`}
            >
              {request.status === 'failed' || request.status === 'expired' ? (
                <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : null}
              {t(`hint.${request.status}`)}
            </p>
            {why && request.status !== 'completed' ? (
              <p
                className={`text-xs ${
                  request.status === 'failed' || request.status === 'expired'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }`}
              >
                {why}
              </p>
            ) : null}
            {PENDING.has(request.status) ? <TillCloseProgress facts={request} /> : null}

            {closedShift ? (
              <div className="flex gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                <div className="min-w-0 space-y-0.5 text-xs">
                  <p>
                    {t('resultSales')}:{' '}
                    <span className="font-medium tabular-nums">
                      {formatCurrency(closedShift.serverTotals?.totalSales)}
                    </span>
                    {' · '}
                    {t('resultDocuments')}:{' '}
                    <span className="tabular-nums">
                      {closedShift.serverTotals?.transactionsCount ?? 0}
                    </span>
                  </p>
                  {closedShift.countedCash == null ? (
                    <p className="text-muted-foreground">{t('resultUncounted')}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {!request ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {tc('cancel')}
              </Button>
              <Button disabled={busy} onClick={() => create.mutate()}>
                {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('submit')}
              </Button>
            </>
          ) : (
            <>
              {PENDING.has(request.status) ? (
                <Button variant="outline" disabled={busy} onClick={() => cancel.mutate()}>
                  {t('cancelRequest')}
                </Button>
              ) : null}
              {closedShift ? (
                <>
                  <Link
                    href={`/dashboard/shifts/${closedShift.id}`}
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    {t('openX')}
                  </Link>
                  <Link href={zWizardHref(machine.shopId, machine.id)} className={buttonVariants()}>
                    {t('produceZ')}
                  </Link>
                </>
              ) : (
                <Button variant="secondary" onClick={() => handleOpenChange(false)}>
                  {t('close')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
