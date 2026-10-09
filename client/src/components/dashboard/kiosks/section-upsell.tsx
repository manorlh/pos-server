'use client';

/**
 * "הגדלת מכירה" in the kiosk's settings (docs/SPEC_KIOSK.md §21): the rules themselves are the
 * menu's — one feature on quick orders, tables and the kiosk, edited under "הגדלות מכירה"
 * (a rule marked "קיוסק" comes up here: on adding an item, entering a category, the start of
 * the order, the basket, the way to payment). The kiosk keeps only its switch and its cap: at
 * most `upsell.maxShown` windows in one order, all rules together.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { UPSELL_MAX_SHOWN } from '@/lib/kioskConfig';
import { NumberField, SectionCard, SwitchField } from './fields';

export function UpsellSection() {
  const t = useTranslations('kiosks.upsell');
  const tf = useTranslations('kiosks.fields');
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('menuHint')} paths={['general.upsellEnabled', 'upsell.maxShown']}>
        <SwitchField path="general.upsellEnabled" label={tf('general.upsellEnabled')} />
        <NumberField path="upsell.maxShown" label={t('maxShown')} hint={t('maxShownHint')} min={1} max={UPSELL_MAX_SHOWN} />
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 p-3 text-sm">
          <span className="flex-1 text-muted-foreground">{t('rulesInMenu')}</span>
          <Link href="/dashboard/upsells?place=kiosk" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
            {t('openRules')} <ExternalLink />
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}
