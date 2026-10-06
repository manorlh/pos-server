'use client';

/**
 * "הפקת ה-Z הסניפי" on a shop — the shop Z's one producer ("אין דבר כזה זד שממוספר מחדש").
 * A shop's Z sequence has exactly one producer at a time, the cloud or the main till on
 * the LAN, and a printed Z number is final. Shown here: who produces it now; a switch
 * waiting for the producer to hand over (every shop Z it printed in the cloud), with the
 * super admin's forced handover; and the shop Zs the cloud could not take as printed —
 * kept as printed, for support, who mark them settled. pos-server
 * `/shops/{id}/shop-z-producer`, `/shop-z-producer/handover`, `/shop-z-conflicts/{z}/resolve`.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ListOrdered } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  conflictNumbersOf,
  formatTillNumbers,
  producerViewOf,
  type ShopZConflict,
  type ShopZProducerState,
} from '@/lib/zParticipation';
import {
  fetchShopZProducer,
  forceShopZHandover,
  resolveShopZConflict,
  shopZProducerKey,
  zParticipationKey,
} from '@/lib/zParticipationApi';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { ShopZForceDialog } from '@/components/dashboard/shop-z-force-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

/** The lists a change of producer makes stale. */
function useRefreshAfterProducer(shopId: string) {
  const qc = useQueryClient();
  return (out: ShopZProducerState) => {
    qc.setQueryData(shopZProducerKey(shopId), out);
    void qc.invalidateQueries({ queryKey: zParticipationKey(shopId) });
    void qc.invalidateQueries({ queryKey: ['main-till', shopId] });
    void qc.invalidateQueries({ queryKey: ['local-shop-z-request', shopId] });
    void qc.invalidateQueries({ queryKey: ['z-candidates'] });
  };
}

export function ShopZProducerCard({ shopId }: { shopId: string }) {
  const t = useTranslations('independentTill.producer');
  const tc = useTranslations('common');
  const isSuperAdmin = useIsSuperAdmin();
  const refresh = useRefreshAfterProducer(shopId);
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: shopZProducerKey(shopId),
    queryFn: () => fetchShopZProducer(shopId),
    // A handover waits on the producer's uploads: look again now and then.
    refetchInterval: (q) => (q.state.data?.handover ? 15_000 : false),
  });
  const data = query.data;

  const handover = useMutation({
    mutationFn: () => forceShopZHandover(shopId),
    onSuccess: (out) => {
      setConfirm(false);
      refresh(out);
      toast.success(t('handedOver'));
    },
    onError: (err: unknown) => {
      setConfirm(false);
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const view = producerViewOf(data?.producer);
  const to = data?.handover?.to;
  const toLabel = !to
    ? null
    : to.kind === 'local'
      ? to.machine
        ? t('toLocal', { till: formatTillNumbers([to.machine]) })
        : t('toLocalNoTill')
      : t('toCloud');

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ListOrdered className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading || !data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            {data.conflicts.length > 0 ? (
              <ShopZConflicts shopId={shopId} conflicts={data.conflicts} canResolve={isSuperAdmin} />
            ) : null}
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{t(view.key, view.values)}</p>
              {data.producer.since ? (
                <p className="text-xs text-muted-foreground">{t('since', { at: formatDateTime(data.producer.since) })}</p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t('desc')}</p>
            {data.handover ? (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
                <p className="flex gap-2 font-medium">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('handoverTitle')}
                </p>
                {data.handover.message ? <p>{data.handover.message}</p> : null}
                {toLabel ? <p className="text-xs text-muted-foreground">{t('handoverTo', { to: toLabel })}</p> : null}
                {isSuperAdmin ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={handover.isPending}
                    onClick={() => setConfirm(true)}
                  >
                    {handover.isPending ? t('forcing') : t('forceHandover')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
      <ShopZForceDialog
        open={confirm}
        pending={handover.isPending}
        onConfirm={() => handover.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  );
}

/** "Z סניפי שלא נקלט בענן — לטיפול התמיכה": each Z kept as printed, and its settling. */
function ShopZConflicts({
  shopId,
  conflicts,
  canResolve,
}: {
  shopId: string;
  conflicts: ShopZConflict[];
  canResolve: boolean;
}) {
  const t = useTranslations('independentTill.conflicts');
  const tc = useTranslations('common');
  const refresh = useRefreshAfterProducer(shopId);
  const [target, setTarget] = useState<ShopZConflict | null>(null);
  const [note, setNote] = useState('');

  const resolve = useMutation({
    mutationFn: (c: ShopZConflict) => resolveShopZConflict(shopId, c.zId, note),
    onSuccess: (out) => {
      setTarget(null);
      setNote('');
      refresh(out);
      toast.success(t('resolved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <p className="flex gap-2 font-medium text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t('title')}
      </p>
      <ul className="space-y-2">
        {conflicts.map((c) => {
          const numbers = conflictNumbersOf(c);
          return (
            <li key={c.zId} className="space-y-1 rounded-md border bg-background p-2">
              {c.message ? <p>{c.message}</p> : null}
              <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t(numbers.key, numbers.values)}</span>
                {c.posNumber ? <span>· {t('till', { n: c.posNumber })}</span> : null}
                {c.closedAt ? <span>· {t('closedAt', { at: formatDateTime(c.closedAt) })}</span> : null}
                {c.attempts ? <span>· {t('attempts', { n: c.attempts })}</span> : null}
                {c.takenByZReportId ? (
                  <Link href={`/dashboard/z-reports/${c.takenByZReportId}`} className="hover:underline">
                    · {t('takenBy')}
                  </Link>
                ) : null}
              </p>
              {canResolve ? (
                <Button size="sm" variant="outline" className="h-7" onClick={() => setTarget(c)}>
                  {t('resolve')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !resolve.isPending) {
            setTarget(null);
            setNote('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('resolveTitle')}</DialogTitle>
            <DialogDescription>{t('resolveText')}</DialogDescription>
          </DialogHeader>
          {target ? (
            <p className="text-xs text-muted-foreground">
              {t(conflictNumbersOf(target).key, conflictNumbersOf(target).values)}
              {target.posNumber ? ` · ${t('till', { n: target.posNumber })}` : ''}
            </p>
          ) : null}
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">{t('note')}</span>
            <textarea
              className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-sm"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={resolve.isPending} onClick={() => setTarget(null)}>
              {t('cancel')}
            </Button>
            <Button disabled={resolve.isPending || !target} onClick={() => target && resolve.mutate(target)}>
              {resolve.isPending ? t('resolving') : t('resolve')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
