'use client';

/**
 * "מחוברים כעת בקופות": who is signed in at which till of the shop, for
 * "עובד מחובר בקופה אחת בלבד" (till parameter `exclusiveUserLogin`,
 * docs/SPEC_EXCLUSIVE_LOGIN.md). A manager may release one — a till that went down with
 * the employee signed in — so they can sign in at another till at once; a till that is
 * still up signs them out on its next heartbeat (about a minute).
 *
 * Shown only when the rule is on for the shop, or when someone is recorded anyway (a
 * till-level value).
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import { fetchUserSessions, releaseUserSession, type UserSession } from '@/lib/userSessionsApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function SignedInNowCard({ shopId, canRelease }: { shopId: string; canRelease: boolean }) {
  const t = useTranslations('userSessions');
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['user-sessions', shopId],
    queryFn: () => fetchUserSessions(shopId),
    enabled: !!shopId,
    // Tills heartbeat every minute; the list follows without a reload.
    refetchInterval: 30_000,
  });
  const release = useMutation({
    mutationFn: (s: UserSession) => releaseUserSession(shopId, s.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-sessions', shopId] });
      toast.success(t('released'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('releaseError'))),
  });

  const data = query.data;
  if (!query.isLoading && data && !data.exclusive && data.sessions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <MonitorSmartphone className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('desc')}</p>
        {query.isLoading || !data ? (
          <Skeleton className="h-16 w-full" />
        ) : data.sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('nobody')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <span className="font-medium">{s.posUserName ?? s.username ?? '—'}</span>
                <span>
                  {[s.posNumber ? t('till', { n: s.posNumber }) : null, s.machineName].filter(Boolean).join(' · ')}
                </span>
                <span className="text-muted-foreground">{t('since', { at: formatDateTime(s.startedAt) })}</span>
                {s.stale && (
                  <Badge variant="outline" title={t('staleHint', { minutes: s.staleMinutes })}>
                    {t('stale', { at: formatDateTime(s.lastSeenAt) })}
                  </Badge>
                )}
                {canRelease && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ms-auto"
                    disabled={release.isPending}
                    onClick={() => {
                      if (window.confirm(t('releaseConfirm', { name: s.posUserName ?? s.username ?? '' }))) {
                        release.mutate(s);
                      }
                    }}
                  >
                    {t('release')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
