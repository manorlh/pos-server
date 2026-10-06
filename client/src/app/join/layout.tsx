import type { Metadata } from 'next';

/**
 * The public club pages (`/join/[token]`, `/join/unsubscribe/[token]`): no login (see
 * `isPublicRoute` in middleware.ts), mobile-first, RTL, blue and white with rounded
 * cards; on a wide screen a centred column of a comfortable width, never stretched.
 * Light colours are fixed here — the business's page, not the dashboard's theme.
 */
export const metadata: Metadata = {
  title: 'הצטרפות למועדון',
  robots: { index: false, follow: false },
};

export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-gradient-to-b from-sky-100 via-sky-50 to-white text-slate-900">
      <main className="mx-auto w-full max-w-md px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(1.5rem+env(safe-area-inset-top))] sm:pt-10">
        {children}
      </main>
    </div>
  );
}
