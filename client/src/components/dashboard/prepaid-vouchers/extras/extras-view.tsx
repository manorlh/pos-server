'use client';

/**
 * "בקרה ובדיקות" (§16, §18): pause redemptions, quotas, staff test vouchers, replacement vouchers —
 * these with the `prepaid_voucher_controls` section (changes only when the server says `editable`)
 * — and the simulator, which only reads and so is open to everyone with the page.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { Segmented } from '@/components/dashboard/insights/ios';
import { PausesSection } from './pauses';
import { QuotasSection } from './quotas';
import { ReplacementSection } from './replacement';
import { SimulatorSection } from './simulator';
import { TestBatchesSection } from './test-batches';

type Part = 'pauses' | 'quotas' | 'tests' | 'replacement' | 'simulator';

export function ExtrasView() {
  const t = useTranslations('prepaidVouchers.extras');
  const access = useDashboardAccess();
  const controls = canAccess(access, 'prepaid_voucher_controls', 'view');
  const parts: Part[] = controls ? ['pauses', 'quotas', 'tests', 'replacement', 'simulator'] : ['simulator'];
  const [picked, setPicked] = useState<Part>(parts[0]);
  const part = parts.includes(picked) ? picked : parts[0];
  return (
    <div className="space-y-3">
      {parts.length > 1 ? (
        <div className="overflow-x-auto">
          <Segmented value={part} onChange={setPicked} className="min-w-[36rem] max-w-3xl" label={t('label')}
            options={parts.map((p) => ({ id: p, label: t(`parts.${p}`) }))} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('controlsHidden')}</p>
      )}
      {part === 'pauses' ? <PausesSection />
        : part === 'quotas' ? <QuotasSection />
          : part === 'tests' ? <TestBatchesSection />
            : part === 'replacement' ? <ReplacementSection />
              : <SimulatorSection />}
    </div>
  );
}
