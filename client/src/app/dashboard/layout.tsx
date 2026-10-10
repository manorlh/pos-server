'use client';

import { Suspense, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth as useClerkAuth } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { Sidebar } from '@/components/sidebar';
import { Breadcrumbs } from '@/components/dashboard/breadcrumbs';
import { ScopeBar } from '@/components/dashboard/scope-bar';
import { ScopeProvider } from '@/lib/scope';
import { useAuth } from '@/lib/auth';
import { Skeleton } from '@/components/ui/skeleton';
import { MobileNav } from '@/components/mobile-nav';
import { useRoleAccess } from '@/lib/accessApi';
import { findNavEntry } from '@/lib/navigation';
import { canAccess, isHomePath, levelForPath, pageAccess, sectionForPath } from '@/lib/dashboardAccess';
import { LANDING_PATH } from '@/lib/homePage';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { SectionDenied } from '@/components/dashboard/access/my-access-card';
import { ProducerShell } from '@/components/dashboard/event-live/producer-shell';
import { isProducer } from '@/lib/producer';
import { DeviceCommandsTray } from '@/components/dashboard/device-commands/commands-tray';
import { DeviceCommandPopup } from '@/components/dashboard/device-commands/command-popup';

function ShellSkeleton() {
  return (
    <div className="space-y-4 max-w-xl">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * Everything that reads the shared scope. Split out from the layout because the
 * scope lives in the URL query, and `useSearchParams` has to sit inside a
 * Suspense boundary for the route to keep prerendering.
 */
function DashboardShell({ children }: { children: React.ReactNode }) {
  // The home (the control board) draws its own filters over the same scope, phone-first;
  // the bar above it would say the same thing twice. The landing hop shows none either.
  const pathname = usePathname();
  const ownFilters = isHomePath(pathname) || pathname === LANDING_PATH;
  return (
    <ScopeProvider>
      <div className="space-y-4">
        {ownFilters ? null : (
          <header className="space-y-3 print:hidden">
            <Breadcrumbs />
            <ScopeBar />
          </header>
        )}
        <AccessGuard>{children}</AccessGuard>
      </div>
    </ScopeProvider>
  );
}

/**
 * "הרשאות": a page the super admin hid from this role is not shown when reached by its
 * address either — not only left out of the menu.
 *
 * "הרשאות דשבורד": nor a page of a section this user was not given — "אין לך הרשאה" instead
 * of a page whose every request the server refuses.
 *
 * Except the home page, the control board: every sign-in lands on it, so it is never refused —
 * without "דוחות" (or with the home hidden from the role) it shows what the user may see, the
 * tills' state, and leaves the figures out (app/dashboard/page.tsx).
 */
function AccessGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations('dashboard.layout');
  const pathname = usePathname();
  const { hidden, loaded } = useRoleAccess();
  const dashboardAccess = useDashboardAccess();
  const entry = findNavEntry(pathname);
  if (!loaded) return <ShellSkeleton />;
  if (isHomePath(pathname)) return <>{children}</>;
  if (entry && hidden.has(entry.href)) {
    return <div className="max-w-lg rounded-lg border bg-card p-6 text-sm text-muted-foreground">{t('hiddenPage')}</div>;
  }
  const verdict = pageAccess(dashboardAccess, pathname);
  if (verdict === 'denied') {
    const section = sectionForPath(pathname);
    const needsEdit = section !== undefined && levelForPath(pathname) === 'edit' && canAccess(dashboardAccess, section, 'view');
    return <SectionDenied section={section ?? ''} needsEdit={needsEdit} />;
  }
  return <>{children}</>;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('dashboard.layout');
  const { fetchUser, authHydrated, activeTenantId, tenants, user } = useAuth();
  const { isLoaded, isSignedIn } = useClerkAuth();

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      fetchUser();
    }
  }, [isLoaded, isSignedIn, fetchUser]);

  // Below md the sidebar is a drawer behind a menu button. It is open for the path it was
  // opened on, so following any link — the menu's or the page's — closes it.
  const pathname = usePathname();
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null);

  // "עמדת מפיק" (feat/event-live): a producer gets their own minimal layout, never the dashboard's.
  if (isLoaded && isSignedIn && authHydrated && isProducer(user?.role) && activeTenantId) {
    return <ProducerShell>{children}</ProducerShell>;
  }

  return (
    <div className="flex h-dvh overflow-hidden print:block print:h-auto print:overflow-visible">
      <Sidebar className="hidden md:flex" />
      <div className="flex min-w-0 flex-1 flex-col print:block">
        <MobileNav
          open={navOpenAt === pathname}
          onOpenChange={(open) => setNavOpenAt(open ? pathname : null)}
        />
        <main className="ios-safe-main min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-muted/20 p-3 sm:p-4 md:p-6 print:overflow-visible print:bg-transparent print:p-0">
          {!isLoaded ? (
            <ShellSkeleton />
          ) : !isSignedIn ? null : isSignedIn && !authHydrated ? (
            <ShellSkeleton />
          ) : authHydrated && tenants.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground max-w-lg">
              {t('noTenant')}
            </div>
          ) : activeTenantId ? (
            <Suspense fallback={<ShellSkeleton />}>
              <DashboardShell>{children}</DashboardShell>
            </Suspense>
          ) : (
            <ShellSkeleton />
          )}
        </main>
        {/* "פקודות שנשלחו": every command sent to a device, followed in the background (never blocking).
            Never a producer's: they get ProducerShell above, and the check here says so again. */}
        {isLoaded && isSignedIn && authHydrated && activeTenantId && !isProducer(user?.role) ? (
          <>
            <DeviceCommandPopup />
            <DeviceCommandsTray />
          </>
        ) : null}
      </div>
    </div>
  );
}
