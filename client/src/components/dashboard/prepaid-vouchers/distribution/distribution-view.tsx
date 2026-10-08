'use client';

/**
 * "הפצה בוואטסאפ" — a prepaid voucher batch's tab: the production's list of phone numbers, each
 * recipient's vouchers as a PDF behind a personal link, and sending over WhatsApp — assisted
 * (wa.me / the share sheet, a person presses send; WhatsApp Web is never automated) or, when a
 * company set it up, the official WhatsApp Business (Cloud) API. pos-server
 * app/services/voucher_distribution.py holds the rules.
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchDistribution } from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { RECIPIENT_STATES } from '@/lib/voucherDistribution';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiPanel } from './api-panel';
import { DistributionLog } from './distribution-log';
import { GroupSends } from './group-sends';
import { ImportPanel } from './import-panel';
import { MessageSettings } from './message-settings';
import { SendQueue } from './send-queue';
import { StateBadge, keys, useDistributionError } from './shared';

export function VoucherDistributionView({ batch }: { batch: PrepaidVoucherBatch }) {
  const t = useTranslations('voucherDistribution');
  const errorText = useDistributionError();
  const overview = useQuery({ queryKey: keys.overview(batch.id), queryFn: () => fetchDistribution(batch.id) });

  if (overview.isLoading) return <Skeleton className="h-64 w-full" />;
  if (overview.isError || !overview.data) {
    return <p className="text-sm text-destructive">{errorText(overview.error)}</p>;
  }
  const o = overview.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-2 pt-4">
          <p className="text-sm">{t('intro')}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{t('recipients', { n: o.recipients })}</span>
            {RECIPIENT_STATES.map((s) => (
              <span key={s} className="flex items-center gap-1">
                <StateBadge state={s} /> <span className="tabular-nums">{o.counts[s] ?? 0}</span>
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('vouchers', { assigned: o.vouchers.assigned, free: o.vouchers.free, total: o.vouchers.total })}
          </p>
          {o.batchCancelled ? <p className="text-xs text-destructive">{t('batchCancelled')}</p> : null}
          {/* Links nobody outside this computer can open: the server's public address is not set. */}
          {/^https?:\/\/(localhost|127\.|\[::1\])/i.test(o.linkBase) ? (
            <p className="rounded-md bg-amber-100 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300" dir="auto">
              {t('localLinks', { base: o.linkBase })}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ImportPanel batch={batch} overview={o} />
      {o.grouped ? <GroupSends batch={batch} /> : null}
      <MessageSettings key={[o.messageTemplate, o.groupMessageTemplate, o.layout, o.linkExpiresAt].join('|')} batch={batch} overview={o} />
      <SendQueue batch={batch} overview={o} />
      <ApiPanel batch={batch} overview={o} />
      <DistributionLog batch={batch} overview={o} />
    </div>
  );
}
