'use client';

/**
 * "עובדים במשמרת": every open attendance shift in the caller's scope, as cards — name, job
 * title, clock-in, duration, status (working / on break / waiting for a manager), open
 * tables, the till they are signed in at now. Refreshed every 30 seconds; the durations
 * tick between refreshes from the server's own figures.
 *
 * The till shown is the login ("POS Session"), never the attendance: an employee on shift
 * may be signed in nowhere at this moment (between tills, on the floor) and is still on shift.
 */

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Monitor, RefreshCw, UtensilsCrossed } from 'lucide-react';
import { fetchLive } from '@/lib/attendanceApi';
import { cardAlerts, cardStatus, formatHours, liveSeconds, type AttendanceShift } from '@/lib/attendance';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AttendanceFilters, EMPTY_ATTENDANCE_SCOPE, scopeParams, type AttendanceScope } from './attendance-filters';
import { CloseShiftDialog } from './close-shift-dialog';

const REFRESH_MS = 30_000;

const STATUS_TONE: Record<'working' | 'on_break' | 'pending', string> = {
  working: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  on_break: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  pending: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
};

function timeOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

export function LiveBoard() {
  const t = useTranslations('attendance');
  const { user } = useAuth();
  const canManage = user?.canManagePosUsers === true;
  const [scope, setScope] = useState<AttendanceScope>(EMPTY_ATTENDANCE_SCOPE);
  const [closing, setClosing] = useState<AttendanceShift | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: ['attendance', 'live', scopeParams(scope)],
    queryFn: () => fetchLive(scopeParams(scope)),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const shifts = useMemo(() => query.data?.shifts ?? [], [query.data]);
  const counts = useMemo(() => {
    const out = { working: 0, on_break: 0, pending: 0 };
    for (const s of shifts) out[cardStatus(s)] += 1;
    return out;
  }, [shifts]);
  const serverTime = query.data?.serverTime ?? null;

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <CardContent className="space-y-3 pt-4">
          <AttendanceFilters value={scope} onChange={setScope} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-sm">{t('live.total', { n: shifts.length })}</Badge>
        <Badge className={cn('text-sm', STATUS_TONE.working)}>{t('live.working', { n: counts.working })}</Badge>
        <Badge className={cn('text-sm', STATUS_TONE.on_break)}>{t('live.onBreak', { n: counts.on_break })}</Badge>
        {counts.pending > 0 ? (
          <Badge className={cn('text-sm', STATUS_TONE.pending)}>{t('live.pending', { n: counts.pending })}</Badge>
        ) : null}
        <span className="text-muted-foreground ms-auto text-xs">
          {query.dataUpdatedAt
            ? t('live.updated', { ago: formatDistanceToNow(query.dataUpdatedAt, { locale: he, addSuffix: true }) })
            : null}
        </span>
        <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} />
          {t('live.refresh')}
        </Button>
      </div>

      {query.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}
        </div>
      ) : query.isError ? (
        <p className="text-destructive text-sm">{t('errors.load')}</p>
      ) : shifts.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border bg-card p-6 text-center text-sm">{t('live.nobody')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shifts.map((s) => {
            const status = cardStatus(s);
            const alerts = cardAlerts(s);
            const duration = liveSeconds(s.durationSeconds ?? 0, serverTime, now);
            const worked = s.status === 'on_break' ? s.workedSeconds : liveSeconds(s.workedSeconds, serverTime, now);
            const till = s.currentMachine;
            return (
              <Card key={s.id}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-semibold">{s.posUserName ?? '—'}</p>
                      <p className="text-muted-foreground text-sm">
                        {[s.roleName || t('live.noRole'), s.shopName].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_TONE[status])}>
                      {t(`status.${status}`)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs">{t('live.clockIn')}</p>
                      <p className="tabular-nums font-medium">{timeOf(s.clockInAt)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">{t('live.duration')}</p>
                      <p className="tabular-nums font-medium">
                        {formatHours(duration)}
                        <span className="text-muted-foreground text-xs"> · {t('live.worked', { h: formatHours(worked) })}</span>
                      </p>
                    </div>
                  </div>
                  {s.status === 'on_break' && s.breakSince ? (
                    <p className="text-sm text-amber-700 dark:text-amber-300">{t('live.breakSince', { at: timeOf(s.breakSince) })}</p>
                  ) : null}
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="inline-flex items-center gap-1">
                      <Monitor className="size-3.5" />
                      {till
                        ? t('live.signedInAt', { till: till.posNumber ? `${till.name ?? ''} (${till.posNumber})` : (till.name ?? '') })
                        : t('live.notSignedIn')}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <UtensilsCrossed className="size-3.5" />
                      {t('live.openTables', { n: s.openTables ?? 0 })}
                    </span>
                  </div>
                  {alerts.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {alerts.map((a) => (
                        <Badge key={a} variant="outline" className="text-xs">
                          {t(`flags.${a}`)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {canManage ? (
                    <div className="flex justify-end pt-1">
                      <Button variant="destructive" size="sm" onClick={() => setClosing(s)}>
                        {t('close.action')}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CloseShiftDialog shift={closing} onClose={() => setClosing(null)} />
    </div>
  );
}
