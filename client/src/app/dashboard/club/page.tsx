'use client';

/**
 * "מועדון לקוחות" — one club per company (docs/SPEC_NOTIFICATIONS_CLUB.md part ג):
 * its settings, the public sign-up page, the versioned terms / privacy / consent texts,
 * the QR sources that lead to the page, and the members. Company managers and up (the
 * server's CLUB_ADMIN_ROLES), for the company in scope.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchClub } from '@/lib/clubApi';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import type { UserRole } from '@/lib/types';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { DocumentsTab } from '@/components/dashboard/club/documents-tab';
import { LandingTab } from '@/components/dashboard/club/landing-tab';
import { MembersTab } from '@/components/dashboard/club/members-tab';
import { ClubSettingsTab } from '@/components/dashboard/club/settings-tab';
import { SourcesTab } from '@/components/dashboard/club/sources-tab';
import { NC, TabBar, useNcErrorText } from '@/components/dashboard/notifications/shared';

type Tab = 'settings' | 'landing' | 'documents' | 'sources' | 'members';

const CLUB_ROLES: UserRole[] = ['super_admin', 'distributor', 'company_manager'];

function ClubBody({ companyId }: { companyId: string }) {
  const t = useTranslations(`${NC}.club`);
  const errorText = useNcErrorText();
  const [tab, setTab] = useState<Tab>('settings');
  const club = useQuery({ queryKey: ['club', companyId], queryFn: () => fetchClub(companyId) });

  if (club.isLoading) return <Skeleton className="h-48 w-full" />;
  if (club.isError || !club.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorText(club.error)}
      </p>
    );
  }
  const data = club.data;
  if (!data.club) return <ClubSettingsTab companyId={companyId} data={data} />;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'settings', label: t('tabs.settings') },
    { id: 'landing', label: t('tabs.landing') },
    { id: 'documents', label: t('tabs.documents') },
    { id: 'sources', label: t('tabs.sources') },
    { id: 'members', label: t('tabs.members') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{data.club.name}</span>
        <span className="text-muted-foreground">· {data.companyName}</span>
        {!data.club.isActive ? <span className="text-amber-800 dark:text-amber-300">· {t('inactiveNote')}</span> : null}
      </div>
      <TabBar tabs={tabs} value={tab} onChange={setTab} label={t('tabsLabel')} />
      {tab === 'settings' ? (
        <ClubSettingsTab companyId={companyId} data={data} />
      ) : tab === 'landing' ? (
        <LandingTab companyId={companyId} data={data} />
      ) : tab === 'documents' ? (
        <DocumentsTab companyId={companyId} data={data} />
      ) : tab === 'sources' ? (
        <SourcesTab companyId={companyId} data={data} />
      ) : (
        <MembersTab companyId={companyId} />
      )}
    </div>
  );
}

export default function ClubPage() {
  const t = useTranslations(`${NC}.club`);
  const role = useAuth((s) => s.user?.role);
  const authHydrated = useAuth((s) => s.authHydrated);
  const { resolution, effective } = usePageScope({ maxLevel: 'company', minLevel: 'company' });
  const allowed = !!role && CLUB_ROLES.includes(role);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {authHydrated && !allowed ? (
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      ) : (
        <ScopeGate resolution={resolution}>
          {effective.companyId ? <ClubBody key={effective.companyId} companyId={effective.companyId} /> : null}
        </ScopeGate>
      )}
    </div>
  );
}
