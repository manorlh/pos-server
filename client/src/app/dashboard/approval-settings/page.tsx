'use client';

/**
 * "בקשות אישור" settings (P:\specs\manager-approval-mobile.md §4): which till actions may be
 * sent to a manager's phone for approval, who approves and how — at a company, a shop, a point
 * of sale or a till. Pick the level with the cascade; the master switch and every field of every
 * type is set here or left to inherit, and the inherited value shows what it is and which level
 * above decided it (else "ברירת מחדל"). The most specific level wins, field by field.
 *
 * Read-only when the server says this user may not write the level (`canWrite`).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { fetchApprovalPolicy } from '@/lib/approvalsApi';
import { apiErrorOf, type PolicyLevel, type PolicyResponse } from '@/lib/approvals';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { PolicyEditor } from '@/components/dashboard/approvals/policy-editor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ApprovalSettingsPage() {
  const t = useTranslations('approvals.settings');
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const target = deepestOrgScope(scope);
  // No organization level here: the policy starts at a company.
  const level = target && target.level !== 'tenant' && target.id ? (target.level as PolicyLevel) : null;
  const entityId = level ? target?.id ?? null : null;

  const { data, isLoading, isError, error } = useQuery<PolicyResponse>({
    queryKey: ['approvals', 'policy', level, entityId],
    queryFn: () => fetchApprovalPolicy(level as PolicyLevel, entityId as string),
    enabled: !!level && !!entityId,
    retry: false,
  });

  return (
    <div className="min-w-0 space-y-4 max-sm:px-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/approvals" className="text-primary text-sm hover:underline">
          {t('listLink')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scopeTitle')}</CardTitle>
          <p className="text-muted-foreground text-xs">{t('scopeHint')}</p>
        </CardHeader>
        <CardContent>
          <OrgScopeCascade value={scope} onChange={setScope} />
        </CardContent>
      </Card>

      {!level ? (
        <p className="text-muted-foreground text-sm">{t('chooseScope')}</p>
      ) : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : isError || !data ? (
        <p className="text-destructive text-sm" role="alert">
          {apiErrorOf(error).status === 403 ? t('noPermission') : t('loadError')}
        </p>
      ) : (
        <PolicyEditor key={`${data.level}:${data.id}:${JSON.stringify(data.own)}`} data={data} />
      )}
    </div>
  );
}
