'use client';

/**
 * One Z run, live: which tills it is waiting for, and what the operator can do about it.
 *
 * The run finishes by itself when every till's close has been accepted with all its
 * documents. Until then it polls `GET /z-runs/{id}` — which is also what sweeps expiry
 * and builds the Z once the last item turns ready — so leaving this open is enough.
 *
 * "Proceed without" builds now over the tills that are ready; the others' shifts simply
 * wait for the next Z (no gap for them — a Z always takes a till's oldest shifts first).
 * Every item that is not ready has to be named in that call, so the button names them
 * all rather than offering a partial choice the server would refuse.
 *
 * A till the run still waits for shows what can be said about it: its own last report of
 * unsent documents (with its age) and how many of the closing shift's documents the cloud
 * already holds — so "closing" is not all an operator has to decide whether to wait.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cancelZRun, fetchZRun, forceZRunCloudRefunds, proceedZRun } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import { findBySameId } from '@/lib/entityLookup';
import { useScope } from '@/lib/scope';
import type { ZRun, ZRunItemStatus } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { TillCloseProgress } from '@/components/dashboard/close-progress';
import { useZErrorText } from './z-errors';
import { OpenTillsRecord } from './open-tills';

const WAITING_ITEM = new Set<ZRunItemStatus>(['waiting_close', 'closing']);

const LIVE = new Set(['waiting', 'building']);

/**
 * How long past `expiresAt` a run may still read as live before this view stops asking.
 * Reading the run is what makes the server expire it, so a live run well past its
 * deadline means the server is not finalising it — polling it every 2 s forever would
 * not change that.
 */
const EXPIRY_GRACE_MS = 60_000;

/** A live run whose deadline passed more than the grace period before `asOf`. */
function overdue(run: ZRun | undefined, asOf: number): boolean {
  if (!run || !LIVE.has(run.status) || !run.expiresAt) return false;
  const deadline = Date.parse(run.expiresAt);
  return Number.isFinite(deadline) && asOf > deadline + EXPIRY_GRACE_MS;
}

function itemVariant(s: ZRunItemStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (s === 'ready') return 'default';
  if (s === 'failed' || s === 'expired') return 'destructive';
  if (s === 'excluded') return 'outline';
  return 'secondary';
}

export function ZRunProgress({ runId }: { runId: string }) {
  const t = useTranslations('zWizard.progress');
  const errors = useZErrorText();
  const qc = useQueryClient();
  const scope = useScope();

  const { data: run, isLoading, isError, error, dataUpdatedAt, refetch, isFetching } = useQuery<ZRun>({
    queryKey: ['z-run', runId],
    queryFn: () => fetchZRun(runId),
    refetchInterval: (q) => {
      const data = q.state.data;
      // Never loaded (a 404, a run of another tenant): asking again will not help.
      if (!data) return q.state.status === 'error' ? false : 2000;
      if (!LIVE.has(data.status)) return false;
      if (overdue(data, q.state.dataUpdatedAt)) return false;
      return 2000;
    },
  });
  const stalled = overdue(run, dataUpdatedAt);

  const settle = (next: ZRun) => qc.setQueryData(['z-run', runId], next);

  // Once the run lands — by polling or by an action here — every list that showed its
  // shifts as waiting is stale, so the wizard behind it never offers a shift a Z took.
  const finished = run ? !LIVE.has(run.status) : false;
  useEffect(() => {
    if (!finished) return;
    for (const key of ['z-candidates', 'machines', 'shifts', 'z-reports']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }, [finished, qc]);

  const notReady = (run?.items ?? []).filter((i) => i.status !== 'ready' && i.status !== 'excluded');
  const readyCount = (run?.items ?? []).filter((i) => i.status === 'ready').length;

  const proceed = useMutation({
    mutationFn: () => proceedZRun(runId, notReady.map((i) => i.machineId)),
    onSuccess: settle,
    onError: (e) => toast.error(errors.forError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelZRun(runId),
    onSuccess: settle,
    onError: (e) => toast.error(errors.forError(e)),
  });
  // "זיכוי באשראי מהענן — חובה לפני ה-Z הבא": support releases the refunds holding the run (a reason).
  const { user } = useAuth();
  const [refundReason, setRefundReason] = useState('');
  const forceRefunds = useMutation({
    mutationFn: () => forceZRunCloudRefunds(runId, refundReason.trim()),
    onSuccess: (next) => {
      setRefundReason('');
      settle(next);
    },
    onError: (e) => toast.error(errors.forError(e)),
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  // Only an error with nothing to show replaces the card; a failed poll of a run already
  // on screen keeps it and says so below.
  if (!run) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-destructive">{errors.forError(error)}</CardContent>
      </Card>
    );
  }

  const live = LIVE.has(run.status);
  // Past its deadline and not finalised by the server: shown as the expiry it is.
  const shownStatus = stalled ? 'expired' : run.status;
  const busy = proceed.isPending || cancel.isPending;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {t('title', { shop: findBySameId(scope.shops, run.shopId)?.name ?? run.shopId.slice(0, 8) })}
            {run.areaName ? (
              <span className="text-muted-foreground text-sm font-normal"> · {run.areaName}</span>
            ) : null}
          </CardTitle>
          <Badge
            variant={
              shownStatus === 'completed'
                ? 'default'
                : shownStatus === 'failed' || shownStatus === 'expired'
                  ? 'destructive'
                  : 'secondary'
            }
          >
            {live && !stalled ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t(`runStatus.${shownStatus}`)}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          {run.businessDate ? t('businessDate', { date: formatDate(run.businessDate) }) : null}
          {run.businessDate && run.expiresAt && live ? ' · ' : null}
          {run.expiresAt && live
            ? stalled
              ? t('expiredAt', { when: formatDateTime(run.expiresAt) })
              : t('expiresAt', { when: formatDateTime(run.expiresAt) })
            : null}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <OpenTillsRecord left={run.openTillsLeftOut} />
        {(run.pendingCloudRefunds ?? []).length > 0 ? (
          <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
            {(run.pendingCloudRefunds ?? []).map((r) => (
              <p key={r.refundId}>
                <span className="font-medium">{r.words}</span>
                {' · '}
                {r.landsInThisZ ? t('cloudRefundLands', { till: r.machineName ?? '—' }) : r.message}
              </p>
            ))}
            {run.cloudRefundsHold && run.status === 'waiting' && user?.role === 'super_admin' ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Input
                  className="h-8 max-w-xs"
                  value={refundReason}
                  maxLength={300}
                  placeholder={t('cloudRefundReason')}
                  onChange={(e) => setRefundReason(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={refundReason.trim().length < 5 || forceRefunds.isPending}
                  onClick={() => forceRefunds.mutate()}
                >
                  {t('cloudRefundForce')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {isError ? (
          <p className="text-xs text-destructive">{t('pollFailed', { error: errors.forError(error) })}</p>
        ) : null}
        {stalled ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
            <span>{t('stalled', { when: formatDateTime(run.expiresAt!) })}</span>
            <Button size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>
              {t('refresh')}
            </Button>
          </div>
        ) : null}
        <ul className="space-y-2">
          {run.items.map((item) => {
            const why = errors.forItem(item.errorCode, item.errorMessage);
            return (
              <li
                key={item.id}
                className="flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.machineName ?? item.machineId}</p>
                  <p className="text-muted-foreground text-xs">{t(`itemHint.${item.status}`)}</p>
                  {why && item.status !== 'ready' ? (
                    <p
                      className={`mt-0.5 text-xs ${
                        item.status === 'failed' || item.status === 'expired'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {why}
                    </p>
                  ) : null}
                  {live && !stalled && WAITING_ITEM.has(item.status) ? (
                    <div className="mt-1">
                      <TillCloseProgress facts={item} />
                    </div>
                  ) : null}
                </div>
                <Badge variant={itemVariant(item.status)}>{t(`itemStatus.${item.status}`)}</Badge>
              </li>
            );
          })}
        </ul>

        {run.status === 'completed' && run.zReportId ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-950">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
            <span className="font-medium">
              {run.zNumber != null ? t('doneNumbered', { number: run.zNumber }) : t('done')}
            </span>
            <Link
              href={`/dashboard/z-reports/${run.zReportId}`}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('openZ')}
            </Link>
          </div>
        ) : null}

        {run.status === 'failed' || run.status === 'expired' || run.status === 'cancelled' ? (
          <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <XCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t(`ended.${run.status}`)}</p>
              {run.status === 'failed' ? (
                <p className="text-muted-foreground text-xs">
                  {errors.forItem(run.errorCode, run.errorMessage) ?? ''}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {run.status === 'waiting' ? (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {readyCount > 0 && notReady.length > 0 ? (
              <Button size="sm" disabled={busy} onClick={() => proceed.mutate()}>
                {t('proceedWithout', {
                  tills: notReady.map((i) => i.machineName ?? i.machineId.slice(0, 8)).join(', '),
                })}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => cancel.mutate()}>
              {t('cancel')}
            </Button>
            <p className="text-muted-foreground basis-full text-xs">
              {notReady.length > 0 ? t('waitingHint') : t('buildingHint')}
            </p>
            {/* A refused "proceed without" (e.g. "חובה לסגור את כל הקופות", local mode): the
                server's Hebrew, kept on the card and not only in a passing toast. */}
            {proceed.isError ? (
              <p className="basis-full rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                {errors.forError(proceed.error)}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
