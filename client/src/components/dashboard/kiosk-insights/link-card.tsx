'use client';

/** The insights page's way into "ביצועי קיוסקים". */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, TabletSmartphone } from 'lucide-react';
import { Card, IOS } from '@/components/dashboard/insights/ios';

export function KioskInsightsLinkCard() {
  const t = useTranslations('kioskInsights.linkCard');
  return (
    <Link href="/dashboard/insights/kiosks" className="mt-5 block rounded-[22px] active:opacity-70">
      <Card className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] text-white" style={{ backgroundColor: IOS.indigo }}>
          <TabletSmartphone className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold">{t('title')}</span>
          <span className="block text-[13px] text-[#8E8E93]">{t('text')}</span>
        </span>
        <ChevronLeft className="h-5 w-5 shrink-0 text-[#C7C7CC]" aria-hidden />
      </Card>
    </Link>
  );
}
