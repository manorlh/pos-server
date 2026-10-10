'use client';

/**
 * "מה אני רשאי לראות" — the signed-in user's own sections and data scope ("הרשאות דשבורד").
 * Shown on the profile page, on the home page of a user without reports, and under a refused
 * page. The names come from `GET /dashboard-access/me`; the grant itself from /users/me.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { grantedSections, sectionHome } from '@/lib/dashboardAccess';
import { useDashboardAccess, useMyAccess } from '@/lib/dashboardAccessApi';

export function MyAccessCard({ className }: { className?: string }) {
  const t = useTranslations('dashboardAccess');
  const access = useDashboardAccess();
  const { data, isLoading } = useMyAccess(access.restricted);

  const granted = grantedSections(access);
  const names = (rows: { name: string }[] | undefined) => (rows ?? []).map((r) => r.name).join(', ');
  const scope = !access.restricted
    ? null
    : access.orgWide
      ? t('scopeOrgWide')
      : (access.companyIds?.length ?? 0) > 0 || (access.shopIds?.length ?? 0) > 0
        ? [
            (access.companyIds?.length ?? 0) > 0 ? t('scopeCompanies', { names: names(data?.companies) }) : null,
            (access.shopIds?.length ?? 0) > 0 ? t('scopeShops', { names: names(data?.shops) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : t('scopeRole');

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" />
          {t('summaryTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!access.restricted ? (
          <p className="text-muted-foreground">{t('summaryFull')}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{granted.length ? t('summaryIntro') : t('noSections')}</p>
            <ul className="flex flex-wrap gap-2">
              {granted.map((id) => (
                <li key={id}>
                  <Link
                    href={sectionHome(id)}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 hover:bg-muted"
                  >
                    {t(`sections.${id}`)}
                    <Badge variant={access.sections[id] === 'edit' ? 'default' : 'secondary'}>
                      {t(`levels.${access.sections[id] ?? 'view'}`)}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="space-y-1">
              <p className="font-medium">{t('dataScope')}</p>
              {isLoading ? (
                <Skeleton className="h-4 w-48" />
              ) : (
                <>
                  <p className="text-muted-foreground">{scope}</p>
                  {data?.organizations?.length ? (
                    <p className="text-muted-foreground">{t('organizations', { names: names(data.organizations) })}</p>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A page of a section this user was not given (or, for a page that only acts, given at view
 * alone): say so, and what they may open instead.
 */
export function SectionDenied({ section, needsEdit = false }: { section: string; needsEdit?: boolean }) {
  const t = useTranslations('dashboardAccess');
  const label = t(`sections.${section}`);
  return (
    <div className="max-w-xl space-y-4">
      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-lg font-semibold">{t('deniedTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {needsEdit ? t('deniedEditBody', { section: label }) : t('deniedBody', { section: label })}
        </p>
      </div>
      <MyAccessCard />
    </div>
  );
}
