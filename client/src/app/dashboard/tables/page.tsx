'use client';

/**
 * Table management ("ניהול שולחנות") for one shop: the floor editor (zones, map or grid,
 * tables), the open tables now, the tables report, and the cancellation reasons. Whether
 * a till uses tables, and how, is its till parameter "ניהול שולחנות" (`tablesMode`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Button } from '@/components/ui/button';
import { TablesEditor } from '@/components/dashboard/tables/tables-editor';
import { TablesLive } from '@/components/dashboard/tables/tables-live';
import { TablesReportView } from '@/components/dashboard/tables/tables-report';
import { CancelReasons } from '@/components/dashboard/tables/cancel-reasons';
import { TableReservations } from '@/components/dashboard/tables/reservations';

type Section = 'editor' | 'live' | 'reservations' | 'report' | 'reasons';

export default function TablesPage() {
  const t = useTranslations('tables');
  // Tables belong to one shop: the page asks for one.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';
  const [section, setSection] = useState<Section>('editor');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={section === 'editor' ? 'default' : 'outline'} onClick={() => setSection('editor')}>
          {t('sectionEditor')}
        </Button>
        <Button size="sm" variant={section === 'live' ? 'default' : 'outline'} onClick={() => setSection('live')}>
          {t('sectionLive')}
        </Button>
        <Button
          size="sm"
          variant={section === 'reservations' ? 'default' : 'outline'}
          onClick={() => setSection('reservations')}
        >
          {t('sectionReservations')}
        </Button>
        <Button size="sm" variant={section === 'report' ? 'default' : 'outline'} onClick={() => setSection('report')}>
          {t('sectionReport')}
        </Button>
        <Button size="sm" variant={section === 'reasons' ? 'default' : 'outline'} onClick={() => setSection('reasons')}>
          {t('sectionReasons')}
        </Button>
      </div>
      {section === 'reasons' ? (
        <CancelReasons />
      ) : (
        <ScopeGate resolution={resolution}>
          {shopId ? (
            section === 'editor' ? (
              <TablesEditor shopId={shopId} />
            ) : section === 'live' ? (
              <TablesLive shopId={shopId} />
            ) : section === 'reservations' ? (
              <TableReservations shopId={shopId} />
            ) : (
              <TablesReportView shopId={shopId} />
            )
          ) : null}
        </ScopeGate>
      )}
    </div>
  );
}
