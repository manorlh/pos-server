'use client';

/**
 * "מסכי מטבח (KDS)" — one shop's kitchen screens (pos-server docs/SPEC_KDS.md §3, §8):
 * the stations as the KDS sees them (preparation / view only, thresholds), which tills
 * are KDS screens and in what role, the public pickup screen's link, and a read-only
 * live view of the open kitchen orders. Whether a till sends anything to the KDS at
 * all is its "תצורת עבודה" (linked).
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { getKdsShop } from '@/lib/kdsApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { StationsSection } from '@/components/dashboard/kds/stations-section';
import { DevicesSection } from '@/components/dashboard/kds/devices-section';
import { PickupSection } from '@/components/dashboard/kds/pickup-section';
import { LiveBoard } from '@/components/dashboard/kds/live-board';
import { Skeleton } from '@/components/ui/skeleton';

export default function KdsPage() {
  const t = useTranslations('kds.page');
  // The screens belong to a shop: the page needs one.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';

  const { data: overview, isLoading, isError } = useQuery({
    queryKey: ['kds-shop', shopId],
    queryFn: () => getKdsShop(shopId),
    enabled: !!shopId,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {shopId ? (
          <Link
            href={`/dashboard/workflow?scopeType=shop&scopeId=${encodeURIComponent(shopId)}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('workflowLink')}
          </Link>
        ) : null}
      </div>

      <ScopeGate resolution={resolution}>
        {isLoading ? (
          <Skeleton className="h-60 w-full" />
        ) : isError || !overview ? (
          <p className="text-sm text-destructive">{t('loadError')}</p>
        ) : (
          <>
            {overview.unroutedTasks > 0 ? (
              <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
                {t('unroutedAlert', { count: overview.unroutedTasks })}
              </p>
            ) : null}
            <StationsSection shopId={shopId} overview={overview} />
            <DevicesSection shopId={shopId} overview={overview} />
            <PickupSection shopId={shopId} overview={overview} />
            <LiveBoard shopId={shopId} stations={overview.stations} />
          </>
        )}
      </ScopeGate>
    </div>
  );
}
