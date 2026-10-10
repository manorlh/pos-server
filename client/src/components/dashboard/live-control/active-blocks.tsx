'use client';

/**
 * "חסומים כעת" (specs/item-blocks-targets.md §5): every block in force in the scope — the item (a
 * product, or "מחלקה · …"), "אזל" / "חסום", the level and its name, the channels when not all four
 * ("קיוסק · תפריט דיגיטלי"), the kiosks' look when set, until when with a live countdown ("עוד 47
 * דק׳"), who set it and from where, the reason; "הארך" (+15/+30/+60) and "בטל" on each. Filters:
 * a product (its own blocks and its category's), a category, a point of sale, a channel.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, PackageX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  channelsLabel,
  channelsOf,
  EXTEND_BY,
  formatLeft,
  formatUntil,
  isAllChannels,
  itemLabel,
  KIOSK_LOOK_BADGES,
  kindLabel,
  levelLabel,
  levelOf,
  originLabel,
  secondsLeft,
  type BlockChannel,
  type ItemBlock,
} from '@/lib/liveControl';
import { clearBlock, extendBlock, fetchBlocks, liveKeys } from '@/lib/liveControlApi';
import type { LiveControlScope } from './types';

/** A clock that ticks every 15 s: the countdowns move without refetching. */
export function useTick(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** "חסומים כעת" narrowed: a category's blocks, those reaching a point of sale, those on a channel. */
export interface ActiveBlocksFilters {
  categoryId?: string | null;
  areaId?: string | null;
  channel?: BlockChannel | null;
}

/** `enabled`: false for a user the server would refuse (the cockpit's feed asks only what each may read). */
export function useActiveBlocks(scope: LiveControlScope, productId?: string | null, enabled = true, filters: ActiveBlocksFilters = {}) {
  const ids = {
    companyId: scope.companyId ?? null,
    shopId: scope.shopId ?? null,
    productId: productId ?? null,
    categoryId: filters.categoryId ?? null,
    areaId: filters.areaId ?? null,
    channel: filters.channel ?? null,
  };
  return useQuery({
    queryKey: liveKeys.blocks(ids),
    queryFn: () => fetchBlocks(ids),
    refetchInterval: 30_000,
    enabled: enabled && !!(ids.companyId || ids.shopId || ids.productId || ids.categoryId),
  });
}

export function ActiveBlocksList({
  scope,
  productId,
  categoryId,
  areaId,
  channel,
  emptyText = 'אין חסימות פעילות',
  compact = false,
}: {
  scope: LiveControlScope;
  productId?: string | null;
  categoryId?: string | null;
  /** Only the blocks that reach a device of this point of sale. */
  areaId?: string | null;
  /** Only the blocks that stop the item on this channel ("קיוסק"…). */
  channel?: BlockChannel | null;
  emptyText?: string;
  /** Inside an item's own sheet: the item's name is said once, above (a category's block still names it). */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const now = useTick();
  const blocks = useActiveBlocks(scope, productId, true, { categoryId, areaId, channel });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['item-blocks'] });
    qc.invalidateQueries({ queryKey: ['kiosks', 'live'] });
  };
  const extend = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) => extendBlock(id, minutes),
    onSuccess: (b) => {
      toast.success(`הוארך עד ${formatUntil(b.until, Date.now()) ?? ''}`);
      refresh();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'ההארכה נכשלה')),
  });
  const clear = useMutation({
    mutationFn: (id: string) => clearBlock(id),
    onSuccess: () => {
      toast.success('החסימה בוטלה');
      refresh();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'הביטול נכשל')),
  });

  if (blocks.isPending && blocks.fetchStatus !== 'idle') {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }
  const rows = (blocks.data ?? []).filter((b) => {
    const left = secondsLeft(b.until, now);
    return b.inForce && (left == null || left > 0);
  });
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="space-y-2">
      {rows.map((b: ItemBlock) => {
        const until = formatUntil(b.until, now);
        const left = formatLeft(secondsLeft(b.until, now));
        const channels = channelsOf(b);
        const level = levelOf(b);
        const isCategory = b.itemType === 'category' || (b.itemType == null && !b.productId);
        // In an item's own sheet its name is above — a block of its category still says which.
        const showItem = !compact || (productId ? isCategory : !categoryId);
        const origin = originLabel(b.origin);
        return (
          <li key={b.id} className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="flex items-start gap-2">
              {b.kind === 'blocked' ? (
                <Ban className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              ) : (
                <PackageX className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {showItem ? <span className="font-medium">{itemLabel(b)}</span> : null}
                  <Badge variant={b.kind === 'blocked' ? 'destructive' : 'secondary'}>{kindLabel(b.kind)}</Badge>
                  {!isAllChannels(channels) ? (
                    <Badge variant="outline" title="ערוצים">
                      {channelsLabel(channels)}
                    </Badge>
                  ) : null}
                  {b.kioskDisplay && channels.includes('kiosk') ? <Badge variant="outline">{KIOSK_LOOK_BADGES[b.kioskDisplay]}</Badge> : null}
                  {b.source === 'auto' ? <Badge variant="outline">אוטומטי — מלאי 0</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {levelLabel(b)}
                  {b.shopName && level !== 'shop' && level !== 'company' ? ` · ${b.shopName}` : ''}
                </p>
                <p className="text-sm">
                  {until ? `עד ${until}` : 'עד ביטול'}
                  {left ? <span className="ms-1.5 font-medium text-primary">{left}</span> : null}
                </p>
                {b.note ? <p className="text-sm">“{b.note}”</p> : null}
                {b.by || origin ? (
                  <p className="text-xs text-muted-foreground">
                    {b.by ? `ע״י ${b.by}${origin ? ` (${origin})` : ''}` : origin}
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 shrink-0"
                aria-label="בטל"
                title="בטל"
                disabled={clear.isPending}
                onClick={() => clear.mutate(b.id)}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {b.until
                ? EXTEND_BY.map((m) => (
                    <Button key={m} variant="outline" size="sm" className="h-9" disabled={extend.isPending} onClick={() => extend.mutate({ id: b.id, minutes: m })}>
                      הארך +{m}
                    </Button>
                  ))
                : null}
              <Button variant="outline" size="sm" className="h-9 text-destructive" disabled={clear.isPending} onClick={() => clear.mutate(b.id)}>
                בטל
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
