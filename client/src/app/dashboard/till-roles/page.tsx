'use client';

/**
 * "תפקידים והרשאות" — what each till user may do (docs/SPEC_ROLES_PERMISSIONS.md): the
 * company's till roles as a matrix (permissions × roles, tri-state מותר / באישור מנהל /
 * אסור, with limits), the till users' roles and personal exceptions, the cash drawer's
 * parameters per level, and the audit of every change.
 *
 * Roles belong to a company. The company's managers (and up) define them; a shop's
 * managers read them and assign their own shop's users. The server decides both
 * (`canEdit`, and the assignment endpoint's own check).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { fetchPermissionCatalogue, fetchTillRoles } from '@/lib/tillRolesApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { TabBar } from '@/components/dashboard/notifications/shared';
import { MatrixTab } from '@/components/dashboard/till-roles/matrix-tab';
import { UsersTab } from '@/components/dashboard/till-roles/users-tab';
import { AuditTab } from '@/components/dashboard/till-roles/audit-tab';
import { DrawerParamsTab } from '@/components/dashboard/till-roles/drawer-params-tab';

type Tab = 'matrix' | 'users' | 'drawer' | 'audit';

function RolesBody({ companyId, shopId }: { companyId: string; shopId: string | null }) {
  const t = useTranslations('tillRoles');
  const canAssign = useAuth((s) => s.user?.canManagePosUsers === true);
  const [tab, setTab] = useState<Tab>('matrix');
  const catalogue = useQuery({ queryKey: ['till-permission-catalogue'], queryFn: fetchPermissionCatalogue, staleTime: 3_600_000 });
  const roles = useQuery({ queryKey: ['till-roles', companyId], queryFn: () => fetchTillRoles(companyId) });

  if (catalogue.isLoading || roles.isLoading) return <Skeleton className="h-96 w-full" />;
  if (roles.isError || catalogue.isError || !roles.data || !catalogue.data) {
    const status = (roles.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <p role="alert" className="text-sm text-destructive">
        {status === 403 ? t('noPermission') : t('loadError')}
      </p>
    );
  }
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'matrix', label: t('tabs.matrix') },
    { id: 'users', label: t('tabs.users') },
    { id: 'drawer', label: t('tabs.drawer') },
    { id: 'audit', label: t('tabs.audit') },
  ];
  return (
    <div className="space-y-4">
      <TabBar tabs={tabs} value={tab} onChange={setTab} label={t('tabs.label')} />
      {tab === 'matrix' ? (
        <MatrixTab companyId={companyId} catalogue={catalogue.data} data={roles.data} />
      ) : tab === 'users' ? (
        <UsersTab companyId={companyId} shopId={shopId} catalogue={catalogue.data} data={roles.data} canAssign={canAssign} />
      ) : tab === 'drawer' ? (
        <DrawerParamsTab companyId={companyId} shopId={shopId} canEdit={roles.data.canEdit} />
      ) : (
        <AuditTab companyId={companyId} catalogue={catalogue.data} />
      )}
    </div>
  );
}

export default function TillRolesPage() {
  const t = useTranslations('tillRoles');
  // Roles are a company's; the shop in scope (if any) narrows the users list and the
  // drawer parameters' levels.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <ScopeGate resolution={resolution}>
        {effective.companyId ? (
          <RolesBody key={effective.companyId} companyId={effective.companyId} shopId={effective.shopId ?? null} />
        ) : null}
      </ScopeGate>
    </div>
  );
}
