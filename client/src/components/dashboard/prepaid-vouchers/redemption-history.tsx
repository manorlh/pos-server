'use client';

/** A voucher's redemptions, newest last: when, which till, who, what it took (or a discount's uses and ₪). */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchPrepaidVoucher } from '@/lib/prepaidVouchersApi';
import { itemText } from '@/lib/prepaidVoucherProducts';
import { formatDateTime, isoDate } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { RedemptionFlags } from './redemption-flags';
import { cn } from '@/lib/utils';

function time(iso: string | null | undefined): string {
  return isoDate(iso) ? formatDateTime(iso) : '';
}

export function RedemptionHistory({ voucherId }: { voucherId: string }) {
  const t = useTranslations('prepaidVouchers.history');
  const tk = useTranslations('prepaidVouchers.kinds');
  const q = useQuery({ queryKey: ['prepaid-voucher', voucherId], queryFn: () => fetchPrepaidVoucher(voucherId) });
  // A discount voucher's use: its uses and the ₪ it took off (a discount on the sale, not a tender).
  const discountUseText = (r: { uses?: number | null; discountAmount?: number | null }) =>
    tk('historyUse', {
      uses: (r.uses ?? 1) === 1 ? tk('usesOne') : tk('usesMany', { n: r.uses ?? 1 }),
      amount: `₪${(r.discountAmount ?? 0).toFixed(2)}`,
    });
  if (q.isPending) return <Skeleton className="h-10 w-full" />;
  const rows = q.data?.redemptions ?? [];
  if (!rows.length) return <p className="text-xs text-muted-foreground">{t('empty')}</p>;
  // A weighed item reads by its unit ("0.3 ק״ג זיתים"), as the voucher's own items say.
  const byProduct = new Map((q.data?.items ?? []).map((i) => [i.productId, i]));
  const lineText = (i: { productId: string; name: string | null; quantity: number }) => {
    const item = byProduct.get(i.productId);
    return itemText({ name: i.name ?? '', quantity: i.quantity, weighed: item?.weighed, unitLabel: item?.unitLabel });
  };
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li key={r.id} className={cn('rounded border px-2 py-1', r.reversedAt && 'opacity-60')}>
          {r.reversedAt ? (
            <span className="me-1 rounded bg-muted px-1 font-medium">{t('reversed')}</span>
          ) : null}
          <span className={cn('font-medium', r.reversedAt && 'line-through')}>{time(r.redeemedAt)}</span>
          {' · '}
          {r.machineName ?? t('unknownTill')}
          {r.posUserName ? ` · ${r.posUserName}` : ''}
          {' — '}
          {r.uses ? discountUseText(r) : r.items.map(lineText).join(', ')}
          <RedemptionFlags flags={r.flags} />
          {r.forfeited.length ? (
            <span className="text-destructive">
              {' '}({t('forfeited', { items: r.forfeited.map(lineText).join(', ') })})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
