import type { Metadata, Viewport } from 'next';

/**
 * `/app` — the single web entry for every role (web-till spec v2 §6.1). The device authenticates
 * with its own machine token; the public route in middleware.ts (as `/k`, `/kds`, `/board`) and
 * its own manifest / service worker (`app.webmanifest`, `app-sw.js`, P1-8) come after the
 * Saturday server merge. Never indexed; no pinch zoom; edge to edge.
 */
export const metadata: Metadata = {
  title: 'R2M POS',
  description: 'R2M POS — קופה, קיוסק, מסך מטבח, מסך מוכן ומסך לקוח בדפדפן',
  robots: { index: false, follow: false },
  applicationName: 'R2M POS',
  appleWebApp: { capable: true, title: 'R2M POS', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-auto overscroll-none bg-neutral-50">{children}</div>;
}
