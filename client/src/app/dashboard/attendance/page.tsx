'use client';

/**
 * "נוכחות עובדים" (docs/SPEC_ATTENDANCE.md, phase 1): who is on shift now, the attendance
 * report, the corrections waiting for a manager, and the job titles.
 *
 * Attendance is separate from the till login and from the till's cash shift ("משמרות"):
 * an employee clocks in and out at a till ("התחל משמרת" / "סיום משמרת"), breaks included;
 * switching tills, signing out or the idle lock never end a shift. Only a clock-out or a
 * manager's recorded action here does. Read by every role but the cashier, within their
 * shops; corrected and closed by the till users' managers.
 *
 * The tab is in the URL (`?tab=report`), so a link to the report — its days and filters
 * are in the URL too — opens on the report.
 */

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { AttendanceReport } from '@/components/dashboard/attendance/attendance-report';
import { Corrections } from '@/components/dashboard/attendance/corrections';
import { LiveBoard } from '@/components/dashboard/attendance/live-board';
import { RolesPanel } from '@/components/dashboard/attendance/roles-panel';
import { useAuth } from '@/lib/auth';

const TABS = ['live', 'report', 'corrections', 'roles'] as const;
type Tab = (typeof TABS)[number];

export default function AttendancePage() {
  const t = useTranslations('attendance');
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: Tab = TABS.find((k) => k === raw) ?? 'live';
  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'live') params.delete('tab');
      else params.set('tab', next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  if (user?.role === 'cashier') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('noAccess')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2 print:hidden" role="tablist" aria-label={t('title')}>
        {TABS.map((k) => (
          <Button
            key={k}
            role="tab"
            aria-selected={tab === k}
            variant={tab === k ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTab(k)}
          >
            {t(`tabs.${k}`)}
          </Button>
        ))}
      </div>

      {tab === 'live' ? <LiveBoard /> : null}
      {tab === 'report' ? <AttendanceReport /> : null}
      {tab === 'corrections' ? <Corrections /> : null}
      {tab === 'roles' ? <RolesPanel /> : null}
    </div>
  );
}
