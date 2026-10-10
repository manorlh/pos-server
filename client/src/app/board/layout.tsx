import type { Metadata, Viewport } from 'next';

/**
 * `/board` — מסך מוכן / לא מוכן in a browser (docs/SPEC_KDS.md §13): public (no sign-in: middleware.ts
 * isPublicRoute — the device authenticates with its own machine token), never indexed, its own
 * web app manifest (installs as "R2M Board", full screen, from `/board`) and its own service worker
 * (public/screens-sw.js, scope `/board`). No pinch zoom; edge to edge.
 */
export const metadata: Metadata = {
  title: 'R2M Board',
  description: 'מסך מוכן / לא מוכן של R2M POS',
  robots: { index: false, follow: false },
  manifest: '/board.webmanifest',
  applicationName: 'R2M Board',
  appleWebApp: { capable: true, title: 'R2M Board', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0d1016',
};

export default function ScreenLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden overscroll-none bg-[#0d1016]">{children}</div>;
}
