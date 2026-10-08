'use client';

/**
 * Where every sign-in lands — Clerk's redirect after signing in or up, `/`, and the installed
 * app's start URL all come here — and goes straight on to the user's opening page ("דף
 * פתיחה", lib/homePage.ts): the control board, unless they chose another page in their
 * profile and may open it. `replace`, so Back never returns to this hop.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useRoleAccess } from '@/lib/accessApi';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { landingTarget } from '@/lib/homePage';
import { Skeleton } from '@/components/ui/skeleton';

export default function StartPage() {
  const router = useRouter();
  const authHydrated = useAuth((s) => s.authHydrated);
  const homePage = useAuth((s) => s.user?.homePage);
  const access = useDashboardAccess();
  const { hidden, loaded } = useRoleAccess();
  // Once: the role's set is a new object on every render.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current || !authHydrated || !loaded) return;
    sent.current = true;
    router.replace(landingTarget(homePage, access, hidden));
  }, [access, authHydrated, hidden, homePage, loaded, router]);

  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-40" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-28 rounded-2xl" />
      </div>
    </div>
  );
}
