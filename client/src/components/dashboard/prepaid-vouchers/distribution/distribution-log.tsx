'use client';

/** "יומן ההפצה": who imported, assigned, sent, revoked, erased — and every open of a link. */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eraser } from 'lucide-react';
import {
  eraseAllRecipients,
  fetchDistributionEvents,
  type DistributionEvent,
  type DistributionOverview,
} from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { serialsText } from '@/lib/voucherDistribution';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { keys, useDistributionError, useRefreshDistribution, when } from './shared';

function detailText(e: DistributionEvent, tv: (k: string) => string): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  if (Array.isArray(d.serials) && d.serials.length) parts.push(serialsText(d.serials as number[]));
  if (typeof d.via === 'string') parts.push(tv(d.via));
  if (typeof d.reason === 'string' && d.reason) parts.push(`"${d.reason}"`);
  if (typeof d.created === 'number') parts.push(`${d.created}/${d.rows}`);
  if (typeof d.status === 'string') parts.push(d.status);
  if (typeof d.code === 'string' && d.code) parts.push(d.code);
  return parts.join(' · ');
}

export function DistributionLog({ batch, overview }: { batch: PrepaidVoucherBatch; overview: DistributionOverview }) {
  const t = useTranslations('voucherDistribution.log');
  const tv = useTranslations('voucherDistribution.via');
  const errorText = useDistributionError();
  const refresh = useRefreshDistribution(batch.id);
  const events = useQuery({ queryKey: keys.events(batch.id), queryFn: () => fetchDistributionEvents(batch.id) });
  const erase = useMutation({
    mutationFn: () => eraseAllRecipients(batch.id),
    onSuccess: (out) => {
      toast.success(t('erased', { n: out.erased }));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">{t('privacyTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('privacy')}</p>
          <Button className="mt-2" size="sm" variant="destructive" disabled={!overview.batchOver || erase.isPending}
            onClick={() => { if (window.confirm(t('eraseConfirm'))) erase.mutate(); }}>
            <Eraser aria-hidden /> {t('eraseAll')}
          </Button>
          {!overview.batchOver ? <p className="mt-1 text-xs text-muted-foreground">{t('eraseWhenOver')}</p> : null}
        </div>
        {events.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (events.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="max-h-96 space-y-1 overflow-auto">
            {(events.data ?? []).map((e) => (
              <li key={e.id} className="rounded border px-2 py-1 text-xs">
                <span className="font-medium tabular-nums">{when(e.createdAt)}</span>
                {' · '}
                {t.has(`action.${e.action}`) ? t(`action.${e.action}`) : e.action}
                {detailText(e, (k) => (tv.has(k) ? tv(k) : k)) ? <span dir="auto"> · {detailText(e, (k) => (tv.has(k) ? tv(k) : k))}</span> : null}
                {e.userName ? <span className="text-muted-foreground"> · {t('by', { name: e.userName })}</span> : null}
                {e.fromPublic ? <span className="text-muted-foreground"> · {t('fromLink')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
