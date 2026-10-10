'use client';

/**
 * "תפריטים" (pos-server docs/SPEC_MENUS.md): sales menus by schedule — "בוקר", "צהריים",
 * "הפי האוור", "קיוסק". Each menu is categories and products in its own order (a price of
 * its own while it is active, VAT by the product), for the tills, the kiosk or both, on a
 * schedule; assigned at a company, shop, point of sale or till with a priority. While a
 * menu is active the till sells exactly it (within availability blocks and the product's
 * sales channel). The tills and kiosks work out which is active on their own clock,
 * offline — lib/menuSchedule.ts is the same rules, pinned by shared golden fixtures.
 *
 * Tabs: the menus (and the editor), where they are assigned, what is active now (and the
 * simulator), and the sales report by menu. Server: `/catalog-menus*`, `/reports/menu-sales`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { IosCanvas, IosSegmented } from '@/components/dashboard/menu/ios';
import { MenuBroadcastBanner } from '@/components/dashboard/menu/broadcast-banner';
import { MenusTab } from '@/components/dashboard/catalog-menus/menus-tab';
import { AssignTab } from '@/components/dashboard/catalog-menus/assign-tab';
import { NowTab } from '@/components/dashboard/catalog-menus/now-tab';
import { ReportTab } from '@/components/dashboard/catalog-menus/report-tab';

type Tab = 'menus' | 'assign' | 'now' | 'report';

export default function CatalogMenusPage() {
  const t = useTranslations('catalogMenus');
  const [tab, setTab] = useState<Tab>('menus');

  return (
    <div className="space-y-4">
      <MenuBroadcastBanner />
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <IosSegmented
        className="max-w-xl"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'menus', label: t('tabs.menus') },
          { id: 'assign', label: t('tabs.assign') },
          { id: 'now', label: t('tabs.now') },
          { id: 'report', label: t('tabs.report') },
        ]}
      />
      {tab === 'report' ? (
        <ReportTab />
      ) : (
        <IosCanvas>
          <div className="mx-auto max-w-4xl">
            {tab === 'menus' ? <MenusTab /> : tab === 'assign' ? <AssignTab /> : <NowTab />}
          </div>
        </IosCanvas>
      )}
    </div>
  );
}
