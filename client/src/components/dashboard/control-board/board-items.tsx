'use client';

/**
 * Best sellers (הנמכרים ביותר): the chosen day's top items by net, each with its units
 * and, with a comparison on, what it did on the compared day and the change.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Trophy } from 'lucide-react';
import { formatCurrency, formatQuantity } from '@/lib/format';
import type { ComparedItem } from '@/lib/controlBoard';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, DeltaPill } from './board-ui';

export function BoardItems({
  items,
  comparing,
  loading,
  href,
  className,
}: {
  items: ComparedItem[];
  comparing: boolean;
  loading: boolean;
  /** The live items page, in the same scope. */
  href: string;
  className?: string;
}) {
  const t = useTranslations('controlBoard.items');
  const max = Math.max(1, ...items.map((i) => Math.max(i.netA, comparing ? i.netB : 0)));
  return (
    <BoardCard className={className} labelledBy="cb-items-title">
      <CardTitle
        id="cb-items-title"
        icon={Trophy}
        trailing={
          <Link
            href={href}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-cb-blue-ink hover:bg-cb-soft"
          >
            {t('all')}
            <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
          </Link>
        }
      >
        {t('title')}
      </CardTitle>
      {loading && items.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full bg-cb-soft" />
          <Skeleton className="h-10 w-full bg-cb-soft" />
          <Skeleton className="h-10 w-full bg-cb-soft" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-cb-muted">{t('empty')}</p>
      ) : (
        <ol className="grid gap-x-8 md:grid-cols-2">
          {items.map((it, i) => (
            <li key={it.key} className="border-b border-cb-line py-2.5">
              <div className="flex items-center gap-3">
                <span className="w-5 shrink-0 text-center text-sm font-semibold tabular-nums text-cb-muted">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-cb-ink">{it.name}</p>
                  <p className="text-xs tabular-nums text-cb-muted">
                    {comparing
                      ? t('qtyVs', { qty: formatQuantity(it.qtyA), other: formatQuantity(it.qtyB) })
                      : t('qty', { qty: formatQuantity(it.qtyA) })}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-sm font-semibold tabular-nums text-cb-ink">{formatCurrency(it.netA)}</p>
                  {comparing ? <p className="text-xs tabular-nums text-cb-muted">{formatCurrency(it.netB)}</p> : null}
                </div>
                {comparing ? <DeltaPill a={it.netA} b={it.netB} /> : null}
              </div>
              <div className="ms-8 mt-1.5 space-y-1" aria-hidden>
                <div className="h-1.5 rounded-full bg-cb-soft">
                  <div className="h-1.5 rounded-full bg-cb-blue" style={{ width: `${(it.netA / max) * 100}%` }} />
                </div>
                {comparing ? (
                  <div className="h-1 rounded-full bg-cb-soft">
                    <div className="h-1 rounded-full bg-cb-muted/50" style={{ width: `${(it.netB / max) * 100}%` }} />
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </BoardCard>
  );
}
