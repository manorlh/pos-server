'use client';

/**
 * "משפטי ונגישות" (P:\specs\digital-menu-ordering-cards-plan.md §17, §21): the accessibility
 * statement, privacy policy, terms and cookie policy of the digital menu, online ordering and
 * business cards — per company, with shop overrides. Each starts from a Hebrew template marked
 * "טיוטה — יש לבדוק עם עורך דין", is published only after "נבדק", and the public pages show only
 * published versions. Plus the publication check per channel and the contrast / toolbar notes.
 *
 * Company managers and up for a company; a shop's manager for their shop (the server decides).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchLegalCatalog, fetchLegalOverview } from '@/lib/digitalLegalApi';
import { LEGAL_KINDS, type LegalKind } from '@/lib/legalDocs';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import type { UserRole } from '@/lib/types';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { TabBar } from '@/components/dashboard/notifications/shared';
import { DraftBanner, LegalDocumentEditor } from '@/components/dashboard/digital-legal/legal-document-editor';
import { PublicationPanel } from '@/components/dashboard/digital-legal/publication-panel';
import { ThemePanel } from '@/components/dashboard/digital-legal/theme-panel';

const NS = 'digitalLegal';
const ROLES: UserRole[] = ['super_admin', 'distributor', 'company_manager', 'shop_manager'];

type Tab = LegalKind | 'publication' | 'theme';

function LegalBody({ companyId, shopId }: { companyId: string; shopId: string | null }) {
  const t = useTranslations(NS);
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('accessibility');
  const catalog = useQuery({ queryKey: ['digital-legal', 'catalog'], queryFn: fetchLegalCatalog, staleTime: 60 * 60 * 1000 });
  const overview = useQuery({
    queryKey: ['digital-legal', 'documents', companyId, shopId],
    queryFn: () => fetchLegalOverview({ companyId, shopId }),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['digital-legal'] });
  };

  if (catalog.isLoading || overview.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!catalog.data || !overview.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('loadError')}
      </p>
    );
  }
  const data = overview.data;
  const defs = new Map(catalog.data.kinds.map((k) => [k.kind, k]));
  const tabs: Array<{ id: Tab; label: string }> = [
    ...LEGAL_KINDS.map((k) => ({ id: k as Tab, label: defs.get(k)?.title ?? k })),
    { id: 'publication', label: t('tabs.publication') },
    { id: 'theme', label: t('tabs.theme') },
  ];
  const def = tab !== 'publication' && tab !== 'theme' ? defs.get(tab) : undefined;

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {data.shopId ? t('scopeShop', { name: data.shopName ?? '' }) : t('scopeCompany', { name: data.companyName })}
      </p>
      <DraftBanner banner={catalog.data.draftBanner} disclaimer={catalog.data.disclaimer} />
      <TabBar tabs={tabs} value={tab} onChange={setTab} label={t('tabsLabel')} />
      {tab === 'publication' ? (
        <PublicationPanel companyId={companyId} shopId={shopId} />
      ) : tab === 'theme' ? (
        <ThemePanel />
      ) : def ? (
        <LegalDocumentEditor
          key={`${tab}:${companyId}:${shopId ?? ''}`}
          scope={{ companyId, shopId }}
          def={def}
          state={data.kinds[tab]}
          banner={catalog.data.draftBanner}
          disclaimer={catalog.data.disclaimer}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}

export default function DigitalLegalPage() {
  const t = useTranslations(NS);
  const role = useAuth((s) => s.user?.role);
  const authHydrated = useAuth((s) => s.authHydrated);
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  const allowed = !!role && ROLES.includes(role);

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
          {effective.companyId ? (
            <LegalBody key={`${effective.companyId}:${effective.shopId ?? ''}`} companyId={effective.companyId} shopId={effective.shopId ?? null} />
          ) : null}
        </ScopeGate>
      )}
    </div>
  );
}
