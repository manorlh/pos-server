import type { Metadata, Viewport } from 'next';

/**
 * `/c/<slug>` — the public digital business card (spec §25–28; server/app/routers/business_cards.py
 * `public_router`). Public like `/k`, `/kds` and `/board` (middleware.ts isPublicRoute): no sign-in,
 * no dashboard shell, no service worker. The page sets no cookies and no third-party scripts of its
 * own; counting is first-party and cookie-free. Zoom stays enabled (accessibility).
 */
export const metadata: Metadata = {
  title: 'כרטיס ביקור',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function CardLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh">{children}</div>;
}
