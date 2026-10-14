'use client';

/**
 * "מחוברים כעת במכשירים": who is signed in at which device of the shop, for
 * "עובד מחובר בקופה אחת בלבד" (till parameter `exclusiveUserLogin`,
 * docs/SPEC_EXCLUSIVE_LOGIN.md; v2: P:/specs/exclusive-login-v2.md §6, §8). Each row: the device,
 * since when, "לא מדווח" when that device stopped reporting (safe to release), and the employee's
 * open tables. A manager holding "שחרור עובד מחובר במכשיר" may release one — a device that went
 * down with the employee signed in — so they can sign in elsewhere at once; a device that is still
 * up signs them out at the end of its operation. Every release is recorded as an exception.
 *
 * The tables (§8ב): they stay the employee's; where `exclusiveReleaseTables = ask` the release asks
 * "להשאיר אצלה / להעביר ל…" and hands them on ("החלפת מלצר"). A silent device's tables are freed by
 * the release itself — what the cloud says about them is shown to the manager.
 *
 * On the employees page and on the phone's home ("הניהול שלי", cockpit registry): one column on a
 * phone, the button a full-width tap target. The button shows only when the server says
 * `canRelease`. Shown only when the rule is on for the shop, or when someone is recorded anyway
 * (a till-level value).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { asksAboutTables, releaseOutcomeLines, tablesQuestion, transfersTo, type TableTransfer } from '@/lib/exclusiveLogin';
import { formatDateTime } from '@/lib/format';
import { fetchUserSessions, releaseUserSession, type UserSession } from '@/lib/userSessionsApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

function nameOf(s: UserSession): string {
  return s.posUserName ?? s.username ?? '';
}

function rowTables(s: UserSession) {
  return { openTables: s.openTables ?? s.tables?.length ?? 0, tables: s.tables ?? [], releaseTables: s.releaseTables ?? 'keep' };
}

export function SignedInNowCard({ shopId }: { shopId: string }) {
  const t = useTranslations('userSessions');
  const qc = useQueryClient();
  const [asking, setAsking] = useState<UserSession | null>(null);
  const query = useQuery({
    queryKey: ['user-sessions', shopId],
    queryFn: () => fetchUserSessions(shopId),
    enabled: !!shopId,
    // Tills heartbeat every minute; the list follows without a reload.
    refetchInterval: 30_000,
  });
  const release = useMutation({
    mutationFn: ({ s, transfers }: { s: UserSession; transfers: TableTransfer[] }) => releaseUserSession(shopId, s.id, transfers),
    onSuccess: (out) => {
      setAsking(null);
      qc.invalidateQueries({ queryKey: ['user-sessions', shopId] });
      toast.success(t('released'));
      // The hand-over, what stayed and why, and what a silent device's tables mean.
      for (const line of releaseOutcomeLines(out)) toast.warning(line, { duration: 12_000 });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('releaseError'))),
  });

  const data = query.data;
  if (!query.isLoading && data && !data.exclusive && data.sessions.length === 0) return null;
  const canRelease = data?.canRelease === true;

  const start = (s: UserSession) => {
    if (asksAboutTables(rowTables(s))) {
      setAsking(s);
      return;
    }
    if (window.confirm(t('releaseConfirm', { name: nameOf(s) }))) release.mutate({ s, transfers: [] });
  };

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
            {data.sessions.map((s) => {
              const open = rowTables(s).openTables;
              return (
                <li
                  key={s.id}
                  className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4"
                >
                  <span className="font-medium">{s.posUserName ?? s.username ?? '—'}</span>
                  <span>
                    {[s.posNumber ? t('till', { n: s.posNumber }) : null, s.machineName].filter(Boolean).join(' · ')}
                  </span>
                  <span className="text-muted-foreground">{t('since', { at: formatDateTime(s.startedAt) })}</span>
                  {open > 0 ? <span className="text-muted-foreground">{t('openTables', { n: open })}</span> : null}
                  {(s.silent || s.stale) && (
                    <Badge
                      variant="outline"
                      className="w-fit"
                      title={s.stale ? t('staleHint', { minutes: s.staleMinutes }) : t('silentHint')}
                    >
                      {t('silent', { at: formatDateTime(s.silentSince ?? s.lastSeenAt) })}
                    </Badge>
                  )}
                  {canRelease && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1 w-full sm:ms-auto sm:mt-0 sm:w-auto"
                      disabled={release.isPending}
                      onClick={() => start(s)}
                    >
                      {t('release')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <TablesQuestion
        session={asking}
        waiters={data?.waiters ?? []}
        busy={release.isPending}
        onClose={() => setAsking(null)}
        onRelease={(s, toPosUserId) => release.mutate({ s, transfers: transfersTo(rowTables(s), toPosUserId) })}
      />
    </Card>
  );
}

/** "לדנה 3 שולחנות פתוחים: להשאיר אצלה / להעביר ל…" (§8ב, `exclusiveReleaseTables = ask`). */
function TablesQuestion({
  session,
  waiters,
  busy,
  onClose,
  onRelease,
}: {
  session: UserSession | null;
  waiters: { posUserId: string; name: string | null; onShift?: boolean }[];
  busy: boolean;
  onClose: () => void;
  onRelease: (s: UserSession, toPosUserId: string | null) => void;
}) {
  const t = useTranslations('userSessions');
  const name = session ? nameOf(session) : '';
  const tables = session ? rowTables(session) : null;
  const others = waiters.filter((w) => w.posUserId !== session?.posUserId);
  return (
    <Dialog open={session !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('releaseTitle', { name })}</DialogTitle>
          <DialogDescription>
            {tables ? `${tablesQuestion(name, tables.openTables)}. ${t('tablesAsk')}` : null}
          </DialogDescription>
        </DialogHeader>
        {tables && tables.tables.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {tables.tables.map((tb) => t('table', { n: String(tb.number ?? tb.name ?? '?') })).join(' · ')}
          </p>
        ) : null}
        <div className="space-y-2">
          <Button className="h-11 w-full" disabled={busy || !session} onClick={() => session && onRelease(session, null)}>
            {t('keepTables', { name })}
          </Button>
          <p className="pt-1 text-sm font-medium">{t('transferTo')}</p>
          {others.length === 0 ? <p className="text-xs text-muted-foreground">{t('noWaiters')}</p> : null}
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
            {others.map((w) => (
              <Button
                key={w.posUserId}
                size="sm"
                variant="outline"
                disabled={busy || !session}
                onClick={() => session && onRelease(session, w.posUserId)}
              >
                {w.name ?? '?'}
                {w.onShift ? <span className="ms-1 text-[10px] text-green-700 dark:text-green-400">●</span> : null}
              </Button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
