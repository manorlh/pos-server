'use client';

/**
 * "בקש מהקופה הראשית" — the shop Z of a shop in local mode (a main till on the LAN). The
 * dashboard never starts that Z: it asks the main till, which gets the request on its next
 * heartbeat, closes every till in the shop Z over the LAN and produces the Z itself. A
 * till that blocks it is named here (the main till tries again about every minute while
 * the request is open); a finished one links to its Z. Polls every 5 s while open.
 *
 * On the shop page as a card (local mode only), and in the Z wizard in place of the
 * "the shop Z is the main till's" notice. pos-server `/shops/{id}/local-shop-z-request`;
 * the rules are in lib/localShopZ.ts.
 */

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Crown, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  canCancelShopZ,
  canRequestShopZ,
  isPendingRequest,
  pollIntervalOf,
  requestViewOf,
  serverMessageOf,
  zReportHrefOf,
  type LocalShopZState,
  type LocalShopZTill,
  type RequestTone,
} from '@/lib/localShopZ';
import {
  cancelLocalShopZRequest,
  fetchLocalShopZRequest,
  localShopZKey,
  requestLocalShopZ,
} from '@/lib/localShopZRequestApi';
import { useCanProduceZ } from '@/lib/zAccess';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function useLocalShopZ(shopId: string) {
  return useQuery({
    queryKey: localShopZKey(shopId),
    queryFn: () => fetchLocalShopZRequest(shopId),
    refetchInterval: (q) => pollIntervalOf(q.state.data),
  });
}

function useTillLabel() {
  const t = useTranslations('independentTill');
  return (till: LocalShopZTill | null | undefined) =>
    !till ? t('localShopZ.noMainTill') : till.posNumber ? t('till', { n: till.posNumber }) : (till.name ?? '—');
}

/** The shop page's card: shown only for a shop in local mode (or with a request still open). */
export function LocalShopZRequestCard({ shopId }: { shopId: string }) {
  const t = useTranslations('independentTill.localShopZ');
  const tillLabel = useTillLabel();
  const { data } = useLocalShopZ(shopId);
  if (!data || (!data.localMode && !isPendingRequest(data.request))) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Crown className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('desc', { till: tillLabel(data.mainTill) })}</p>
        <LocalShopZBody shopId={shopId} state={data} />
      </CardContent>
    </Card>
  );
}

/**
 * The Z wizard's notice for a shop whose shop Z is the main till's: in local mode, why the
 * wizard cannot start it and the request to the main till; otherwise `children` (the
 * wizard's own notice) as it was.
 */
export function LocalShopZWizardNotice({ shopId, children }: { shopId: string; children: ReactNode }) {
  const t = useTranslations('independentTill.localShopZ');
  const tillLabel = useTillLabel();
  const { data } = useLocalShopZ(shopId);
  if (!data?.localMode) return <>{children}</>;
  return (
    <Card className="border-amber-500/50">
      <CardContent className="space-y-3 py-3 text-sm">
        <p>{t('wizardNotice', { till: tillLabel(data.mainTill) })}</p>
        <LocalShopZBody shopId={shopId} state={data} />
      </CardContent>
    </Card>
  );
}

const TONE_BOX: Record<RequestTone, string> = {
  pending: 'border bg-muted/40',
  progress: 'border bg-muted/40',
  error: 'border border-destructive/40 bg-destructive/5 text-destructive',
  success: 'border border-green-600/30 bg-green-50 dark:bg-green-950/40',
  muted: 'border bg-muted/20 text-muted-foreground',
};

function ToneIcon({ tone }: { tone: RequestTone }) {
  const cls = 'h-4 w-4 shrink-0 mt-0.5';
  if (tone === 'progress') return <Loader2 className={cn(cls, 'animate-spin')} aria-hidden />;
  if (tone === 'error') return <AlertTriangle className={cls} aria-hidden />;
  if (tone === 'success') return <CheckCircle2 className={cn(cls, 'text-green-600')} aria-hidden />;
  if (tone === 'muted') return <XCircle className={cls} aria-hidden />;
  return <Clock className={cls} aria-hidden />;
}

function LocalShopZBody({ shopId, state }: { shopId: string; state: LocalShopZState }) {
  const t = useTranslations('independentTill.localShopZ');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const canProduceZ = useCanProduceZ();
  const req = state.request;
  const status = req?.status ?? null;

  // A Z the main till just produced: every list that showed its shifts as waiting is stale.
  useEffect(() => {
    if (status !== 'completed') return;
    for (const key of ['z-candidates', 'z-reports', 'machines', 'shifts']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  }, [status, qc]);

  const codeOf = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
    return typeof detail === 'string' ? detail : null;
  };
  const settle = (out: LocalShopZState) => qc.setQueryData(localShopZKey(shopId), out);

  const ask = useMutation({
    mutationFn: () => requestLocalShopZ(shopId),
    onSuccess: (out) => {
      settle(out);
      toast.success(t('requested'));
    },
    onError: (err: unknown) => {
      toast.error(
        serverMessageOf(err) ??
          (codeOf(err) === 'not_local_mode' ? t('notLocalMode') : axiosErrorToToastMessage(err, tc('error'))),
      );
      void qc.invalidateQueries({ queryKey: localShopZKey(shopId) });
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelLocalShopZRequest(shopId),
    onSuccess: (out) => {
      settle(out);
      toast.success(t('cancelled'));
    },
    onError: (err: unknown) => {
      toast.error(
        serverMessageOf(err) ??
          (codeOf(err) === 'request_not_pending' ? t('notPending') : axiosErrorToToastMessage(err, tc('error'))),
      );
      void qc.invalidateQueries({ queryKey: localShopZKey(shopId) });
    },
  });

  const view = req ? requestViewOf(req) : null;
  const href = zReportHrefOf(req);
  const busy = ask.isPending || cancel.isPending;

  return (
    <div className="space-y-2">
      {/* A change of the shop Z's producer waiting on the main till ("העברת הפקת ה-Z ממתינה"). */}
      {state.handover?.message ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
          {state.handover.message}
        </p>
      ) : null}
      {req && view ? (
        <div className={cn('space-y-1 rounded-md p-3 text-sm', TONE_BOX[view.tone])}>
          <div className={cn('flex gap-2', view.tone === 'error' ? 'font-medium' : undefined)}>
            <ToneIcon tone={view.tone} />
            {href ? (
              <Link href={href} className="font-medium hover:underline">
                {t(`status.${view.key}`, view.values)}
              </Link>
            ) : (
              <span>{t(`status.${view.key}`, view.values)}</span>
            )}
          </div>
          {view.tone === 'error' ? <p className="text-xs">{t('retrying')}</p> : null}
          {status === 'waiting' ? (
            <p className="text-xs text-muted-foreground">
              {req.sentAt ? t('takenAt', { at: formatDateTime(req.sentAt) }) : t('notTakenYet')}
            </p>
          ) : null}
          {req.createdAt ? (
            <p className="text-xs text-muted-foreground">
              {req.createdBy
                ? t('createdBy', { name: req.createdBy, at: formatDateTime(req.createdAt) })
                : t('createdAt', { at: formatDateTime(req.createdAt) })}
            </p>
          ) : null}
        </div>
      ) : null}

      {canProduceZ ? (
        <div className="flex flex-wrap gap-2">
          {canRequestShopZ(state) ? (
            <Button size="sm" disabled={busy} onClick={() => ask.mutate()}>
              {ask.isPending ? t('requesting') : t('request')}
            </Button>
          ) : null}
          {canCancelShopZ(state) ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => cancel.mutate()}>
              {cancel.isPending ? t('cancelling') : t('cancel')}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('noPermission')}</p>
      )}
    </div>
  );
}
