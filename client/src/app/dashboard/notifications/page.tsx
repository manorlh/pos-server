'use client';

/**
 * "הודעות" — the SMS notification service (docs/SPEC_NOTIFICATIONS_CLUB.md §17–§18):
 * the message log, the templates, the 019 provider account and (later) campaigns.
 *
 * The log follows the scope bar down to a shop; the templates, the provider account
 * and campaigns are a company's (or, for the super admin / distributor with no company
 * in scope, the organization's default). A shop manager reads the log of their shop
 * only; the other tabs are company managers' and up — the server's own role sets.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { CampaignsTab } from '@/components/dashboard/notifications/campaigns-tab';
import { LogTab } from '@/components/dashboard/notifications/log-tab';
import { ProviderTab } from '@/components/dashboard/notifications/provider-tab';
import { NC, TabBar } from '@/components/dashboard/notifications/shared';
import { TemplatesTab } from '@/components/dashboard/notifications/templates-tab';
import type { UserRole } from '@/lib/types';

type Tab = 'log' | 'templates' | 'provider' | 'campaigns';

/** server: app/services/club/scope.py CLUB_ADMIN_ROLES / LOG_ROLES. */
const ADMIN_ROLES: UserRole[] = ['super_admin', 'distributor', 'company_manager'];
const LOG_ROLES: UserRole[] = [...ADMIN_ROLES, 'shop_manager'];

export default function NotificationsPage() {
  const t = useTranslations(`${NC}.notifications`);
  const user = useAuth((s) => s.user);
  const authHydrated = useAuth((s) => s.authHydrated);
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop' });
  const [tab, setTab] = useState<Tab>('log');

  const role = user?.role;
  const isAdmin = !!role && ADMIN_ROLES.includes(role);
  const canReadLog = !!role && LOG_ROLES.includes(role);
  const isSuperAdmin = role === 'super_admin';
  const orgWide = role === 'super_admin' || role === 'distributor';
  // A company manager without a company in scope works on their own company.
  const settingsCompanyId = effective.companyId ?? (role === 'company_manager' ? (user?.companyId ?? null) : null);
  const settingsReady = orgWide || !!settingsCompanyId;
  const settingsLabel = settingsCompanyId
    ? (scope.companies.find((c) => c.id === settingsCompanyId)?.name ?? scope.company?.name ?? '')
    : t('orgDefault');

  if (authHydrated && !canReadLog) {
    return (
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      </div>
    );
  }

  const tabs: Array<{ id: Tab; label: string }> = [{ id: 'log', label: t('tabs.log') }];
  if (isAdmin) {
    tabs.push(
      { id: 'templates', label: t('tabs.templates') },
      { id: 'provider', label: t('tabs.provider') },
      { id: 'campaigns', label: t('tabs.campaigns') },
    );
  }
  const current: Tab = tabs.some((x) => x.id === tab) ? tab : 'log';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <TabBar tabs={tabs} value={current} onChange={setTab} label={t('tabsLabel')} />

      <ScopeGate resolution={resolution} silent={current !== 'log'}>
        {current === 'log' ? (
          <LogTab companyId={effective.companyId} shopId={effective.shopId} canReveal={isAdmin} />
        ) : !settingsReady ? (
          <p className="rounded-lg border bg-muted/30 p-5 text-sm">{t('pickCompany')}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('settingsFor', { name: settingsLabel })}</p>
            {current === 'templates' ? (
              <TemplatesTab companyId={settingsCompanyId} canWrite={isAdmin} />
            ) : current === 'provider' ? (
              <ProviderTab companyId={settingsCompanyId} isSuperAdmin={isSuperAdmin} />
            ) : (
              <CampaignsTab companyId={settingsCompanyId} />
            )}
          </div>
        )}
      </ScopeGate>
    </div>
  );
}
