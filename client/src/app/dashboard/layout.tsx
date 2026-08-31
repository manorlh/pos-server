'use client';

import { Suspense, useEffect } from 'react';
import { useAuth as useClerkAuth } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { Sidebar } from '@/components/sidebar';
import { Breadcrumbs } from '@/components/dashboard/breadcrumbs';
import { ScopeBar } from '@/components/dashboard/scope-bar';
import { ScopeProvider } from '@/lib/scope';
import { useAuth } from '@/lib/auth';
import { Skeleton } from '@/components/ui/skeleton';

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
  return (
    <ScopeProvider>
      <div className="space-y-4">
        <header className="space-y-3">
          <Breadcrumbs />
          <ScopeBar />
        </header>
        {children}
      </div>
    </ScopeProvider>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('dashboard.layout');
  const { fetchUser, authHydrated, activeTenantId, tenants } = useAuth();
  const { isLoaded, isSignedIn } = useClerkAuth();

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      fetchUser();
    }
  }, [isLoaded, isSignedIn, fetchUser]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-muted/20 p-6">
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
    </div>
  );
}
