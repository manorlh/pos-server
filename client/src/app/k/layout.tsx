import type { Metadata, Viewport } from 'next';

/**
 * `/k` — the browser kiosk (docs/SPEC_KIOSK.md §27): public (no sign-in: middleware.ts
 * isPublicRoute — the device authenticates with its own machine token), never indexed, its own
 * web app manifest (installs as "R2M Kiosk", full screen, from `/k`) and its own service worker
 * (public/kiosk-sw.js, scope `/k`). No pinch zoom; edge to edge on an iPad / iPhone.
 */
export const metadata: Metadata = {
  title: 'R2M Kiosk',
  description: 'קיוסק הזמנה עצמית של R2M POS',
  robots: { index: false, follow: false },
  manifest: '/k.webmanifest',
  applicationName: 'R2M Kiosk',
  appleWebApp: { capable: true, title: 'R2M Kiosk', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#000000',
};

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden overscroll-none bg-black">{children}</div>;
}
