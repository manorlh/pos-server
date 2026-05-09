'use client';

import { useEffect } from 'react';
import { useAuth as useClerkAuth } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { Sidebar } from '@/components/sidebar';
import { useAuth } from '@/lib/auth';
import { Skeleton } from '@/components/ui/skeleton';

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
          <div className="space-y-4 max-w-xl">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : !isSignedIn ? null : isSignedIn && !authHydrated ? (
          <div className="space-y-4 max-w-xl">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : authHydrated && tenants.length === 0 ? (
          <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground max-w-lg">
            {t('noTenant')}
          </div>
        ) : activeTenantId ? (
          children
        ) : (
          <div className="space-y-4 max-w-xl">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </main>
    </div>
  );
}
