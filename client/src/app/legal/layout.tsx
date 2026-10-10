import type { Metadata } from 'next';

/**
 * The public legal pages of a business (`/legal/{companyId}/{kind}`): no login (`isPublicRoute` in
 * middleware.ts), only published versions, inside `PublicPageShell` (footer, cookie consent).
 * Light colours are fixed here — the business's page, not the dashboard's theme.
 */
export const metadata: Metadata = {
  title: 'מידע משפטי ונגישות',
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-white text-slate-900">{children}</div>;
}
