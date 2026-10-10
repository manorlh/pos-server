'use client';

/**
 * "עמדת מפיק" — the producer's own minimal layout: no menu, no scope bar, nothing of the
 * business but their events. The dashboard layout renders it instead of its shell for a
 * PRODUCER_VIEW user, and any other dashboard address takes them home (`/dashboard/producer`).
 * The server refuses everything else anyway (app/services/dashboard_access.py).
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';
import { useTranslations } from 'next-intl';
import { LogOut, Ticket } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PRODUCER_HOME, producerRedirect } from '@/lib/producer';

export function ProducerShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('producer');
  const pathname = usePathname();
  const router = useRouter();
  const { signOut } = useClerk();
  const { user, tenants, activeTenantId, clearUser } = useAuth();
  const target = producerRedirect(pathname);
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);
  const org = tenants.find((x) => x.id === activeTenantId)?.name;

  return (
    <div className="min-h-dvh overflow-y-auto bg-[#F2F2F7] text-black dark:bg-black dark:text-white">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-black/5 bg-white/90 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-[#1C1C1E]/90">
        <Link href={PRODUCER_HOME} className="flex min-w-0 items-center gap-2 font-bold">
          <Ticket className="size-5 text-[#007AFF]" aria-hidden />
          <span className="truncate">{t('title')}</span>
        </Link>
        <span className="hidden truncate text-sm text-[#8E8E93] sm:inline">{[org, user?.username].filter(Boolean).join(' · ')}</span>
        <button
          type="button"
          onClick={async () => {
            clearUser();
            await signOut({ redirectUrl: '/sign-in' });
          }}
          className="ms-auto inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm text-[#007AFF] hover:bg-[#007AFF]/10"
        >
          <LogOut className="size-4" aria-hidden />
          {t('signOut')}
        </button>
      </header>
      <main className="mx-auto max-w-5xl px-3 py-4 sm:px-6">{target ? null : children}</main>
    </div>
  );
}
