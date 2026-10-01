'use client';

/**
 * A till asked for its own Z (docs/SHIFTS_API.md §5.3–§5.4), followed live.
 *
 * The till closes its open shift unattended, flushes its documents, asks the cloud for
 * the Z and prints it. The cloud numbers the Z per till and builds it from the documents
 * it holds, so the request ends `completed` with the Z (or with nothing to report).
 * While it is pending the row polls `GET /till-z-requests/{id}` every 2 s, as the remote
 * close and the Z run do, and shows what can be said about the till meanwhile: online,
 * and its own last report of unsent documents (a reading with its age, never live).
 */

import { useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cancelTillZRequest, fetchTillZRequest, fetchTillZRequests } from '@/lib/api';
import {
  isTillZPending,
  latestTillZRequestFor,
  tillZOutcome,
  tillZStatusVariant,
} from '@/lib/tillZ';
import type { TillZRequest, ZMode } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TillCloseProgress } from '@/components/dashboard/close-progress';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';

/** The HTTP status of a failed request, if it has one. */
function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** "Z בענן" / "Z בקופה". */
export function ZModeBadge({ mode, className }: { mode: ZMode; className?: string }) {
  const t = useTranslations('tillZ.mode');
  return (
    <Badge
      variant={mode === 'till' ? 'secondary' : 'outline'}
      className={className}
      title={mode === 'till' ? t('tillHint') : t('cloudHint')}
    >
      {t(mode)}
    </Badge>
  );
}

/**
 * The lists a finished request makes stale: the till's shifts are now in a Z, and the
 * machines list showed them awaiting one.
 */
export function useRefreshAfterTillZ() {
  const qc = useQueryClient();
  return useCallback(
    (machineId?: string | null) => {
      for (const key of ['machines', 'shifts', 'z-candidates', 'z-reports', 'till-z-requests', 'dashboard-stats']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      if (machineId) qc.invalidateQueries({ queryKey: ['machine', machineId] });
    },
    [qc],
  );
}

/** One request, polled while pending. `initial` (the create response) shows at once. */
export function useTillZRequest(requestId: string | null, initial?: TillZRequest | null, enabled = true) {
  return useQuery<TillZRequest>({
    queryKey: ['till-z-request', requestId],
    queryFn: () => fetchTillZRequest(requestId!),
    enabled: enabled && !!requestId,
    initialData: initial && initial.id === requestId ? initial : undefined,
    // The create response is fresh, but polling picks up from there.
    initialDataUpdatedAt: 0,
    refetchInterval: (q) => {
      // Gone or not ours: asking every 2 s will not change that.
      const code = httpStatus(q.state.error);
      if (code === 403 || code === 404) return false;
      return q.state.data && !isTillZPending(q.state.data.status) ? false : 2000;
    },
  });
}

/**
 * What one request says: its status, why, the till's reachability while it waits, and
 * the Z it produced. Presentational; the polling is the caller's.
 */
export function TillZRequestView({
  request,
  title,
  onCancel,
  cancelling,
}: {
  request: TillZRequest;
  /** Shown before the status; omitted in a dialog that already names the till. */
  title?: string | null;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const t = useTranslations('tillZ.request');
  const errors = useZErrorText();
  const pending = isTillZPending(request.status);
  const failed = request.status === 'failed' || request.status === 'expired';
  const outcome = tillZOutcome(request);
  // `nothing_to_report` is the outcome itself on a completed request, said below.
  const why =
    request.status === 'completed' ? null : errors.forItem(request.errorCode, request.errorMessage);

  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        {title ? <span className="min-w-0 truncate font-medium">{title}</span> : <span />}
        <Badge variant={tillZStatusVariant(request.status)}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t(`status.${request.status}`)}
        </Badge>
      </div>
      <p className={`flex items-start gap-1 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
        {failed ? <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        {outcome === 'nothing' ? t('nothingToReport') : t(`hint.${request.status}`)}
      </p>
      {why ? (
        <p className={`text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>{why}</p>
      ) : null}
      {request.initiatedBy ? (
        <p className="text-muted-foreground text-xs">{t('initiatedBy', { name: request.initiatedBy })}</p>
      ) : null}
      {pending ? <TillCloseProgress facts={request} /> : null}
      {outcome === 'z' ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-xs dark:border-emerald-800 dark:bg-emerald-950">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
          <Link href={`/dashboard/z-reports/${request.zReportId}`} className="font-medium hover:underline">
            {request.machineSequenceNumber != null
              ? t('zLink', { number: request.machineSequenceNumber })
              : t('zLinkNoNumber')}
          </Link>
        </div>
      ) : null}
      {pending && onCancel ? (
        <Button size="sm" variant="outline" disabled={cancelling} onClick={onCancel}>
          {t('cancelRequest')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One request, live, with its cancel — the row the wizard and the progress view list.
 * `initial` is the create response, so the row shows before the first poll answers.
 */
export function TillZRequestLive({
  requestId,
  initial,
  title,
}: {
  requestId: string;
  initial?: TillZRequest | null;
  title?: string | null;
}) {
  const t = useTranslations('tillZ.request');
  const errors = useZErrorText();
  const qc = useQueryClient();
  const refresh = useRefreshAfterTillZ();
  const { data: request, isLoading, isError, error, refetch } = useTillZRequest(requestId, initial);

  const cancel = useMutation({
    mutationFn: () => cancelTillZRequest(requestId),
    onSuccess: (next) => qc.setQueryData(['till-z-request', requestId], next),
    onError: (e) => {
      toast.error(errors.forError(e));
      // A refused cancel usually means the request moved on: show where it is now.
      void refetch();
    },
  });

  // Once it has ended, every list that showed the till's shifts waiting is stale.
  const endedFor = request && !isTillZPending(request.status) ? request.machineId : null;
  useEffect(() => {
    if (endedFor) refresh(endedFor);
  }, [endedFor, refresh]);

  if (isLoading && !request) return <Skeleton className="h-14 w-full" />;
  if (!request) {
    return <p className="text-xs text-destructive">{errors.forError(error)}</p>;
  }
  return (
    <div className="space-y-1">
      {isError ? (
        <p className="text-xs text-destructive">{t('pollFailed', { error: errors.forError(error) })}</p>
      ) : null}
      <TillZRequestView
        request={request}
        title={title === undefined ? (request.machineName ?? request.machineId.slice(0, 8)) : title}
        onCancel={() => cancel.mutate()}
        cancelling={cancel.isPending}
      />
    </div>
  );
}

/**
 * The newest request of one till, for the machine row's details and the machine page:
 * read from the shop's list (`GET /till-z-requests?shopId=`). A pending one is then
 * polled by id, like any other; the list itself is refreshed when a request is made.
 */
export function LatestTillZRequest({ machineId, shopId }: { machineId: string; shopId: string }) {
  const t = useTranslations('tillZ.request');
  const errors = useZErrorText();
  const { data, isLoading, isError, error } = useQuery<TillZRequest[]>({
    queryKey: ['till-z-requests', { shopId }],
    queryFn: () => fetchTillZRequests({ shopId }),
  });
  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (isError) {
    return <p className="text-xs text-destructive">{t('loadFailed', { error: errors.forError(error) })}</p>;
  }
  const latest = latestTillZRequestFor(data ?? [], machineId);
  if (!latest) return <p className="text-muted-foreground text-xs">{t('none')}</p>;
  return <TillZRequestLive requestId={latest.id} initial={latest} title={t('latest')} />;
}
