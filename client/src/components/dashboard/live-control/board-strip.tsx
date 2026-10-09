'use client';

/**
 * The control board's small blocks for stock and targets, kept apart from the board itself: the
 * targets' progress today with the pace ("בקצב הנוכחי: ₪X עד סוף היום"), and the low-stock alerts
 * (to the stock page's transfers). Nothing at all while there is neither.
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PackageSearch, Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import { alertTitle, barPercent, formatQty, paceLine, shekels, targetTone, type StockAlert, type TargetProgress } from '@/lib/stockLive';
import { fetchAlerts, fetchProgress, stockKeys } from '@/lib/stockLiveApi';
import type { LiveControlScope } from './types';

export function useTargetsProgress(scope: LiveControlScope, enabled = true) {
  return useQuery({
    queryKey: stockKeys.progress(scope),
    queryFn: () => fetchProgress(scope),
    enabled: enabled && !!(scope.companyId || scope.shopId),
    refetchInterval: 60_000,
  });
}

export function useStockAlertsOf(scope: LiveControlScope, enabled = true) {
  return useQuery({
    queryKey: stockKeys.alerts(scope),
    queryFn: () => fetchAlerts(scope),
    enabled: enabled && !!(scope.companyId || scope.shopId),
    refetchInterval: 60_000,
  });
}

const TONE_BAR: Record<ReturnType<typeof targetTone>, string> = {
  ok: 'bg-emerald-500',
  on_track: 'bg-sky-500',
  behind: 'bg-amber-500',
  unknown: 'bg-muted-foreground/50',
};

function ProgressRow({ p }: { p: TargetProgress }) {
  const tone = targetTone(p);
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate font-medium">{p.label}</span>
        <span className="shrink-0 tabular-nums">
          {shekels(p.actual)} <span className="text-muted-foreground">/ {shekels(p.amount)}</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(barPercent(p))} aria-valuemin={0} aria-valuemax={100} aria-label={p.label}>
        <div className={cn('h-full rounded-full transition-[width]', TONE_BAR[tone])} style={{ width: `${barPercent(p)}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{p.reached ? 'היעד הושג' : paceLine(p)}</p>
    </li>
  );
}

/** The targets' progress today, as a list (the targets page, the cockpit). */
export function TargetsProgressList({ scope, emptyText, limit }: { scope: LiveControlScope; emptyText?: string; limit?: number }) {
  const progress = useTargetsProgress(scope);
  const rows = (progress.data ?? []).slice(0, limit ?? 50);
  if (progress.isPending) return <div className="h-16 animate-pulse rounded-2xl bg-muted" />;
  if (rows.length === 0) return emptyText ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null;
  return (
    <ul className="space-y-3 rounded-2xl border bg-card p-3">
      {rows.map((p) => (
        <ProgressRow key={p.targetId} p={p} />
      ))}
    </ul>
  );
}

function AlertRow({ a }: { a: StockAlert }) {
  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <span className="truncate">{alertTitle(a)}</span>
      <span className={cn('shrink-0 tabular-nums font-semibold', a.kind === 'out' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')}>{formatQty(a.quantity)}</span>
    </li>
  );
}

/** The board's strip: targets and low stock, each its own small card; hidden when both are empty. */
export function LiveControlBoardStrip({ scope }: { scope: LiveControlScope }) {
  const progress = useTargetsProgress(scope);
  const alerts = useStockAlertsOf(scope);
  const targets = progress.data ?? [];
  const low = alerts.data ?? [];
  if (targets.length === 0 && low.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="יעדים ומלאי">
      {targets.length > 0 ? (
        <section className="space-y-2 rounded-2xl border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Target className="size-4 text-muted-foreground" aria-hidden /> יעדים היום
            </h2>
            <Link href="/dashboard/targets" className="text-xs text-primary underline-offset-2 hover:underline">
              כל היעדים
            </Link>
          </div>
          <ul className="space-y-3">
            {targets.slice(0, 3).map((p) => (
              <ProgressRow key={p.targetId} p={p} />
            ))}
          </ul>
        </section>
      ) : null}
      {low.length > 0 ? (
        <section className="space-y-2 rounded-2xl border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <PackageSearch className="size-4 text-muted-foreground" aria-hidden /> מלאי נמוך
              <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-black/85">{low.length}</span>
            </h2>
            <Link href="/dashboard/stock?tab=transfers" className="text-xs text-primary underline-offset-2 hover:underline">
              להעברות
            </Link>
          </div>
          <ul className="space-y-1.5">
            {low.slice(0, 4).map((a) => (
              <AlertRow key={a.id} a={a} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
