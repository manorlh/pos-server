'use client';

/**
 * The catalog pages' "יש שינויים שטרם שודרו לקופות (N)" — only for shops in review mode
 * ("סקירת שינויים לפני שידור לקופות", a shop with tables or the override «תמיד»): their
 * menu edits are a draft until someone reviews and approves the broadcast
 * (pos-server app/services/menu_broadcast.py). A tenant with no such shop in the scope
 * sees nothing at all — its edits reach the tills at once, as always.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { RadioTower, Send } from 'lucide-react';
import { useScope } from '@/lib/scope';
import { BROADCAST_KEYS, fetchBroadcastStatus } from '@/lib/menuBroadcastApi';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The review screen for the scope: one shop, a company, or every shop of the organization. */
export function broadcastHref(scope: { companyId?: string | null; shopId?: string | null }): string {
  if (scope.shopId) return `/dashboard/products/broadcast?shop=${scope.shopId}`;
  if (scope.companyId) return `/dashboard/products/broadcast?company=${scope.companyId}`;
  return '/dashboard/products/broadcast';
}

export function MenuBroadcastBanner({ className }: { className?: string }) {
  const t = useTranslations('menuBroadcast.banner');
  const { selection } = useScope();
  const shopId = selection.shopId ?? null;
  const companyId = shopId ? null : (selection.companyId ?? null);
  const query = useQuery({
    queryKey: BROADCAST_KEYS.status(companyId, shopId),
    queryFn: () => fetchBroadcastStatus({ companyId, shopId }),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const shops = query.data?.shops ?? [];
  if (shops.length === 0) return null;

  // Changes this shop's tills would see; a draft that only touches what the shop does not
  // sell rides along with its next broadcast.
  const changed = shops.filter((s) => s.pending > 0);
  const pending = query.data?.pending ?? 0;
  const href =
    changed.length === 1
      ? broadcastHref({ shopId: changed[0].shopId })
      : broadcastHref({ companyId, shopId });

  if (changed.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground',
          className,
        )}
      >
        <RadioTower className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('quiet', { shops: shops.map((s) => s.shopName).join(', ') })}</span>
        <Link href={href} className="font-medium text-foreground underline-offset-4 hover:underline">
          {t('versions')}
        </Link>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <RadioTower className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t('pending', { count: pending })}</p>
          <p className="text-xs opacity-80">
            {shops.length > 1
              ? changed.map((s) => t('shopCount', { name: s.shopName, count: s.pending })).join(' · ')
              : t('hint')}
          </p>
        </div>
      </div>
      <Link href={href} className={buttonVariants({ size: 'sm' })}>
        <Send className="h-3.5 w-3.5" aria-hidden />
        {t('broadcast')}
      </Link>
    </div>
  );
}
