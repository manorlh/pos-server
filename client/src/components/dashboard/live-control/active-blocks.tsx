'use client';

/**
 * "חסימות פעילות": every block in force in the scope, with who set it, where, until when and a
 * live countdown ("עוד 47 דק׳"); "הארך" (+15/+30/+60) and "בטל עכשיו" on each.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, PackageX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { EXTEND_BY, formatLeft, formatUntil, kindLabel, scopeLabel, secondsLeft, type ItemBlock } from '@/lib/liveControl';
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

/** `enabled`: false for a user the server would refuse (the cockpit's feed asks only what each may read). */
export function useActiveBlocks(scope: LiveControlScope, productId?: string | null, enabled = true) {
  const ids = { companyId: scope.companyId ?? null, shopId: scope.shopId ?? null, productId: productId ?? null };
  return useQuery({
    queryKey: liveKeys.blocks(ids),
    queryFn: () => fetchBlocks(ids),
    refetchInterval: 30_000,
    enabled: enabled && !!(ids.companyId || ids.shopId || ids.productId),
  });
}

export function ActiveBlocksList({
  scope,
  productId,
  emptyText = 'אין חסימות פעילות',
  compact = false,
}: {
  scope: LiveControlScope;
  productId?: string | null;
  emptyText?: string;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const now = useTick();
  const blocks = useActiveBlocks(scope, productId);
  const refresh = () => qc.invalidateQueries({ queryKey: ['item-blocks'] });
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
                  {!compact || !productId ? <span className="font-medium">{b.productName}</span> : null}
                  <Badge variant={b.kind === 'blocked' ? 'destructive' : 'secondary'}>{kindLabel(b.kind)}</Badge>
                  {b.source === 'auto' ? <Badge variant="outline">אוטומטי — מלאי 0</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {scopeLabel(b.scope, b.scopeName)}
                  {b.shopName && b.scope !== 'shop' && b.scope !== 'kiosks' ? ` · ${b.shopName}` : ''}
                </p>
                <p className="text-sm">
                  {until ? `עד ${until}` : 'עד שאבטל'}
                  {left ? <span className="ms-1.5 font-medium text-primary">{left}</span> : null}
                </p>
                {b.note ? <p className="text-sm">“{b.note}”</p> : null}
                {b.by ? <p className="text-xs text-muted-foreground">ע״י {b.by}</p> : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 shrink-0"
                aria-label="בטל עכשיו"
                title="בטל עכשיו"
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
                בטל עכשיו
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
