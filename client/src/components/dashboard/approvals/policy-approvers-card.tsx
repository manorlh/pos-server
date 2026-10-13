'use client';

/**
 * "מי יקבל בקשות" on the settings page (P:\specs\manager-approval-mobile.md §5, §9.3): everyone
 * who could receive this level's requests — every type that is on with "בקשה מהנייד", whatever
 * their shift and ceilings — with their roles, the types and their phones' health; and a warning
 * per person with no phone registered: they get no requests until they register one.
 * `GET /approvals/policy/approvers` (refetched after a save, components/…/policy-editor.tsx).
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, Users } from 'lucide-react';
import { roleLabel, typeLabels, type ApprovalCatalog, type PolicyLevel } from '@/lib/approvals';
import { fetchPolicyApprovers } from '@/lib/approvalsApi';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApproverHealth } from './approver-health';

export const policyApproversKey = (level: PolicyLevel, id: string) => ['approvals', 'policy-approvers', level, id] as const;

export function PolicyApproversCard({ level, id, catalog }: { level: PolicyLevel; id: string; catalog: ApprovalCatalog }) {
  const t = useTranslations('approvals.receivers');
  const query = useQuery({
    queryKey: policyApproversKey(level, id),
    queryFn: () => fetchPolicyApprovers(level, id),
    retry: false,
  });
  // A server without the endpoint: the card is not shown.
  if (query.isError) return null;

  const items = query.data?.items ?? [];
  const withoutDevice = query.data?.withoutDevice ?? [];

  return (
    <Card className="gap-3 p-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <Users className="size-4" aria-hidden />
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-xs">{t('hint')}</p>
      </div>

      {query.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <>
          {withoutDevice.length ? (
            <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40" role="alert">
              {withoutDevice.map((name) => (
                <li key={name} className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                  <span>{t('noDevice', { name })}</span>
                </li>
              ))}
              <li className="text-muted-foreground ps-6 text-xs">
                {t('noDeviceHint')}{' '}
                <Link href="/dashboard/alerts" className="text-primary hover:underline">
                  {t('alertsLink')}
                </Link>
              </li>
            </ul>
          ) : null}
          <ul className="divide-y text-sm">
            {items.map((p) => {
              const types = typeLabels(p.types, catalog.types);
              return (
                <li key={p.userId || p.name} className="flex items-start gap-3 py-2">
                  <ApproverHealth health={p.health} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {p.name}
                      {p.roles.length ? (
                        <span className="text-muted-foreground font-normal"> · {p.roles.map((r) => roleLabel(catalog.roles, r)).join(', ')}</span>
                      ) : null}
                    </p>
                    {p.shops.length > 1 ? <p className="text-muted-foreground text-xs">{p.shops.join(', ')}</p> : null}
                    {types.length ? (
                      <p className="text-muted-foreground text-xs" title={types.join(', ')}>
                        {types.length > 4 ? t('typesMore', { list: types.slice(0, 4).join(', '), more: types.length - 4 }) : types.join(', ')}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
